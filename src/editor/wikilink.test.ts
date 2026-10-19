import { describe, expect, it } from "vitest";
import { linkReaches } from "./wikilink";
import { linkTargetForFormat } from "../lib/rename";
import { VaultIndex } from "../lib/vaultIndex";
import type { VaultNote } from "../lib/vault";

const vnote = (rel: string): VaultNote => ({ path: `/v/${rel}`, rel, name: rel.split("/").pop()!.replace(/\.md$/, ""), content: "" });

// The link a suggestion writes, and the one a rename writes, for each pair.
function both(rels: string[], from: string, to: string) {
  const notes = rels.map(vnote);
  const idx = new VaultIndex();
  idx.build(notes);
  const toNoExt = to.replace(/\.md$/, "");
  const suggested = linkTargetForFormat("relative", toNoExt, false, from, linkReaches(notes, from, to));
  const renamed = linkTargetForFormat("relative", toNoExt, false, from, (t) => idx.resolveFromRel(t, from) === `/v/${to}`);
  return { suggested, renamed };
}

describe("link suggestions", () => {
  it("write a same-folder note's plain name, whatever else ends in it", () => {
    expect(both(["Kit/Src.md", "Kit/sub.md", "Kitsub.md"], "Kit/Src.md", "Kit/sub.md")).toEqual({ suggested: "sub", renamed: "sub" });
  });

  it("keep ./ when a root note of the same name would take the link", () => {
    expect(both(["q/Src.md", "q/Zed.md", "Zed.md"], "q/Src.md", "q/Zed.md")).toEqual({ suggested: "./Zed", renamed: "./Zed" });
  });

  it("reach a note named like a file by its whole name, unless a plain note has it", () => {
    expect(linkReaches([{ rel: "f/Foo.md.md" }], "f/A.md", "f/Foo.md.md")("Foo.md")).toBe(true);
    expect(linkReaches([{ rel: "f/Foo.md.md" }, { rel: "Foo.md" }], "f/A.md", "f/Foo.md.md")("Foo.md")).toBe(false);
  });

  it("agree with the rename path across random vaults", () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const FOLDERS = ["", "f", "F2", "foo", "f/sub", "sub", "g/f", "f/sub/deep", "fsub", "Kit", "Kit/sub"];
    const NAMES = ["x", "X", "Done", "done", "sub", "f", "Leaf", "fsub", "Kitsub", "Foo.md"];
    const differ: string[] = [];
    for (let iter = 0; iter < 1500; iter++) {
      const rels = new Map<string, string>();
      for (let i = 0, n = 2 + rnd(7); i < n; i++) {
        const f = FOLDERS[rnd(FOLDERS.length)];
        const rel = `${f ? `${f}/` : ""}${NAMES[rnd(NAMES.length)]}.md`;
        rels.set(rel.toLowerCase(), rel);
      }
      const all = [...rels.values()];
      for (const from of all)
        for (const to of all) {
          const { suggested, renamed } = both(all, from, to);
          if (suggested !== renamed) differ.push(`${from} -> ${to}: [[${suggested}]] vs [[${renamed}]] in ${all.join(",")}`);
        }
    }
    expect(differ.slice(0, 5)).toEqual([]);
  });
});
