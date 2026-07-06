import { describe, expect, it } from "vitest";
import {
  parseQuery,
  runQuery,
  extractTasks,
  evalQueryExpr,
  queryCellParts,
  DateVal,
  LinkVal,
  type BaseRow,
  type QueryCtx,
  type Task,
} from "./query";

function row(over: Partial<BaseRow> = {}): BaseRow {
  return {
    name: "N.md",
    basename: "N",
    path: "N.md",
    folder: "",
    ext: "md",
    size: 0,
    ctime: 0,
    mtime: 0,
    tags: [],
    linkKeys: [],
    properties: {},
    ...over,
  };
}

function ctx(r: Partial<BaseRow> = {}): QueryCtx {
  const rr = row(r);
  return { row: rr, self: rr, tasksOf: () => [] };
}
const ev = (src: string, c: QueryCtx = ctx()) => evalQueryExpr(src, c);

describe("parseQuery", () => {
  it("parses TABLE with columns, AS, and clauses", () => {
    const q = parseQuery(
      'TABLE file.mtime AS "Modified", status FROM #project AND "Work" WHERE status != "done" SORT file.name DESC LIMIT 5',
    );
    expect(q.kind).toBe("TABLE");
    expect(q.columns).toEqual([
      { expr: "file.mtime", name: "Modified" },
      { expr: "status", name: "status" },
    ]);
    expect(q.from).toEqual({
      t: "and",
      l: { t: "tag", tag: "project" },
      r: { t: "folder", folder: "Work" },
    });
    expect(q.where).toBe('status != "done"');
    expect(q.sort).toEqual([{ expr: "file.name", dir: "DESC" }]);
    expect(q.limit).toBe(5);
  });

  it("parses TABLE WITHOUT ID, LIST expr, TASK, GROUP BY, FLATTEN", () => {
    expect(parseQuery("TABLE WITHOUT ID file.name").withoutId).toBe(true);
    expect(parseQuery("LIST file.link").listExpr).toBe("file.link");
    expect(parseQuery("TASK WHERE !checked").kind).toBe("TASK");
    expect(parseQuery("LIST GROUP BY status").groupBy).toBe("status");
    const fl = parseQuery("LIST FROM #x FLATTEN file.tags AS tag");
    expect(fl.flatten).toEqual([{ expr: "file.tags", name: undefined, as: "tag" }].map((x) => ({ expr: x.expr, as: x.as })));
  });

  it("does not split clause keywords inside quoted FROM / strings", () => {
    const q = parseQuery('LIST FROM "from-folder" WHERE title = "sort this where"');
    expect(q.from).toEqual({ t: "folder", folder: "from-folder" });
    expect(q.where).toBe('title = "sort this where"');
  });

  it("flags an unknown query type instead of throwing", () => {
    expect(parseQuery("BOGUS foo").error).toMatch(/Unknown query type/);
  });

  it("parses FROM boolean combos incl. -neg and outgoing()", () => {
    expect(parseQuery("LIST FROM #a or #b").from).toEqual({
      t: "or",
      l: { t: "tag", tag: "a" },
      r: { t: "tag", tag: "b" },
    });
    expect(parseQuery("LIST FROM #a and -#b").from).toEqual({
      t: "and",
      l: { t: "tag", tag: "a" },
      r: { t: "not", e: { t: "tag", tag: "b" } },
    });
    expect(parseQuery("LIST FROM outgoing([[Hub]])").from).toEqual({
      t: "link",
      target: "Hub",
      dir: "out",
    });
  });
});

