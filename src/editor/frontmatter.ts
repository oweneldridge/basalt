// Live Preview for YAML frontmatter: render the leading `---…---` block as an
// Obsidian-style Properties view with EDITABLE values. Simple properties
// (scalar / inline-array / block-list) get inputs; edits dispatch a precise,
// span-only change through lib/frontmatter (which rewrites just that key and
// preserves every other line). Complex values (block scalars, nested maps,
// anchors) are shown read-only — "Edit as text" reveals the raw YAML.
//
// Like tables, this is a block decoration, so it comes from a StateField. The
// widget gets the EditorView in toDOM(view) and dispatches directly; inputs are
// plain DOM (no CM transaction while typing), so the widget is stable until a
// commit rebuilds it.
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, EditorSelection, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { frontmatterRange } from "./regions";
import { parseFm, setProp, deleteProp, type FmProp } from "../lib/frontmatter";

class PropertiesWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: PropertiesWidget): boolean {
    return other.source === this.source;
  }
  ignoreEvent(): boolean {
    return true; // inputs/buttons handle their own events; CM stays out
  }

  /** Apply a structured edit to the LIVE frontmatter block and dispatch it.
   * Deferred (so we never dispatch inside an in-progress CM update — e.g. a blur
   * fired while an external reload rebuilds the widget) and guarded: if the
   * block changed since this widget rendered (external reload, or a prior
   * commit that rebuilt the widget and left this handler stale), the edit is
   * DROPPED rather than clobbering the newer content. */
  private commit(view: EditorView, mutate: (src: string) => string): void {
    const render = this.source;
    queueMicrotask(() => {
      const range = frontmatterRange(view.state);
      if (!range) return;
      const src = view.state.doc.sliceString(range.from, range.to);
      if (src !== render) return; // stale — the block moved on; don't overwrite
      const next = mutate(src);
      if (next === src) return;
      view.dispatch({ changes: { from: range.from, to: range.to, insert: next } });
    });
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-properties";
    wrap.contentEditable = "false";
    const parsed = parseFm(this.source);
    const props = parsed?.props ?? [];

    if (props.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cm-properties-empty";
      empty.textContent = "No properties";
      wrap.append(empty);
    }

    for (const p of props) {
      wrap.append(this.renderRow(view, p, parsed!.body));
    }

    // Footer: add a property, or drop to raw YAML for anything the UI can't edit.
    const footer = document.createElement("div");
    footer.className = "cm-prop-footer";
    const addBtn = document.createElement("button");
    addBtn.className = "cm-prop-add";
    addBtn.textContent = "+ Add property";
    addBtn.onclick = () => this.appendNewRow(view, wrap);
    const rawBtn = document.createElement("button");
    rawBtn.className = "cm-prop-raw";
    rawBtn.textContent = "{ } Edit as text";
    rawBtn.onclick = () => {
      const range = frontmatterRange(view.state);
      if (range) view.dispatch({ selection: { anchor: Math.min(range.from + 4, range.to) } });
      view.focus();
    };
    footer.append(addBtn, rawBtn);
    wrap.append(footer);
    return wrap;
  }

  private renderRow(view: EditorView, p: FmProp, body: string[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "cm-prop-row";

    const key = document.createElement("div");
    key.className = "cm-prop-key";
    key.textContent = p.key;
    key.title = p.key;

    const values = document.createElement("div");
    values.className = "cm-prop-values";

    if (p.kind === "complex") {
      // Read-only: show the raw lines, untouched by the structured editor.
      const raw = document.createElement("div");
      raw.className = "cm-prop-complex";
      raw.textContent = body.slice(p.start, p.end + 1).join("\n");
      raw.title = "Complex value — use “Edit as text”";
      values.append(raw);
    } else if (p.kind === "list" || p.kind === "inline") {
      values.classList.add("cm-prop-multi");
      const multi = true;
      const reread = (): string[] =>
        [...values.querySelectorAll<HTMLInputElement>(".cm-prop-input")].map((i) => i.value);
      for (const v of p.values) {
        values.append(this.listItem(view, p.key, v, reread, multi));
      }
      const add = document.createElement("button");
      add.className = "cm-prop-additem";
      add.textContent = "+";
      add.title = "Add value";
      add.onclick = () => {
        const item = this.listItem(view, p.key, "", reread, multi);
        values.insertBefore(item, add);
        item.querySelector("input")?.focus();
      };
      values.append(add);
    } else {
      // scalar / empty: a single editable value
      const input = this.valueInput(p.values[0] ?? "");
      const fire = () => this.commit(view, (src) => setProp(src, p.key, [input.value], false));
      input.onblur = fire;
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
        }
      };
      values.append(input);
    }

    row.append(key, values);

    if (p.kind !== "complex") {
      const del = document.createElement("button");
      del.className = "cm-prop-del";
      del.textContent = "×";
      del.title = `Remove ${p.key}`;
      del.onclick = () => this.commit(view, (src) => deleteProp(src, p.key));
      row.append(del);
    }
    return row;
  }

  private listItem(
    view: EditorView,
    key: string,
    value: string,
    rereadValues: () => string[],
    multi: boolean,
  ): HTMLElement {
    const pill = document.createElement("span");
    pill.className = "cm-prop-pill";
    const input = this.valueInput(value);
    const commitAll = () =>
      this.commit(view, (src) => setProp(src, key, rereadValues(), multi));
    input.onblur = commitAll;
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    };
    const remove = document.createElement("button");
    remove.className = "cm-prop-removeitem";
    remove.textContent = "×";
    remove.title = "Remove value";
    remove.onclick = () => {
      pill.remove();
      this.commit(view, (src) => setProp(src, key, rereadValues(), multi));
    };
    pill.append(input, remove);
    return pill;
  }

  private valueInput(value: string): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "cm-prop-input";
    input.type = "text";
    input.value = value;
    input.spellcheck = false;
    return input;
  }

  /** Inline "add property": a key + value input pair; commits when the key is set. */
  private appendNewRow(view: EditorView, wrap: HTMLElement): void {
    const row = document.createElement("div");
    row.className = "cm-prop-row cm-prop-new";
    const keyInput = this.valueInput("");
    keyInput.placeholder = "key";
    keyInput.classList.add("cm-prop-keyinput");
    const valInput = this.valueInput("");
    valInput.placeholder = "value";
    // A key the simple serializer can't emit safely (would split/become a
    // comment) or that collides with an existing property is rejected — adding
    // a key that exists is handled by editing its row above, never by overwrite.
    const keyIsSafe = (k: string): boolean =>
      k.length > 0 && !/[:#]/.test(k) && !/^[-?[\]{}&*!|>'"%@`,]/.test(k);
    const commitNew = () => {
      const k = keyInput.value.trim();
      if (!keyIsSafe(k)) {
        keyInput.classList.toggle("cm-prop-invalid", k.length > 0);
        return;
      }
      this.commit(view, (src) => {
        const parsed = parseFm(src);
        if (parsed?.props.some((p) => p.key === k)) return src; // already exists: no-op
        return setProp(src, k, [valInput.value], false);
      });
    };
    valInput.onblur = commitNew;
    // Commit on key blur too (so a key typed without a value isn't lost) —
    // UNLESS focus is moving to the value field, where the user will keep typing.
    keyInput.onblur = (e) => {
      if (e.relatedTarget === valInput) return;
      commitNew();
    };
    keyInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        valInput.focus();
      }
    };
    valInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        valInput.blur();
      }
    };
    const keyCell = document.createElement("div");
    keyCell.className = "cm-prop-key";
    keyCell.append(keyInput);
    const valCell = document.createElement("div");
    valCell.className = "cm-prop-values";
    valCell.append(valInput);
    row.append(keyCell, valCell);
    // Insert before the footer.
    wrap.insertBefore(row, wrap.lastElementChild);
    keyInput.focus();
  }
}

interface FmState {
  deco: DecorationSet;
  range: { from: number; to: number } | null;
}

function compute(state: EditorState): FmState {
  const range = frontmatterRange(state);
  if (!range) return { deco: Decoration.none, range: null };
  const touched = state.selection.ranges.some((r) => r.from <= range.to && r.to >= range.from);
  if (touched) return { deco: Decoration.none, range }; // editing: show raw
  const builder = new RangeSetBuilder<Decoration>();
  const source = state.doc.sliceString(range.from, range.to);
  builder.add(
    range.from,
    range.to,
    Decoration.replace({ widget: new PropertiesWidget(source), block: true }),
  );
  return { deco: builder.finish(), range };
}

function touches(range: { from: number; to: number } | null, sel: EditorSelection): boolean {
  if (!range) return false;
  return sel.ranges.some((r) => r.from <= range.to && r.to >= range.from);
}

const fmField = StateField.define<FmState>({
  create: (state) => compute(state),
  update: (value, tr) => {
    if (tr.docChanged) return compute(tr.state);
    if (tr.selection) {
      const before = touches(value.range, tr.startState.selection);
      const after = touches(value.range, tr.state.selection);
      if (before !== after) return compute(tr.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
});

export const frontmatter: Extension = [fmField];
