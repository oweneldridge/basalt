// Templater Lite — insert templates written in Templater syntax. A pragmatic
// subset of the Templater plugin, built on Basalt's own plugin API.
//
// Supported in a template:
//   <% tp.file.title %>            interpolation (auto-awaited, method chaining)
//   <%* for (…) { tR += … } %>     JS execution blocks (build output via tR)
//   <%_ … _%> / <%- … -%>          whitespace trimming
//   <%# a comment %>               comments (produce nothing)
//   tp.file.cursor()               marks where the caret lands after insertion
// tp namespaces: file (title/folder/path/creation_date/last_modified_date/
// cursor/selection), date (now/tomorrow/yesterday/weekday), system (prompt/
// suggester/clipboard), plus tp.frontmatter and tp.config.
//
// NOT full Templater: no tp.user user-script files, no tp.hooks, no dynamic
// commands, single cursor (no tabstops), no template-on-creation automation.
// Runs JavaScript from your templates — enable only in trusted vaults.
const { Plugin, Notice, PluginSettingTab } = require("basalt");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CURSOR = "@@TP_CURSOR@@"; // sentinel; stripped, its position becomes the caret
const CANCELLED = Symbol("cancelled");

// ---- date formatting (moment-token subset) -------------------------------
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n) => String(n).padStart(2, "0");
const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");

function parseDateish(input, _fmt) {
  if (input == null) return new Date();
  if (input instanceof Date) return new Date(input.getTime());
  const s = String(input);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const t = Date.parse(s);
  return Number.isNaN(t) ? new Date(NaN) : new Date(t);
}

function formatMoment(d, fmt) {
  if (Number.isNaN(d.getTime())) return "Invalid date";
  const h12 = d.getHours() % 12 || 12;
  const map = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MMMM: MONTHS[d.getMonth()],
    MMM: MONTHS[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    Do: ordinal(d.getDate()),
    DD: pad(d.getDate()),
    D: String(d.getDate()),
    dddd: WDAYS[d.getDay()],
    ddd: WDAYS[d.getDay()].slice(0, 3),
    dd: WDAYS[d.getDay()].slice(0, 2),
    HH: pad(d.getHours()),
    H: String(d.getHours()),
    hh: pad(h12),
    h: String(h12),
    mm: pad(d.getMinutes()),
    m: String(d.getMinutes()),
    ss: pad(d.getSeconds()),
    s: String(d.getSeconds()),
    a: d.getHours() < 12 ? "am" : "pm",
    A: d.getHours() < 12 ? "AM" : "PM",
  };
  return String(fmt || "YYYY-MM-DD").replace(
    /\[[^\]]*\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|dd|HH|H|hh|h|mm|m|ss|s|a|A/g,
    (t) => (t[0] === "[" ? t.slice(1, -1) : map[t]),
  );
}

// ---- template compiler ----------------------------------------------------
// Turn a template into an async function `(tp, __s) => Promise<string>` that
// accumulates into `tR`. Interpolations are auto-awaited and null-coerced so
// `<% tp.system.prompt(...) %>` works without the author writing `await`.
function compileTemplate(text) {
  const TAG = /<%([\s\S]*?)%>/g;
  const ops = [];
  let last = 0;
  let m;
  while ((m = TAG.exec(text))) {
    let lit = text.slice(last, m.index);
    last = m.index + m[0].length;
    let inner = m[1];
    let exec = false;
    if (inner[0] === "*") {
      exec = true;
      inner = inner.slice(1);
    }
    let leadTrim = false;
    if (inner[0] === "-" || inner[0] === "_") {
      leadTrim = true;
      inner = inner.slice(1);
    }
    let tailTrim = false;
    const lc = inner[inner.length - 1];
    if (lc === "-" || lc === "_") {
      tailTrim = true;
      inner = inner.slice(0, -1);
    }
    if (leadTrim) lit = lit.replace(/\s+$/, "");
    ops.push({ t: "lit", v: lit });
    const code = inner.trim();
    if (exec) ops.push({ t: "exec", v: code, tailTrim });
    else if (code[0] === "#" || code === "") ops.push({ t: "noop", tailTrim }); // comment / empty
    else ops.push({ t: "interp", v: code, tailTrim });
  }
  ops.push({ t: "lit", v: text.slice(last) });

  // Apply trailing-trim to the literal that follows a trimmed tag.
  for (let i = 0; i < ops.length - 1; i++) {
    if (ops[i].tailTrim && ops[i + 1].t === "lit") ops[i + 1].v = ops[i + 1].v.replace(/^\s+/, "");
  }

  let body = 'let tR = "";\n';
  for (const op of ops) {
    if (op.t === "lit") {
      if (op.v) body += `tR += ${JSON.stringify(op.v)};\n`;
    } else if (op.t === "interp") {
      body += `tR += __s(await ( ${op.v} ));\n`;
    } else if (op.t === "exec") {
      body += `${op.v}\n`;
    }
  }
  body += "return tR;";
  return new AsyncFunction("tp", "__s", body);
}

const coerce = (v) => (v == null ? "" : String(v));

