// Regression tests for the syntax-aware Mod-B/Mod-I toggles — a purely textual
// before/after check corrupted markup (review findings T1-T3): Mod-I on bold
// text deleted one star from each ** delimiter.
import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { markdownKeys } from "./markdownKeys";

const bold = markdownKeys.find((k) => k.key === "Mod-b")!.run!;
const italic = markdownKeys.find((k) => k.key === "Mod-i")!.run!;
const link = markdownKeys.find((k) => k.key === "Mod-k")!.run!;

function apply(
  cmd: (target: { state: EditorState; dispatch: (tr: Transaction) => void }) => boolean,
  doc: string,
  anchor: number,
  head = anchor,
): string {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage, extensions: GFM }),
    ],
  });
  let out = doc;
  cmd({
    state,
    dispatch: (tr) => {
      out = tr.state.doc.toString();
    },
  });
  return out;
}

describe("Mod-B / Mod-I syntax-aware toggling", () => {
  it("wraps a plain selection in bold", () => {
    expect(apply(bold, "hello world", 0, 5)).toBe("**hello** world");
  });
  it("unwraps bold when the selection is the bold content", () => {
    expect(apply(bold, "**bold**", 2, 6)).toBe("bold");
  });
  it("unwraps bold when the selection covers the whole **bold**", () => {
    expect(apply(bold, "**bold**", 0, 8)).toBe("bold");
  });
  it("T2 regression: Mod-I inside bold wraps as italic instead of eating ** stars", () => {
    expect(apply(italic, "**bold**", 2, 6)).toBe("***bold***");
  });
  it("T1 regression: Mod-I with caret between closing ** never deletes markers", () => {
    const out = apply(italic, "**bold**", 7);
    expect(out).toContain("**bold"); // nothing deleted
    expect(out.length).toBe("**bold**".length + 2); // pure insertion
  });
  it("unwraps italic", () => {
    expect(apply(italic, "*it* x", 1, 3)).toBe("it x");
  });
  it("nested ***bi***: Mod-I removes only the italic layer", () => {
    expect(apply(italic, "***bi***", 3, 5)).toBe("**bi**");
  });
  it("empty selection wraps with caret markers", () => {
    expect(apply(bold, "ab", 1)).toBe("a****b");
  });
});

describe("Mod-K link insertion", () => {
  it("wraps a selection as [text]() ", () => {
    expect(apply(link, "visit site now", 6, 10)).toBe("visit [site]() now");
  });
  it("inserts an empty link at the caret", () => {
    expect(apply(link, "x", 1)).toBe("x[]()");
  });
});
