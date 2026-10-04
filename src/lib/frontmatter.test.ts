// Frontmatter round-trip safety (Phase 3d). This writes to a shared vault at
// byte 0, so the central guarantee is: editing one property NEVER disturbs any
// other line — comments, blanks, block scalars, nested maps all survive.
import { describe, expect, it } from "vitest";
import {
  parseFm,
  splitTemplate,
  mergeTemplateProps,
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
    expect(scalarType("yes")).toBe("boolean");
    expect(scalarType("Off")).toBe("boolean");
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

describe("lists that aren't plain", () => {
  it("treats a list of maps or flow items as complex", () => {
    const maps = parseFm("---\npeople:\n  - name: Ann\n    role: lead\n  - name: Cy\nnext: 1\n---\n")!;
    expect(maps.props.find((p) => p.key === "people")?.kind).toBe("complex");
    expect(maps.props.find((p) => p.key === "next")?.values).toEqual(["1"]);
    const flow = parseFm("---\nxs:\n  - [a, b]\n---\n")!;
    expect(flow.props[0].kind).toBe("complex");
  });
  it("keeps plain scalar lists editable, including URLs and quoted links", () => {
    const fm = parseFm('---\nsee:\n  - "[[Note]]"\n  - https://example.com/a\n  - 10:30\n---\n')!;
    expect(fm.props[0].kind).toBe("list");
    expect(fm.props[0].values).toEqual(["[[Note]]", "https://example.com/a", "10:30"]);
  });
});

describe("templates with properties", () => {
  it("splits a template into its property lines and body", () => {
    const t = "---\ntags: [a]\nstatus: draft\n---\n## Body\n";
    const s = splitTemplate(t)!;
    expect(s.props).toEqual(["tags: [a]", "status: draft"]);
    expect(s.body).toBe("## Body\n");
    expect(t.slice(s.offset)).toBe(s.body);
    expect(splitTemplate("## No properties\n")).toBeNull();
  });

  it("adds a frontmatter block to a note without one", () => {
    expect(mergeTemplateProps("Hello\n", ["status: draft"])).toBe("---\nstatus: draft\n---\nHello\n");
  });

  it("merges like Obsidian and leaves every other line alone", () => {
    const note = "---\n# keep me\ntags:\n  - a\nstatus: done\nowner: Ann\nmeta:\n  x: 1\n---\nBody\n";
    const out = mergeTemplateProps(note, ["tags: [a, b]", "status: 'draft'", "owner:", "meta:", "  y: 2", "due: 2026-10-04"]);
    expect(out).toBe(
      "---\n# keep me\ntags:\n  - a\n  - b\nstatus: 'draft'\nowner: Ann\nmeta:\n  x: 1\ndue: 2026-10-04\n---\nBody\n",
    );
  });

  it("rejects invalid template YAML", () => {
    expect(() => mergeTemplateProps("---\na: 1\n---\n", ["a: [unclosed"])).toThrow();
  });
});

describe("template merge keeps what the note has", () => {
  const m = (note: string, props: string[]) => mergeTemplateProps(`---\n${note}\n---\nBody\n`, props);
  it("a single value meeting a template list becomes a list of both", () => {
    expect(m("tags: work", ["tags: [meeting]"])).toBe("---\ntags:\n  - work\n  - meeting\n---\nBody\n");
  });
  it("adds only missing items, keeps the note's lines and types", () => {
    expect(m("nums:\n  - 1\n  - 2", ["nums: [2, 3]"])).toBe("---\nnums:\n  - 1\n  - 2\n  - 3\n---\nBody\n");
    expect(m("tags: [a]", ["tags: [b, 'c, d']"])).toBe('---\ntags: [a, b, "c, d"]\n---\nBody\n');
    const same = "tags: [a, b]";
    expect(m(same, ["tags: [a]"])).toBe(`---\n${same}\n---\nBody\n`);
  });
  it("never writes a list of maps as strings, and an empty value wipes nothing", () => {
    expect(m("people:\n  - Ann", ["people:", "  - name: Bob"])).toBe("---\npeople:\n  - Ann\n---\nBody\n");
    expect(m("status: active", ['status: ""'])).toBe("---\nstatus: active\n---\nBody\n");
  });
  it("matches a quoted template key to the note's key", () => {
    expect(m("title: old", ['"title": new'])).toBe('---\n"title": new\n---\nBody\n');
  });
});

describe("template merge, second pass", () => {
  const m = (note: string, props: string[]) => mergeTemplateProps(`---\n${note}\n---\nBody\n`, props);
  it("keeps a quoted value whole when it becomes a list", () => {
    expect(m('tags: "#a #b"', ["tags: [meeting]"])).toBe('---\ntags:\n  - "#a #b"\n  - meeting\n---\nBody\n');
  });
  it("a template single value joins the note's list instead of replacing it", () => {
    expect(m("tags:\n  - work", ["tags: meeting"])).toBe("---\ntags:\n  - work\n  - meeting\n---\nBody\n");
    expect(m("tags: [work]", ["tags: work"])).toBe("---\ntags: [work]\n---\nBody\n");
  });
  it("leaves shapes it can't extend safely alone", () => {
    expect(m("tags: [a] # mine", ["tags: [b]"])).toBe("---\ntags: [a] # mine\n---\nBody\n");
    expect(m("note: first\n  continued", ["note: [x]"])).toBe("---\nnote: first\n  continued\n---\nBody\n");
  });
  it("quotes flow items that need it as valid YAML", () => {
    const out = m("tags: [a]", ['tags: ["line\\nnext, more"]']);
    expect(out).toBe('---\ntags: [a, "line\\nnext, more"]\n---\nBody\n');
  });
});

describe("template merge, third pass", () => {
  const m = (note: string, props: string[]) => mergeTemplateProps(`---\n${note}\n---\nBody\n`, props);
  it("leaves a flow list that wraps onto more lines alone", () => {
    const note = "tags: [project, meeting,\n  client-x]";
    expect(m(note, ["tags: q3"])).toBe(`---\n${note}\n---\nBody\n`);
  });
  it("appends after a trailing comma without a doubled one", () => {
    expect(m("tags: [a, b,]", ["tags: [meeting]"])).toBe("---\ntags: [a, b, meeting]\n---\nBody\n");
    expect(m("tags: [a, ]", ["tags: b"])).toBe("---\ntags: [a, b]\n---\nBody\n");
  });
  it("leaves a value continued after a blank line alone", () => {
    const note = "note: first\n\n  continued";
    expect(m(note, ["note: [x]"])).toBe(`---\n${note}\n---\nBody\n`);
  });
  it("merges a single tag or alias with the template's instead of replacing it", () => {
    expect(m("tags: work", ["tags: meeting"])).toBe("---\ntags:\n  - work\n  - meeting\n---\nBody\n");
    expect(m("aliases: Old", ["aliases: New"])).toBe("---\naliases:\n  - Old\n  - New\n---\nBody\n");
    expect(m("status: done", ["status: draft"])).toBe("---\nstatus: draft\n---\nBody\n");
  });
});

describe("template merge with comma-separated aliases and tags", () => {
  const m = (note: string, props: string[]) => mergeTemplateProps(`---\n${note}\n---\nBody\n`, props);
  it("keeps each comma-separated alias or tag as its own item", () => {
    expect(m("aliases: Foo, Bar", ["aliases: New"])).toBe("---\naliases:\n  - Foo\n  - Bar\n  - New\n---\nBody\n");
    expect(m("tags: work, home", ["tags: [home, q3]"])).toBe("---\ntags:\n  - work\n  - home\n  - q3\n---\nBody\n");
    expect(m('aliases: "Smith, John"', ["aliases: JS"])).toBe('---\naliases:\n  - "Smith, John"\n  - JS\n---\nBody\n');
    expect(m("aliases: Foo, *Bar", ["aliases: New"])).toBe('---\naliases:\n  - Foo\n  - "*Bar"\n  - New\n---\nBody\n');
  });
  it("leaves the note alone when the template adds nothing new", () => {
    const note = "---\naliases: Foo, Bar\n---\nBody\n";
    expect(mergeTemplateProps(note, ["aliases: Bar"])).toBe(note);
  });
});