async function processTemplate(text, tp) {
  const fn = compileTemplate(text);
  const out = await fn(tp, coerce);
  const idx = out.indexOf(CURSOR);
  return { text: out.split(CURSOR).join(""), caret: idx === -1 ? undefined : idx };
}

// ---- the tp object --------------------------------------------------------
// `io` supplies prompt/suggester (interactive in a command, defaults in a
// passive preview) so the engine stays UI-agnostic and testable.
function buildTp(fileInfo, frontmatter, io) {
  const dateNow = (fmt, offset, reference, referenceFormat) => {
    const base = reference != null ? parseDateish(reference, referenceFormat) : new Date();
    if (offset) {
      const days = typeof offset === "number" ? offset : parseInt(String(offset).replace(/[^\d-]/g, ""), 10) || 0;
      base.setDate(base.getDate() + days);
    }
    return formatMoment(base, fmt);
  };
  return {
    file: {
      get title() {
        return fileInfo.title;
      },
      folder: (absolute) => (absolute ? fileInfo.folder : fileInfo.folder.split("/").pop() || ""),
      path: (relative) => (relative ? fileInfo.path : fileInfo.absPath || fileInfo.path),
      creation_date: (fmt) => formatMoment(new Date(fileInfo.ctime || Date.now()), fmt || "YYYY-MM-DD HH:mm"),
      last_modified_date: (fmt) => formatMoment(new Date(fileInfo.mtime || Date.now()), fmt || "YYYY-MM-DD HH:mm"),
      cursor: () => CURSOR,
      selection: () => (io.selection ? io.selection() : ""),
    },
    date: {
      now: dateNow,
      tomorrow: (fmt) => dateNow(fmt, 1),
      yesterday: (fmt) => dateNow(fmt, -1),
      weekday: (fmt, weekday, reference, referenceFormat) => {
        const base = reference != null ? parseDateish(reference, referenceFormat) : new Date();
        base.setDate(base.getDate() + ((weekday | 0) - base.getDay()));
        return formatMoment(base, fmt);
      },
    },
    system: {
      prompt: async (message, defaultValue, throwOnCancel, multiline) => {
        const v = await io.prompt(String(message ?? ""), defaultValue == null ? "" : String(defaultValue), !!multiline);
        if (v === CANCELLED) {
          if (throwOnCancel) throw new Error("Templater prompt cancelled");
          return null;
        }
        return v;
      },
      suggester: async (textItems, items, throwOnCancel, placeholder) => {
        const values = Array.from(items || []);
        const labels = typeof textItems === "function" ? values.map((v, i) => String(textItems(v, i))) : Array.from(textItems || []).map(String);
        const v = await io.suggester(labels, values, String(placeholder || ""));
        if (v === CANCELLED) {
          if (throwOnCancel) throw new Error("Templater suggester cancelled");
          return null;
        }
        return v;
      },
      clipboard: async () => {
        try {
          return navigator && navigator.clipboard ? await navigator.clipboard.readText() : "";
        } catch {
          return "";
        }
      },
    },
    frontmatter: frontmatter || {},
    config: { active_file: { path: fileInfo.path }, target_file: { path: fileInfo.path }, template_file: fileInfo.templatePath ? { path: fileInfo.templatePath } : null, run_mode: 0 },
    // tp.user scripts require loading arbitrary JS files — unsupported in lite.
    user: new Proxy(
      {},
      {
        get: () => () => {
          io.notice && io.notice("tp.user.* scripts aren't supported in Templater Lite");
          return "";
        },
      },
    ),
  };
}

// ---- interactive modals (command mode) -----------------------------------
function promptModal(message, defaultValue, multiline) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "tp-modal-overlay";
    const box = document.createElement("div");
    box.className = "tp-modal";
    const label = document.createElement("div");
    label.className = "tp-modal-title";
    label.textContent = message || "Enter a value";
    const input = document.createElement(multiline ? "textarea" : "input");
    input.className = "tp-modal-input";
    input.value = defaultValue || "";
    const row = document.createElement("div");
    row.className = "tp-modal-buttons";
    const ok = document.createElement("button");
    ok.textContent = "OK";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    row.append(cancel, ok);
    box.append(label, input, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const done = (v) => {
      overlay.remove();
      resolve(v);
    };
    ok.addEventListener("click", () => done(input.value));
    cancel.addEventListener("click", () => done(CANCELLED));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !(multiline && e.shiftKey)) {
        e.preventDefault();
        done(input.value);
      } else if (e.key === "Escape") {
        done(CANCELLED);
      }
    });
    setTimeout(() => input.focus(), 0);
  });
}

