import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installHost, loadPlugin, unloadAll, codeBlockProcessor, pluginCommands, emitVaultEvent, type HostDeps, type PluginInfo } from "./plugins";

const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../plugins/templater-lite/main.js"), "utf8");

interface El {
  _tag: string;
  className: string;
  textContent: string;
  type: string;
  value: string;
  placeholder: string;
  children: El[];
  style: Record<string, string>;
  setAttribute(k: string, v: string): void;
  listeners: Record<string, () => void>;
  addEventListener(type: string, fn: () => void): void;
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
    value: "",
    placeholder: "",
    children: [],
    style: {},
    setAttribute(k, v) {
      (el as unknown as Record<string, string>)[k] = v;
    },
    listeners: {},
    addEventListener(type, fn) {
      el.listeners[type] = fn;
    },
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
function textOf(el: El): string {
  if (el.children.length) return el.children.map(textOf).join("");
  return el.textContent;
}
vi.stubGlobal("document", { createElement: (t: string) => makeEl(t), body: makeEl("body") });

const CONTENT: Record<string, string> = {
  "Templates/Daily.md": "# <% tp.file.title %>\n<% tp.file.cursor() %>",
  "Journal/Today.md": "",
  "Journal/Note.md": "",
  "Journal/2026-10-06.md":
    "created: <% tp.file.creation_date('YYYY') %>\n<% await tp.user.hello('Owen') %>\n# <% moment(tp.file.title, 'YYYY-MM-DD').format('dddd, MMMM DD, YYYY') %>\n",
  "Scripts/hello.js": "async function hello(name) { return `Hello ${name}`; }\nmodule.exports = hello;",
  ".obsidian/plugins/templater-obsidian/data.json": '{"trigger_on_file_creation": true, "user_scripts_folder": "Scripts"}',
};
const modified: Record<string, string> = {};
const STATS: Record<string, { ctime: number; mtime: number }> = {
  "Journal/Note.md": { ctime: new Date(2024, 0, 2).getTime(), mtime: new Date(2024, 0, 3).getTime() },
};
let inserted: { text: string; caret?: number } | null = null;
let activeNote: string | null = "Journal/Note.md";
function fakeHost(): HostDeps {
  return {
    getMarkdownFiles: () =>
      Object.keys(CONTENT).map((p) => ({ path: p, name: p.split("/").pop()!.replace(/\.md$/, ""), ...(STATS[p] || {}) })),
    readNote: async (rel: string) => CONTENT[rel] ?? "",
    createNote: async () => {},
    modifyNote: async (rel: string, content: string) => {
      modified[rel] = content;
    },
    deleteNote: async () => {},
    renameNote: async () => {},
    createFolder: async () => {},
    getActiveNotePath: () => activeNote,
    openNote: () => {},
    vaultName: () => "V",
    savePluginData: async () => {},
    notice: () => {},
    getFileCache: () => ({ tags: [], links: [], headings: [], frontmatter: {} }),
    insertAtCursor: (text, caret) => {
      inserted = { text, caret };
    },
    onRegistryChanged: () => {},
  };
}
const info = (): PluginInfo => ({ id: "templater-lite", name: "Templater Lite", version: "1.0.0", description: "", author: "", minAppVersion: "", code, data: null });
const flush = () => new Promise((r) => setTimeout(r, 0));
async function preview(source: string, notePath = "Journal/Note.md"): Promise<string> {
  const el = makeEl("div");
  codeBlockProcessor("templater")!(source, el as unknown as HTMLElement, { notePath });
  el.children.find((c) => c.className === "templater-run")!.listeners.click();
  await flush();
  return textOf(el);
}

beforeEach(async () => {
  await unloadAll();
  inserted = null;
  activeNote = "Journal/Note.md";
  installHost(fakeHost());
  await loadPlugin(info());
});

describe("templater-lite", () => {
  it("interpolates tp.file/tp.date (with a fixed reference) and strips the cursor marker", async () => {
    expect(await preview("<% tp.file.title %> — <% tp.date.now('YYYY', 0, '2020-06-15') %>")).toBe("Note — 2020");
    expect(await preview("x<% tp.file.cursor() %>y")).toBe("xy");
    expect(await preview("<% tp.file.creation_date('YYYY-MM-DD') %>")).toBe("2024-01-02");
  });

  it("supports method chaining and <%* %> execution blocks writing to tR", async () => {
    expect(await preview("<% tp.file.title.toUpperCase() %>")).toBe("NOTE");
    expect(await preview("<%* for (let i = 1; i <= 3; i++) { tR += i + ' '; } %>")).toBe("1 2 3 ");
  });

  it("suggester/prompt use defaults in preview; whitespace markers trim; comments vanish", async () => {
    expect(await preview("<% tp.system.suggester(['A','B'], ['a','b']) %>-<% tp.system.prompt('Q', 'def') %>")).toBe("a-def");
    expect(await preview("A <%_ tp.file.title _%> B")).toBe("ANoteB");
    expect(await preview("[<%# a note to self %>]")).toBe("[]");
  });

  it("runs nothing until the preview is requested", async () => {
    const g = globalThis as { __tpRan?: number };
    delete g.__tpRan;
    const el = makeEl("div");
    const src = "<%* globalThis.__tpRan = 1 %><% globalThis.__tpRan = 2 %>";
    codeBlockProcessor("templater")!(src, el as unknown as HTMLElement, { notePath: "Journal/Note.md" });
    await flush();
    expect(g.__tpRan).toBeUndefined();
    expect(textOf(el)).toContain(src);
  });

  it("moment parses and formats dates", async () => {
    expect(await preview("<% moment('2026-10-06', 'YYYY-MM-DD').format('dddd, MMMM DD, YYYY') %>")).toBe("Tuesday, October 06, 2026");
    expect(await preview("<% moment('2026-10-06').add(1, 'days').format('YYYY-MM-DD') %>")).toBe("2026-10-07");
  });

  it("processes a new note's tags when the vault's Templater triggers on creation", async () => {
    emitVaultEvent("create", { path: "Journal/2026-10-06.md", name: "2026-10-06" });
    for (let k = 0; k < 10 && !modified["Journal/2026-10-06.md"]; k++) await flush();
    expect(modified["Journal/2026-10-06.md"]).toBe(`created: ${new Date().getFullYear()}\nHello Owen\n# Tuesday, October 06, 2026\n`);
  });

  it("reports a template error instead of throwing", async () => {
    expect(await preview("<% tp.nope.crash() %>")).toContain("Templater error");
  });

  it("the insert command processes the sole template and inserts at the caret", async () => {
    const cmd = pluginCommands().find((c) => c.id === "templater-lite:insert")!;
    await cmd.callback();
    // Daily.md → "# Today\n" then a cursor marker at offset 8. Active file = Note.md.
    expect(inserted).toEqual({ text: "# Note\n", caret: 7 });
  });

  it("inserting with no open note is a safe no-op", async () => {
    activeNote = null;
    await pluginCommands().find((c) => c.id === "templater-lite:insert")!.callback();
    expect(inserted).toBeNull();
  });
});
