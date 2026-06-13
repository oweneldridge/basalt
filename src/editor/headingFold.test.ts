// Heading-section range logic — the gutter's foldability decision (Phase 3c).
// Obsidian only folds at headings; this is the predicate that enforces that.
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { headingSectionAt } from "./headingFold";

function stateFor(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: GFM })],
  });
  ensureSyntaxTree(state, doc.length, 5000); // force a full parse (no view here)
  return state;
}

/** The heading-section fold range for `lineNo` (1-based) as [fromLine, toLine]. */
function foldLines(doc: string, lineNo: number): [number, number] | null {
  const state = stateFor(doc);
  const line = state.doc.line(lineNo);
  const range = headingSectionAt(state, line.from);
  if (!range) return null;
  return [state.doc.lineAt(range.from).number, state.doc.lineAt(range.to).number];
}

describe("headingSectionAt", () => {
  it("folds a heading's body down to the next same-level heading", () => {
    const doc = ["# A", "a1", "a2", "# B", "b1"].join("\n");
    expect(foldLines(doc, 1)).toEqual([1, 3]); // # A folds through a2
  });

  it("a section includes deeper subsections (## under #)", () => {
    const doc = ["# A", "a1", "## A.1", "x", "# B"].join("\n");
    expect(foldLines(doc, 1)).toEqual([1, 4]); // # A swallows ## A.1 and its body
    expect(foldLines(doc, 3)).toEqual([3, 4]); // ## A.1 folds just its own body
  });

  it("a heading with no body below it is not foldable", () => {
    const doc = ["# A", "# B", "b"].join("\n");
    expect(foldLines(doc, 1)).toBeNull(); // nothing between # A and # B
  });

  it("the last heading folds to end of document", () => {
    const doc = ["# A", "a", "## Last", "x", "y"].join("\n");
    expect(foldLines(doc, 3)).toEqual([3, 5]);
  });

  it("a non-heading line is never foldable (Obsidian doesn't fold paragraphs)", () => {
    expect(foldLines(["# A", "body", "more"].join("\n"), 2)).toBeNull();
  });

  it("a higher-level heading stops a deeper section (## then #)", () => {
    const doc = ["## A", "a", "# B", "b"].join("\n");
    expect(foldLines(doc, 1)).toEqual([1, 2]); // ## A stops at # B (higher level)
  });

  it("does not treat a '#' inside a fenced code block as a heading", () => {
    const doc = ["# Real", "```", "# not a heading", "still code", "```", "after"].join("\n");
    expect(foldLines(doc, 1)).toEqual([1, 6]); // real heading folds the code block + after
    expect(foldLines(doc, 3)).toBeNull(); // the '#' line inside the fence isn't a heading
  });
});
