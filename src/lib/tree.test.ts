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
