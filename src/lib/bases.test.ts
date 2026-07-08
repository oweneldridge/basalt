import { describe, expect, it } from "vitest";
import {
  parseProperties,
  parseBase,
  serializeBase,
  evalExpr,
  evalFilter,
  runView,
  cellParts,
  columnLabel,
  parseDuration,
  parseDateStr,
  DateVal,
  DurVal,
  LinkVal,
  toText,
  type BaseRow,
  type EvalCtx,
} from "./bases";

// Fixed local clock: 2026-01-15 00:00 local (constructed locally, so tests
// are timezone-independent).
const NOW = new Date(2026, 0, 15).getTime();

function row(over: Partial<BaseRow> = {}): BaseRow {
  return {
    name: "Note.md",
    basename: "Note",
    path: "Note.md",
    folder: "",
    ext: "md",
    size: 10,
    ctime: 1_000,
    mtime: 2_000,
    tags: [],
    linkKeys: [],
    properties: {},
    ...over,
  };
}

function mkCtx(r: Partial<BaseRow> = {}, formulas: Record<string, string> = {}): EvalCtx {
  return { row: row(r), formulas, nowMs: NOW };
}

const ev = (src: string, ctx: EvalCtx = mkCtx()) => evalExpr(src, ctx);

describe("serializeBase", () => {
  it("round-trips view edits and preserves everything else", () => {
    const src = [
      "filters: 'status != \"done\"'",
      "formulas:",
      "  age: 'now() - file.ctime'",
      "properties:",
      "  status:",
      "    displayName: State",
      "customField: keep-me",
      "views:",
      "  - type: table",
      "    name: All",
      "    order: [file.name, status]",
      "    sort:",
      "      - property: status",
      "        direction: DESC",
    ].join("\n");
    const def = parseBase(src)!;
    // Edit a view: add a column + rename.
    def.views[0] = { ...def.views[0], name: "Everything", order: ["file.name", "status", "age"] };
    const out = parseBase(serializeBase(def))!;
    // view edits applied
    expect(out.views[0].name).toBe("Everything");
    expect(out.views[0].order).toEqual(["file.name", "status", "age"]);
    expect(out.views[0].sort).toEqual([{ property: "status", direction: "DESC" }]);
    // everything Basalt's editor doesn't touch is preserved
    expect(out.formulas.age).toBe("now() - file.ctime");
    expect(out.display.status).toBe("State");
    expect(out.filters).toBe('status != "done"');
    // an unknown top-level key survives (via raw)
    expect(serializeBase(def)).toMatch(/customField:\s*keep-me/);
  });

  it("drops an optional (limit) when cleared", () => {
    const def = parseBase("views:\n  - type: table\n    name: V\n    limit: 5")!;
    def.views[0] = { ...def.views[0], limit: undefined };
    expect(parseBase(serializeBase(def))!.views[0].limit).toBeUndefined();
  });

  it("preserves top-level comments and formatting on a view edit (no data loss)", () => {
    const src = [
      "# my base notes",
      "filters: 'status != \"done\"'  # only open items",
      "formulas:",
      "  age: 'now()'",
      "views:",
      "  - type: table",
      "    name: All",
    ].join("\n");
    const def = parseBase(src)!;
    def.views[0] = { ...def.views[0], name: "Renamed" };
    const out = serializeBase(def);
    expect(out).toContain("# my base notes");
    expect(out).toContain("# only open items");
    expect(out).toContain("age: 'now()'"); // formula body untouched
    expect(parseBase(out)!.views[0].name).toBe("Renamed"); // edit applied
  });

  it("does not re-serialize (and risk dropping) a nested filter it can't fully model", () => {
    const src = [
      "views:",
      "  - type: table",
      "    name: V",
      "    filters:",
      "      and:",
      "        - 'a == 1'",
      "        - unknownKey: keep", // a shape filterNode() doesn't model
    ].join("\n");
    const def = parseBase(src)!;
    def.views[0] = { ...def.views[0], name: "V2" }; // edit something else
    expect(serializeBase(def)).toContain("unknownKey: keep");
  });
});

