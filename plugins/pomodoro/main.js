// Pomodoro Timer — a first-party Basalt plugin. Demonstrates the plugin API:
// addStatusBarItem, registerInterval, addCommand, addSettingTab, loadData/saveData,
// registerDomEvent, and Notice. Pure client-side; no vault writes.
const { Plugin, Notice, PluginSettingTab } = require("basalt");

const DEFAULTS = { work: 25, shortBreak: 5, longBreak: 15, cycles: 4 };

module.exports = class PomodoroPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, saved);
    this.state = { phase: "work", remaining: this.settings.work * 60, running: false, completed: 0 };

    this.statusEl = this.addStatusBarItem();
    this.statusEl.style.cursor = "pointer";
    this.registerDomEvent(this.statusEl, "click", () => this.toggle());

    this.addCommand({ id: "toggle", name: "Pomodoro: start / pause", callback: () => this.toggle() });
    this.addCommand({ id: "reset", name: "Pomodoro: reset", callback: () => this.reset() });
    this.addCommand({ id: "skip", name: "Pomodoro: skip to next phase", callback: () => this.advance(false) });

    this.registerInterval(() => this.tick(), 1000);

    const tab = new PluginSettingTab(this.app, this);
    const self = this;
    tab.display = function () {
      this.containerEl.replaceChildren();
      self.numberField(this.containerEl, "Work minutes", "work");
      self.numberField(this.containerEl, "Short break minutes", "shortBreak");
      self.numberField(this.containerEl, "Long break minutes", "longBreak");
      self.numberField(this.containerEl, "Sessions before a long break", "cycles");
    };
    this.addSettingTab(tab);

    this.render();
  }

  numberField(container, label, key) {
    const row = document.createElement("label");
    row.style.display = "flex";
    row.style.justifyContent = "space-between";
    row.style.alignItems = "center";
    row.style.margin = "8px 0";
    row.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.value = String(this.settings[key]);
    input.style.width = "72px";
    input.addEventListener("change", async () => {
      this.settings[key] = Math.max(1, parseInt(input.value, 10) || DEFAULTS[key]);
      await this.saveData(this.settings);
      if (!this.state.running) this.reset();
    });
    row.appendChild(input);
    container.appendChild(row);
  }

  durationFor(phase) {
    if (phase === "work") return this.settings.work * 60;
    if (phase === "long") return this.settings.longBreak * 60;
    return this.settings.shortBreak * 60;
  }

  toggle() {
    this.state.running = !this.state.running;
    this.render();
  }

  reset() {
    this.state = { phase: "work", remaining: this.durationFor("work"), running: false, completed: 0 };
    this.render();
  }

  tick() {
    if (!this.state.running) return;
    if (this.state.remaining > 0) {
      this.state.remaining -= 1;
      this.render();
      return;
    }
    this.advance(true); // phase elapsed — auto-advance and keep running
  }

  // Move to the next phase. `auto` = triggered by the timer (keep running).
  advance(auto) {
    if (this.state.phase === "work") {
      this.state.completed += 1;
      const long = this.state.completed % this.settings.cycles === 0;
      this.state.phase = long ? "long" : "short";
      new Notice(long ? "Long break — nice work!" : "Break time.");
    } else {
      this.state.phase = "work";
      new Notice("Back to focus.");
    }
    this.state.remaining = this.durationFor(this.state.phase);
    if (auto) this.state.running = true;
    this.render();
  }

  render() {
    const m = Math.floor(this.state.remaining / 60);
    const s = this.state.remaining % 60;
    const icon = this.state.phase === "work" ? "🍅" : "☕";
    this.statusEl.textContent = `${icon} ${m}:${String(s).padStart(2, "0")}${this.state.running ? "" : " ⏸"}`;
    this.statusEl.title = this.state.running ? "Pomodoro running — click to pause" : "Pomodoro paused — click to start";
  }
};
