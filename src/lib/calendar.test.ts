import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installHost, loadPlugin, unloadAll, pluginRightViews, type HostDeps, type PluginInfo } from "./plugins";

const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../plugins/calendar/main.js"), "utf8");

// Reach the pure static helpers directly (stubbed `basalt`).
interface CalModule {
  dailyKey: (d: Date) => string;
  parseDailyDate: (name: string) => Date | null;
  monthMatrix: (y: number, m: number, ws: number) => { date: Date; inMonth: boolean; key: string }[][];
  dailyNotePath: (key: string, folder: string) => string;
  weekdayLabels: (ws: number) => string[];
}
function loadModule(): CalModule {
  const module = { exports: {} as Record<string, unknown> };
  const require = (n: string) => {
    if (n === "basalt")
      return {
        Plugin: class {
          registerView() {}
          addCommand() {}
          addSettingTab() {}
          async loadData() {
            return null;
          }
        },
        Notice: class {},
        PluginSettingTab: class {},
      };
    throw new Error(`require(${n})`);
  };
  new Function("module", "exports", "require", code)(module, module.exports, require);
  return module.exports as unknown as CalModule;
}
const K = loadModule();

// ---- listener-capturing DOM stub -----------------------------------------
type Listener = (e: unknown) => void;
type El = Record<string, unknown> & { children: El[]; _tag: string; _on: Record<string, Listener[]> };
function makeEl(tag: string): El {
  const el = {
    _tag: tag,
    _on: {} as Record<string, Listener[]>,
    className: "",
    textContent: "",
    children: [] as El[],
    setAttribute(k: string, v: string) {
      (el as Record<string, unknown>)[k] = v;
    },
    addEventListener(type: string, cb: Listener) {
      (el._on[type] = el._on[type] || []).push(cb);
    },
    appendChild(c: El) {
      el.children.push(c);
      return c;
    },
    append(...c: El[]) {
      el.children.push(...c);
    },
    replaceChildren(...c: El[]) {
      el.children.length = 0;
      el.children.push(...c);
    },
    remove() {},
  } as unknown as El;
  return el;
}
function fire(el: El, type: string) {
  for (const cb of el._on[type] || []) cb({ preventDefault() {} });
}
function allBy(el: El, pred: (e: El) => boolean, acc: El[] = []): El[] {
  for (const c of el.children) {
    if (pred(c)) acc.push(c);
    allBy(c, pred, acc);
  }
  return acc;
}
const cls = (name: string) => (e: El) => typeof e.className === "string" && (e.className as string).split(" ").includes(name);
vi.stubGlobal("document", { createElement: (t: string) => makeEl(t) });

const flush = () => new Promise((r) => setTimeout(r, 0));
let files: { path: string; name: string }[] = [];
const opened: string[] = [];
const created: { path: string; content: string }[] = [];
let activePath: string | null = null;
function fakeHost(): HostDeps {
  return {
    getMarkdownFiles: () => files,
    readNote: async () => "",
    createNote: async (path, content) => {
      created.push({ path, content });
      files.push({ path, name: path.split("/").pop()!.replace(/\.md$/, "") });
    },
    modifyNote: async () => {},
    deleteNote: async () => {},
    renameNote: async () => {},
    createFolder: async () => {},
    getActiveNotePath: () => activePath,
    openNote: (t) => opened.push(t),
    vaultName: () => "V",
    savePluginData: async () => {},
    notice: () => {},
    getFileCache: () => null,
    insertAtCursor: () => {},
    onRegistryChanged: () => {},
  };
}
const info = (): PluginInfo => ({ id: "calendar", name: "Calendar", version: "1.0.0", description: "", author: "", minAppVersion: "", code, data: null });

describe("calendar date helpers", () => {
  it("dailyKey + parseDailyDate round-trip and reject bad dates", () => {
    expect(K.dailyKey(new Date(2026, 6, 5))).toBe("2026-07-05");
    expect(K.dailyKey(K.parseDailyDate("Journal/2026-07-05.md")!)).toBe("2026-07-05");
    expect(K.parseDailyDate("meeting notes")).toBeNull();
    expect(K.parseDailyDate("2026-13-40")).toBeNull(); // impossible month/day
    expect(K.parseDailyDate("2026-02-30")).toBeNull(); // Feb 30 rolls over → rejected
  });

  it("monthMatrix is a padded 6×7 grid with correct in-month flags", () => {
    // July 2026: the 1st is a Wednesday. Sunday-start → 3 leading June days.
    const wk = K.monthMatrix(2026, 6, 0);
    expect(wk).toHaveLength(6);
    expect(wk.every((w) => w.length === 7)).toBe(true);
    expect(wk[0][0].key).toBe("2026-06-28"); // first cell is the preceding Sunday
    expect(wk[0][3]).toMatchObject({ key: "2026-07-01", inMonth: true });
    const inMonth = wk.flat().filter((d) => d.inMonth);
    expect(inMonth).toHaveLength(31); // July has 31 days
    // Monday-start shifts the lead: first cell is Mon 2026-06-29.
    expect(K.monthMatrix(2026, 6, 1)[0][0].key).toBe("2026-06-29");
  });

  it("dailyNotePath honors the folder; weekdayLabels rotate with weekStart", () => {
    expect(K.dailyNotePath("2026-07-05", "")).toBe("2026-07-05.md");
    expect(K.dailyNotePath("2026-07-05", "Journal/Daily")).toBe("Journal/Daily/2026-07-05.md");
    expect(K.weekdayLabels(0)[0]).toBe("Sun");
    expect(K.weekdayLabels(1)[0]).toBe("Mon");
  });
});

describe("calendar view", () => {
  beforeEach(async () => {
    await unloadAll();
    files = [];
    opened.length = 0;
    created.length = 0;
    activePath = null;
    installHost(fakeHost());
    await loadPlugin(info());
  });

  it("renders a 42-cell month grid with weekday headers and a month title", () => {
    const container = makeEl("div");
    const view = pluginRightViews().find((v) => v.id === "calendar")!;
    view.mount(container as unknown as HTMLElement);
    expect(allBy(container, cls("cal-day"))).toHaveLength(42);
    expect(allBy(container, cls("cal-weekday"))).toHaveLength(7);
    const title = allBy(container, cls("cal-title"))[0];
    expect(title.textContent).toContain(String(new Date().getFullYear()));
  });

  it("clicking a day with a note opens it; an empty day creates then opens it", async () => {
    const todayKey = K.dailyKey(new Date());
    files.push({ path: `${todayKey}.md`, name: todayKey });
    const container = makeEl("div");
    pluginRightViews()
      .find((v) => v.id === "calendar")!
      .mount(container as unknown as HTMLElement);

    const cells = allBy(container, cls("cal-day"));
    const todayCell = cells.find((c) => c["data-date"] === todayKey)!;
    fire(todayCell, "click");
    await flush();
    expect(opened).toContain(todayKey); // existing note opened, not created
    expect(created).toHaveLength(0);

    // An in-month day that isn't today and has no note → create + open.
    const empty = cells.find((c) => cls("is-outside")(c) === false && c["data-date"] !== todayKey && !cls("has-note")(c))!;
    const emptyKey = empty["data-date"] as string;
    fire(empty, "click");
    await flush();
    expect(created).toEqual([{ path: `${emptyKey}.md`, content: `# ${emptyKey}\n` }]);
    expect(opened).toContain(emptyKey);
  });
});
