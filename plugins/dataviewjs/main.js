// Dataview JS (lite) — runs `dataviewjs` blocks with a practical subset of
// Dataview's JS API. Provides a `dv` object (current/pages/page, a chainable
// DataArray with where/sort/map/limit/groupBy, render helpers list/table/
// taskList/paragraph/header/span/el/fileLink) plus:
//   • dv.luxon.DateTime + dv.date()/dv.duration()  — a bundled minimal Luxon
//   • page.file.cday/ctime/mday/mtime/day          — DateTime file dates
//   • page.file.tasks                              — parsed checkbox tasks
//   • a legacy `moment` shim (many older blocks still use it)
// Before the block runs it pre-loads every note once (like Dataview's index)
// so dv.pages()/file.tasks are SYNCHRONOUS inside your code. NOT full Dataview:
// no query-language blocks, no inline `dv.el` reactivity, no calendar view,
// limited `dv.pages("a" or "b")` source algebra. Runs JavaScript from your
// notes — enable only in trusted vaults.
const { Plugin } = require("basalt");

// ---- minimal Luxon DateTime ---------------------------------------------
// Backed by a native Date in local time. Covers the surface real dataviewjs
// blocks lean on: fromISO/fromMillis/now, plus/minus/diff, toFormat/toISODate,
// the year/month/day/weekday getters, startOf/endOf, hasSame, comparisons.
const L_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const L_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]; // luxon weekday 1..7 = Mon..Sun
const pad2 = (n) => String(Math.abs(n)).padStart(2, "0");

function parseISOish(s) {
  const str = String(s).trim();
  const m = /^(-?\d{4,})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?/.exec(str);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), +((m[7] || "0") + "00").slice(0, 3));
  }
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : new Date(t);
}

class DateTime {
  constructor(date, valid) {
    this._d = date instanceof Date ? date : new Date(NaN);
    this.isValid = valid !== false && !Number.isNaN(this._d.getTime());
  }
  static now() {
    return new DateTime(new Date());
  }
  static local(...a) {
    if (!a.length) return DateTime.now();
    const [y, mo, d, h, mi, s, ms] = a;
    return new DateTime(new Date(y, (mo || 1) - 1, d || 1, h || 0, mi || 0, s || 0, ms || 0));
  }
  static fromMillis(ms) {
    return new DateTime(new Date(ms), Number.isFinite(ms));
  }
  static fromJSDate(d) {
    return new DateTime(new Date(d.getTime()));
  }
  static fromISO(s) {
    const d = parseISOish(s);
    return new DateTime(d || new Date(NaN), !!d);
  }
  static fromObject(o) {
    o = o || {};
    return new DateTime(new Date(o.year || 1970, (o.month || 1) - 1, o.day || 1, o.hour || 0, o.minute || 0, o.second || 0, o.millisecond || 0));
  }
  static invalid() {
    return new DateTime(new Date(NaN), false);
  }

  get year() {
    return this._d.getFullYear();
  }
  get month() {
    return this._d.getMonth() + 1;
  }
  get day() {
    return this._d.getDate();
  }
  get hour() {
    return this._d.getHours();
  }
  get minute() {
    return this._d.getMinutes();
  }
  get second() {
    return this._d.getSeconds();
  }
  get millisecond() {
    return this._d.getMilliseconds();
  }
  get weekday() {
    const wd = this._d.getDay();
    return wd === 0 ? 7 : wd; // luxon: Mon=1..Sun=7
  }
  get monthLong() {
    return L_MONTHS[this._d.getMonth()];
  }
  get monthShort() {
    return L_MONTHS[this._d.getMonth()].slice(0, 3);
  }
  get weekdayLong() {
    return L_DAYS[this.weekday - 1];
  }
  get weekdayShort() {
    return L_DAYS[this.weekday - 1].slice(0, 3);
  }
  get ts() {
    return this._d.getTime();
  }

