// Dataview JS (lite) — runs `dataviewjs` blocks with a subset of Dataview's JS
// API. Provides a `dv` object (current/pages/page, chainable DataArray with
// where/sort/map/limit, and render helpers list/table/taskList/paragraph/
// header/span/el/fileLink) plus a minimal `moment`. NOT full Dataview: no
// grouping proxies, no calendar, no complex `dv.pages("a" or "b")` source
// algebra. Runs JavaScript from your notes — enable only in trusted vaults.
const { Plugin } = require("basalt");

// ---- DataArray: a chainable list of pages -------------------------------
class DataArray extends Array {
  where(fn) {
    return DataArray.from([...this].filter(fn));
  }
  filterBy(fn) {
    return this.where(fn);
  }
  sort(key, dir) {
    const k = typeof key === "function" ? key : (p) => p[key];
    const arr = [...this].sort((a, b) => {
      const x = k(a);
      const y = k(b);
      const r = x < y ? -1 : x > y ? 1 : 0;
      return dir === "desc" ? -r : r;
    });
    return DataArray.from(arr);
  }
  map(fn) {
    return DataArray.from([...this].map(fn));
  }
  limit(n) {
    return DataArray.from([...this].slice(0, n));
  }
  first() {
    return this[0];
  }
  array() {
    return [...this];
  }
}

// ---- minimal moment ------------------------------------------------------
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function toDate(input) {
  if (input == null) return new Date();
  if (input instanceof Date) return new Date(input.getTime());
  if (typeof input === "number") return new Date(input);
  const s = String(input);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return new Date(s);
}
function momentTime(o) {
  if (o && typeof o.valueOf === "function") return o.valueOf();
  return toDate(o).getTime();
}
function makeMoment(input) {
  const d = toDate(input);
  const valid = !Number.isNaN(d.getTime());
  const pad = (n) => String(n).padStart(2, "0");
  return {
    _isMoment: true,
    isValid: () => valid,
    valueOf: () => d.getTime(),
    toDate: () => d,
    isBefore: (o) => d.getTime() < momentTime(o),
    isAfter: (o) => d.getTime() > momentTime(o),
    isSame: (o) => d.getTime() === momentTime(o),
    isSameOrBefore: (o) => d.getTime() <= momentTime(o),
    isSameOrAfter: (o) => d.getTime() >= momentTime(o),
    diff: (o, unit) => {
      const ms = d.getTime() - momentTime(o);
      return unit === "days" ? Math.trunc(ms / 86400000) : ms;
    },
    format: (fmt) =>
      (fmt || "YYYY-MM-DD").replace(/YYYY|MMMM|MM|DD|dddd|HH|mm|ss/g, (t) => {
        if (t === "YYYY") return String(d.getFullYear());
        if (t === "MMMM") return MONTHS[d.getMonth()];
        if (t === "MM") return pad(d.getMonth() + 1);
        if (t === "DD") return pad(d.getDate());
        if (t === "dddd") return DAYS[d.getDay()];
        if (t === "HH") return pad(d.getHours());
        if (t === "mm") return pad(d.getMinutes());
        if (t === "ss") return pad(d.getSeconds());
        return t;
      }),
  };
}
const moment = (input) => makeMoment(input);