describe("parseProperties", () => {
  it("YAML-parses typed frontmatter values", () => {
    const p = parseProperties(
      "---\nprice: 3.5\ndone: true\ntags:\n  - a\n  - b\ntitle: Hello\n---\nbody",
    );
    expect(p).toEqual({ price: 3.5, done: true, tags: ["a", "b"], title: "Hello" });
  });
  it("returns {} when absent, unclosed, or malformed", () => {
    expect(parseProperties("no frontmatter")).toEqual({});
    expect(parseProperties("---\nkey: value")).toEqual({});
    expect(parseProperties("---\n{ not: valid: yaml:\n---\n")).toEqual({});
    expect(parseProperties("---\n- just\n- a list\n---\n")).toEqual({});
  });
  it("tolerates CRLF", () => {
    expect(parseProperties("---\r\nprice: 2\r\n---\r\nbody")).toEqual({ price: 2 });
  });
});

describe("expression basics", () => {
  it("arithmetic with precedence", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("10 / 4")).toBe(2.5);
    expect(ev("10 % 3")).toBe(1);
    expect(ev("4 / 2 / 2")).toBe(1);
    expect(ev("-3 + 1")).toBe(-2);
    expect(ev("1 / 0")).toBeNull(); // no Infinity leaks
  });
  it("string concat via +", () => {
    expect(ev('"a" + "b"')).toBe("ab");
    expect(ev('1.5.toFixed(2) + " dollars"')).toBe("1.50 dollars");
  });
  it("comparisons and equality with sensible coercions", () => {
    expect(ev("2 > 1")).toBe(true);
    expect(ev("2 <= 1")).toBe(false);
    expect(ev('"apple" < "banana"')).toBe(true);
    expect(ev('1 == "1"')).toBe(true);
    expect(ev('"x" != "y"')).toBe(true);
    expect(ev("null == null")).toBe(true);
    expect(ev('missing == null', mkCtx({ properties: {} }))).toBe(true);
  });
  it("logical ops short-circuit and ! negates truthiness", () => {
    expect(ev("true && false")).toBe(false);
    expect(ev("false || true")).toBe(true);
    expect(ev("!0")).toBe(true);
    expect(ev('!""')).toBe(true);
    expect(ev("!5")).toBe(false);
    // right side must not evaluate when short-circuited (unknownFn would error)
    expect(ev("false && unknownFn()")).toBe(false);
  });
  it("note property shorthand: bare ident ≡ note.x", () => {
    const c = mkCtx({ properties: { price: 3, status: "todo" } });
    expect(ev("price + 1", c)).toBe(4);
    expect(ev("note.price + 1", c)).toBe(4);
    expect(ev('status == "todo"', c)).toBe(true);
  });
  it("errors yield null and are reported, never thrown", () => {
    const errors: string[] = [];
    const c = { ...mkCtx(), _errors: (m: string) => errors.push(m) };
    expect(evalExpr("unknownFn(1)", c)).toBeNull();
    expect(evalExpr('"unterminated', c)).toBeNull();
    expect(evalExpr("1 + + 2 trailing", c)).toBeNull();
    expect(errors.length).toBe(3);
  });
  it("bounds runaway expressions (depth + output size)", () => {
    const deep = "(".repeat(300) + "1" + ")".repeat(300);
    expect(ev(deep)).toBeNull(); // parse-depth budget, not a stack overflow
    expect(ev('"a".repeat(200000)')).toBeNull(); // output-size bound
  });
});

