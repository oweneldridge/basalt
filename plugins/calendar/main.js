// Calendar — a month grid in the sidebar for daily notes. A day with a
// `YYYY-MM-DD` note gets a dot; clicking a day opens that note, or creates it
// (in the configured folder) if it doesn't exist yet. Today and the currently
// open daily note are highlighted. Prev/next month + Today navigation.
//
// Daily notes are detected by a `YYYY-MM-DD` in the filename (Obsidian's
// default). NOT full Obsidian-Calendar: no week notes, no per-day dot counts
// beyond presence, no custom filename formats, single daily-note folder.
const { Plugin, Notice, PluginSettingTab } = require("basalt");

const pad2 = (n) => String(n).padStart(2, "0");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---- pure date helpers (unit-tested) -------------------------------------
function dailyKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Parse a YYYY-MM-DD out of a filename; returns a Date only if it's a real
// calendar date (rejects 2026-13-40), else null.
function parseDailyDate(name) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(name));
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const da = +m[3];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const d = new Date(y, mo - 1, da);
  return d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === da ? d : null;
}

// A 6×7 matrix of days covering `month` (0-based), padded from adjacent months.
function monthMatrix(year, month, weekStartsOn) {
  const ws = weekStartsOn | 0;
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - ws + 7) % 7;
  const start = new Date(year, month, 1 - lead);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      days.push({ date: cur, inMonth: cur.getMonth() === month, key: dailyKey(cur) });
    }
    weeks.push(days);
  }
  return weeks;
}

function dailyNotePath(key, folder) {
  const f = String(folder || "").replace(/^\/+|\/+$/g, "");
  return (f ? f + "/" : "") + key + ".md";
}

function weekdayLabels(weekStartsOn) {
  const ws = weekStartsOn | 0;
  return Array.from({ length: 7 }, (_, i) => WD[(i + ws) % 7]);
}

module.exports = class Calendar extends Plugin {
  async onload() {
    this.settings = Object.assign({ folder: "", weekStart: 0 }, (await this.loadData()) || {});

    this.registerView("calendar", "Calendar", (container) => this.mountCalendar(container));
    this.addCommand({ id: "today", name: "Open today's daily note", callback: () => this.openDaily(dailyKey(new Date())) });

    const self = this;
    const tab = new PluginSettingTab(this.app, this);
    tab.display = function () {
      this.containerEl.replaceChildren();
      const folderRow = document.createElement("label");
      folderRow.className = "cal-setting";
      folderRow.textContent = "Daily notes folder";
      const folder = document.createElement("input");
      folder.type = "text";
      folder.value = self.settings.folder;
      folder.placeholder = "(vault root)";
      folder.addEventListener("change", async () => {
        self.settings.folder = folder.value.trim().replace(/^\/+|\/+$/g, "");
        await self.saveData(self.settings);
      });
      folderRow.appendChild(folder);
      this.containerEl.appendChild(folderRow);

      const wkRow = document.createElement("label");
      wkRow.className = "cal-setting";
      wkRow.textContent = "Start week on Monday";
      const wk = document.createElement("input");
      wk.type = "checkbox";
      wk.checked = self.settings.weekStart === 1;
      wk.addEventListener("change", async () => {
        self.settings.weekStart = wk.checked ? 1 : 0;
        await self.saveData(self.settings);
      });
      wkRow.appendChild(wk);
      this.containerEl.appendChild(wkRow);
    };
    this.addSettingTab(tab);
  }

  datedNoteKeys() {
    const keys = new Set();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const d = parseDailyDate(f.name || f.path);
      if (d) keys.add(dailyKey(d));
    }
    return keys;
  }

  async openDaily(key) {
    const has = this.datedNoteKeys().has(key);
    if (!has) {
      const path = dailyNotePath(key, this.settings.folder);
      try {
        await this.app.vault.create(path, `# ${key}\n`);
      } catch (e) {
        new Notice("Calendar: couldn't create " + path + " — " + (e && e.message ? e.message : e));
        return;
      }
    }
    this.app.workspace.openLinkText(key);
  }

  mountCalendar(container) {
    const today = new Date();
    const state = { year: today.getFullYear(), month: today.getMonth() };

    const render = () => {
      container.replaceChildren();
      const root = document.createElement("div");
      root.className = "calendar-view";

      const head = document.createElement("div");
      head.className = "cal-head";
      const prev = document.createElement("button");
      prev.className = "cal-nav";
      prev.textContent = "‹";
      prev.title = "Previous month";
      prev.addEventListener("click", () => {
        state.month--;
        if (state.month < 0) {
          state.month = 11;
          state.year--;
        }
        render();
      });
      const label = document.createElement("span");
      label.className = "cal-title";
      label.textContent = `${MONTHS[state.month]} ${state.year}`;
      const next = document.createElement("button");
      next.className = "cal-nav";
      next.textContent = "›";
      next.title = "Next month";
      next.addEventListener("click", () => {
        state.month++;
        if (state.month > 11) {
          state.month = 0;
          state.year++;
        }
        render();
      });
      const todayBtn = document.createElement("button");
      todayBtn.className = "cal-today-btn";
      todayBtn.textContent = "Today";
      todayBtn.addEventListener("click", () => {
        const n = new Date();
        state.year = n.getFullYear();
        state.month = n.getMonth();
        render();
      });
      head.append(prev, label, next, todayBtn);
      root.appendChild(head);

      const grid = document.createElement("div");
      grid.className = "cal-grid";
      for (const w of weekdayLabels(this.settings.weekStart)) {
        const wd = document.createElement("div");
        wd.className = "cal-weekday";
        wd.textContent = w;
        grid.appendChild(wd);
      }

      const keys = this.datedNoteKeys();
      const todayKey = dailyKey(new Date());
      const activeFile = this.app.workspace.getActiveFile();
      const activeDate = activeFile ? parseDailyDate(activeFile.path.split("/").pop() || activeFile.path) : null;
      const activeKey = activeDate ? dailyKey(activeDate) : null;

      for (const week of monthMatrix(state.year, state.month, this.settings.weekStart)) {
        for (const day of week) {
          const cell = document.createElement("div");
          let cls = "cal-day";
          if (!day.inMonth) cls += " is-outside";
          if (day.key === todayKey) cls += " is-today";
          if (day.key === activeKey) cls += " is-active";
          if (keys.has(day.key)) cls += " has-note";
          cell.className = cls;
          cell.setAttribute("data-date", day.key);
          const num = document.createElement("span");
          num.className = "cal-day-num";
          num.textContent = String(day.date.getDate());
          cell.appendChild(num);
          const dot = document.createElement("span");
          dot.className = "cal-dot";
          cell.appendChild(dot);
          cell.addEventListener("click", () => this.openDaily(day.key));
          grid.appendChild(cell);
        }
      }
      root.appendChild(grid);
      container.appendChild(root);
    };

    render();
    const refs = [
      this.app.vault.on("create", render),
      this.app.vault.on("delete", render),
      this.app.vault.on("rename", render),
      this.app.workspace.on("file-open", render),
    ];
    return () => refs.forEach((r) => r.off());
  }
};

// Pure helpers exposed for unit tests (harmless at runtime).
module.exports.dailyKey = dailyKey;
module.exports.parseDailyDate = parseDailyDate;
module.exports.monthMatrix = monthMatrix;
module.exports.dailyNotePath = dailyNotePath;
module.exports.weekdayLabels = weekdayLabels;
