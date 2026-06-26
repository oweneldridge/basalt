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
    expect(html).toContain('<li class="md-task"><input type="checkbox" disabled /> todo</li>');
    expect(html).toContain('<input type="checkbox" disabled checked /> done');
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
