import { toggleTaskLine } from "./render";
// Markdown→HTML rendering for Reading mode / export. Output is inserted via
// innerHTML, so escaping is security-critical and gets first-class coverage.
import { afterEach, describe, expect, it } from "vitest";
import { renderMarkdown, renderInline, escapeHtml, setStrictLineBreaks } from "./render";

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
    expect(html).not.toContain("onerror"); // inline HTML keeps only harmless attributes
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
    // the text is the link text with `#` read as " > ", as Obsidian shows it.
    expect(renderInline("[[notes/Foo#H]]")).toContain('data-target="notes/Foo#H">notes/Foo &gt; H</a>');
    expect(renderInline("[[#H]]")).toContain('data-target="#H">H</a>');
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
    expect(renderMarkdown("one\ntwo\n\nthree")).toBe("<p>one<br>\ntwo</p>\n<p>three</p>");
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
    expect(html).toContain('<li class="md-task" data-task=" "><input type="checkbox" class="md-task-check" data-task-line="1" /> todo</li>');
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
    expect(c).toContain('<div class="md-callout md-callout-warning md-callout-color-orange">');
    expect(c).toContain('<div class="md-callout-title"><span class="md-callout-icon">⚠️</span>Heads up</div>');
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

describe("line breaks (Obsidian's Strict line breaks setting)", () => {
  afterEach(() => setStrictLineBreaks(false));

  it("keeps every line break when the setting is off, as Obsidian does by default", () => {
    expect(renderMarkdown("y = x^2\nx = 4\ny = 16")).toBe("<p>y = x^2<br>\nx = 4<br>\ny = 16</p>");
    expect(renderMarkdown("two spaces  \nnext")).toBe("<p>two spaces<br>\nnext</p>");
  });

  it("breaks only after two spaces or a backslash when the setting is on", () => {
    setStrictLineBreaks(true);
    expect(renderMarkdown("one\ntwo")).toBe("<p>one\ntwo</p>");
    expect(renderMarkdown("one  \ntwo")).toBe("<p>one<br>\ntwo</p>");
    expect(renderMarkdown("one\\\ntwo")).toBe("<p>one<br>\ntwo</p>");
  });

  it("keeps a line under a list item in that item", () => {
    expect(renderMarkdown("- item one\n  more of one\n- item two")).toBe(
      "<ul><li>item one<br>\nmore of one</li><li>item two</li></ul>",
    );
    expect(renderMarkdown("1. first\nlazy line")).toBe("<ol><li>first<br>\nlazy line</li></ol>");
    setStrictLineBreaks(true);
    expect(renderMarkdown("- item one\n  more of one")).toBe("<ul><li>item one\nmore of one</li></ul>");
  });

  it("still ends a list at a heading, a quote or a fence", () => {
    expect(renderMarkdown("- a\n# H")).toBe("<ul><li>a</li></ul>\n<h1>H</h1>");
    expect(renderMarkdown("- a\n> q")).toContain("<blockquote>");
    expect(renderMarkdown("- a\n```\ncode\n```")).toContain("<pre");
  });
});

describe("dollar amounts aren't math", () => {
  it("leaves prices as text, as Obsidian does", () => {
    expect(renderMarkdown("Copay +$25 and OOP +$25.")).not.toContain("data-math");
    expect(renderMarkdown("was $268.18 (2026), so **$1,059.20/yr** total")).not.toContain("data-math");
    expect(renderMarkdown("was $268.18 (2026), so **$1,059.20/yr** total")).toContain("<strong>$1,059.20/yr</strong>");
    expect(renderMarkdown("price $5 and `$var`")).toContain("<code");
  });
  it("still renders real inline math", () => {
    expect(renderMarkdown("area $x^2$ here")).toContain('data-tex="x^2"');
    expect(renderMarkdown("$a$5")).not.toContain("data-math");
  });
});

