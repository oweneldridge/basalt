// The bridge between the pure query engine and the app. The editor's Live
// Preview widget and the Reading view both render ```dataview blocks, but
// neither has direct access to the vault index. App installs a QueryHost here;
// the renderer calls it to run a query and to handle link clicks / task toggles.

import {
  queryCellParts,
  LinkVal,
  type QueryResult,
  type QueryResultRow,
  type CellPart,
  type Task,
  type Val,
} from "./query";

export interface QueryHost {
  /** Run a query's source text against the vault, from the note at `selfPath`. */
  run: (source: string, selfPath: string) => QueryResult;
  /** Open a vault file / wikilink target (no-create). */
  openLink: (target: string) => void;
  /** Toggle a task's checkbox on disk. */
  toggleTask: (task: Task) => void;
}

let host: QueryHost | null = null;
export function setQueryHost(h: QueryHost | null): void {
  host = h;
}
export function getQueryHost(): QueryHost | null {
  return host;
}

function partsToDom(parts: CellPart[], onOpen: (t: string) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const p of parts) {
    if (p.kind === "link") {
      const a = document.createElement("a");
      a.className = "query-link";
      a.textContent = p.text;
      a.title = p.target;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        onOpen(p.target);
      });
      frag.append(a);
    } else if (p.kind === "check") {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = p.checked;
      box.disabled = true;
      frag.append(box);
    } else if (p.kind === "tag") {
      const s = document.createElement("span");
      s.className = "query-tag";
      s.textContent = p.text;
      frag.append(s);
    } else if (p.kind === "image") {
      const s = document.createElement("span");
      s.textContent = p.src;
      frag.append(s);
    } else {
      frag.append(document.createTextNode(p.text));
    }
  }
  return frag;
}

function cell(v: Val, onOpen: (t: string) => void): DocumentFragment {
  return partsToDom(queryCellParts(v), onOpen);
}

/** Build the DOM for a query result. Read-only except TASK checkboxes, which
 * toggle on disk via the host. */
export function renderQueryResult(res: QueryResult, h: QueryHost): HTMLElement {
  const root = document.createElement("div");
  root.className = "query-block";
  const onOpen = (t: string) => h.openLink(t);

  if (res.error) {
    const err = document.createElement("div");
    err.className = "query-error";
    err.textContent = `Query error: ${res.error}`;
    root.append(err);
    return root;
  }

  if (res.kind === "TASK") {
    if (res.tasks.length === 0) {
      root.append(emptyNode("No tasks"));
      return root;
    }
    const ul = document.createElement("ul");
    ul.className = "query-tasks";
    for (const t of res.tasks) ul.append(taskItem(t, h, onOpen));
    root.append(ul);
    return root;
  }

  if (res.kind === "LIST") {
    if (res.rows.length === 0 && !res.groups) {
      root.append(emptyNode("No results"));
      return root;
    }
    root.append(res.groups ? groupedList(res.groups, onOpen) : listOf(res.rows, onOpen));
    return root;
  }

  // TABLE
  if (res.rows.length === 0 && !res.groups) {
    root.append(emptyNode("No results"));
    return root;
  }
  root.append(tableOf(res, onOpen));
  return root;
}

function emptyNode(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "query-empty";
  d.textContent = text;
  return d;
}

function taskItem(t: Task, h: QueryHost, onOpen: (t: string) => void): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "query-task";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = t.checked;
  box.addEventListener("change", () => {
    box.disabled = true; // avoid double-fire before the reload
    h.toggleTask(t);
  });
  li.append(box);
  // Render the task text with wikilinks clickable (reuse cell parts on the string).
  const text = document.createElement("span");
  text.className = t.checked ? "query-task-text done" : "query-task-text";
  renderInlineTaskText(text, t.text, onOpen);
  li.append(text);
  // A small source link to the note.
  const src = document.createElement("a");
  src.className = "query-task-src";
  src.textContent = t.path.split("/").pop()?.replace(/\.md$/i, "") ?? t.path;
  src.title = `${t.path}:${t.line + 1}`;
  src.addEventListener("click", (e) => {
    e.preventDefault();
    onOpen(t.path);
  });
  li.append(src);
  return li;
}

/** Render task text, turning [[wikilinks]] into clickable links (plain text
 * otherwise — the text is inserted via textContent, never innerHTML). */
function renderInlineTaskText(el: HTMLElement, text: string, onOpen: (t: string) => void): void {
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) el.append(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement("a");
    a.className = "query-link";
    a.textContent = m[2] ?? m[1];
    a.addEventListener("click", (e) => {
      e.preventDefault();
      onOpen(m![1]);
    });
    el.append(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) el.append(document.createTextNode(text.slice(last)));
}

function listOf(rows: QueryResultRow[], onOpen: (t: string) => void): HTMLUListElement {
  const ul = document.createElement("ul");
  ul.className = "query-list";
  for (const r of rows) {
    const li = document.createElement("li");
    li.append(cell(r.listValue ?? new LinkVal(r.row.path, r.row.basename), onOpen));
    ul.append(li);
  }
  return ul;
}

function groupedList(groups: QueryResult["groups"], onOpen: (t: string) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const g of groups ?? []) {
    const h = document.createElement("div");
    h.className = "query-group";
    h.textContent = g.label === "" ? "(none)" : g.label;
    frag.append(h);
    frag.append(listOf(g.rows, onOpen));
  }
  return frag;
}

function tableOf(res: QueryResult, onOpen: (t: string) => void): HTMLElement {
  const table = document.createElement("table");
  table.className = "query-table";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const col of res.columns) {
    const th = document.createElement("th");
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  table.append(thead);

  const tbody = document.createElement("tbody");
  const withId = !res.columns.length || res.columns[0] === "File";
  const rowTr = (r: QueryResultRow) => {
    const tr = document.createElement("tr");
    if (withId) {
      const td = document.createElement("td");
      td.append(cell(new LinkVal(r.row.path, r.row.basename), onOpen));
      tr.append(td);
    }
    for (const c of r.cells) {
      const td = document.createElement("td");
      td.append(cell(c, onOpen));
      tr.append(td);
    }
    return tr;
  };

  if (res.groups) {
    for (const g of res.groups) {
      const gtr = document.createElement("tr");
      gtr.className = "query-group-row";
      const td = document.createElement("td");
      td.colSpan = res.columns.length || 1;
      td.textContent = g.label === "" ? "(none)" : g.label;
      gtr.append(td);
      tbody.append(gtr);
      for (const r of g.rows) tbody.append(rowTr(r));
    }
  } else {
    for (const r of res.rows) tbody.append(rowTr(r));
  }
  table.append(tbody);
  return table;
}

/** Convenience: parse + run + render from source, using the installed host.
 * Returns a placeholder element when no host is installed (e.g. before the
 * vault loads). */
export function renderQuerySource(source: string, selfPath: string): HTMLElement {
  const h = getQueryHost();
  if (!h) {
    const d = document.createElement("div");
    d.className = "query-block query-empty";
    d.textContent = "…";
    return d;
  }
  const res = h.run(source, selfPath);
  return renderQueryResult(res, h);
}
