import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { textChanges } from "./textDiff";

const apply = (a: string, b: string) => ChangeSet.of(textChanges(a, b), a.length);

describe("textChanges", () => {
  it("produces b, with one edit per changed run of lines", () => {
    const a = "Top [[Target]] here.\nmid\nwhere I type\nmore\nEnd [[Target]].\n";
    const b = "Top [[Target Renamed]] here.\nmid\nwhere I type\nmore\nEnd [[Target Renamed]].\n";
    const set = apply(a, b);
    expect(set.apply(Text.of(a.split("\n"))).toString()).toBe(b);
    expect(textChanges(a, b)).toHaveLength(2);
    // The caret at the end of "where I type" stays there.
    const caret = a.indexOf("where I type") + "where I type".length;
    const mapped = set.mapPos(caret);
    expect(b.slice(mapped - "where I type".length, mapped)).toBe("where I type");
  });

  it("keeps a caret on a changed line near its column", () => {
    const a = "See [[Projects/Beta]] and more\n";
    const b = "See [[Beta]] and more\n";
    const caret = a.indexOf(" and more") + " and more".length;
    const mapped = apply(a, b).mapPos(caret);
    expect(b.slice(0, mapped).endsWith(" and more")).toBe(true);
  });

  it("round-trips inserts, deletes and endings without a newline", () => {
    const cases: [string, string][] = [
      ["a\nb\nc", "a\nB\nc\nd"],
      ["", "x\ny"],
      ["x\ny\n", ""],
      ["one\ntwo\nthree\n", "zero\none\nthree\nfour\n"],
    ];
    for (const [a, b] of cases) {
      let out = a;
      for (const c of [...textChanges(a, b)].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
      expect(out).toBe(b);
    }
  });
});