describe("expression evaluation", () => {
  it("fields, frontmatter, file.*, this", () => {
    const c = ctx({ basename: "Foo", folder: "Notes", tags: ["book"], properties: { rating: 4, status: "read" } });
    expect(ev("file.name", c)).toBe("Foo");
    expect(ev("file.folder", c)).toBe("Notes");
    expect(ev("rating + 1", c)).toBe(5);
    expect(ev('status = "read"', c)).toBe(true);
    expect(ev("file.tags", c)).toEqual(["#book"]);
    expect(ev("this.file.name", c)).toBe("Foo");
  });

  it("operators use DQL forms (= equality, and/or/not)", () => {
    expect(ev("1 = 1")).toBe(true);
    expect(ev("1 != 2")).toBe(true);
    expect(ev("2 > 1 and 3 > 2")).toBe(true);
    expect(ev("false or true")).toBe(true);
    expect(ev("not false")).toBe(true);
    expect(ev("2 * 3 + 1")).toBe(7);
    expect(ev("10 / 0")).toBeNull();
  });

  it("functions: contains/length/sum/round/default/choice/dateformat/date", () => {
    const c = ctx({ properties: { xs: [1, 2, 3], name: "hi" } });
    expect(ev('contains("hello", "ell")')).toBe(true);
    expect(ev('icontains("Hello", "ELL")')).toBe(true);
    expect(ev("contains(xs, 2)", c)).toBe(true);
    expect(ev("length(xs)", c)).toBe(3);
    expect(ev("sum(xs)", c)).toBe(6);
    expect(ev("round(3.14159, 2)")).toBe(3.14);
    expect(ev("default(missing, 7)", c)).toBe(7);
    expect(ev('choice(1 > 0, "y", "n")')).toBe("y");
    expect(ev('dateformat(date("2026-03-05"), "yyyy-MM-dd")')).toBe("2026-03-05");
    expect((ev('date("2026-01-01")') as DateVal).ms).toBe(new Date(2026, 0, 1).getTime());
  });

  it("links compare by target; [[wikilink]] literals parse", () => {
    expect(ev('[[Note]] = [[Note]]')).toBe(true);
    expect(ev('[[Note.md]] = [[Note]]')).toBe(true);
    const c = ctx({ properties: { rel: "[[Target|alias]]" } });
    expect((ev("rel", c) as LinkVal).target).toBe("Target");
  });

  it("list literals and indexing", () => {
    expect(ev("[1, 2, 3][1]")).toBe(2);
    expect(ev("length([1,2,3])")).toBe(3);
  });

  it("bounds a catastrophic regexmatch pattern (no freeze)", () => {
    const t0 = Date.now();
    expect(ev('regexmatch("(a+)+$", "' + "a".repeat(30) + '!")')).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("reports errors as null, never throws", () => {
    const errs: string[] = [];
    const c = { ...ctx(), errors: (m: string) => errs.push(m) };
    expect(evalQueryExpr("unknownFn(1)", c)).toBeNull();
    expect(evalQueryExpr("1 +", c)).toBeNull();
    expect(errs.length).toBe(2);
  });
});

describe("extractTasks", () => {
  it("parses checkbox tasks, status, indent, tags, and due dates", () => {
    const md = [
      "# Heading",
      "- [ ] open task #urgent",
      "  - [x] done subtask",
      "- [/] in progress 📅 2026-05-01",
      "- not a task",
      "* [ ] star bullet [due:: 2026-06-15]",
    ].join("\n");
    const tasks = extractTasks(md, "Note.md");
    expect(tasks).toHaveLength(4);
    expect(tasks[0]).toMatchObject({ checked: false, status: " ", indent: 0, tags: ["urgent"] });
    expect(tasks[1]).toMatchObject({ checked: true, status: "x", indent: 2 });
    expect(tasks[2].due).toBe(new Date(2026, 4, 1).getTime());
    expect(tasks[3].due).toBe(new Date(2026, 5, 15).getTime());
  });
});

describe("runQuery", () => {
  const rows = [
    row({ basename: "A", path: "A.md", folder: "", tags: ["book"], mtime: 3, properties: { rating: 5, status: "read" } }),
    row({ basename: "B", path: "Work/B.md", folder: "Work", tags: ["book", "fav"], mtime: 5, properties: { rating: 3, status: "reading" } }),
    row({ basename: "C", path: "Work/C.md", folder: "Work", tags: ["article"], mtime: 1, properties: { rating: 4, status: "read" } }),
    row({ basename: "D", path: "D.md", folder: "", tags: ["book"], mtime: 2, properties: { status: "unread" } }),
  ];
  const base = { rows, selfPath: "A.md", tasksOf: () => [] as Task[] };

  it("TABLE: FROM tag + WHERE + SORT + columns, with the id column", () => {
    const q = parseQuery('TABLE rating, status FROM #book WHERE status != "unread" SORT rating DESC');
    const r = runQuery(q, base);
    expect(r.columns).toEqual(["File", "rating", "status"]);
    expect(r.rows.map((x) => x.row.basename)).toEqual(["A", "B"]); // D filtered (unread), rating desc
    expect(r.rows[0].cells).toEqual([5, "read"]);
    // id column renders as a link to the file
    expect(queryCellParts(new LinkVal(r.rows[0].row.path, r.rows[0].row.basename))).toEqual([
      { kind: "link", text: "A", target: "A.md" },
    ]);
  });

  it("FROM folder matches subfolders; WITHOUT ID drops the file column", () => {
    const q = parseQuery('TABLE WITHOUT ID file.name FROM "Work"');
    const r = runQuery(q, base);
    expect(r.columns).toEqual(["file.name"]);
    expect(r.rows.map((x) => x.cells[0])).toEqual(["B", "C"]);
  });

  it("LIST default value is a file link; LIST <expr> uses the expression", () => {
    const r1 = runQuery(parseQuery("LIST FROM #article"), base);
    expect((r1.rows[0].listValue as LinkVal).target).toBe("Work/C.md");
    const r2 = runQuery(parseQuery("LIST rating FROM #book SORT file.name"), base);
    expect(r2.rows.map((x) => x.listValue)).toEqual([5, 3, null]);
  });

  it("GROUP BY buckets rows by key", () => {
    const r = runQuery(parseQuery("LIST GROUP BY status"), base);
    expect(r.groups?.map((g) => g.label).sort()).toEqual(["read", "reading", "unread"]);
    const read = r.groups?.find((g) => g.label === "read");
    expect(read?.rows.map((x) => x.row.basename).sort()).toEqual(["A", "C"]);
  });

  it("LIMIT caps rows; total reflects pre-limit count", () => {
    const r = runQuery(parseQuery("LIST FROM #book SORT file.name LIMIT 2"), base);
    expect(r.rows).toHaveLength(2);
    expect(r.total).toBe(3);
  });

  it("FLATTEN expands one row per list element", () => {
    const r = runQuery(parseQuery("TABLE tag FROM #book FLATTEN file.tags AS tag SORT file.name"), base);
    // A has [book] (1), B has [book,fav] (2), D has [book] (1) => 4 rows
    expect(r.rows).toHaveLength(4);
    expect(r.rows.map((x) => x.cells[0])).toContain("#fav");
  });

  it("TASK: collects matching tasks across the vault", () => {
    const tasksByPath: Record<string, Task[]> = {
      "A.md": extractTasks("- [ ] a1\n- [x] a2", "A.md"),
      "D.md": extractTasks("- [ ] d1", "D.md"),
    };
    const r = runQuery(parseQuery("TASK WHERE !checked"), {
      rows,
      selfPath: "A.md",
      tasksOf: (p) => tasksByPath[p] ?? [],
    });
    // note: DQL "!checked" — our dialect uses "not checked"; use that form
    const r2 = runQuery(parseQuery("TASK WHERE not checked"), {
      rows,
      selfPath: "A.md",
      tasksOf: (p) => tasksByPath[p] ?? [],
    });
    expect(r2.tasks.map((t) => t.text)).toEqual(["a1", "d1"]);
    expect(r.error).toBeUndefined(); // "!checked" parses but matches nothing gracefully
  });

  it("incoming-link FROM uses the provided incomingTo set", () => {
    const r = runQuery(parseQuery("LIST FROM [[A]]"), {
      ...base,
      incomingTo: (t) => (t === "A" ? new Set(["Work/B.md"]) : new Set()),
    });
    expect(r.rows.map((x) => x.row.path)).toEqual(["Work/B.md"]);
  });

  it("a parse error surfaces without throwing", () => {
    const r = runQuery(parseQuery("BOGUS"), base);
    expect(r.error).toMatch(/Unknown query type/);
    expect(r.rows).toEqual([]);
  });

  it("TASK honors SORT (#11)", () => {
    const tasksByPath: Record<string, Task[]> = {
      "A.md": extractTasks("- [ ] zebra\n- [ ] apple", "A.md"),
    };
    const r = runQuery(parseQuery("TASK SORT text"), {
      rows,
      selfPath: "A.md",
      tasksOf: (p) => tasksByPath[p] ?? [],
    });
    expect(r.tasks.map((t) => t.text)).toEqual(["apple", "zebra"]);
  });

  it("LIMIT applies to GROUPS when grouping (#14)", () => {
    const r = runQuery(parseQuery("LIST GROUP BY status LIMIT 1"), base);
    expect(r.groups).toHaveLength(1);
  });

  it("incoming-link FROM with AND requires links to BOTH targets (#10)", () => {
    const inc: Record<string, Set<string>> = {
      A: new Set(["A.md", "Work/B.md"]),
      C: new Set(["Work/B.md"]),
    };
    const r = runQuery(parseQuery("LIST FROM [[A]] and [[C]]"), {
      ...base,
      incomingTo: (t) => inc[t] ?? new Set(),
    });
    expect(r.rows.map((x) => x.row.path)).toEqual(["Work/B.md"]); // only B links to both
  });
});

describe("review fixes (DoS + correctness)", () => {
  it("rejects catastrophic regexmatch patterns the old heuristic missed (#1)", () => {
    for (const pat of ["(a|a)*c", "(a|ab)*$", "(x|x|x|x)*y", "(.*a){20}", "(.*){10}", "(a+)+$"]) {
      const t0 = Date.now();
      // unsafe pattern → treated as no-match, and returns instantly (never run)
      expect(ev(`regexmatch("${pat.replace(/"/g, '\\"')}", "${"a".repeat(40)}!")`)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(200);
    }
    // a safe pattern still works
    expect(ev('regexmatch("^a+$", "aaa")')).toBe(true);
  });

  it("caps FLATTEN row explosion (#2)", () => {
    // Two distinct list fields cross-product (400 × 400 = 160k > the 50k cap).
    const big = Array.from({ length: 400 }, (_, i) => i);
    const rows = [row({ path: "A.md", basename: "A", properties: { arr: big, brr: big } })];
    const t0 = Date.now();
    const r = runQuery(parseQuery("LIST FLATTEN arr FLATTEN brr LIMIT 1"), {
      rows,
      selfPath: "A.md",
      tasksOf: () => [],
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.errors.some((e) => /too many rows/.test(e))).toBe(true);
  });

  it('empty/whitespace string does not equal 0 (#8)', () => {
    expect(ev('"" = 0')).toBe(false);
    expect(ev('"  " = 0')).toBe(false);
    expect(ev('"3" = 3')).toBe(true);
  });

  it("date(today)/date(now) use the bare keyword (#9)", () => {
    const today = ev("date(today)") as DateVal;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    expect(today.ms).toBe(d.getTime());
    expect(ev("date(now)")).toBeInstanceOf(DateVal);
  });

  it("clause keywords inside parens/strings don't split the query (#7)", () => {
    const q = parseQuery('LIST WHERE contains(tags, "sort") and length(tags) > 0');
    expect(q.where).toBe('contains(tags, "sort") and length(tags) > 0');
    expect(q.sort).toEqual([]);
  });

  it("AS inside a string is not an alias (#12)", () => {
    const q = parseQuery('TABLE default(x, "a as b") AS "Label"');
    expect(q.columns).toEqual([{ expr: 'default(x, "a as b")', name: "Label" }]);
  });

  it("default() is lazy — a present value ignores an erroring fallback (#15)", () => {
    const c = ctx({ properties: { x: 5 } });
    expect(ev("default(x, unknownFn())", c)).toBe(5);
  });

  it("contains() list membership honors case (#16)", () => {
    const c = ctx({ properties: { xs: ["Apple", "Pear"] } });
    expect(ev('contains(xs, "Apple")', c)).toBe(true);
    expect(ev('contains(xs, "apple")', c)).toBe(false);
    expect(ev('icontains(xs, "apple")', c)).toBe(true);
  });
});