describe("string/number/list methods", () => {
  it("string methods", () => {
    expect(ev('"Hello World".lower()')).toBe("hello world");
    expect(ev('"hello world".title()')).toBe("Hello World");
    expect(ev('"  x  ".trim()')).toBe("x");
    expect(ev('"abc".contains("b")')).toBe(true);
    expect(ev('"abc".containsAll("a", "c")')).toBe(true);
    expect(ev('"abc".containsAny("z", "c")')).toBe(true);
    expect(ev('"abc".startsWith("ab")')).toBe(true);
    expect(ev('"abc".endsWith("bc")')).toBe(true);
    expect(ev('"abc".slice(1)')).toBe("bc");
    expect(ev('"abc".slice(0, 2)')).toBe("ab");
    expect(ev('"abc".reverse()')).toBe("cba");
    expect(ev('"ab".repeat(3)')).toBe("ababab");
    expect(ev('"a-b-c".split("-").length')).toBe(3);
    expect(ev('"a-b-c".split("-", 2).length')).toBe(2);
    expect(ev('"x".length')).toBe(1);
    expect(ev('"".isEmpty()')).toBe(true);
  });
  it("replace with plain string replaces ALL occurrences", () => {
    expect(ev('"a.b.c".replace(".", "-")')).toBe("a-b-c");
  });
  it("replace/split/matches with regex literals (incl. capture groups)", () => {
    expect(ev('"foo123bar".replace(/[0-9]+/, "#")')).toBe("foo#bar");
    expect(ev('"a1b2".replace(/([a-z])([0-9])/g, "$2$1")')).toBe("1a2b");
    expect(ev('"a  b   c".split(/ +/).length')).toBe(3);
    expect(ev('/^ab/.matches("abc")')).toBe(true);
    expect(ev('/^b/.matches("abc")')).toBe(false);
  });
  it("number methods", () => {
    expect(ev("(2.345).round(2)")).toBe(2.35);
    expect(ev("(2.5).floor()")).toBe(2);
    expect(ev("(2.1).ceil()")).toBe(3);
    expect(ev("(-4).abs()")).toBe(4);
    expect(ev("(1.005).toFixed(1)")).toBe("1.0");
    expect(ev("number(true)")).toBe(1);
    expect(ev('number("2.5")')).toBe(2.5);
  });
  it("list methods incl. filter/map/reduce scoped vars", () => {
    const c = mkCtx({ properties: { xs: [3, 1, 2], names: ["a", "b"] } });
    expect(ev("xs.length", c)).toBe(3);
    expect(ev("xs.contains(2)", c)).toBe(true);
    expect(ev("xs.containsAll(1, 3)", c)).toBe(true);
    expect(ev("xs.containsAny(9, 2)", c)).toBe(true);
    expect(ev('xs.sort().join(", ")', c)).toBe("1, 2, 3");
    expect(ev('names.join("-")', c)).toBe("a-b");
    expect(ev("xs.reverse().join(\",\")", c)).toBe("2,1,3");
    expect(ev("xs.slice(0, 2).length", c)).toBe(2);
    expect(ev("xs.filter(value > 1).length", c)).toBe(2);
    expect(ev("xs.map(value * 10).sort().join(\",\")", c)).toBe("10,20,30");
    expect(ev("xs.map(index).join(\",\")", c)).toBe("0,1,2");
    expect(ev("xs.reduce(acc + value, 0)", c)).toBe(6);
    expect(ev("list(5).length")).toBe(1);
    expect(ev("list(xs).length", c)).toBe(3);
    expect(ev("xs.unique().length", c)).toBe(3);
    expect(ev("min(xs)", c)).toBe(1);
    expect(ev("max(xs, 99)", c)).toBe(99);
  });
  it("flat flattens nested lists", () => {
    const c = mkCtx({ properties: { xs: [1, [2, [3, 4]], 5] } });
    expect(ev('xs.flat().join(",")', c)).toBe("1,2,3,4,5");
  });
});

