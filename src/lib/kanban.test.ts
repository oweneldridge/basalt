import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installHost, loadPlugin, unloadAll, codeBlockProcessor, type HostDeps, type PluginInfo } from "./plugins";

const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../plugins/kanban/main.js"), "utf8");

// Evaluate the plugin module directly (stubbed `basalt`) to reach its pure
// static helpers — the data-safety-critical parse/serialize/locate functions.
interface KanbanModule {
  parseBoard: (s: string) => { columns: { title: string; cards: { done: boolean; text: string }[] }[]; canonical: boolean };
  serializeBoard: (b: { columns: { title: string; cards: { done: boolean; text: string }[] }[] }) => string;
  boardEditable: (s: string) => boolean;
  replaceKanbanBlock: (note: string, oldBody: string, newBody: string) => string | null;
}
function loadModule(): KanbanModule {
  const module = { exports: {} as Record<string, unknown> };
  const require = (n: string) => {
    if (n === "basalt")
      return {
        Plugin: class {
          registerMarkdownCodeBlockProcessor() {}
          addCommand() {}
        },
        Notice: class {},
      };
    throw new Error(`unexpected require(${n})`);
  };
  new Function("module", "exports", "require", code)(module, module.exports, require);
  return module.exports as unknown as KanbanModule;
}

// ---- DOM stub for the rendering test -------------------------------------
type El = Record<string, unknown> & { children: El[]; _tag: string };
function makeEl(tag: string): El {
  const el = {
    _tag: tag,
    className: "",
    textContent: "",
    children: [] as El[],
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {} },
    setAttribute() {},
    addEventListener() {},
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
function findAll(el: El, tag: string, acc: El[] = []): El[] {
  for (const c of el.children) {
    if (c._tag === tag) acc.push(c);
    findAll(c, tag, acc);
  }
  return acc;
}
function textOf(el: El): string {
  if (el.children.length) return el.children.map(textOf).join("");
  return (el.textContent as string) || "";
}
vi.stubGlobal("document", { createElement: (t: string) => makeEl(t) });
vi.stubGlobal("window", {});

function fakeHost(): HostDeps {
  return {
    getMarkdownFiles: () => [],
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
    getFileCache: () => null,
    insertAtCursor: () => {},
    onRegistryChanged: () => {},
  };
}
const info = (): PluginInfo => ({ id: "kanban", name: "Kanban", version: "1.0.0", description: "", author: "", minAppVersion: "", code, data: null });
function render(source: string): El {
  const el = makeEl("div");
  codeBlockProcessor("kanban")!(source, el as unknown as HTMLElement, { notePath: "Boards/B.md" });
  return el;
}

const CANON = "## To Do\n- [ ] a\n- [x] b\n\n## Doing\n- [ ] c\n\n## Done\n";

describe("kanban model", () => {
  const K = loadModule();

  it("parses columns + cards and round-trips canonical boards", () => {
    const b = K.parseBoard(CANON);
    expect(b.columns.map((c) => c.title)).toEqual(["To Do", "Doing", "Done"]);
    expect(b.columns[0].cards).toEqual([
      { done: false, text: "a" },
      { done: true, text: "b" },
    ]);
    expect(b.columns[2].cards).toEqual([]);
    expect(b.canonical).toBe(true);
    // serialize is stable (idempotent) modulo trailing blank line
    expect(K.serializeBoard(b) + "\n").toBe(CANON.replace(/\n+$/, "\n"));
  });

  it("flags non-canonical boards as read-only (never silently reformatted)", () => {
    expect(K.boardEditable(CANON)).toBe(true);
    expect(K.boardEditable("## A\n- [ ] x\n  - a nested note\n")).toBe(false); // sub-bullet
    expect(K.boardEditable("## A\nsome stray prose\n- [ ] x\n")).toBe(false); // stray text
    expect(K.boardEditable("- [ ] orphan card before any heading\n")).toBe(false);
    expect(K.boardEditable("")).toBe(false);
  });

  it("replaceKanbanBlock rewrites only the matching fenced block", () => {
    const note = "# Notes\n\n```kanban\n" + CANON.trimEnd() + "\n```\n\nafter\n";
    const out = K.replaceKanbanBlock(note, CANON.trimEnd(), "## To Do\n- [x] a");
    expect(out).toContain("```kanban\n## To Do\n- [x] a\n```");
    expect(out).toContain("# Notes"); // surrounding note preserved
    expect(out).toContain("after");
  });

  it("refuses to write when the block can't be uniquely located", () => {
    // no match
    expect(K.replaceKanbanBlock("```kanban\n## X\n```", "## Different", "## Y")).toBeNull();
    // two identical blocks → ambiguous
    const dup = "```kanban\n## A\n```\n\n```kanban\n## A\n```";
    expect(K.replaceKanbanBlock(dup, "## A", "## B")).toBeNull();
  });
});

describe("kanban rendering", () => {
  beforeEach(async () => {
    await unloadAll();
    installHost(fakeHost());
    await loadPlugin(info());
  });

  it("renders columns, cards, and per-column counts for an editable board", () => {
    const el = render(CANON);
    expect(findAll(el, "div").filter((d) => d.className === "kanban-col")).toHaveLength(3);
    const texts = findAll(el, "span")
      .filter((s) => s.className === "kanban-card-text")
      .map((s) => s.textContent);
    expect(texts).toEqual(["a", "b", "c"]);
    // an editable board offers the "+ Add column" affordance
    expect(findAll(el, "button").some((b) => (b.textContent as string).includes("Add column"))).toBe(true);
  });

  it("shows a read-only notice for a non-canonical board", () => {
    const el = render("## A\nstray prose\n- [ ] x\n");
    expect(textOf(el)).toContain("Read-only");
    const inputs = findAll(el, "input");
    expect(inputs.every((i) => i.disabled === true)).toBe(true); // checkboxes disabled
    expect(inputs.some((i) => i.className === "kanban-add-card")).toBe(false); // no add-card field
  });
});
