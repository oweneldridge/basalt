// Frontmatter round-trip safety (Phase 3d). This writes to a shared vault at
// byte 0, so the central guarantee is: editing one property NEVER disturbs any
// other line — comments, blanks, block scalars, nested maps all survive.
import { describe, expect, it } from "vitest";
import {
  parseFm,
  needsQuote,
  serializeScalar,
  serializeProp,
  setProp,
  deleteProp,
  hasFrontmatter,
  scalarType,
} from "./frontmatter";

describe("scalarType (typed properties)", () => {
  it("infers bool / number / date; a quoted value stays text", () => {
    expect(scalarType("true")).toBe("boolean");
    expect(scalarType("false")).toBe("boolean");
    expect(scalarType("42")).toBe("number");
    expect(scalarType("-3.14")).toBe("number");
    expect(scalarType("2026-07-10")).toBe("date");
    expect(scalarType("hello")).toBe("text");
    expect(scalarType('"true"')).toBe("text"); // explicitly quoted → string
    expect(scalarType("'42'")).toBe("text");
  });

  it("parseFm tags scalar props with their type", () => {
    const fm = parseFm('---\ndone: true\ncount: 7\ndue: 2026-07-10\nname: "true"\n---\nx')!;
    const byKey = Object.fromEntries(fm.props.map((p) => [p.key, p.type]));
    expect(byKey).toEqual({ done: "boolean", count: "number", due: "date", name: "text" });
  });

  it("setProp raw writes an UNQUOTED typed value (bool/number)", () => {
    const src = "---\ndone: false\n---\nx";
    expect(setProp(src, "done", ["true"], false, true)).toContain("done: true");
    expect(setProp(src, "done", ["true"], false, false)).toContain('done: "true"'); // non-raw quotes it
  });

  it("a typed edit round-trips: the written value re-parses to the same type", () => {
    for (const [val, type] of [["true", "boolean"], ["42", "number"], ["2026-07-10", "date"]] as const) {
      const out = setProp("---\nk: x\n---\nbody", "k", [val], false, true);
      const p = parseFm(out)!.props.find((pr) => pr.key === "k")!;
      expect(p.type).toBe(type); // stable widget across the round-trip
      expect(p.values[0]).toBe(val);
    }
  });

  it("a typed edit preserves other keys, comments, and the note body", () => {
    const src = "---\n# my notes\ndone: false\ntags:\n  - a\n  - b\ntitle: Hello\n---\nBody text";
    const out = setProp(src, "done", ["true"], false, true);
    expect(out).toContain("# my notes"); // comment kept
    expect(out).toContain("title: Hello");
    expect(out).toContain("  - a"); // list untouched
    expect(out).toContain("Body text");
    expect(out).toContain("done: true");
  });

  it("clearing a typed value writes `key:` (null), not a stray quote", () => {
    const out = setProp("---\ncount: 7\n---\nx", "count", [], false);
    expect(out).toContain("count:");
    expect(out).not.toMatch(/count:\s*["']/);
  });
});

describe("parseFm", () => {
  it("parses scalar, inline-array, and block-list props with line spans", () => {
    const src = ["---", "title: Hello", "tags: [a, b]", "aliases:", "  - x", "  - y", "---"].join(
      "\n",
    );
    const p = parseFm(src)!;
    expect(p.props.map((x) => [x.key, x.kind, x.values])).toEqual([
      ["title", "scalar", ["Hello"]],
      ["tags", "inline", ["a", "b"]],
      ["aliases", "list", ["x", "y"]],
    ]);
    // aliases spans body lines 2..4 (key + two items)
    const aliases = p.props[2];
    expect([aliases.start, aliases.end]).toEqual([2, 4]);
  });

  it("returns null when there is no closing fence", () => {
    expect(parseFm("---\ntitle: x\nbody")).toBeNull();
  });

  it("does not attach a list item to a scalar property", () => {
    const p = parseFm(["---", "title: Hello", "- stray", "---"].join("\n"))!;
    expect(p.props).toHaveLength(1); // the stray `- ` is a loose line, not a value
    expect(p.props[0].values).toEqual(["Hello"]);
  });

  it("marks block scalars and nested maps as complex, spanning their lines", () => {
    const src = [
      "---",
      "desc: |",
      "  line one",
      "  line two",
      "nested:",
      "  a: 1",
      "  b: 2",
      "title: T",
      "---",
    ].join("\n");
    const p = parseFm(src)!;
    const byKey = Object.fromEntries(p.props.map((x) => [x.key, x]));
    expect(byKey.desc.kind).toBe("complex");
    expect([byKey.desc.start, byKey.desc.end]).toEqual([0, 2]); // desc: | + 2 indented
    expect(byKey.nested.kind).toBe("complex");
    expect([byKey.nested.start, byKey.nested.end]).toEqual([3, 5]);
    expect(byKey.title.kind).toBe("scalar"); // simple props after a complex one still parse
  });

  it("treats a flow map / anchor value as complex", () => {
    const p = parseFm(["---", "obj: { a: 1 }", "ref: &anchor x", "---"].join("\n"))!;
    expect(p.props.map((x) => x.kind)).toEqual(["complex", "complex"]);
  });

  it("does not mistake a full-line comment for a property", () => {
    const p = parseFm(["---", "# note: not a prop", "title: T", "---"].join("\n"))!;
    expect(p.props.map((x) => x.key)).toEqual(["title"]);
  });
});

describe("needsQuote / serializeScalar", () => {
  it("leaves safe bare words unquoted", () => {
    for (const v of ["Hello", "a-word", "2026-06-13", "path/to/thing"]) {
      expect(needsQuote(v)).toBe(false);
      expect(serializeScalar(v)).toBe(v);
    }
  });
  it("quotes values that would otherwise change meaning", () => {
    expect(needsQuote("")).toBe(true);
    expect(needsQuote("true")).toBe(true);
    expect(needsQuote("42")).toBe(true);
    expect(needsQuote("a: b")).toBe(true);
    expect(needsQuote("- leading")).toBe(true);
    expect(needsQuote(" pad ")).toBe(true);
    expect(needsQuote("has # hash")).toBe(true);
  });
  it("double-quotes and escapes quotes/backslashes/newlines", () => {
    expect(serializeScalar('say "hi"')).toBe('"say \\"hi\\""');
    expect(serializeScalar("a\\b")).toBe('"a\\\\b"');
    expect(serializeScalar("line1\nline2")).toBe('"line1\\nline2"');
  });
});

describe("serializeProp", () => {
  it("scalar, block list, and empty forms", () => {
    expect(serializeProp("title", ["Hi"], false)).toEqual(["title: Hi"]);
    expect(serializeProp("tags", ["a", "b"], true)).toEqual(["tags:", "  - a", "  - b"]);
    expect(serializeProp("status", [], false)).toEqual(["status:"]);
    expect(serializeProp("tags", ["solo"], true)).toEqual(["tags:", "  - solo"]); // multi forces list
  });
});

describe("setProp / deleteProp — preservation", () => {
  const COMPLEX = [
    "---",
    "# a leading comment",
    "title: Old Title",
    "",
    "desc: |",
    "  a block scalar",
    "  second line",
    "nested:",
    "  a: 1",
    "  b: 2",
    "tags: [x, y]",
    "---",
    "",
    "Body text.",
  ].join("\n");

  it("editing one scalar leaves every other line byte-identical", () => {
    const next = setProp(COMPLEX, "title", ["New Title"], false);
    expect(next).toBe(COMPLEX.replace("title: Old Title", "title: New Title"));
    // The comment, blank line, block scalar, and nested map are untouched.
    expect(next).toContain("# a leading comment");
    expect(next).toContain("desc: |\n  a block scalar\n  second line");
    expect(next).toContain("nested:\n  a: 1\n  b: 2");
  });

  it("converts a tags list in place without touching neighbors", () => {
    const next = setProp(COMPLEX, "tags", ["alpha", "beta", "gamma"], true);
    expect(next).toContain("tags:\n  - alpha\n  - beta\n  - gamma");
    expect(next).toContain("# a leading comment");
    expect(next).toContain("nested:\n  a: 1\n  b: 2");
    expect(next.endsWith("---\n\nBody text.")).toBe(true);
  });

  it("adds a new property before the closing fence", () => {
    const next = setProp("---\ntitle: T\n---\nbody", "status", ["draft"], false);
    expect(next).toBe("---\ntitle: T\nstatus: draft\n---\nbody");
  });

  it("deletes only the target property's span", () => {
    const next = deleteProp(COMPLEX, "title");
    expect(next).not.toContain("title:");
    expect(next).toContain("# a leading comment");
    expect(next).toContain("desc: |");
    expect(next).toContain("nested:\n  a: 1\n  b: 2");
  });

  it("quotes an edited value that needs it", () => {
    const next = setProp("---\nwhen: today\n---", "when", ["2026: a year"], false);
    expect(next).toContain('when: "2026: a year"');
  });

  it("is a no-op on a source with no frontmatter", () => {
    expect(setProp("no fm here", "k", ["v"], false)).toBe("no fm here");
    expect(hasFrontmatter("no fm here")).toBe(false);
  });

  it("round-trips an edited value through parse again unchanged", () => {
    const next = setProp(COMPLEX, "title", ['Tricky: "value"'], false);
    const reparsed = parseFm(next)!;
    expect(reparsed.props.find((p) => p.key === "title")!.values).toEqual(['Tricky: "value"']);
  });
});

// Review fixes (3d adversarial pass) — each was a confirmed corruption vector.
describe("3d review regressions", () => {
  it("CRLF: edits the existing key in place (not a duplicate) and keeps \\r\\n", () => {
    const src = "---\r\ntitle: Hello\r\nfoo: bar\r\n---\r\nbody\r\n";
    const next = setProp(src, "title", ["New"]);
    expect(next).toBe("---\r\ntitle: New\r\nfoo: bar\r\n---\r\nbody\r\n");
    expect(parseFm(src)!.props.map((p) => p.key)).toEqual(["title", "foo"]);
    expect(deleteProp(src, "foo")).toBe("---\r\ntitle: Hello\r\n---\r\nbody\r\n");
  });

  it("empty key with a blank-line-separated nested block is complex (never orphaned)", () => {
    const src = "---\nkey:\n\n  a: 1\n  b: 2\ntitle: T\n---\nbody";
    const p = parseFm(src)!;
    expect(p.props.find((x) => x.key === "key")!.kind).toBe("complex");
    expect(p.props.find((x) => x.key === "key")!.end).toBe(3); // through `  b: 2`
  });

  it("inline arrays with quoted commas / nesting are complex (no lossy split)", () => {
    expect(parseFm('---\ntags: ["a,b", c]\n---')!.props[0].kind).toBe("complex");
    expect(parseFm("---\nm: [a, [b, c]]\n---")!.props[0].kind).toBe("complex");
    // a clean inline array is still editable
    expect(parseFm("---\ntags: [a, b]\n---")!.props[0].kind).toBe("inline");
  });

  it("a quoted key containing a colon is complex (never mis-split)", () => {
    const p = parseFm('---\n"a: b": value\ntitle: T\n---')!;
    expect(p.props.map((x) => [x.key, x.kind])).toEqual([
      ['"a: b": value', "complex"],
      ["title", "scalar"],
    ]);
  });

  it("duplicate keys are all marked complex (edit can't hit the wrong span)", () => {
    const p = parseFm("---\ntags:\n  - a\ntags:\n  - b\n---")!;
    expect(p.props.every((x) => x.kind === "complex")).toBe(true);
  });

  it("quotes hex/octal/binary, .inf/.nan, y/n, and sexagesimals", () => {
    for (const v of ["0x1F", "0o17", "0b1010", ".inf", ".nan", "y", "N", "12:34", "1:2:3"]) {
      expect(needsQuote(v)).toBe(true);
      expect(serializeScalar(v)).toBe(`"${v}"`);
    }
  });
});
