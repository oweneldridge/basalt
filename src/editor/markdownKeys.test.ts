// Regression tests for the syntax-aware Mod-B/Mod-I toggles — a purely textual
// before/after check corrupted markup (review findings T1-T3): Mod-I on bold
// text deleted one star from each ** delimiter.
import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { markdownKeys } from "./markdownKeys";

// KeyBinding.run is typed against a full EditorView, but these StateCommands
// only touch { state, dispatch } — narrow the type for headless testing.
type StateCmdLike = (target: {
  state: EditorState;
  dispatch: (tr: Transaction) => void;
}) => boolean;

const get = (key: string) =>
  markdownKeys.find((k) => k.key === key)!.run as unknown as StateCmdLike;
const bold = get("Mod-b");
const italic = get("Mod-i");
const link = get("Mod-k");

function apply(cmd: StateCmdLike, doc: string, anchor: number, head = anchor): string {
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
  it("a caret in a word bolds the word, as in Obsidian", () => {
    expect(apply(bold, "ab", 1)).toBe("**ab**");
    expect(applySel(bold, "say hello there", 6)).toEqual({ doc: "say **hello** there", head: 8 });
  });
  it("a caret between words gets the markers with the caret inside", () => {
    expect(applySel(bold, "a  b", 2)).toEqual({ doc: "a **** b", head: 4 });
  });
  it("a caret just before the closing markers steps out of them", () => {
    expect(applySel(bold, "**bold** x", 6)).toEqual({ doc: "**bold** x", head: 8 });
    expect(applySel(italic, "*it* x", 3)).toEqual({ doc: "*it* x", head: 4 });
  });
  it("spaces at the ends of the selection stay outside the markers", () => {
    expect(apply(bold, "hello world", 0, 6)).toBe("**hello** world");
    expect(apply(italic, "a  word  b", 1, 8)).toBe("a  *word*  b");
  });
});

function applySel(cmd: StateCmdLike, doc: string, anchor: number, head = anchor): { doc: string; head: number } {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdown({ base: markdownLanguage, extensions: GFM })],
  });
  let out = { doc, head };
  cmd({
    state,
    dispatch: (tr) => {
      out = { doc: tr.state.doc.toString(), head: tr.state.selection.main.head };
    },
  });
  return out;
}

describe("Mod-K link insertion", () => {
  it("wraps a selection as [text]() ", () => {
    expect(apply(link, "visit site now", 6, 10)).toBe("visit [site]() now");
  });
  it("inserts an empty link at the caret", () => {
    expect(apply(link, "x", 1)).toBe("x[]()");
  });
});

describe("Cmd-B with two carets in one word", () => {
  it("bolds the word once", () => {
    const state = EditorState.create({
      doc: "one two",
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(2)]),
      extensions: [EditorState.allowMultipleSelections.of(true), markdown({ base: markdownLanguage, extensions: GFM })],
    });
    let out = "";
    bold({ state, dispatch: (tr) => (out = tr.state.doc.toString()) });
    expect(out).toBe("**one** two");
  });
});