function suggesterModal(labels, values, placeholder) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "tp-modal-overlay";
    const box = document.createElement("div");
    box.className = "tp-modal tp-suggester";
    const input = document.createElement("input");
    input.className = "tp-modal-input";
    input.placeholder = placeholder || "Type to filter…";
    const list = document.createElement("ul");
    list.className = "tp-suggester-list";
    box.append(input, list);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    let active = 0;
    let filtered = labels.map((l, i) => ({ l, i }));
    const done = (v) => {
      overlay.remove();
      resolve(v);
    };
    const render = () => {
      list.replaceChildren();
      filtered.forEach((f, row) => {
        const li = document.createElement("li");
        li.className = "tp-suggester-item" + (row === active ? " is-active" : "");
        li.textContent = f.l;
        li.addEventListener("click", () => done(values[f.i]));
        list.appendChild(li);
      });
    };
    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      filtered = labels.map((l, i) => ({ l, i })).filter((f) => f.l.toLowerCase().includes(q));
      active = 0;
      render();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        active = Math.min(active + 1, filtered.length - 1);
        render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        active = Math.max(active - 1, 0);
        render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[active]) done(values[filtered[active].i]);
      } else if (e.key === "Escape") {
        done(CANCELLED);
      }
    });
    render();
    setTimeout(() => input.focus(), 0);
  });
}

module.exports = class TemplaterLite extends Plugin {
  async onload() {
    this.settings = Object.assign({ folder: "Templates" }, (await this.loadData()) || {});

    this.addCommand({ id: "insert", name: "Insert template", callback: () => this.insertTemplate() });

    // A `templater` code block previews a template's static output inline.
    // Interactive tags fall back to their defaults (no prompt/suggester UI).
    this.registerMarkdownCodeBlockProcessor("templater", (source, el, ctx) => {
      el.replaceChildren();
      const fileInfo = this.fileInfoFor(ctx.notePath);
      const io = {
        prompt: async (_m, def) => def,
        suggester: async (_labels, values) => (values.length ? values[0] : ""),
        notice: () => {},
      };
      processTemplate(source, buildTp(fileInfo, fileInfo.frontmatter, io))
        .then((res) => {
          el.replaceChildren();
          const pre = document.createElement("div");
          pre.className = "templater-preview";
          pre.style.whiteSpace = "pre-wrap";
          pre.textContent = res.text;
          el.appendChild(pre);
        })
        .catch((e) => this.renderError(el, e));
    });

    const self = this;
    const tab = new PluginSettingTab(this.app, this);
    tab.display = function () {
      this.containerEl.replaceChildren();
      const label = document.createElement("label");
      label.className = "tp-setting";
      label.textContent = "Templates folder";
      const input = document.createElement("input");
      input.type = "text";
      input.value = self.settings.folder;
      input.addEventListener("change", async () => {
        self.settings.folder = input.value.trim().replace(/^\/+|\/+$/g, "");
        await self.saveData(self.settings);
      });
      label.appendChild(input);
      this.containerEl.appendChild(label);
    };
    this.addSettingTab(tab);
  }

  fileInfoFor(path, templatePath) {
    const rel = path || "";
    const meta = this.app.vault.getMarkdownFiles().find((f) => f.path === rel);
    const cache = this.app.metadataCache.getFileCache(rel) || {};
    return {
      title: (rel.split("/").pop() || rel).replace(/\.md$/i, ""),
      folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
      path: rel,
      ctime: meta && meta.ctime,
      mtime: meta && meta.mtime,
      frontmatter: cache.frontmatter || {},
      templatePath,
    };
  }

  templateFiles() {
    const prefix = this.settings.folder ? this.settings.folder.replace(/\/+$/, "") + "/" : "";
    return this.app.vault.getMarkdownFiles().filter((f) => (prefix ? f.path.startsWith(prefix) : true));
  }

  async insertTemplate() {
    const active = this.app.workspace.getActiveFile();
    const target = this.app.workspace.activeEditor;
    if (!active || !target) {
      new Notice("Open a note to insert a template into.");
      return;
    }
    const templates = this.templateFiles();
    if (templates.length === 0) {
      new Notice(`No templates found in "${this.settings.folder}". Set the folder in Settings → Plugins.`);
      return;
    }
    // One template → use it; several → pick.
    let chosen = templates[0];
    if (templates.length > 1) {
      const labels = templates.map((f) => (f.name || f.path).replace(/\.md$/i, ""));
      chosen = await suggesterModal(labels, templates, "Choose a template");
      if (chosen === CANCELLED || !chosen) return;
    }
    let content;
    try {
      content = await this.app.vault.read(chosen.path);
    } catch (e) {
      new Notice(`Couldn't read template: ${e && e.message ? e.message : e}`);
      return;
    }
    const io = {
      prompt: (m, def, multiline) => promptModal(m, def, multiline),
      suggester: (labels, values, ph) => suggesterModal(labels, values, ph),
      notice: (msg) => new Notice(msg),
    };
    const fileInfo = this.fileInfoFor(active.path, chosen.path);
    try {
      const res = await processTemplate(content, buildTp(fileInfo, fileInfo.frontmatter, io));
      target.editor.insertAtCursor(res.text, res.caret);
    } catch (e) {
      new Notice(`Templater error: ${e && e.message ? e.message : e}`);
    }
  }

  renderError(el, e) {
    el.replaceChildren();
    const div = document.createElement("div");
    div.className = "templater-error";
    div.textContent = "Templater error: " + (e && e.message ? e.message : String(e));
    el.appendChild(div);
  }
};
