import { describe, expect, it } from "vitest";
import { buildTree, sameShape } from "./tree";


describe("buildTree sort orders", () => {
  const notes = [
    { path: "/v/b.md", rel: "b.md", name: "b", content: "", mtime: 100, ctime: 5 },
    { path: "/v/a.md", rel: "a.md", name: "a", content: "", mtime: 200, ctime: 1 },
  ];
  it("name-asc / name-desc / mtime-desc / ctime-desc order files", () => {
    const names = (o: any) => buildTree(notes as any, [], o).map((n) => n.name);
    expect(names("name-asc")).toEqual(["a", "b"]);
    expect(names("name-desc")).toEqual(["b", "a"]);
    expect(names("mtime-desc")).toEqual(["a", "b"]); // a mtime 200 > b 100
    expect(names("ctime-desc")).toEqual(["b", "a"]); // b ctime 5 > a 1
  });
});

describe("buildTree name order", () => {
  it("sorts numbers by value, as Obsidian does", () => {
    const n = (name: string) => ({ path: `/v/${name}.md`, rel: `${name}.md`, name, content: "" });
    const notes = ["Untitled 10", "Untitled 2", "Untitled 1", "AEOC-977", "AEOC-1057"].map(n);
    expect(buildTree(notes as any, [], "name-asc").map((x) => x.name)).toEqual([
      "AEOC-977",
      "AEOC-1057",
      "Untitled 1",
      "Untitled 2",
      "Untitled 10",
    ]);
  });
});

describe("empty folders", () => {
  it("show in the tree beside the ones holding notes", () => {
    const alpha = { path: "/v/Projects/Alpha.md", rel: "Projects/Alpha.md", name: "Alpha", content: "", mtime: 1, ctime: 1 };
    const tree = buildTree([alpha], [], "name-asc", ["Empty", "Projects", "Projects/Sub/Deeper"]);
    expect(tree.map((n) => n.name)).toEqual(["Empty", "Projects"]);
    const projects = tree[1] as { children: { name: string; type: string }[] };
    expect(projects.children.map((c) => `${c.type}:${c.name}`)).toEqual(["folder:Sub", "file:Alpha"]);
  });
});

describe("sameShape", () => {
  const note = (path: string, mtime: number, ctime: number) => ({ path, rel: path, name: path, content: "", mtime, ctime });
  const was = [note("a.md", 1, 1), note("b.md", 2, 2)];
  it("ignores the dates the order doesn't read", () => {
    const edited = [note("a.md", 9, 1), was[1]];
    expect(sameShape(was, edited, "name-asc")).toBe(true);
    expect(sameShape(was, edited, "name-desc")).toBe(true);
    expect(sameShape(was, edited, "ctime-desc")).toBe(true);
    expect(sameShape(was, edited, "mtime-desc")).toBe(false);
    const made = [note("a.md", 1, 9), was[1]];
    expect(sameShape(was, made, "mtime-desc")).toBe(true);
    expect(sameShape(was, made, "ctime-desc")).toBe(false);
  });
  it("sees a note added, removed or renamed", () => {
    expect(sameShape(was, [...was, note("c.md", 3, 3)], "name-asc")).toBe(false);
    expect(sameShape(was, [was[0]], "name-asc")).toBe(false);
    expect(sameShape(was, [was[0], note("c.md", 2, 2)], "name-asc")).toBe(false);
    expect(sameShape(was, was.map((n) => ({ ...n })), "mtime-desc")).toBe(true);
  });
});
