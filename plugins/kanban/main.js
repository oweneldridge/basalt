// Kanban — Markdown-backed boards inside a ```kanban code block. Columns are
// `## Headings`, cards are `- [ ] item` / `- [x] item` (done). Drag cards to
// move them, add/rename/delete columns and cards, toggle done. Changes are
// saved back into the SAME fenced block in the host note via the vault's
// single-writer path (it refuses while the note has unsaved edits or an
// unresolved conflict, so the board never races the editor).
//
// Data safety: the board only edits the ONE fenced block it renders, located
// by its exact source. If that block can't be uniquely found (e.g. it was
// changed since render), the edit is refused — never a whole-note rewrite.
// Non-canonical boards (blank lines in a column, multi-line cards, stray text)
// render READ-ONLY so nothing is silently reformatted.
//
// NOT full Obsidian-Kanban: no per-card metadata UI, no archive, no board
// settings, no swimlanes. One board per block for editing.
const { Plugin, Notice } = require("basalt");

// ---- pure model: parse / serialize / locate (unit-tested) ----------------
const HEADING = /^##\s+(.*)$/;
const CARD = /^- \[([ xX])\]\s?(.*)$/;

function parseBoard(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const columns = [];
  let canonical = true;
  let col = null;
  let sawContent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = HEADING.exec(line);
    if (h) {
      col = { title: h[1].trim(), cards: [] };
      columns.push(col);
      sawContent = true;
      continue;
    }
    const c = CARD.exec(line);
    if (c && col) {
      col.cards.push({ done: c[1] !== " ", text: c[2] });
      sawContent = true;
      continue;
    }
    if (line.trim() === "") continue; // blank lines are allowed but non-canonical spacing is caught below
    // Any other content (stray text, sub-bullets, cards before a heading) is
    // something we can't round-trip losslessly → mark non-canonical.
    canonical = false;
    sawContent = true;
  }
  return { columns, canonical: canonical && sawContent };
}

function serializeBoard(board) {
  return board.columns
    .map((col) => ["## " + col.title, ...col.cards.map((cd) => `- [${cd.done ? "x" : " "}] ${cd.text}`)].join("\n"))
    .join("\n\n");
}

