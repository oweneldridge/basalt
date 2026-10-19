import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { math } from "./math";

describe("an inline formula and a $$ block on one line", () => {
  it("never breaks the edit that makes them", () => {
    const state = EditorState.create({ doc: "x", extensions: [markdown({ base: markdownLanguage, extensions: GFM }), math] });
    const doc = "$a$ $$b\nc$$\n\nplain";
    const next = state.update({ changes: { from: 0, to: 1, insert: doc }, selection: { anchor: doc.length } }).state;
    expect(next.doc.toString()).toBe(doc);
  });
});