  _shift(obj, sign) {
    const d = new Date(this._d.getTime());
    const o = obj || {};
    const yr = (o.years || o.year || 0) * sign;
    const mo = (o.months || o.month || 0) * sign;
    if (yr) d.setFullYear(d.getFullYear() + yr);
    if (mo) d.setMonth(d.getMonth() + mo);
    const days = (o.days || o.day || 0) + (o.weeks || o.week || 0) * 7;
    let ms = 0;
    ms += (o.hours || o.hour || 0) * 3600000;
    ms += (o.minutes || o.minute || 0) * 60000;
    ms += (o.seconds || o.second || 0) * 1000;
    ms += o.milliseconds || o.millisecond || 0;
    d.setTime(d.getTime() + sign * (days * 86400000 + ms));
    return new DateTime(d, this.isValid);
  }
  plus(obj) {
    return this._shift(obj, 1);
  }
  minus(obj) {
    return this._shift(obj, -1);
  }
  set(obj) {
    const o = obj || {};
    return new DateTime(
      new Date(
        o.year != null ? o.year : this.year,
        (o.month != null ? o.month : this.month) - 1,
        o.day != null ? o.day : this.day,
        o.hour != null ? o.hour : this.hour,
        o.minute != null ? o.minute : this.minute,
        o.second != null ? o.second : this.second,
        o.millisecond != null ? o.millisecond : this.millisecond,
      ),
      this.isValid,
    );
  }
  startOf(unit) {
    const d = new Date(this._d.getTime());
    switch (unit) {
      case "year":
        d.setMonth(0);
      // falls through
      case "month":
        d.setDate(1);
      // falls through
      case "day":
        d.setHours(0, 0, 0, 0);
        break;
      case "week": {
        d.setHours(0, 0, 0, 0);
        const back = (d.getDay() === 0 ? 7 : d.getDay()) - 1; // to Monday
        d.setDate(d.getDate() - back);
        break;
      }
      case "hour":
        d.setMinutes(0, 0, 0);
        break;
      case "minute":
        d.setSeconds(0, 0);
        break;
    }
    return new DateTime(d, this.isValid);
  }
  endOf(unit) {
    return this.startOf(unit)
      .plus(unit === "week" ? { weeks: 1 } : { [unit + "s"]: 1 })
      .minus({ milliseconds: 1 });
  }
  diff(other, unit) {
    const ms = this._d.getTime() - (other instanceof DateTime ? other._d.getTime() : new Date(other).getTime());
    const per = {
      milliseconds: 1,
      seconds: 1000,
      minutes: 60000,
      hours: 3600000,
      days: 86400000,
      weeks: 604800000,
      months: 2629800000,
      years: 31557600000,
    };
    const units = Array.isArray(unit) ? unit : [unit || "milliseconds"];
    const dur = { milliseconds: ms, as: (u) => ms / (per[u] || 1), toMillis: () => ms, valueOf: () => ms };
    for (const u of units) dur[u] = ms / (per[u] || 1);
    return dur;
  }
  hasSame(other, unit) {
    if (!(other instanceof DateTime)) other = new DateTime(new Date(other));
    if (unit === "year") return this.year === other.year;
    if (unit === "month") return this.year === other.year && this.month === other.month;
    if (unit === "day") return this.startOf("day").ts === other.startOf("day").ts;
    return this.ts === other.ts;
  }
  equals(other) {
    return other instanceof DateTime && this.ts === other.ts;
  }
  toFormat(fmt) {
    if (!this.isValid) return "Invalid DateTime";
    const d = this._d;
    const h12 = d.getHours() % 12 || 12;
    const map = {
      yyyy: String(d.getFullYear()).padStart(4, "0"),
      yy: String(d.getFullYear()).slice(-2),
      LLLL: this.monthLong,
      LLL: this.monthShort,
      LL: pad2(this.month),
      MMMM: this.monthLong,
      MMM: this.monthShort,
      MM: pad2(this.month),
      dd: pad2(this.day),
      cccc: this.weekdayLong,
      ccc: this.weekdayShort,
      EEEE: this.weekdayLong,
      EEE: this.weekdayShort,
      HH: pad2(d.getHours()),
      hh: pad2(h12),
      mm: pad2(d.getMinutes()),
      ss: pad2(d.getSeconds()),
      a: d.getHours() < 12 ? "AM" : "PM",
      // single-letter fall-backs (checked last)
      y: String(d.getFullYear()),
      L: String(this.month),
      M: String(this.month),
      d: String(this.day),
      c: String(this.weekday),
      H: String(d.getHours()),
      h: String(h12),
      m: String(d.getMinutes()),
      s: String(d.getSeconds()),
    };
    // Longest tokens first; quoted literals ('lit') pass through verbatim.
    return fmt.replace(/'[^']*'|yyyy|yy|LLLL|LLL|LL|MMMM|MMM|MM|dd|cccc|ccc|EEEE|EEE|HH|hh|mm|ss|[yLMdcHhmsa]/g, (t) =>
      t[0] === "'" ? t.slice(1, -1) : map[t],
    );
  }
  toISODate() {
    if (!this.isValid) return null;
    return `${String(this.year).padStart(4, "0")}-${pad2(this.month)}-${pad2(this.day)}`;
  }
  toISO() {
    if (!this.isValid) return null;
    return `${this.toISODate()}T${pad2(this.hour)}:${pad2(this.minute)}:${pad2(this.second)}`;
  }
  toJSDate() {
    return new Date(this._d.getTime());
  }
  toMillis() {
    return this._d.getTime();
  }
  valueOf() {
    return this._d.getTime();
  }
  toString() {
    return this.isValid ? this.toISO() : "Invalid DateTime";
  }
}

