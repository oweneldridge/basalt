import { describe, expect, it } from "vitest";
import { searchVault, parseSearchQuery } from "./search";
import type { VaultNote } from "./vault";

function note(rel: string, content: string): VaultNote {
  const name = (rel.split("/").pop() ?? rel).replace(/\.md$/i, "");
  return { path: `/v/${rel}`, rel, name, content };
}

const NOTES = [
  note("Alpha.md", "the quick brown fox\njumps over\n#animals here"),
  note("proj/Beta.md", "slow green turtle\nquick tortoise"),
  note("Gamma.md", "nothing relevant"),
];

const tagsOf = (p: string) => (p.endsWith("Alpha.md") ? ["animals"] : []);

describe("parseSearchQuery", () => {
  it("parses operators, phrases, negation, regex", () => {
    const q = parseSearchQuery('path:proj file:beta tag:animals -slow "green turtle" /quick/');
    expect(q.paths).toEqual(["proj"]);
    expect(q.files).toEqual(["beta"]);
    expect(q.tags).toEqual(["animals"]);
    expect(q.negations).toEqual(["slow"]);
    expect(q.terms).toContain("green turtle");
    expect(q.regex).toBeInstanceOf(RegExp);
  });
});

describe("searchVault operators", () => {
  it("bare terms are AND-ed at the note level", () => {
    expect(searchVault(NOTES, "quick brown").map((h) => h.name)).toEqual(["Alpha"]);
    expect(searchVault(NOTES, "brown turtle").map((h) => h.name)).toEqual([]); // split across notes
  });

  it("path: scopes to matching rels", () => {
    const hits = searchVault(NOTES, "path:proj quick");
    expect(hits.every((h) => h.path.includes("/proj/"))).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("file: scopes to filename", () => {
    expect(searchVault(NOTES, "file:alpha quick").every((h) => h.name === "Alpha")).toBe(true);
  });

  it("tag: filters by tag (via tagsOf)", () => {
    const hits = searchVault(NOTES, "tag:animals", { tagsOf });
    expect(hits.map((h) => h.name)).toContain("Alpha");
    expect(hits.every((h) => h.name === "Alpha")).toBe(true);
  });

  it("-term excludes notes containing it", () => {
    const withSlow = searchVault(NOTES, "turtle");
    expect(withSlow.some((h) => h.name === "Beta")).toBe(true);
    const withoutSlow = searchVault(NOTES, "turtle -slow");
    expect(withoutSlow.some((h) => h.name === "Beta")).toBe(false);
  });

  it("/regex/ matches lines by pattern", () => {
    const hits = searchVault(NOTES, "/qu.ck/");
    expect(hits.some((h) => h.lineText.includes("quick"))).toBe(true);
  });

  it("empty / whitespace query returns nothing", () => {
    expect(searchVault(NOTES, "   ")).toEqual([]);
  });
});

describe("OR search groups", () => {
  const notes = [
    { path: "/v/a.md", rel: "a.md", name: "a", content: "green turtle" },
    { path: "/v/b.md", rel: "b.md", name: "b", content: "blue whale" },
    { path: "/v/c.md", rel: "c.md", name: "c", content: "red fox" },
  ] as any;
  const paths = (q: string) => new Set(searchVault(notes, q).map((h) => h.path));
  it("matches notes in EITHER OR-group", () => {
    const p = paths("turtle OR whale");
    expect(p.has("/v/a.md")).toBe(true);
    expect(p.has("/v/b.md")).toBe(true);
    expect(p.has("/v/c.md")).toBe(false);
  });
  it("each group keeps AND semantics", () => {
    // (green AND turtle) OR (blue AND fox) → only a matches (b has blue but not fox)
    const p = paths("green turtle OR blue fox");
    expect([...p]).toEqual(["/v/a.md"]);
  });
  it("a quoted \"OR\" is a literal phrase, not the operator", () => {
    const withOr = [{ path: "/v/x.md", rel: "x.md", name: "x", content: "this OR that" }] as any;
    expect(searchVault(withOr, '"OR that"').length).toBe(1);
    expect(searchVault(withOr, '"zzz OR"').length).toBe(0);
  });
});
