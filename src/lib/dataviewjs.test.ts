import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installHost, loadPlugin, unloadAll, codeBlockProcessor, type HostDeps, type PluginInfo } from "./plugins";

const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../plugins/dataviewjs/main.js"), "utf8");

interface El {
  _tag: string;
  className: string;
  textContent: string;
  type: string;
  checked: boolean;
  disabled: boolean;
  children: El[];
  style: Record<string, string>;
  setAttribute(k: string, v: string): void;
  addEventListener(): void;
  appendChild(c: El): El;
  append(...c: El[]): void;
  replaceChildren(...c: El[]): void;
  remove(): void;
}
function makeEl(tag: string): El {
  const el: El = {
    _tag: tag,
    className: "",
    textContent: "",
    type: "",
    checked: false,
    disabled: false,
    children: [],
    style: {},
    setAttribute(k, v) {
      (el as unknown as Record<string, string>)[k] = v;
    },
    addEventListener() {},
    appendChild(c) {
      el.children.push(c);
      return c;
    },
    append(...c) {
      el.children.push(...c);
    },
    replaceChildren(...c) {
      el.children.length = 0;
      el.children.push(...c);
    },
    remove() {},
  };
  return el;
}
function findAll(el: El, tag: string, acc: El[] = []): El[] {
  for (const c of el.children) {
    if (c._tag === tag) acc.push(c);
    findAll(c, tag, acc);
  }
  return acc;
}
function textOf(el: El): string {
  if (el.children.length) return el.children.map(textOf).join("");
  return el.textContent;
}
vi.stubGlobal("document", {
  createElement: (t: string) => makeEl(t),
  createTextNode: (t: string) => ({ _tag: "#text", textContent: t, children: [] as El[] }),
});

// mtime chosen so 2026-07-01's mtime lands on 2026-07-10 (a known date to assert).
const JUL10 = new Date(2026, 6, 10, 9, 30).getTime();
const NOTES: { path: string; ctime: number; mtime: number; content: string }[] = [
  { path: "SmithRx/Daily Notes/2026-07-01.md", ctime: JUL10 - 86400000, mtime: JUL10, content: "# 2026-07-01\n- [ ] morning standup 📅 2026-07-03 #work\n- [x] wrote notes\n" },
  { path: "SmithRx/Daily Notes/2026-07-05.md", ctime: JUL10, mtime: JUL10, content: "- [ ] review PR\n" },
  { path: "SmithRx/Daily Notes/2026-07-09.md", ctime: JUL10, mtime: JUL10, content: "no tasks here\n" },
  { path: "Other/Misc.md", ctime: JUL10, mtime: JUL10, content: "- [ ] stray task\n" },
];
const byPath = new Map(NOTES.map((n) => [n.path, n]));
function fakeHost(): HostDeps {
  return {
    getMarkdownFiles: () =>
      NOTES.map((n) => ({ path: n.path, name: n.path.split("/").pop()!.replace(/\.md$/, ""), ctime: n.ctime, mtime: n.mtime })),
    readNote: async (rel: string) => byPath.get(rel)?.content ?? "",
    createNote: async () => {},
    modifyNote: async () => {},
    deleteNote: async () => {},
    renameNote: async () => {},
    createFolder: async () => {},
    getActiveNotePath: () => null,
    openNote: () => {},
    vaultName: () => "V",
    savePluginData: async () => {},
    notice: () => {},
    getFileCache: () => ({ tags: [], links: [], headings: [], frontmatter: {} }),
    onRegistryChanged: () => {},
  };
}
const info = (): PluginInfo => ({ id: "dataviewjs", name: "Dataview JS", version: "1.0.0", description: "", author: "", minAppVersion: "", code, data: null });
const flush = () => new Promise((r) => setTimeout(r, 0));
async function run(source: string, notePath = "SmithRx/Daily Notes/2026-07-01.md"): Promise<El> {
  const el = makeEl("div");
  codeBlockProcessor("dataviewjs")!(source, el as unknown as HTMLElement, { notePath });
  await flush(); // the processor pre-loads notes async before running the block
  return el;
}

beforeEach(async () => {
  await unloadAll();
  installHost(fakeHost());
  await loadPlugin(info());
});

describe("dataviewjs (lite)", () => {
  it("runs a daily-notes query sorted by file.day, formatted with Luxon", async () => {
    const el = await run(`
      const pages = dv.pages('"SmithRx/Daily Notes"')
        .where(p => /^\\d{4}-\\d{2}-\\d{2}/.test(p.file.name))
        .sort(p => p.file.day);
      dv.table(["Date", "Day"], pages.map(p => [p.file.link, p.file.day.toFormat("cccc")]));
      dv.paragraph("Total: " + pages.length);
    `);
    expect(findAll(el, "th").map((t) => t.textContent)).toEqual(["Date", "Day"]);
    const rows = findAll(findAll(el, "tbody")[0], "tr");
    expect(rows).toHaveLength(3); // Misc.md excluded by folder source
    // 2026-07-01 sorts first and is a Wednesday.
    expect(textOf(rows[0])).toContain("2026-07-01");
    expect(textOf(rows[0])).toContain("Wednesday");
    expect(findAll(el, "a").length).toBe(3);
    expect(textOf(el)).toContain("Total: 3");
  });

  it("exposes dv.luxon.DateTime with plus/diff/toFormat", async () => {
    const el = await run(`
      const { DateTime } = dv.luxon;
      const a = DateTime.fromISO("2026-07-01");
      const b = a.plus({ days: 8 });
      dv.paragraph([a.toFormat("cccc"), b.toISODate(), b.diff(a, "days").days].join(" "));
    `);
    // 2026-07-01 = Wednesday; +8 days = 2026-07-09; diff = 8
    expect(textOf(el)).toContain("Wednesday 2026-07-09 8");
  });

  it("exposes file.tasks with completed state, and file.mtime as a DateTime", async () => {
    const tl = await run(`dv.taskList(dv.current().file.tasks);`);
    const boxes = findAll(tl, "input");
    expect(boxes).toHaveLength(2); // one open + one done
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);

    const mt = await run(`dv.paragraph(dv.current().file.mtime.toISODate());`);
    expect(textOf(mt)).toContain("2026-07-10");
  });

  it("dv.date parses and compares, and dv.current resolves the block's note", async () => {
    const el = await run(`dv.paragraph([dv.date("2026-07-01") < dv.date("2026-07-09"), dv.current().file.name].join(" "));`);
    expect(textOf(el)).toContain("true 2026-07-01");
  });

  it("renders [[wikilinks]] in dv output as clickable links (daily-note nav)", async () => {
    const el = await run(
      `dv.paragraph("<< [[SmithRx/Daily Notes/2026-07-01.md|Previous Day]] | [[2026-07-05]] >>")`,
    );
    const links = findAll(el, "a");
    expect(links.map((a) => a.textContent)).toEqual(["Previous Day", "2026-07-05"]);
    // the surrounding "<<"/">>" text is preserved around the links
    expect(textOf(el)).toContain("<<");
    expect(textOf(el)).toContain(">>");
  });

  it("reports a runtime error instead of throwing", async () => {
    const el = await run(`dv.pages().nope.crash();`);
    expect(textOf(el)).toContain("dataviewjs error");
  });
});
