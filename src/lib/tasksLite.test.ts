import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installHost, loadPlugin, unloadAll, codeBlockProcessor, type HostDeps, type PluginInfo } from "./plugins";

const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../plugins/tasks-lite/main.js"), "utf8");

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
vi.stubGlobal("document", { createElement: (t: string) => makeEl(t) });

const CONTENT: Record<string, string> = {
  "SmithRx/A.md": "# A\n- [ ] ship the thing 📅 2026-07-10 #work\n- [x] wrote the doc\n",
  "SmithRx/B.md": "notes\n- [ ] review PR 📅 2026-07-20\n- [ ] call vendor #home\n",
  "Personal/C.md": "- [ ] buy milk 📅 2026-07-02\n",
};
function fakeHost(): HostDeps {
  return {
    getMarkdownFiles: () => Object.keys(CONTENT).map((p) => ({ path: p, name: p.split("/").pop()!.replace(/\.md$/, "") })),
    readNote: async (rel: string) => CONTENT[rel] ?? "",
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
    getFileCache: () => null,
    onRegistryChanged: () => {},
  };
}
const info = (): PluginInfo => ({ id: "tasks-lite", name: "Tasks Lite", version: "1.0.0", description: "", author: "", minAppVersion: "", code, data: null });
async function run(query: string): Promise<El> {
  const el = makeEl("div");
  await codeBlockProcessor("tasks")!(query, el as unknown as HTMLElement, { notePath: "cur.md" });
  return el;
}

beforeEach(async () => {
  await unloadAll();
  installHost(fakeHost());
  await loadPlugin(info());
});

describe("tasks-lite", () => {
  it("`not done` collects open checkboxes across the vault", async () => {
    const el = await run("not done");
    const texts = findAll(el, "span").map((s) => s.textContent.trim()).sort();
    expect(texts).toEqual(["buy milk 📅 2026-07-02", "call vendor #home", "review PR 📅 2026-07-20", "ship the thing 📅 2026-07-10 #work"].sort());
    // the done "wrote the doc" is excluded
    expect(textOf(el)).not.toContain("wrote the doc");
  });

  it("filters by due date and path, and sorts by due", async () => {
    const el = await run("not done\ndue before 2026-07-15\nsort by due");
    const texts = findAll(el, "span").map((s) => s.textContent.trim());
    // 07-02 (buy milk) then 07-10 (ship the thing); 07-20 excluded, no-due excluded
    expect(texts).toEqual(["buy milk 📅 2026-07-02", "ship the thing 📅 2026-07-10 #work"]);
  });

  it("`path includes` scopes to a folder; done state reflects on the checkbox", async () => {
    const el = await run("path includes SmithRx/A");
    const boxes = findAll(el, "input");
    expect(boxes).toHaveLength(2); // ship (open) + wrote the doc (done)
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
  });

  it("`tags include` filters by tag; limit truncates; empty reports", async () => {
    expect(findAll(await run("tags include #work"), "input")).toHaveLength(1);
    expect(findAll(await run("not done\nlimit 1"), "input")).toHaveLength(1);
    expect(textOf(await run("done\ndue on 1999-01-01"))).toContain("No matching tasks");
  });
});
