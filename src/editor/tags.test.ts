import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { ObsidianTasks } from "../lib/mdTasks";
import { ObsidianTables } from "../lib/mdTables";
import { findTags } from "./tags";

function chips(doc: string): string[] {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [GFM, ObsidianTasks, ObsidianTables] })] });
  ensureSyntaxTree(state, doc.length, 5000);
  return findTags(state, [{ from: 0, to: doc.length }]).map(([a, b]) => doc.slice(a, b));
}

describe("Live Preview tags", () => {
  it("chips a tag right after a quote's mark", () => {
    expect(chips(">#a")).toEqual(["#a"]);
    expect(chips("> >#b")).toEqual(["#b"]);
    expect(chips("- >#c")).toEqual(["#c"]);
    expect(chips("- a\n  - b\n    >#d")).toEqual(["#d"]);
    expect(chips("para\n   >#e")).toEqual(["#e"]);
  });

  it("doesn't chip one after a `>` that is paragraph text or code", () => {
    expect(chips("para\n    >#x")).toEqual([]);
    expect(chips("- a\n      >#y")).toEqual([]);
    expect(chips("        >#seven")).toEqual([]);
    expect(chips("a >#b")).toEqual([]);
    expect(chips("- a\n2. >#u")).toEqual([]);
    expect(chips("text\n\t>#t")).toEqual([]);
  });

  it("still chips ordinary tags", () => {
    expect(chips("a #one and **#two** #42")).toEqual(["#one", "#two"]);
  });
});