// A tiny Duration parser for dv.duration("3 days") etc.
function parseDuration(str) {
  const per = { second: 1000, seconds: 1000, minute: 60000, minutes: 60000, hour: 3600000, hours: 3600000, day: 86400000, days: 86400000, week: 604800000, weeks: 604800000, month: 2629800000, months: 2629800000, year: 31557600000, years: 31557600000 };
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)/gi;
  let m;
  while ((m = re.exec(String(str)))) ms += parseFloat(m[1]) * (per[m[2].toLowerCase()] || 0);
  return { milliseconds: ms, as: (u) => ms / (per[u] || 1), toMillis: () => ms, valueOf: () => ms };
}

const luxon = { DateTime, Duration: { fromObject: (o) => parseDuration(JSON.stringify(o)) } };

// ---- legacy moment shim (kept for older blocks) --------------------------
const M_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function momentTime(o) {
  if (o && typeof o.valueOf === "function") return o.valueOf();
  const d = parseISOish(o);
  return d ? d.getTime() : new Date(o).getTime();
}
function makeMoment(input) {
  const d = input == null ? new Date() : parseISOish(input) || new Date(input);
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
        if (t === "MMMM") return L_MONTHS[d.getMonth()];
        if (t === "MM") return pad(d.getMonth() + 1);
        if (t === "DD") return pad(d.getDate());
        if (t === "dddd") return M_DAYS[d.getDay()];
        if (t === "HH") return pad(d.getHours());
        if (t === "mm") return pad(d.getMinutes());
        if (t === "ss") return pad(d.getSeconds());
        return t;
      }),
  };
}
const moment = (input) => makeMoment(input);

// ---- DataArray: a chainable list of pages/values -------------------------
class DataArray extends Array {
  where(fn) {
    return DataArray.from([...this].filter(fn));
  }
  filter(fn) {
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
      const xv = x instanceof DateTime ? x.valueOf() : x;
      const yv = y instanceof DateTime ? y.valueOf() : y;
      const r = xv < yv ? -1 : xv > yv ? 1 : 0;
      return dir === "desc" ? -r : r;
    });
    return DataArray.from(arr);
  }
  map(fn) {
    return DataArray.from([...this].map(fn));
  }
  flatMap(fn) {
    return DataArray.from([...this].flatMap(fn));
  }
  limit(n) {
    return DataArray.from([...this].slice(0, n));
  }
  groupBy(key) {
    const k = typeof key === "function" ? key : (p) => p[key];
    const groups = new Map();
    for (const p of this) {
      const g = k(p);
      const gk = g instanceof DateTime ? g.toISODate() : String(g);
      if (!groups.has(gk)) groups.set(gk, { key: g, rows: [] });
      groups.get(gk).rows.push(p);
    }
    return DataArray.from([...groups.values()].map((g) => ({ key: g.key, rows: DataArray.from(g.rows) })));
  }
  first() {
    return this[0];
  }
  last() {
    return this[this.length - 1];
  }
  array() {
    return [...this];
  }
}

// ---- task + inline-field parsing ----------------------------------------
const TASK_RE = /^(\s*)[-*+] \[([ xX/\-])\]\s+(.*)$/;
const DUE_RE = /(?:📅|\[due::\s*)\s*(\d{4}-\d{2}-\d{2})/;
const INLINE_FIELD_RE = /(?:^|\[)([A-Za-z][\w -]*)::\s*([^\]\n]+?)\s*\]?$/;