describe("dates and durations", () => {
  it("parses dates as LOCAL time and rejects rollover", () => {
    expect(parseDateStr("2026-01-15")).toBe(new Date(2026, 0, 15).getTime());
    expect(parseDateStr("2026-01-15 08:30")).toBe(new Date(2026, 0, 15, 8, 30).getTime());
    expect(parseDateStr("2026-13-01")).toBeNull();
    expect(parseDateStr("2026-02-30")).toBeNull();
    expect(parseDateStr("nonsense")).toBeNull();
  });
  it("parses durations incl. compounds", () => {
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("2h30m")).toBe(9_000_000);
    expect(parseDuration("1d 2h")).toBe(93_600_000);
    expect(parseDuration("junk")).toBeNull();
    expect(parseDuration("1d junk")).toBeNull();
  });
  it("date fields, arithmetic, and comparisons", () => {
    expect(ev('date("2026-01-15").year')).toBe(2026);
    expect(ev('date("2026-01-15").month')).toBe(1);
    expect(ev('date("2026-01-15").day')).toBe(15);
    expect(toText(ev('date("2026-01-15") + "1d"') as DateVal)).toBe("2026-01-16");
    expect(toText(ev('date("2026-01-16") - date("2026-01-15")') as DurVal)).toBe("1d");
    expect(ev('date("2026-01-16") - date("2026-01-15") == duration("1d")')).toBe(true);
    expect(ev('date("2026-01-16") - date("2026-01-15") == "1d"')).toBe(true);
    expect(ev('date("2026-01-02") > date("2026-01-01")')).toBe(true);
    // date vs date-string comparison coerces
    expect(ev('date("2026-01-02") > "2026-01-01"')).toBe(true);
    expect(ev('due == "2026-03-01"', mkCtx({ properties: { due: "2026-03-01" } }))).toBe(true);
  });
  it("now/today honor the injected clock", () => {
    expect(toText(ev("today()") as DateVal)).toBe("2026-01-15");
    expect(ev("now().year")).toBe(2026);
    expect(ev('today() - "1d" == date("2026-01-14")')).toBe(true);
  });
  it("format() uses the Moment subset with ISO fallback", () => {
    expect(ev('date("2026-01-15").format("YYYY/MM/DD")')).toBe("2026/01/15");
  });
  it("relative() humanizes", () => {
    expect(ev('date("2026-01-14").relative()')).toBe("1 day ago");
    expect(ev('date("2026-01-22").relative()')).toBe("in 1 week");
  });
  it("date().date() strips time; time() extracts it", () => {
    expect(toText(ev('date("2026-01-15 08:30").date()') as DateVal)).toBe("2026-01-15");
    expect(ev('date("2026-01-15 08:30").time()')).toBe("08:30:00");
  });
});

describe("file.* and links", () => {
  const c = () =>
    mkCtx({
      name: "Book.md",
      basename: "Book",
      path: "Reading/Book.md",
      folder: "Reading",
      ext: "md",
      size: 42,
      mtime: new Date(2026, 0, 10).getTime(),
      tags: ["book", "project/basalt"],
      linkKeys: ["textbook", "reading/textbook"],
      properties: { status: "todo" },
    });
  it("file fields", () => {
    expect(ev("file.name", c())).toBe("Book.md");
    expect(ev("file.basename", c())).toBe("Book");
    expect(ev("file.path", c())).toBe("Reading/Book.md");
    expect(ev("file.folder", c())).toBe("Reading");
    expect(ev('file.ext == "md"', c())).toBe(true);
    expect(ev("file.size", c())).toBe(42);
    expect(ev("file.mtime.year", c())).toBe(2026);
    expect(ev("file.tags.length", c())).toBe(2);
  });
  it("hasTag matches any argument and nested children", () => {
    expect(ev('file.hasTag("book")', c())).toBe(true);
    expect(ev('file.hasTag("#book")', c())).toBe(true);
    expect(ev('file.hasTag("project")', c())).toBe(true); // parent matches nested
    expect(ev('file.hasTag("proj")', c())).toBe(false); // no prefix matching
    expect(ev('file.hasTag("nope", "book")', c())).toBe(true);
  });
  it("hasLink matches by name or path, with or without .md", () => {
    expect(ev('file.hasLink("Textbook")', c())).toBe(true);
    expect(ev('file.hasLink("Textbook.md")', c())).toBe(true);
    expect(ev('file.hasLink("Reading/Textbook")', c())).toBe(true);
    expect(ev('file.hasLink("Other")', c())).toBe(false);
  });
  it("inFolder includes subfolders; root contains everything", () => {
    expect(ev('file.inFolder("Reading")', c())).toBe(true);
    expect(ev('file.inFolder("Read")', c())).toBe(false);
    expect(ev('file.inFolder("")', c())).toBe(true);
    const sub = mkCtx({ folder: "Reading/2026" });
    expect(ev('file.inFolder("Reading")', sub)).toBe(true);
  });
  it("hasProperty and asLink", () => {
    expect(ev('file.hasProperty("status")', c())).toBe(true);
    expect(ev('file.hasProperty("missing")', c())).toBe(false);
    const l = ev('file.asLink("Read me")', c()) as LinkVal;
    expect(l).toBeInstanceOf(LinkVal);
    expect(l.target).toBe("Reading/Book.md");
    expect(l.display).toBe("Read me");
  });
  it("link() global and linksTo; file() resolves via lookup", () => {
    const target = row({ basename: "Other", path: "Other.md", name: "Other.md" });
    const ctx: EvalCtx = { ...mkCtx(), lookupFile: (t) => (t.includes("Other") ? target : null) };
    expect((ev('link("Other", "o")', ctx) as LinkVal).display).toBe("o");
    expect(ev('link("Other").linksTo(file("Other.md"))', ctx)).toBe(true);
    expect(ev('file("Other.md").basename', ctx)).toBe("Other");
    expect(ev('file("Missing.md")', ctx)).toBeNull();
  });
});

