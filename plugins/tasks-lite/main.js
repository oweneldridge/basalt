// Tasks Lite — a `tasks` code-block query (obsidian-tasks subset) for Basalt.
// Scans every note for checkbox lines, filters/sorts them, and renders a linked
// checkbox list. Supported filters: done | not done | has/no due date | due
// before|after|on <YYYY-MM-DD> | path includes|does not include <text> |
// description includes <text> | tags include <tag>; plus `sort by due|
// description` and `limit <n>`. Not full obsidian-tasks (no recurrence, no
// editing, no priority emojis beyond parsing).
const { Plugin } = require("basalt");

const TASK_RE = /^\s*[-*+] \[([ xX/\-])\]\s+(.*)$/;
const DUE_RE = /(?:📅|\[due::\s*)\s*(\d{4}-\d{2}-\d{2})/;

function extractTasks(content, path, name) {
  const out = [];
  content.split("\n").forEach((line, i) => {
    const m = TASK_RE.exec(line);
    if (!m) return;
    const text = m[2].trim();
    const dueM = DUE_RE.exec(text);
    out.push({
      text,
      done: /[xX]/.test(m[1]),
      due: dueM ? dueM[1] : null,
      tags: (text.match(/#[\w/-]+/g) || []).map((t) => t.slice(1)),
      path,
      name,
      line: i,
    });
  });
  return out;
}

function parseQuery(source) {
  const filters = [];
  let sort = null;
  let limit = null;
  for (const raw of source.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const l = raw.toLowerCase();
    const after = (kw) => raw.slice(kw.length).trim();
    if (l === "done") filters.push((t) => t.done);
    else if (l === "not done") filters.push((t) => !t.done);
    else if (l === "has due date") filters.push((t) => !!t.due);
    else if (l === "no due date") filters.push((t) => !t.due);
    else if (l.startsWith("due before ")) {
      const d = after("due before ");
      filters.push((t) => !!t.due && t.due < d);
    } else if (l.startsWith("due after ")) {
      const d = after("due after ");
      filters.push((t) => !!t.due && t.due > d);
    } else if (l.startsWith("due on ")) {
      const d = after("due on ");
      filters.push((t) => t.due === d);
    } else if (l.startsWith("path includes ")) {
      const s = after("path includes ").toLowerCase();
      filters.push((t) => t.path.toLowerCase().includes(s));
    } else if (l.startsWith("path does not include ")) {
      const s = after("path does not include ").toLowerCase();
      filters.push((t) => !t.path.toLowerCase().includes(s));
    } else if (l.startsWith("description includes ")) {
      const s = after("description includes ").toLowerCase();
      filters.push((t) => t.text.toLowerCase().includes(s));
    } else if (/^tags? includes? /.test(l)) {
      const s = raw.replace(/^tags? includes? /i, "").trim().replace(/^#/, "");
      filters.push((t) => t.tags.some((tag) => tag === s || tag.startsWith(s + "/")));
    } else if (l.startsWith("sort by ")) {
      sort = after("sort by ").toLowerCase();
    } else if (l.startsWith("limit ")) {
      limit = parseInt(l.replace(/limit (to )?/, ""), 10) || null;
    }
    // unknown instructions are ignored (forward-compatible)
  }
  return { filters, sort, limit };
}

module.exports = class TasksLite extends Plugin {
  onload() {
    this.registerMarkdownCodeBlockProcessor("tasks", (source, el) => this.run(source, el));
  }

  async run(source, el) {
    el.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "tasks-lite-loading";
    loading.textContent = "Searching tasks…";
    el.appendChild(loading);

    const q = parseQuery(source);
    const files = this.app.vault.getMarkdownFiles();
    const contents = await Promise.all(files.map((f) => this.app.vault.read(f.path).catch(() => "")));
    let tasks = [];
    files.forEach((f, i) => {
      const name = (f.name || f.path).replace(/\.md$/i, "");
      tasks = tasks.concat(extractTasks(contents[i], f.path, name));
    });
    tasks = tasks.filter((t) => q.filters.every((fn) => fn(t)));
    if (q.sort === "due") tasks.sort((a, b) => (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99"));
    else if (q.sort === "description") tasks.sort((a, b) => a.text.localeCompare(b.text));
    if (q.limit != null) tasks = tasks.slice(0, q.limit);

    el.replaceChildren();
    if (tasks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tasks-lite-empty";
      empty.textContent = "No matching tasks.";
      el.appendChild(empty);
      return;
    }
    const ul = document.createElement("ul");
    ul.className = "tasks-lite";
    for (const t of tasks) {
      const li = document.createElement("li");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = t.done;
      box.disabled = true;
      li.appendChild(box);
      const span = document.createElement("span");
      span.className = "tasks-lite-text";
      span.textContent = " " + t.text + " ";
      li.appendChild(span);
      const a = document.createElement("a");
      a.className = "internal-link tasks-lite-src";
      a.textContent = t.name;
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.app.workspace.openLinkText(t.name);
      });
      li.appendChild(a);
      ul.appendChild(li);
    }
    el.appendChild(ul);
  }
};
