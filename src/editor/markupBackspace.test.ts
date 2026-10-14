import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { deleteMarkupOnly } from "./markupBackspace";

const backspace = (doc: string, pos: number): string | null => {
  const state = EditorState.create({ doc, selection: { anchor: pos }, extensions: [markdown({ base: markdownLanguage, extensions: GFM })] });
  ensureSyntaxTree(state, doc.length, 5000);
  let out: string | null = null;
  deleteMarkupOnly({ state, dispatch: (tr) => (out = tr.state.doc.toString()) });
  return out;
};

describe("Backspace after a marker", () => {
  it("never takes a letter with the marker", () => {
    expect(backspace("> [!note] T\n>body", 14)).toBeNull(); // plain Backspace deletes the b
  });
  it("still removes the marker itself", () => {
    expect(backspace("> a\n> b", 6)).toBe("> a\nb");
    expect(backspace(">body", 1)).toBe("body");
  });
  it("never cuts a marker in part", () => {
    expect(backspace("- > - > w\n  2. 3. c", 18)).toBeNull();
    expect(backspace("> [!note] T\n2. second", 14)).toBeNull();
  });
  it("removes a quote marker inside a list item", () => {
    expect(backspace("- > q", 4)).toBe("- q");
  });
});