describe("if / isType / isTruthy / html safety", () => {
  it("if() is lazy and defaults false-branch to null", () => {
    expect(ev('if(true, "y", "n")')).toBe("y");
    expect(ev('if(false, "y", "n")')).toBe("n");
    expect(ev('if(false, "y")')).toBeNull();
    expect(ev('if(true, "y", unknownFn())')).toBe("y"); // false branch not evaluated
  });
  it("isType / isTruthy / toString", () => {
    expect(ev('(5).isType("number")')).toBe(true);
    expect(ev('"x".isType("string")')).toBe(true);
    expect(ev('date("2026-01-01").isType("date")')).toBe(true);
    expect(ev('null.isType("null")')).toBe(true);
    expect(ev("(0).isTruthy()")).toBe(false);
    expect(ev("(3).toString()")).toBe("3");
  });
  it("html() renders as plain text parts (never live HTML)", () => {
    const parts = cellParts(ev('html("<img src=x onerror=alert(1)>")'));
    expect(parts).toEqual([{ kind: "text", text: "<img src=x onerror=alert(1)>" }]);
  });
  it("escapeHTML escapes", () => {
    expect(ev('escapeHTML("<b>&\\"")')).toBe("&lt;b&gt;&amp;&quot;");
  });
});

describe("formulas", () => {
  it("evaluates, chains, and caches per row", () => {
    const c = mkCtx({ properties: { price: 10, age: 4 } }, {
      ppu: "(price / age).round(2)",
      label: 'formula.ppu + " each"',
    });
    expect(ev("formula.ppu", c)).toBe(2.5);
    expect(ev("formula.label", c)).toBe("2.5 each");
  });
  it("cycles resolve to null instead of recursing", () => {
    const c = mkCtx({}, { a: "formula.b", b: "formula.a" });
    expect(ev("formula.a", c)).toBeNull();
  });
});

describe("filters", () => {
  const c = () => mkCtx({ tags: ["book"], folder: "Shelf", properties: { status: "todo" } });
  it("and/or/not semantics (not = none may match)", () => {
    expect(evalFilter({ and: ['status == "todo"', 'file.hasTag("book")'] }, c())).toBe(true);
    expect(evalFilter({ and: ['status == "done"', 'file.hasTag("book")'] }, c())).toBe(false);
    expect(evalFilter({ or: ['status == "done"', 'file.hasTag("book")'] }, c())).toBe(true);
    expect(evalFilter({ not: ['status == "done"', 'file.hasTag("nope")'] }, c())).toBe(true);
    expect(evalFilter({ not: ['status == "todo"'] }, c())).toBe(false);
    expect(evalFilter("status != \"done\"", c())).toBe(true);
    expect(evalFilter(undefined, c())).toBe(true);
  });
  it("a broken expression filters the row out, not the whole view", () => {
    expect(evalFilter("totally garbage ((", c())).toBe(false);
  });
});

