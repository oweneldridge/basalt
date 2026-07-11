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
vi.stubGlobal("document", { createElement: (t: string) => makeEl(t) });

const NOTES = ["SmithRx/Daily Notes/2026-07-01.md", "SmithRx/Daily Notes/2026-07-05.md", "SmithRx/Daily Notes/2026-07-09.md", "Other/Misc.md"];
function fakeHost(): HostDeps {
  return {
    getMarkdownFiles: () => NOTES.map((p) => ({ path: p, name: p.split("/").pop()!.replace(/\.md$/, "") })),
    readNote: async () => "",
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
function run(source: string, notePath = "SmithRx/Daily Notes/2026-07-01.md"): El {
  const el = makeEl("div");
  codeBlockProcessor("dataviewjs")!(source, el as unknown as HTMLElement, { notePath });
  return el;
}

beforeEach(async () => {
  await unloadAll();
  installHost(fakeHost());
  await loadPlugin(info());
});

describe("dataviewjs (lite)", () => {
  it("runs a realistic daily-notes query: pages → where → sort → table + moment", () => {
    const el = run(`
      const pages = dv.pages('"SmithRx/Daily Notes"')
        .where(p => /^\\d{4}-\\d{2}-\\d{2}/.test(p.file.name))
        .sort(p => moment(p.file.name.substring(0, 10)).valueOf(), "asc");
      dv.table(["Date", "Day"], pages.map(p => [p.file.link, moment(p.file.name.substring(0, 10)).format("dddd")]));
      dv.paragraph("Total: " + pages.length);
    `);
    // header row + 3 daily notes (Misc.md excluded by folder + name filter)
    expect(findAll(el, "th").map((t) => t.textContent)).toEqual(["Date", "Day"]);
    const rows = findAll(findAll(el, "tbody")[0], "tr");
    expect(rows).toHaveLength(3);
    // Sorted ascending: 07-01 first, and 2026-07-01 is a Wednesday.
    expect(textOf(rows[0])).toContain("2026-07-01");
    expect(textOf(rows[0])).toContain("Wednesday");
    // Links are clickable anchors, and the paragraph counted them.
    expect(findAll(el, "a").length).toBe(3);
    expect(textOf(el)).toContain("Total: 3");
  });

  it("dv.current() resolves the block's own note; dv.list renders links", () => {
    const el = run(`dv.list([dv.current().file.link]);`);
    expect(findAll(el, "a").map((a) => a.textContent)).toEqual(["2026-07-01"]);
  });

  it("moment comparisons work (isBefore / isAfter / isValid)", () => {
    const el = run(`
      const a = moment("2026-07-01"), b = moment("2026-07-09");
      dv.paragraph([a.isBefore(b), b.isAfter(a), moment("not-a-date").isValid(), a.format("YYYY/MM/DD")].join(" "));
    `);
    expect(textOf(el)).toContain("true true false 2026/07/01");
  });

  it("reports a runtime error instead of throwing", () => {
    const el = run(`dv.pages().nope.crash();`);
    expect(textOf(el)).toContain("dataviewjs error");
  });
});