function parseTasks(content, path) {
  const out = [];
  content.split("\n").forEach((line, i) => {
    const m = TASK_RE.exec(line);
    if (!m) return;
    const text = m[3].trim();
    const dueM = DUE_RE.exec(text);
    out.push({
      text,
      status: m[2],
      completed: /[xX]/.test(m[2]),
      fullyCompleted: /[xX]/.test(m[2]),
      checked: m[2] !== " ",
      due: dueM ? DateTime.fromISO(dueM[1]) : null,
      tags: (text.match(/#[\w/-]+/g) || []).map((t) => t.slice(1)),
      line: i,
      path,
      subtasks: [],
    });
  });
  return out;
}

function parseInlineFields(content) {
  const fields = {};
  for (const line of content.split("\n")) {
    const m = INLINE_FIELD_RE.exec(line.trim());
    if (m) {
      const key = m[1].trim();
      if (!(key in fields)) fields[key] = m[2].trim();
    }
  }
  return fields;
}

// A DateTime for `file.day`: an explicit date/day frontmatter field, else a
// YYYY-MM-DD implied by the filename (Dataview's rule).
function fileDay(name, frontmatter) {
  const fm = frontmatter || {};
  const explicit = fm.day ?? fm.date;
  if (explicit != null) {
    const dt = DateTime.fromISO(explicit);
    if (dt.isValid) return dt;
  }
  const m = /(\d{4}-\d{2}-\d{2})/.exec(name);
  return m ? DateTime.fromISO(m[1]) : null;
}

// ---- page index (built once per render, briefly cached) -----------------
let _cache = null; // { at, pages, byPath }
async function buildIndex(app) {
  const files = app.vault.getMarkdownFiles();
  const now = typeof Date !== "undefined" && Date.now ? Date.now() : 0;
  if (_cache && now - _cache.at < 1000) return _cache;

  const contents = await Promise.all(files.map((f) => app.vault.read(f.path).catch(() => "")));
  const byPath = new Map();
  const pages = DataArray.from(
    files.map((f, i) => {
      const content = contents[i];
      const cache = app.metadataCache.getFileCache(f.path) || {};
      const fm = cache.frontmatter || {};
      const name = (f.name || f.path).replace(/\.md$/i, "");
      const folder = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      const ctime = f.ctime || 0;
      const mtime = f.mtime || 0;
      const page = {
        file: {
          name,
          path: f.path,
          folder,
          link: { path: f.path, display: name },
          ctime: DateTime.fromMillis(ctime),
          mtime: DateTime.fromMillis(mtime),
          cday: DateTime.fromMillis(ctime).startOf("day"),
          mday: DateTime.fromMillis(mtime).startOf("day"),
          day: fileDay(name, fm),
          size: content.length,
          tasks: DataArray.from(parseTasks(content, f.path)),
          tags: (cache.tags || []).map((t) => (t[0] === "#" ? t : "#" + t)),
          etags: cache.tags || [],
          outlinks: cache.links || [],
        },
        tags: (cache.tags || []).map((t) => (t[0] === "#" ? t : "#" + t)),
      };
      Object.assign(page, parseInlineFields(content));
      Object.assign(page, fm); // frontmatter wins over inline fields
      byPath.set(f.path, page);
      byPath.set(name, page);
      return page;
    }),
  );
  _cache = { at: now, pages, byPath };
  return _cache;
}

// ---- the dv object -------------------------------------------------------
function buildDv(idx, el, notePath) {
  const { pages, byPath } = idx;
  const filterSource = (list, source) => {
    if (!source) return list;
    const s = String(source).trim();
    if (s.startsWith('"') || s.startsWith("'")) {
      const folder = s.replace(/^['"]|['"]$/g, "");
      return list.where((p) => p.file.path === folder + ".md" || p.file.path.startsWith(folder + "/"));
    }
    if (s.startsWith("#")) {
      const tag = s.slice(1).replace(/^#/, "");
      return list.where((p) => p.file.tags.some((t) => t.replace(/^#/, "") === tag || t.replace(/^#/, "").startsWith(tag + "/")));
    }
    return list;
  };
  const openLink = (target) => idx.openLinkText(target);
  const cellValue = (value) => {
    if (value instanceof DateTime) return value.toISODate() || "";
    if (value == null) return "";
    return Array.isArray(value) ? value.join(", ") : String(value);
  };
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
    span.textContent = cellValue(value);
    return span;
  };

  return {
    luxon,
    current: () =>
      byPath.get(notePath) ||
      pages.where((p) => p.file.path === notePath).first() || {
        file: { name: (notePath.split("/").pop() || notePath).replace(/\.md$/i, ""), path: notePath, tasks: DataArray.from([]) },
      },
    pages: (source) => filterSource(pages, source),
    pagePaths: (source) => filterSource(pages, source).map((p) => p.file.path),
    page: (path) => byPath.get(path) || byPath.get(String(path).replace(/\.md$/i, "")),
    array: (x) => DataArray.from(x),
    date: (x) => (x == null ? DateTime.now() : x instanceof DateTime ? x : DateTime.fromISO(x)),
    duration: (x) => parseDuration(x),
    fileLink: (path, _embed, display) => ({ path, display: display || (path.split("/").pop() || path).replace(/\.md$/i, "") }),
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
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !!(t && (t.completed || t.checked));
        box.disabled = true;
        li.appendChild(box);
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
      const loading = document.createElement("div");
      loading.className = "dvjs-loading";
      loading.textContent = "Running dataviewjs…";
      el.appendChild(loading);

      buildIndex(this.app)
        .then((idx) => {
          idx.openLinkText = (t) => this.app.workspace.openLinkText(t);
          el.replaceChildren();
          const dv = buildDv(idx, el, ctx.notePath);
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
        })
        .catch((e) => this.error(el, e));
    });
  }
  error(el, e) {
    el.replaceChildren();
    const div = document.createElement("div");
    div.className = "dvjs-error";
    div.textContent = "dataviewjs error: " + (e && e.message ? e.message : String(e));
    el.appendChild(div);
  }
};
