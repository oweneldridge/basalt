// The HTML block and math fields skip rescanning a note on edits that can't
// change them. Random edits check that they still always agree with a scan.
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { htmlBlockField } from "./htmlBlock";
import { findMath, mathField } from "./math";
import { htmlBlockRanges } from "../lib/htmlBlocks";
import { comments } from "./comments";
import { commentRanges } from "../lib/render";

const BASE = [
  "---", "title: x", "---", "intro $a$ and $$b$$ here", "", "<div>", "html body", "</div>", "after", "",
  "```", "<div>not html</div> $not math$", "```", "", "$$", "x^2", "$$", "", "text with `$code$` and $5 and $10",
  "<center>one line</center>", "plain words", "", "last $z$",
].join("\n");

// A small deterministic random source, so a failure can be replayed.
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
const CHARS = ["a", " ", "\n", "$", "<", ">", "`", "~", "\\", "-", "5", "x", "/", "d", "i", "v", "%"];

function scanHtml(state: EditorState) {
  return htmlBlockRanges(state.doc.toString()).map((r) => [state.doc.line(r.fromLine + 1).from, state.doc.line(r.toLine + 1).to]);
}
function scanMath(state: EditorState) {
  return findMath(state.doc.toString()).map((s) => [s.from, s.to, s.tex, s.block]);
}

describe("incremental fields", () => {
  for (const seed of [1, 7, 42, 99, 2026, 3, 11, 123, 777, 31337]) {
    it(`agree with a full scan after random edits (seed ${seed})`, () => {
      const r = rng(seed);
      let state = EditorState.create({ doc: BASE + "\n%% c %%\n%x%y%%", extensions: [markdown({ base: markdownLanguage, extensions: GFM }), htmlBlockField, mathField, comments] });
      for (let step = 0; step < 1500; step++) {
        const len = state.doc.length;
        const from = Math.floor(r() * (len + 1));
        const del = r() < 0.4 ? Math.min(len - from, Math.floor(r() * 4)) : 0;
        const insert = r() < 0.8 ? CHARS[Math.floor(r() * CHARS.length)] : "";
        if (!del && !insert) continue;
        state = state.update({ changes: { from, to: from + del, insert } }).state;
        const html = state.field(htmlBlockField).blocks.map((b) => [b.from, b.to]);
        expect(html, `html after step ${step}`).toEqual(scanHtml(state));
        const math = state.field(mathField).spans.map((s) => [s.from, s.to, s.tex, s.block]);
        expect(math, `math after step ${step}`).toEqual(scanMath(state));
        const cm: number[][] = [];
        state.field(comments).between(0, state.doc.length, (f, t) => {
          cm.push([f, t]);
        });
        expect(cm, `comments after step ${step}`).toEqual(commentRanges(state.doc.toString()));
      }
    });
  }
});

describe("math on one line with a $$ block", () => {
  it("never breaks an edit", () => {
    const state = EditorState.create({ doc: "x", extensions: [markdown({ base: markdownLanguage, extensions: GFM }), mathField] });
    const doc = "$a$ $$b\nc$$\n\nplain";
    const next = state.update({ changes: { from: 0, to: 1, insert: doc }, selection: { anchor: doc.length } }).state;
    expect(next.doc.toString()).toBe(doc);
    expect(next.field(mathField).deco.size).toBe(1);
  });
});
