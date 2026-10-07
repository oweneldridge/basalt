import { describe, expect, it } from "vitest";
import { EditorState, type ChangeSpec } from "@codemirror/state";
import { foldEffect } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { renumberLists } from "./listRenumber";
import { headingFold, headingSectionAt } from "./headingFold";

const md = markdown({ base: markdownLanguage, extensions: GFM });
const edit = (doc: string, changes: ChangeSpec, userEvent?: string) =>
  EditorState.create({ doc, extensions: [renumberLists, md] }).update({ changes, userEvent }).state.doc.toString();
// Type `text` at the end of line `n`.
const typeAt = (doc: string, n: number, text = "x", userEvent = "input.type") => {
  const at = EditorState.create({ doc }).doc.line(n).to;
  return edit(doc, { from: at, insert: text }, userEvent);
};

describe("numbered lists after an edit", () => {
  it("count on after an item is deleted", () => {
    expect(edit("1. a\n2. b\n3. c\n4. d", { from: 5, to: 10 }, "delete.line")).toBe("1. a\n2. c\n3. d");
  });
  it("number a new item after the one before it", () => {
    expect(edit("1. a\n2. b\n", { from: 10, insert: "1. c" }, "input.type")).toBe("1. a\n2. b\n3. c");
  });
  it("keep a number the user typed on the first item", () => {
    expect(edit("1. a\n2. b", { from: 0, to: 1, insert: "5" }, "input.type")).toBe("5. a\n6. b");
  });
  it("leave undo, a reload from disk and other text alone", () => {
    expect(edit("1. a\n3. b", { from: 0, insert: "" + "" }, "undo")).toBe("1. a\n3. b");
    expect(edit("1. a\n2. b", { from: 5, to: 7, insert: "7." })).toBe("1. a\n7. b");
    expect(edit("para\n\n1. a\n3. b", { from: 0, insert: "x" }, "input.type")).toBe("xpara\n\n1. a\n3. b");
  });
});

describe("only real list items are renumbered", () => {
  it("leaves numbered lines in code, math, comments, frontmatter and HTML alone", () => {
    const fenced = "1. a\n\n```\n4. x\n5. y\n```\n";
    expect(typeAt(fenced, 4)).toBe("1. a\n\n```\n4. xx\n5. y\n```\n");
    expect(typeAt("Run:\n\n    1. one\n    1. two\n", 3)).toBe("Run:\n\n    1. onex\n    1. two\n");
    expect(typeAt("$$\n1. a\n1. b\n$$\n", 2)).toBe("$$\n1. ax\n1. b\n$$\n");
    expect(typeAt("%%\n1. a\n1. b\n%%\n", 2)).toBe("%%\n1. ax\n1. b\n%%\n");
    expect(typeAt("---\nsteps:\n1. a\n1. b\n---\nbody\n", 3)).toBe("---\nsteps:\n1. ax\n1. b\n---\nbody\n");
    expect(typeAt("<div>\n1. a\n1. b\n</div>\n", 2)).toBe("<div>\n1. ax\n1. b\n</div>\n");
  });
  it("leaves a paste into a code block as pasted", () => {
    const doc = "1. a\n\n```\n\n```\n";
    expect(edit(doc, { from: 10, insert: "1. a\n1. b\n7. c" }, "input.paste")).toBe("1. a\n\n```\n1. a\n1. b\n7. c\n```\n");
  });
  it("leaves numbers that only continue a paragraph alone", () => {
    expect(typeAt("Some text\n2. not a list\n5. still not\n", 1)).toBe("Some textx\n2. not a list\n5. still not\n");
  });
  it("leaves numbers too long to be list items, and keeps zero padding", () => {
    const long = "1234567890123456789. a\n1. b\n";
    expect(typeAt(long, 1)).toBe("1234567890123456789. ax\n1. b\n");
    expect(edit("01. a\n02. b\n03. c\n04. d", { from: 6, to: 12 }, "delete.line")).toBe("01. a\n02. c\n03. d");
  });
  it("nests by the list's own indentation, so 3-space children don't restart it", () => {
    const doc = "1. a\n   - x\n2. b\n3. c\n";
    expect(typeAt(doc, 2)).toBe("1. a\n   - xx\n2. b\n3. c\n");
    expect(typeAt(doc, 2, "\n   - y", "input")).toBe("1. a\n   - x\n   - y\n2. b\n3. c\n");
    expect(typeAt("1. a\n   1. x\n   3. y\n2. b\n", 2)).toBe("1. a\n   1. xx\n   2. y\n2. b\n");
  });
  it("keeps counting past a paragraph started between items", () => {
    const doc = "1. a\n2. b\n\n   - sub\n\n3. c\n4. d\n";
    expect(typeAt(doc, 5)).toBe("1. a\n2. b\n\n   - sub\nx\n3. c\n4. d\n");
  });
  it("leaves the lines of a code block alone while its fence is being edited", () => {
    const doc = "Steps:\n\n```\n4. x\n9. y\n```\n";
    expect(edit(doc, { from: 10, to: 11 }, "delete.backward")).toBe("Steps:\n\n``\n4. x\n9. y\n```\n");
  });
  it("leaves the lines of a closed fold alone", () => {
    const doc = "# H\n1. a\n1. b\n1. c\n";
    const base = EditorState.create({ doc, extensions: [renumberLists, md, headingFold] });
    const folded = base.update({ effects: foldEffect.of(headingSectionAt(base, 0)!) }).state;
    expect(folded.update({ changes: { from: 3, insert: "x" }, userEvent: "input.type" }).state.doc.toString()).toBe("# Hx\n1. a\n1. b\n1. c\n");
  });
});
