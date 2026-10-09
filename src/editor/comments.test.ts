import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { comments } from "./comments";
import { commentRanges } from "../lib/render";

const spans = (state: EditorState) => {
  const out: string[] = [];
  state.field(comments).deco.between(0, state.doc.length, (from, to) => {
    out.push(state.sliceDoc(from, to));
  });
  return out;
};

describe("comments", () => {
  it("are found inline and over lines, never in code", () => {
    const md = "a %%one%% b\n%%\ntwo\n%%\n`%%code%%` ```\n%%fence%%\n```\n~~~\nx = 10 %% 3\ny = 7 %% 2\n~~~\n`` a %% b %% ``";
    expect(commentRanges(md).map(([f, t]) => md.slice(f, t))).toEqual(["%%one%%", "%%\ntwo\n%%"]);
  });
  it("follow an edit that changes which % pair up", () => {
    let state = EditorState.create({ doc: "%x%secret%% end", extensions: [comments] });
    expect(spans(state)).toEqual([]);
    state = state.update({ changes: { from: 1, to: 2 } }).state;
    expect(spans(state)).toEqual(["%%secret%%"]);
  });

  it("follow typing: a new closing %% makes one, other keys just move them", () => {
    let state = EditorState.create({ doc: "x %%open and more", extensions: [comments] });
    expect(spans(state)).toEqual([]);
    state = state.update({ changes: { from: 12, insert: "%%" } }).state;
    expect(spans(state)).toEqual(["%%open and%%"]);
    state = state.update({ changes: { from: 0, insert: "typed " } }).state;
    expect(spans(state)).toEqual(["%%open and%%"]);
    state = state.update({ changes: { from: 18, to: 20 } }).state;
    expect(spans(state)).toEqual([]);
  });
});
