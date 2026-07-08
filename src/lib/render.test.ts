import { toggleTaskLine } from "./render";
// Markdown→HTML rendering for Reading mode / export. Output is inserted via
// innerHTML, so escaping is security-critical and gets first-class coverage.
import { describe, expect, it } from "vitest";
import { renderMarkdown, renderInline, escapeHtml } from "./render";

describe("escaping (XSS safety)", () => {
  it("escapes HTML in prose, code, and attributes", () => {
    expect(renderMarkdown("a <script>alert(1)</script> b")).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(renderMarkdown("`<b>x</b>`")).toContain("<code class=\"md-code-inline\">&lt;b&gt;x&lt;/b&gt;</code>");
    expect(renderInline('[x](javascript:alert("x"))')).toContain('data-href="javascript:alert(&quot;x&quot;)"');
    expect(escapeHtml('<>&"')).toBe("&lt;&gt;&amp;&quot;");
  });
  it("never emits a raw script tag from user input", () => {
    const html = renderMarkdown("# <img src=x onerror=alert(1)>\n\ntext");
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
  it("escapes double-quotes in attribute values (no breakout)", () => {
    // The injected `"` becomes &quot;, so it stays INSIDE the attribute value
    // (a harmless string) and can't start a new on*= handler attribute.
    expect(renderInline('[[a"x]]')).toContain('data-target="a&quot;x"');
    expect(renderInline('[t](h" onclick=x)')).toContain("&quot;");
    expect(renderInline('![a](p" onerror=alert(1))')).toContain("&quot;");
    // No literal double-quote from user content survives unescaped: every `"`
    // in the output is a tag/attr delimiter, so attribute count stays sane.
    const html = renderInline('[[" onload=alert(1)]]');
    expect(html).toContain("&quot;");
    expect(html).not.toContain('" onload='); // would be a real injected attribute
  });
});

describe("inline", () => {
  it("bold, italic, strikethrough, highlight, inline code", () => {
    expect(renderInline("**b** _i_ ~~s~~ ==h== `c`")).toBe(
      '<strong>b</strong> <em>i</em> <del>s</del> <mark class="md-highlight">h</mark> <code class="md-code-inline">c</code>',
    );
  });
  it("nests emphasis around links", () => {
    expect(renderInline("**[[Note]]**")).toBe(
      '<strong><a class="md-wikilink" data-target="Note">Note</a></strong>',
    );
  });
  it("wikilinks (alias + heading) and md links", () => {
    expect(renderInline("[[Foo|bar]]")).toContain('data-target="Foo">bar</a>');
    // Raw target kept (folder + heading) so resolution matches the editor;
    // display falls back to the bare note name.
    expect(renderInline("[[notes/Foo#H]]")).toContain('data-target="notes/Foo#H">Foo</a>');
    expect(renderInline("[text](https://a.com)")).toBe(
      '<a class="md-link" data-href="https://a.com">text</a>',
    );
  });
  it("tags and autolinks", () => {
    expect(renderInline("see #project/sub here")).toContain('<span class="md-tag">#project/sub</span>');
    expect(renderInline("a #b")).toContain('<span class="md-tag">#b</span>');
    expect(renderInline("x #not-after-word")).toContain("md-tag"); // standalone tag
    expect(renderInline("<https://a.com>")).toContain('data-href="https://a.com"');
  });
  it("does not treat a heading '# ' or 'a#b' as a tag", () => {
    expect(renderInline("a#b")).toBe("a#b");
  });
  it("images / embeds become resolvable img tags", () => {
    expect(renderInline("![alt](pic.png)")).toContain('<img class="md-image" data-basalt-img="pic.png"');
    expect(renderInline("![[diagram.png]]")).toContain('<img class="md-embed" data-basalt-img="diagram.png"');
  });
});

describe("blocks", () => {
  it("headings by level", () => {
    expect(renderMarkdown("# A\n## B")).toBe("<h1>A</h1>\n<h2>B</h2>");
  });
  it("paragraphs join soft-wrapped lines", () => {
    expect(renderMarkdown("one\ntwo\n\nthree")).toBe("<p>one\ntwo</p>\n<p>three</p>");
  });
  it("horizontal rule", () => {
    expect(renderMarkdown("---")).toBe("<hr />");
    expect(renderMarkdown("***")).toBe("<hr />");
  });
  it("fenced code is escaped and language-classed", () => {
    expect(renderMarkdown("```js\nlet x = 1 < 2;\n```")).toBe(
      '<pre class="md-code"><code class="language-js">let x = 1 &lt; 2;</code></pre>',
    );
  });
  it("tags a ```mermaid block so reading/export can find it", () => {
    expect(renderMarkdown("```mermaid\ngraph TD; A-->B\n```")).toContain(
      '<code class="language-mermaid">graph TD; A--&gt;B</code>',
    );
  });
  it("a '#' inside a fence is not a heading", () => {
    expect(renderMarkdown("```\n# not a heading\n```")).toContain("# not a heading");
    expect(renderMarkdown("```\n# not a heading\n```")).not.toContain("<h1>");
  });
  it("bullet list with task checkboxes", () => {
    const html = renderMarkdown("- a\n- [ ] todo\n- [x] done");
    expect(html).toContain("<ul><li>a</li>");
    expect(html).toContain('<li class="md-task"><input type="checkbox" class="md-task-check" data-task-line="1" /> todo</li>');
    expect(html).toContain('data-task-line="2" checked /> done');
  });
  it("nested lists", () => {
    const html = renderMarkdown("- a\n  - b\n- c");
    expect(html).toBe("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
  });
  it("ordered list", () => {
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });
  it("blockquote and callout", () => {
    expect(renderMarkdown("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
    const c = renderMarkdown("> [!warning] Heads up\n> body text");
    expect(c).toContain('<div class="md-callout md-callout-warning">');
    expect(c).toContain('<div class="md-callout-title">Heads up</div>');
    expect(c).toContain("body text");
  });
  it("table", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table class=\"md-table\"><thead><tr><th>a</th><th>b</th></tr></thead>");
    expect(html).toContain("<tbody><tr><td>1</td><td>2</td></tr></tbody>");
  });
  it("frontmatter renders as a properties table and is not duplicated in the body", () => {
    const html = renderMarkdown("---\ntitle: Hi\ntags: [a, b]\n---\nBody.");
    expect(html).toContain('<table class="md-properties">');
    expect(html).toContain("<th>title</th><td>Hi</td>");
    expect(html).toContain("<th>tags</th><td>a, b</td>");
    expect(html).toContain("<p>Body.</p>");
    expect(html).not.toContain("title: Hi");
  });
});

describe("stripComments (Obsidian %% comments)", () => {
  it("removes inline and multi-line comments but keeps code", () => {
    expect(renderMarkdown("a %%hidden%% b")).toContain("a  b");
    expect(renderMarkdown("a %%hidden%% b")).not.toContain("hidden");
    const multi = renderMarkdown("before\n%%\nsecret\nnote\n%%\nafter");
    expect(multi).toContain("before");
    expect(multi).toContain("after");
    expect(multi).not.toContain("secret");
    // code spans keep their %%
    expect(renderMarkdown("`%%kept%%`")).toContain("%%kept%%");
    expect(renderMarkdown("```\n%%kept%%\n```")).toContain("%%kept%%");
  });
});

describe("stripBlockIds (^block markers)", () => {
  it("conceals inline and own-line block ids", () => {
    expect(renderMarkdown("a paragraph ^abc")).not.toContain("^abc");
    expect(renderMarkdown("a paragraph ^abc")).toContain("a paragraph");
    expect(renderMarkdown("para\n^xyz\nmore")).not.toContain("^xyz");
  });
});

describe("math placeholders", () => {
  it("emits inline $…$ and display $$…$$ placeholders with the TeX", () => {
    const inl = renderMarkdown("energy is $E = mc^2$ here");
    expect(inl).toContain('data-math="inline"');
    expect(inl).toContain('data-tex="E = mc^2"');
    const disp = renderMarkdown("$$\\int_0^1 x\\,dx$$");
    expect(disp).toContain('data-math="block"');
  });
  it("does NOT treat prose dollar amounts as math", () => {
    const out = renderMarkdown("it costs $5 and $10 total");
    expect(out).not.toContain("data-math");
  });
  it("renders a multi-line $$ block", () => {
    const out = renderMarkdown("before\n$$\na = b + c\n$$\nafter");
    expect(out).toContain('data-math="block"');
    expect(out).toContain("before");
    expect(out).toContain("after");
  });
  it("leaves $…$ inside code untouched", () => {
    expect(renderMarkdown("`$x$`")).toContain("<code");
    expect(renderMarkdown("`$x$`")).not.toContain("data-math");
  });
});

describe("footnotes", () => {
  it("numbers references by first appearance and emits a footnotes section", () => {
    const out = renderMarkdown("First[^a] then second[^b].\n\n[^a]: Note A.\n[^b]: Note B.");
    // ref markers numbered 1, 2 in order
    expect(out).toMatch(/footnote-ref"[^>]*id="fnref-a"><a href="#fn-a">1</);
    expect(out).toMatch(/footnote-ref"[^>]*id="fnref-b"><a href="#fn-b">2</);
    // a footnotes section with the definitions + backrefs
    expect(out).toContain('<section class="footnotes">');
    expect(out).toContain('id="fn-a"');
    expect(out).toContain("Note A.");
    expect(out).toContain('class="footnote-backref"');
    // the definition lines are not rendered as body paragraphs
    expect(out).not.toContain("<p>[^a]: Note A.");
  });

  it("supports inline footnotes ^[text]", () => {
    const out = renderMarkdown("Claim^[the evidence].");
    expect(out).toContain("footnote-ref");
    expect(out).toContain("the evidence");
    expect(out).toContain('<section class="footnotes">');
  });

  it("reuses the number for a footnote referenced twice", () => {
    const out = renderMarkdown("a[^x] b[^x]\n\n[^x]: once");
    expect((out.match(/>1<\/a>/g) ?? []).length).toBe(2); // both refs show 1
    expect((out.match(/<li id="fn-x"/g) ?? []).length).toBe(1); // one definition
  });

  it("emits nothing when there are no footnotes", () => {
    expect(renderMarkdown("plain text")).not.toContain("footnotes");
  });
});

describe("foldable callouts", () => {
  it("renders [!note]- as a collapsed <details> and [!note]+ as open", () => {
    const closed = renderMarkdown("> [!note]- Title\n> body text");
    expect(closed).toContain("<details");
    expect(closed).toContain("md-callout-foldable");
    expect(closed).not.toMatch(/<details[^>]*\sopen/); // collapsed
    expect(closed).toContain("<summary");

    const open = renderMarkdown("> [!tip]+ Heads up\n> content");
    expect(open).toMatch(/<details[^>]*\sopen/);
  });
  it("a plain callout (no +/-) stays a non-foldable div", () => {
    const out = renderMarkdown("> [!info] Note\n> body");
    expect(out).toContain('class="md-callout md-callout-info"');
    expect(out).not.toContain("<details");
  });
});

describe("raw HTML", () => {
  it("emits a block-HTML placeholder (filled/sanitized by the reader)", () => {
    const out = renderMarkdown('<div class="box">\nhello\n</div>');
    expect(out).toContain("raw-html");
    expect(out).toContain('data-basalt-html="');
    // the raw HTML is escaped INTO the attribute (not live in the output)
    expect(out).not.toContain('<div class="box">');
  });
  it("passes safe attribute-free inline tags through", () => {
    expect(renderMarkdown("x<br>y")).toContain("<br>");
    expect(renderMarkdown("H<sub>2</sub>O")).toContain("<sub>2</sub>");
    expect(renderMarkdown("a<sup>2</sup>")).toContain("<sup>2</sup>");
  });
  it("does NOT treat an inline tag at line start as a block", () => {
    const out = renderMarkdown("<sup>note</sup> text");
    expect(out).not.toContain("raw-html"); // stays a paragraph
    expect(out).toContain("<sup>");
  });
  it("escapes arbitrary inline HTML that isn't on the safe list", () => {
    const out = renderMarkdown("hi <span onclick=alert(1)>x</span>");
    expect(out).not.toContain("<span onclick");
    expect(out).toContain("&lt;span");
  });
});

describe("raw HTML — review fixes", () => {
  it("stops the HTML block at the matching close tag so following markdown renders", () => {
    const out = renderMarkdown("<div>box</div>\n# Heading after");
    expect(out).toContain("raw-html");
    expect(out).toContain("<h1"); // heading after </div> still rendered
  });
  it("does not misfire on prose starting with <word (no >)", () => {
    const out = renderMarkdown("<address of the sender is unknown");
    expect(out).not.toContain("raw-html");
    expect(out).toContain("&lt;address"); // escaped as prose
  });
});

describe("media embeds", () => {
  it("emits a media marker for audio/video/pdf, not a transclusion", () => {
    const audio = renderMarkdown("![[song.mp3]]");
    expect(audio).toContain('data-basalt-media="song.mp3"');
    expect(audio).not.toContain("data-basalt-embed");
    expect(renderMarkdown("![[paper.pdf]]")).toContain("data-basalt-media");
    // notes still transclude, images still img
    expect(renderMarkdown("![[Some Note]]")).toContain("data-basalt-embed");
    expect(renderMarkdown("![[pic.png]]")).toContain("data-basalt-img");
  });
});

describe("toggleTaskLine", () => {
  it("flips an unchecked task to checked and back, on the exact line", () => {
    const doc = "# H\n\n- [ ] one\n- [x] two\nplain";
    const a = toggleTaskLine(doc, 2)!;
    expect(a.split("\n")[2]).toBe("- [x] one");
    expect(toggleTaskLine(a, 3)!.split("\n")[3]).toBe("- [ ] two");
  });
  it("returns null for a non-task line or out of range", () => {
    expect(toggleTaskLine("- [ ] a", 1)).toBeNull();
    expect(toggleTaskLine("plain text", 0)).toBeNull();
  });
});