describe("parseBase", () => {
  it("parses the official example shape", () => {
    const def = parseBase(`
filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - note.age
      - formula.ppu
    summaries:
      formula.ppu: Average
`)!;
    expect(def).not.toBeNull();
    expect(Object.keys(def.formulas)).toEqual(["formatted_price", "ppu"]);
    expect(def.display.status).toBe("Status");
    expect(def.display["formula.formatted_price"]).toBe("Price");
    expect(def.summaries.customAverage).toContain("mean");
    expect(def.views).toHaveLength(1);
    const v = def.views[0];
    expect(v.limit).toBe(10);
    expect(v.groupBy).toEqual({ property: "note.age", direction: "DESC" });
    expect(v.order).toEqual(["file.name", "note.age", "formula.ppu"]);
    expect(v.summaries).toEqual({ "formula.ppu": "Average" });
    expect(def.filters && typeof def.filters === "object" && "or" in def.filters).toBe(true);
  });
  it("is tolerant: bad YAML → null; anything else → default view", () => {
    expect(parseBase(": : : not yaml [")).toBeNull();
    const empty = parseBase("")!;
    expect(empty.views).toEqual([{ type: "table", name: "Table" }]);
    const junk = parseBase("views: 12\nfilters: 3.5\nformulas: [1,2]")!;
    expect(junk.views).toHaveLength(1);
    expect(junk.filters).toBeUndefined();
  });
});