// Normalize for idempotency comparison: strip per-line trailing whitespace and
// leading/trailing blank lines.
function normalizeBoardText(s) {
  return String(s)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

// A board is editable only if parse→serialize reproduces it exactly — otherwise
// saving would reformat the note, so we stay read-only.
function boardEditable(src) {
  const board = parseBoard(src);
  if (!board.canonical || board.columns.length === 0) return false;
  return normalizeBoardText(serializeBoard(board)) === normalizeBoardText(src);
}

// Replace the body of the UNIQUE ```kanban block whose current body equals
// `oldBody`. Returns the new note text, or null if not found / ambiguous.
function replaceKanbanBlock(noteText, oldBody, newBody) {
  const src = String(noteText);
  const fence = /(^|\n)([ \t]*)(`{3,}|~{3,})[ \t]*kanban[ \t]*\n([\s\S]*?)\n\2\3[ \t]*(?=\n|$)/gi;
  const matches = [];
  let m;
  while ((m = fence.exec(src))) {
    matches.push({ index: m.index + m[1].length, full: m[0].slice(m[1].length), body: m[4], indent: m[2], ticks: m[3] });
  }
  const want = normalizeBoardText(oldBody);
  const hits = matches.filter((x) => normalizeBoardText(x.body) === want);
  if (hits.length !== 1) return null;
  const hit = hits[0];
  const rebuilt = `${hit.indent}${hit.ticks}kanban\n${newBody}\n${hit.indent}${hit.ticks}`;
  const start = hit.index;
  return src.slice(0, start) + rebuilt + src.slice(start + hit.full.length);
}

const STARTER = "## To Do\n- [ ] First task\n\n## Doing\n\n## Done\n";

// ---- the interactive board (DOM) -----------------------------------------
module.exports = class Kanban extends Plugin {
  onload() {
    this.registerMarkdownCodeBlockProcessor("kanban", (source, el, ctx) => {
      this.renderBoard(source, el, ctx.notePath);
    });
    this.addCommand({
      id: "insert",
      name: "Insert Kanban board",
      callback: () => {
        const ed = this.app.workspace.activeEditor;
        if (!ed) {
          new Notice("Open a note to insert a board into.");
          return;
        }
        ed.editor.insertAtCursor("```kanban\n" + STARTER + "```\n");
      },
    });
  }

  renderBoard(source, el, notePath) {
    const board = parseBoard(source);
    const editable = boardEditable(source);
    el.replaceChildren();
    const root = document.createElement("div");
    root.className = "kanban-board" + (editable ? "" : " is-readonly");
    el.appendChild(root);

    // Persist the current model back into the block. `origin` is the source we
    // rendered from (used to locate the block); we advance it on success. Saves
    // are serialized through `chain` so overlapping mutations can't race the
    // block locator (each save sees the previous one's advanced `origin`).
    let origin = source;
    let chain = Promise.resolve();
    const doSave = async () => {
      const nextBody = serializeBoard(board);
      if (nextBody === origin) return; // nothing changed on disk
      let content;
      try {
        content = await this.app.vault.read(notePath);
      } catch (e) {
        new Notice("Kanban: couldn't read the note. " + (e && e.message ? e.message : e));
        return;
      }
      const updated = replaceKanbanBlock(content, origin, nextBody);
      if (updated == null) {
        new Notice("Kanban: couldn't locate this board to save it (edit the note as text).");
        return;
      }
      try {
        await this.app.vault.modify(notePath, updated);
        origin = nextBody; // block body is now nextBody
      } catch (e) {
        new Notice("Kanban: " + (e && e.message ? e.message : String(e)));
      }
    };
    const save = () => {
      chain = chain.then(doSave, doSave);
      return chain;
    };
    const mutate = (fn) => {
      fn();
      draw();
      save();
    };

    let drag = null; // { col, idx }

    const draw = () => {
      root.replaceChildren();
      board.columns.forEach((col, ci) => {
        const colEl = document.createElement("div");
        colEl.className = "kanban-col";

        const head = document.createElement("div");
        head.className = "kanban-col-head";
        const title = document.createElement("span");
        title.className = "kanban-col-title";
        title.textContent = col.title;
        if (editable) {
          title.title = "Double-click to rename";
          title.addEventListener("dblclick", () => {
            const name = window.prompt ? window.prompt("Column name", col.title) : col.title;
            if (name != null && name.trim()) mutate(() => (col.title = name.trim()));
          });
        }
        head.appendChild(title);
        const count = document.createElement("span");
        count.className = "kanban-col-count";
        count.textContent = String(col.cards.length);
        head.appendChild(count);
        if (editable) {
          const del = document.createElement("button");
          del.className = "kanban-col-del";
          del.textContent = "×";
          del.title = "Delete column";
          del.addEventListener("click", () => {
            if (col.cards.length && window.confirm && !window.confirm(`Delete "${col.title}" and its ${col.cards.length} card(s)?`)) return;
            mutate(() => board.columns.splice(ci, 1));
          });
          head.appendChild(del);
        }
        colEl.appendChild(head);

        const cardsEl = document.createElement("div");
        cardsEl.className = "kanban-cards";
        if (editable) {
          cardsEl.addEventListener("dragover", (e) => {
            e.preventDefault();
            cardsEl.classList.add("is-drop");
          });
          cardsEl.addEventListener("dragleave", () => cardsEl.classList.remove("is-drop"));
          cardsEl.addEventListener("drop", (e) => {
            e.preventDefault();
            cardsEl.classList.remove("is-drop");
            if (!drag) return;
            const moved = board.columns[drag.col].cards[drag.idx];
            if (!moved) return;
            mutate(() => {
              board.columns[drag.col].cards.splice(drag.idx, 1);
              board.columns[ci].cards.push(moved);
            });
            drag = null;
          });
        }
        col.cards.forEach((card, di) => {
          const cardEl = document.createElement("div");
          cardEl.className = "kanban-card" + (card.done ? " is-done" : "");
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = card.done;
          box.disabled = !editable;
          if (editable) box.addEventListener("change", () => mutate(() => (card.done = box.checked)));
          cardEl.appendChild(box);
          const text = document.createElement("span");
          text.className = "kanban-card-text";
          text.textContent = card.text;
          if (editable) {
            text.addEventListener("dblclick", () => {
              const v = window.prompt ? window.prompt("Card", card.text) : card.text;
              if (v != null) mutate(() => (card.text = v));
            });
          }
          cardEl.appendChild(text);
          if (editable) {
            cardEl.draggable = true;
            cardEl.addEventListener("dragstart", (e) => {
              drag = { col: ci, idx: di };
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", card.text); // WebKit needs a payload
              }
            });
            const x = document.createElement("button");
            x.className = "kanban-card-del";
            x.textContent = "×";
            x.title = "Delete card";
            x.addEventListener("click", () => mutate(() => col.cards.splice(di, 1)));
            cardEl.appendChild(x);
          }
          cardsEl.appendChild(cardEl);
        });
        colEl.appendChild(cardsEl);

        if (editable) {
          const add = document.createElement("input");
          add.className = "kanban-add-card";
          add.placeholder = "+ Add a card";
          add.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && add.value.trim()) {
              const v = add.value.trim();
              add.value = "";
              mutate(() => col.cards.push({ done: false, text: v }));
            }
          });
          colEl.appendChild(add);
        }
        root.appendChild(colEl);
      });

      if (editable) {
        const addCol = document.createElement("button");
        addCol.className = "kanban-add-col";
        addCol.textContent = "+ Add column";
        addCol.addEventListener("click", () => {
          const name = window.prompt ? window.prompt("Column name", "New column") : "New column";
          if (name != null && name.trim()) mutate(() => board.columns.push({ title: name.trim(), cards: [] }));
        });
        root.appendChild(addCol);
      } else {
        const note = document.createElement("div");
        note.className = "kanban-readonly-note";
        note.textContent = "Read-only: this board isn't in Kanban's canonical format. Edit the note as text.";
        root.appendChild(note);
      }
    };
    draw();
  }
};

// Expose the pure helpers for unit tests (also harmless at runtime).
module.exports.parseBoard = parseBoard;
module.exports.serializeBoard = serializeBoard;
module.exports.boardEditable = boardEditable;
module.exports.replaceKanbanBlock = replaceKanbanBlock;
