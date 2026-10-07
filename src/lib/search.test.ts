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

  it("-path:, -file: and -tag: exclude, as in Obsidian", () => {
    const names = (q: string) => [...new Set(searchVault(NOTES, q, { tagsOf }).map((h) => h.name))];
    expect(names("quick -path:proj")).toEqual(["Alpha"]);
    expect(names("quick -file:alpha")).toEqual(["Beta"]);
    expect(names("quick -tag:animals")).toEqual(["Beta"]);
  });

  it("quoted operator values and regexes with spaces stay whole", () => {
    const notes = [...NOTES, note("Daily Notes/Day.md", "a quick daily line")];
    const names = (q: string) => [...new Set(searchVault(notes, q).map((h) => h.name))];
    expect(names('path:"Daily Notes" quick')).toEqual(["Day"]);
    expect(names("/quick daily/")).toEqual(["Day"]);
  });

  it("empty / whitespace query returns nothing", () => {
    expect(searchVault(NOTES, "   ")).toHaveLength(0);
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

describe("line: same-line operator", () => {
  const notes = [
    { path: "/v/a.md", rel: "a.md", name: "a", content: "the quick brown fox\nlazy dog sleeps" },
    { path: "/v/b.md", rel: "b.md", name: "b", content: "quick\nbrown\nfox" },
  ] as any;
  const paths = (q: string) => new Set(searchVault(notes, q).map((h) => h.path));
  it("matches only notes where the terms share ONE line", () => {
    const p = paths("line:(quick fox)");
    expect(p.has("/v/a.md")).toBe(true);
    expect(p.has("/v/b.md")).toBe(false);
  });
  it("single line:term matches a line containing the term", () => {
    expect(paths("line:lazy").has("/v/a.md")).toBe(true);
    expect(paths("line:lazy").has("/v/b.md")).toBe(false);
  });
  it("reports the matching line as the hit", () => {
    const hits = searchVault(notes, "line:(lazy dog)");
    expect(hits[0].lineText).toContain("lazy dog");
  });
});

describe("more of Obsidian's operators", () => {
  const vault = [
    note("Tasks.md", "# Plan\n- [ ] call Alice about budget\n- [x] email Bob about budget\nbudget notes\n## Later\nAlice again"),
    note("Props.md", "---\nstatus: draft\ntags: [x]\naliases:\n  - Thing One\n---\nbody with Case words"),
    note("Other.md", "Alice and budget in one section\n# Next\nnothing"),
  ];
  const paths = (q: string) => [...new Set(searchVault(vault, q).map((h) => h.path.replace("/v/", "")))].sort();
  const lines = (q: string) => searchVault(vault, q).filter((h) => h.line > 1 || h.lineText !== h.name).map((h) => h.lineText);

  it("task:, task-todo: and task-done: look in tasks only", () => {
    expect(paths("task:budget")).toEqual(["Tasks.md"]);
    expect(lines("task-todo:budget")).toEqual(["- [ ] call Alice about budget"]);
    expect(lines("task-done:(bob budget)")).toEqual(["- [x] email Bob about budget"]);
    expect(paths("task:nothing")).toEqual([]);
  });
  it("section: wants every term under one heading", () => {
    expect(paths("section:(alice budget)")).toEqual(["Other.md", "Tasks.md"]);
    expect(paths("section:(budget again)")).toEqual([]);
  });
  it("[property] and [property:value] look at the frontmatter", () => {
    expect(paths("[status]")).toEqual(["Props.md"]);
    expect(paths("[status:draft]")).toEqual(["Props.md"]);
    expect(paths("[status:final]")).toEqual([]);
    expect(paths('[aliases:"thing one"]')).toEqual(["Props.md"]);
  });
  it("match-case: is case-sensitive", () => {
    expect(paths("match-case:Case")).toEqual(["Props.md"]);
    expect(paths("match-case:case")).toEqual([]);
  });
  it("(a OR b) groups inside a search", () => {
    expect(paths("budget (bob OR nobody)")).toEqual(["Tasks.md"]);
    expect(paths("(alice OR thing) budget")).toEqual(["Other.md", "Tasks.md"]);
  });
});

describe("search totals", () => {
  it("count every result and note, past the ones listed", () => {
    const notes = Array.from({ length: 400 }, (_, i) => note(`n${i}.md`, "a word here"));
    const hits = searchVault(notes, "word");
    expect(hits).toHaveLength(300);
    expect(hits.total).toBe(400);
    expect(hits.notes).toBe(400);
  });
  it("count a note's lines past the ones it lists", () => {
    const hits = searchVault([note("Many.md", Array.from({ length: 50 }, (_, i) => `word ${i}`).join("\n"))], "word");
    expect(hits).toHaveLength(20);
    expect(hits.total).toBe(50);
  });
});

describe("regexes, phrases and links with brackets", () => {
  const notes = [
    note("A.md", "ticket 12345 here\ncall (Alice) later\n- [x] box ticked\nsee [[Note]] too\nfoo first"),
    note("B.md", "nothing to see"),
  ];
  const found = (q: string) => [...new Set(searchVault(notes, q).map((h) => h.path))];
  it("stay whole", () => {
    for (const q of ["/[0-9]{3}/", "/(foo|bar)/", "/call \\(alice\\)/i", '"call (Alice)"', '"[x] box"', "[[Note]]"]) {
      expect(found(q), q).toEqual(["/v/A.md"]);
    }
  });
  it("while operators beside them still work", () => {
    expect(found('"call (Alice)" [status]')).toEqual([]);
    expect(found('/[0-9]{3}/ (foo OR zzz)')).toEqual(["/v/A.md"]);
  });
});