describe("runView", () => {
  const rows = [
    row({ name: "A.md", basename: "A", path: "A.md", properties: { price: 10, age: 2, status: "todo" } }),
    row({ name: "B.md", basename: "B", path: "B.md", properties: { price: 30, age: 3, status: "reading" } }),
    row({ name: "C.md", basename: "C", path: "C.md", properties: { price: 20, age: 4, status: "done" } }),
    row({ name: "D.md", basename: "D", path: "D.md", properties: { price: 5, age: 1, status: "todo" } }),
    row({ name: "E.md", basename: "E", path: "E.md", properties: { status: "todo" } }),
  ];
  const def = parseBase(`
filters:
  and:
    - 'status != "done"'
formulas:
  ppu: "(price / age).round(2)"
properties:
  status:
    displayName: Status
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: Books
    order: [file.name, status, price, formula.ppu]
    sort:
      - property: price
        direction: DESC
    limit: 3
    summaries:
      price: Average
      formula.ppu: customAverage
  - type: table
    name: Grouped
    order: [file.name]
    groupBy:
      property: status
      direction: ASC
`)!;

  it("filters, sorts (nulls last), limits, and computes formula columns", () => {
    const r = runView(def, def.views[0], rows, { nowMs: NOW });
    expect(r.total).toBe(4); // C filtered out by the global filter
    expect(r.truncated).toBe(true);
    expect(r.rows.map((x) => x.row.basename)).toEqual(["B", "A", "D"]); // E's null price sorts last
    expect(r.columns.map((c) => c.label)).toEqual(["Name", "Status", "price", "formula.ppu"]);
    expect(r.rows.map((x) => x.cells[3])).toEqual([10, 5, 5]);
    expect(r.errors).toEqual([]);
    // the file.name column renders as the file's link (click-to-open)
    expect(cellParts(r.rows[0].cells[0])).toEqual([{ kind: "link", text: "B", target: "B.md" }]);
  });
  it("summaries: builtin Average + custom formula over shown rows", () => {
    const r = runView(def, def.views[0], rows, { nowMs: NOW });
    expect(r.summary).not.toBeNull();
    expect(r.summary![2]).toBe("15"); // (30+10+5)/3
    expect(r.summary![3]).toBe("6.667"); // mean(10,5,5).round(3)
  });
  it("groups by property with direction", () => {
    const r = runView(def, def.views[1], rows, { nowMs: NOW });
    expect(r.groups).not.toBeNull();
    expect(r.groups!.map((g) => g.label)).toEqual(["reading", "todo"]);
    expect(r.groups![1].rows.map((x) => x.row.basename)).toEqual(["A", "D", "E"]);
  });
  it("one broken formula doesn't blank the view; errors are surfaced", () => {
    const bad = parseBase(`
formulas:
  boom: "nonsense((("
views:
  - type: table
    name: T
    order: [file.name, formula.boom]
`)!;
    const r = runView(bad, bad.views[0], rows.slice(0, 2), { nowMs: NOW });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].cells[1]).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("DoS guards (untrusted .base)", () => {
  it("rejects catastrophic-backtracking regex literals at parse time (no freeze)", () => {
    const errors: string[] = [];
    const c = { ...mkCtx(), _errors: (m: string) => errors.push(m) };
    const t0 = Date.now();
    // (a+)+$ over 30 a's + ! would hang for minutes if run — must be refused fast
    expect(evalExpr('/(a+)+$/.matches("' + "a".repeat(30) + '!")', c)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(errors.some((e) => /unsafe regex/.test(e))).toBe(true);
    // a safe regex still works
    expect(ev('/^a+$/.matches("aaa")')).toBe(true);
  });
  it("bounds exponential value growth (reduce acc+acc) via the allocation budget", () => {
    const errors: string[] = [];
    const c = { ...mkCtx({ properties: { xs: Array.from({ length: 40 }, (_, i) => i) } }), _errors: (m: string) => errors.push(m) };
    const t0 = Date.now();
    // acc + acc doubled 40× would be a 2^40-element array; budget must cut it off
    expect(evalExpr('xs.reduce(acc + acc, list("x"))', c)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(errors.some((e) => /allocation budget/.test(e))).toBe(true);
  });
  it("normal expressions are unaffected by the budgets", () => {
    const c = mkCtx({ properties: { price: 3.14159, xs: [1, 2, 3, 4, 5] } });
    expect(ev("price.toFixed(2) + \" dollars\"", c)).toBe("3.14 dollars");
    expect(ev("xs.map(value * 2).reduce(acc + value, 0)", c)).toBe(30);
  });
});

describe("review fixes", () => {
  it("#4 bracket access reaches dashed/spaced property names", () => {
    const c = mkCtx({ properties: { "due-date": "2026-03-01", "my prop": 7 } });
    expect(ev('note["due-date"]', c)).toBe("2026-03-01");
    expect(ev('note["my prop"] + 1', c)).toBe(8);
    expect(ev('file.properties["due-date"]', c)).toBe("2026-03-01");
  });
  it("#5 frontmatter wikilink strings are LinkVal (== / linksTo / cell render)", () => {
    const c = mkCtx({ properties: { author: "[[Jane Doe]]" } });
    expect(ev('author == "Jane Doe"', c)).toBe(true);
    expect(ev('author.linksTo("Jane Doe")', c)).toBe(true);
    expect(cellParts(ev("author", c))).toEqual([{ kind: "link", text: "Jane Doe", target: "Jane Doe" }]);
  });
  it("#11 date + month/year is calendar-aware, not fixed-ms", () => {
    expect(toText(ev('date("2026-01-31") + "1M"') as DateVal)).toBe("2026-03-03"); // Jan31 + 1mo rolls
    expect(toText(ev('date("2026-01-15") + "1y"') as DateVal)).toBe("2027-01-15");
    expect(toText(ev('date("2026-03-15") - "1M"') as DateVal)).toBe("2026-02-15");
  });
  it("#12 link() == link() compares targets, not references", () => {
    expect(ev('link("Note") == link("Note")')).toBe(true);
    expect(ev('link("Note.md") == link("Note")')).toBe(true);
    expect(ev('list(link("A")).contains(link("A"))')).toBe(true);
  });
  it("#13 date-string + duration does date math, not string concat", () => {
    const c = mkCtx({ properties: { due: "2026-03-01" } });
    expect(toText(ev('due + "1d"', c) as DateVal)).toBe("2026-03-02");
    expect(ev('due + "1d" == date("2026-03-02")', c)).toBe(true);
  });
  it("#15 summary key matches across note./bare forms", () => {
    const def = parseBase(
      "views:\n  - type: table\n    name: T\n    order: [note.price]\n    summaries:\n      price: Sum\n",
    )!;
    const rows = [
      row({ properties: { price: 2 } }),
      row({ path: "B.md", properties: { price: 3 } }),
    ];
    const r = runView(def, def.views[0], rows, { nowMs: NOW });
    expect(r.summary![0]).toBe("5");
  });
  it("#16 regex character class may contain '/'", () => {
    expect(ev('"a/b".split(/[/]/).length')).toBe(2);
    expect(ev('/[a/b]/.matches("/")')).toBe(true);
  });
  it("#18 empty string does not equal 0; BOM/whitespace fences still parse", () => {
    expect(ev('"" == 0')).toBe(false);
    expect(ev('note.missing == 0', mkCtx())).toBe(false);
    expect(parseProperties("﻿---\nprice: 4\n--- \nbody")).toEqual({ price: 4 });
  });
});

describe("cellParts / columnLabel", () => {
  it("renders values as typed parts", () => {
    expect(cellParts(true)).toEqual([{ kind: "check", checked: true }]);
    expect(cellParts("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(cellParts(null)).toEqual([]);
    expect(cellParts("[[Note|alias]]")).toEqual([{ kind: "link", text: "alias", target: "Note" }]);
    expect(cellParts("[[Note]]")).toEqual([{ kind: "link", text: "Note", target: "Note" }]);
    expect(cellParts("#tag/x")).toEqual([{ kind: "tag", text: "#tag/x" }]);
    expect(cellParts(new LinkVal("Folder/Doc.md"))).toEqual([
      { kind: "link", text: "Doc", target: "Folder/Doc.md" },
    ]);
    expect(cellParts(["a", "b"])).toEqual([
      { kind: "text", text: "a" },
      { kind: "text", text: ", " },
      { kind: "text", text: "b" },
    ]);
    expect(cellParts(new DateVal(new Date(2026, 0, 15).getTime()))).toEqual([
      { kind: "text", text: "2026-01-15" },
    ]);
  });
  it("labels use displayName, bare property names, and Name for file.name", () => {
    const def = parseBase("properties:\n  status:\n    displayName: Status\n")!;
    expect(columnLabel("file.name", def)).toBe("Name");
    expect(columnLabel("status", def)).toBe("Status");
    expect(columnLabel("note.status", def)).toBe("Status");
    expect(columnLabel("price", def)).toBe("price");
    expect(columnLabel("formula.x", def)).toBe("formula.x");
  });
});

describe("serializeBase groupBy round-trip", () => {
  const SRC = "views:\n  - type: table\n    name: All\n    order:\n      - file.name\n";
  it("writes an added groupBy in the documented { property, direction } shape", () => {
    const def = parseBase(SRC)!;
    def.views[0].groupBy = { property: "status", direction: "DESC" };
    const out = serializeBase(def);
    expect(out).toMatch(/groupBy:/);
    const back = parseBase(out)!;
    expect(back.views[0].groupBy).toEqual({ property: "status", direction: "DESC" });
  });
  it("removing groupBy drops the key", () => {
    const def = parseBase("views:\n  - type: table\n    name: All\n    groupBy:\n      property: status\n      direction: ASC\n")!;
    expect(def.views[0].groupBy).toEqual({ property: "status", direction: "ASC" });
    def.views[0].groupBy = undefined;
    expect(parseBase(serializeBase(def))!.views[0].groupBy).toBeUndefined();
  });
});