describe("tasks with other statuses", () => {
  it("render as checkboxes, including in numbered lists", () => {
    const html = renderMarkdown("- [/] doing\n- [-] dropped\n1. [ ] numbered");
    expect(html.match(/md-task-check/g)).toHaveLength(3);
    expect(html.match(/ checked/g)).toHaveLength(2);
  });
  it("toggle back to open, and numbered tasks toggle too", () => {
    expect(toggleTaskLine("- [/] doing", 0)).toBe("- [ ] doing");
    expect(toggleTaskLine("1. [ ] numbered", 0)).toBe("1. [x] numbered");
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
    expect(out).toContain('class="md-callout md-callout-info md-callout-color-blue"');
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
  it("keeps inline HTML on the safe list without its attributes, escapes the rest", () => {
    const out = renderMarkdown("hi <span onclick=alert(1)>x</span> and <iframe src=x>");
    expect(out).not.toContain("onclick");
    expect(out).toContain("<span>x</span>"); // shown as markup, as in Obsidian
    expect(out).toContain("&lt;iframe"); // not on the list: text
  });
  it("treats a <font>-led line as a raw-HTML block (Obsidian daily-note header)", () => {
    // A common Obsidian daily-note template: <font color=…><center>…<cite>…</cite></center></font>
    const out = renderMarkdown('<font color="#ff0000"><center>Wednesday<cite>a quote</cite></center></font>');
    expect(out).toContain("raw-html");
    expect(out).toContain('data-basalt-html="');
    // the full source (font/center/cite) is escaped INTO the placeholder for the
    // sanitizer to fill — NOT emitted as escaped literal prose…
    expect(out).toContain("&lt;font color=&quot;#ff0000&quot;&gt;");
    // …and the color hex is NOT misread as a #tag (the pre-fix bug)
    expect(out).not.toContain('class="md-tag"');
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

describe("reading-view task lines", () => {
  const lineOf = (html: string, label: string) => {
    const m = new RegExp(`data-task-line="(\\d+)"[^>]*/> ${label}`).exec(html);
    return m ? Number(m[1]) : null;
  };
  it("points tasks inside callouts and blockquotes at their source line", () => {
    const doc = ["- [ ] Pay rent", "- [ ] Call mom", "", "> [!todo] Today", "> - [ ] Write report", "", "> - [ ] Quoted"].join("\n");
    const html = renderMarkdown(doc);
    expect(lineOf(html, "Write report")).toBe(4);
    expect(lineOf(html, "Quoted")).toBe(6);
    expect(toggleTaskLine(doc, 4)).toBe(doc.replace("> - [ ] Write report", "> - [x] Write report"));
  });
  it("keeps line numbers after a multi-line comment", () => {
    const doc = ["%%", "hidden", "%%", "- [ ] A", "- [ ] B", "- [ ] C"].join("\n");
    const html = renderMarkdown(doc);
    expect(lineOf(html, "C")).toBe(5);
    expect(toggleTaskLine(doc, 5)).toBe(doc.replace("- [ ] C", "- [x] C"));
  });
  it("maps a task in a nested callout", () => {
    const doc = ["> [!note] Outer", "> > [!todo] Inner", "> > - [ ] Deep"].join("\n");
    expect(lineOf(renderMarkdown(doc), "Deep")).toBe(2);
    expect(toggleTaskLine(doc, 2)).toBe(doc.replace("[ ] Deep", "[x] Deep"));
  });
});


describe("markdown image paths", () => {
  it("names the decoded vault file, as Obsidian writes spaces and # encoded", () => {
    expect(renderInline("![s](Media/shot%20one.png)")).toContain('data-basalt-img="Media/shot one.png"');
    expect(renderInline("![s](a%23b.png)")).toContain('data-basalt-img="a#b.png"');
    expect(renderInline("![s](<Media/shot one.png>)")).toContain('data-basalt-img="Media/shot one.png"');
    expect(renderInline("![s](100%.png)")).toContain('data-basalt-img="100%.png"');
    expect(renderInline("![s](https://x.test/a%20b.png)")).toContain('data-basalt-img="https://x.test/a%20b.png"');
  });
});

describe("CommonMark and Obsidian fidelity (Reading view hunt)", () => {
  it("resolves reference images and links, hiding their definitions", () => {
    const html = renderMarkdown("![][image1] and [text][r] and [r]\n\n[image1]: <data:image/png;base64,AAA>\n[r]: https://x.com");
    expect(html).toContain('data-basalt-img="data:image/png;base64,AAA"');
    expect(html).toContain('<a class="md-link" data-href="https://x.com">text</a>');
    expect(html).toContain('<a class="md-link" data-href="https://x.com">r</a>');
    expect(html).not.toContain("base64,AAA&gt;");
    expect(renderMarkdown("[no def] stays")).toContain("[no def] stays");
  });

  it("keeps lists whole: wrapped items, start numbers, code inside items, type changes", () => {
    const html = renderMarkdown("3. **Stray core** wrapped\n   onto two lines\n4. next\n   ```\n   code\n   ```\n- bullet");
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("<strong>Stray core</strong> wrapped<br>\nonto two lines");
    expect(html).toContain('<pre class="md-code"><code>code</code></pre>');
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html).toContain("<ul><li>bullet</li></ul>");
  });

  it("lets emphasis wrap onto the next line", () => {
    expect(renderMarkdown("**bold that wraps\nonto the next line** end")).toContain("<strong>bold that wraps<br>\nonto the next line</strong>");
  });

  it("keeps footnotes after a blockquote or a callout", () => {
    const html = renderMarkdown("one[^a]\n\n> quote\n\n> [!note]\n> in callout[^c]\n\ntwo[^b]\n\n[^a]: A\n[^b]: B\n[^c]: C");
    expect(html.match(/class="footnote-ref"/g)).toHaveLength(3);
    for (const t of ["A", "B", "C"]) expect(html).toMatch(new RegExp(`<li id="fn-[abc]">${t} <a`));
  });

  it("labels same-note heading links", () => {
    expect(renderInline("[[#Local]]")).toContain(">Local</a>");
  });

  it("survives absurdly deep blockquotes", () => {
    expect(() => renderMarkdown(">".repeat(2000) + " deep")).not.toThrow();
  });

  it("follows CommonMark emphasis rules", () => {
    expect(renderMarkdown("2 * 3 * 4")).toContain("2 * 3 * 4");
    expect(renderMarkdown("***both***")).toMatch(/<em><strong>both<\/strong><\/em>|<strong><em>both<\/em><\/strong>/);
  });

  it("keeps a heading's own closing #", () => {
    expect(renderMarkdown("## Learning C#")).toContain("<h2>Learning C#</h2>");
  });

  it("handles backslash escapes", () => {
    const html = renderMarkdown("\\*not em\\* and \\$5 and \\#not-a-tag");
    expect(html).toContain("*not em* and $5 and #not-a-tag");
    expect(html).not.toContain("md-tag");
    expect(html).not.toContain("<em>");
  });

  it("hides HTML comments and links bare URLs", () => {
    const html = renderMarkdown("see <!-- hidden --> https://example.com/a. and www.example.org");
    expect(html).not.toContain("hidden");
    expect(html).toContain('data-href="https://example.com/a"');
    expect(html).toContain('data-href="https://www.example.org"');
  });

  it("reads tags as Obsidian does", () => {
    expect(renderMarkdown("issue #42 here")).not.toContain("md-tag");
    expect(renderMarkdown("a #café tag")).toContain('<span class="md-tag">#café</span>');
    expect(renderMarkdown("&#169; and &copy;")).not.toContain("md-tag");
    expect(renderMarkdown("&#169; and &copy;")).toContain("&#169; and &copy;");
  });

  it("renders linked images and sized images", () => {
    expect(renderMarkdown("[![a](i.png)](https://u.com)")).toMatch(/<a class="md-link" data-href="https:\/\/u.com"><img [^>]*data-basalt-img="i.png"/);
    expect(renderMarkdown("![[pic.png|300]]")).toContain('width="300"');
    expect(renderMarkdown("![[pic.png|300x100]]")).toContain('width="300" height="100"');
    expect(renderMarkdown("![shot|150](x.png)")).toMatch(/alt="shot" width="150"/);
  });

  it("reads setext headings, lazy quote lines, and code spans with backticks", () => {
    expect(renderMarkdown("Title\n===")).toContain("<h1>Title</h1>");
    expect(renderMarkdown("> quoted\nlazy line")).toMatch(/<blockquote><p>quoted<br>\nlazy line<\/p><\/blockquote>/);
    expect(renderMarkdown("``a ` b``")).toContain('<code class="md-code-inline">a ` b</code>');
    expect(renderMarkdown("    indented code")).toContain('<pre class="md-code"><code>indented code</code></pre>');
  });

  it("aligns table columns and pads short rows", () => {
    const html = renderMarkdown("| a | b | c |\n|:-|:-:|-:|\n| 1 |");
    expect(html).toContain('<th style="text-align:center">b</th>');
    expect(html).toContain('<td style="text-align:right"></td>');
    expect(html.match(/<td/g)).toHaveLength(3);
  });
});

describe("source lines", () => {
  const src = "---\na: 1\n---\n# Title\n\npara\n\n- one\n- two\n\n> [!note]\n> ## Inside\n\n%% gone\nstill gone %%\n\nlast ^blk\n";
  it("mark each block with the line it starts on when asked", () => {
    const html = renderMarkdown(src, { lines: true });
    expect(html).toContain('<h1 data-line="3">');
    expect(html).toContain('<p data-line="5">para</p>');
    expect(html).toContain('<li data-line="7">one</li><li data-line="8">two</li>');
    expect(html).toContain('<h2 data-line="11">');
    expect(html).toContain('<p data-line="16">last</p>');
  });
  it("leave the output unchanged otherwise", () => {
    expect(renderMarkdown(src)).not.toContain("data-line");
  });
});

describe("HTML comments", () => {
  it("hide, but text after one on its line stays", () => {
    expect(renderMarkdown("<!-- only -->\n\npara")).toBe("<p>para</p>");
    expect(renderMarkdown("<!-- c --> visible tail\n\npara")).toContain("visible tail");
  });
  it("over several lines show only what follows, and an unclosed one hides the rest", () => {
    const multi = renderMarkdown("<!--\nprivate draft notes\n--> tail text\n\npara");
    expect(multi).toContain("tail text");
    expect(multi).not.toContain("private draft");
    expect(renderMarkdown("<!-- open\n# Head\n**b**\n")).not.toMatch(/Head|\*\*b/);
    const two = renderMarkdown("<!-- a --> visible <!-- b -->\n");
    expect(two).toContain("visible");
    expect(two).not.toContain(" a ");
  });
});

describe("table rows wider than the header", () => {
  it("keep their extra cells, as Obsidian shows them", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 | 3 |\n");
    expect(html).toContain("<td>1</td><td>2</td><td>3</td>");
  });
});

describe("property values", () => {
  it("make their links live", () => {
    const html = renderMarkdown('---\nup: "[[Ideas]]"\nsee: "x [[A|the a]] y"\nurl: https://example.com\nplain: <b>\n---\nbody\n');
    expect(html).toContain('<a class="md-wikilink" data-target="Ideas">Ideas</a>');
    expect(html).toContain('x <a class="md-wikilink" data-target="A">the a</a> y');
    expect(html).toContain('<a class="md-link" data-href="https://example.com">https://example.com</a>');
    expect(html).toContain("&lt;b&gt;");
  });
});
