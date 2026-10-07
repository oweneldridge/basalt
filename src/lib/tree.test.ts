import { describe, expect, it } from "vitest";
import { buildTree } from "./tree";


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