// ---- the dv object -------------------------------------------------------
function buildDv(app, el, notePath) {
  const pageFor = (f) => {
    const cache = app.metadataCache.getFileCache(f.path) || {};
    const name = (f.name || f.path).replace(/\.md$/i, "");
    const folder = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    const page = { file: { name, path: f.path, link: { path: f.path, display: name }, folder }, tags: cache.tags || [] };
    Object.assign(page, cache.frontmatter || {});
    return page;
  };
  const all = () => DataArray.from(app.vault.getMarkdownFiles().map(pageFor));
  const filterSource = (pages, source) => {
    if (!source) return pages;
    const s = String(source).trim();
    if (s.startsWith('"') || s.startsWith("'")) {
      const folder = s.replace(/^['"]|['"]$/g, "");
      return pages.where((p) => p.file.path === folder + ".md" || p.file.path.startsWith(folder + "/"));
    }
    if (s.startsWith("#")) {
      const tag = s.slice(1).replace(/^#/, "");
      return pages.where((p) => p.tags.some((t) => t.replace(/^#/, "") === tag || t.replace(/^#/, "").startsWith(tag + "/")));
    }
    return pages;
  };
  const openLink = (target) => app.workspace.openLinkText(target);
  const cell = (value) => {
    if (value && value.path !== undefined && value.display !== undefined) {
      const a = document.createElement("a");
      a.className = "internal-link";
      a.textContent = value.display;
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        openLink(value.display);
      });
      return a;
    }
    const span = document.createElement("span");
    span.textContent = value == null ? "" : Array.isArray(value) ? value.join(", ") : String(value);
    return span;
  };

  return {
    current: () => all().where((p) => p.file.path === notePath).first() || pageFor({ path: notePath, name: (notePath.split("/").pop() || notePath).replace(/\.md$/i, "") }),
    pages: (source) => filterSource(all(), source),
    page: (path) => all().where((p) => p.file.path === path || p.file.name === path).first(),
    array: (x) => DataArray.from(x),
    paragraph: (md) => {
      const p = document.createElement("p");
      p.className = "dvjs-p";
      p.appendChild(cell(md));
      el.appendChild(p);
    },
    header: (level, text) => {
      const h = document.createElement("h" + Math.min(6, Math.max(1, level | 0)));
      h.textContent = String(text);
      el.appendChild(h);
    },
    span: (text) => {
      const s = cell(text);
      el.appendChild(s);
      return s;
    },
    el: (tag, text) => {
      const e = document.createElement(tag);
      e.appendChild(cell(text));
      el.appendChild(e);
      return e;
    },
    fileLink: (path, _embed, display) => ({ path, display: display || (path.split("/").pop() || path).replace(/\.md$/i, "") }),
    list: (items) => {
      const ul = document.createElement("ul");
      ul.className = "dvjs-list";
      for (const it of items || []) {
        const li = document.createElement("li");
        li.appendChild(cell(it));
        ul.appendChild(li);
      }
      el.appendChild(ul);
    },
    taskList: (tasks) => {
      const ul = document.createElement("ul");
      ul.className = "dvjs-tasks";
      for (const t of tasks || []) {
        const li = document.createElement("li");
        li.appendChild(cell(t && t.text !== undefined ? t.text : t));
        ul.appendChild(li);
      }
      el.appendChild(ul);
    },
    table: (headers, rows) => {
      const table = document.createElement("table");
      table.className = "dvjs-table";
      const thead = document.createElement("thead");
      const htr = document.createElement("tr");
      for (const h of headers || []) {
        const th = document.createElement("th");
        th.textContent = String(h);
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const row of rows || []) {
        const tr = document.createElement("tr");
        for (const c of row || []) {
          const td = document.createElement("td");
          td.appendChild(cell(c));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      el.appendChild(table);
    },
  };
}

module.exports = class DataviewJs extends Plugin {
  onload() {
    this.registerMarkdownCodeBlockProcessor("dataviewjs", (source, el, ctx) => {
      el.replaceChildren();
      const dv = buildDv(this.app, el, ctx.notePath);
      try {
        // The block's JS runs with `dv` and `moment` in scope (like Dataview).
        const fn = new Function("dv", "moment", `"use strict";\n${source}`);
        const result = fn(dv, moment);
        if (result && typeof result.catch === "function") {
          result.catch((e) => this.error(el, e));
        }
      } catch (e) {
        this.error(el, e);
      }
    });
  }
  error(el, e) {
    const div = document.createElement("div");
    div.className = "dvjs-error";
    div.textContent = "dataviewjs error: " + (e && e.message ? e.message : String(e));
    el.appendChild(div);
  }
};
