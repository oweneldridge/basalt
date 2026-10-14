import { test, expect, type Page } from "@playwright/test";

// The paste converter, run in a real browser DOM (it needs DOMParser).
const MODULE = "/src/lib/htmlToMarkdown.ts";
const convert = (page: Page, html: string) =>
  page.evaluate(async ([m, h]) => (await import(m)).htmlToMarkdown(h) as string, [MODULE, html]);
const matters = (page: Page, html: string) =>
  page.evaluate(async ([m, h]) => (await import(m)).pastedHtmlMatters(h) as boolean, [MODULE, html]);

test.beforeEach(async ({ page }) => {
  await page.goto("/app-harness.html");
});

const cases: [string, string, string][] = [
  [
    "a nested list beside its item, as Chromium writes one",
    "<ul><li>parent</li><ul><li>child one</li><li>child two</li></ul><li>after</li></ul>",
    "- parent\n\t- child one\n\t- child two\n- after",
  ],
  ["list items inside a wrapper", "<ul><div><li>wrapped item</li></div></ul>", "- wrapped item"],
  ["bare text in a list", "<ul>Intro text<li>a</li></ul>", "- Intro text\n- a"],
  ["inline code holding a backtick", "<p>x <code>a`b</code> y</p>", "x ``a`b`` y"],
  ["inline code starting with a backtick", "<p><code>`tick</code></p>", "`` `tick ``"],
  [
    "a code block holding a fence",
    "<pre>before\n```\nmiddle\n```\nafter</pre>",
    "````\nbefore\n```\nmiddle\n```\nafter\n````",
  ],
  [
    "a code block inside a list item",
    "<ul><li>Run:<pre>npm ci\nnpm test</pre></li><li>done</li></ul>",
    "- Run:\n\t```\n\tnpm ci\n\tnpm test\n\t```\n- done",
  ],
  [
    "paragraphs and a quote inside list items",
    "<ul><li><p>one</p><p>two</p></li><li>a<blockquote>q</blockquote></li></ul>",
    "- one\n\n\ttwo\n- a\n\t> q",
  ],
  [
    "a table inside a table cell",
    "<table><tr><td>outer<table><tr><td>inner cell</td></tr></table></td></tr></table>",
    "| outer<br>inner cell |\n| --- |",
  ],
  [
    "a table caption",
    "<table><caption>Quarterly totals</caption><tr><th>q</th></tr><tr><td>1</td></tr></table>",
    "Quarterly totals\n\n| q |\n| --- |\n| 1 |",
  ],
  [
    "a merged cell and a line break in a cell",
    "<table><tr><th colspan=2>wide</th><th>c</th></tr><tr><td>1<br>2</td><td>3</td><td>4</td></tr></table>",
    "| wide |  | c |\n| --- | --- | --- |\n| 1<br>2 | 3 | 4 |",
  ],
  [
    "text with Markdown characters, kept as typed (Obsidian doesn't escape)",
    "<p>snake_case_name and [[Wiki Link]] and C:\\Users\\me and 2*3*4</p>",
    "snake_case_name and [[Wiki Link]] and C:\\Users\\me and 2*3*4",
  ],
  ["a highlight", "<p><mark>hi</mark> there</p>", "==hi== there"],
  ["a link with parentheses", '<a href="https://e.com/a_(b)">t</a>', "[t](https://e.com/a_\\(b\\))"],
  ["a list starting at zero", '<ol start="0"><li>z</li><li>o</li></ol>', "0. z\n1. o"],
  ["a JavaScript: link", '<a href="JavaScript:alert(1)">x</a>', "x"],
  [
    "a small inline image",
    '<img alt="dot" src="data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=">',
    "![dot](data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=)",
  ],
  ["a code block with line breaks", "<pre>alpha<br>beta</pre>", "```\nalpha\nbeta\n```"],
  ["a code block of line blocks", "<pre><div>one</div><div>two</div></pre>", "```\none\ntwo\n```"],
  [
    "code copied from an IntelliJ IDE",
    `<pre style="background-color:#2b2b2b;color:#a9b7c6;font-family:'JetBrains Mono',monospace;"><span style="color:#cc7832;">def </span><span style="color:#ffc66d;">f</span>():<br>    <span style="color:#cc7832;">return </span><span style="color:#6897bb;">1</span><br></pre>`,
    "```\ndef f():\n    return 1\n```",
  ],
  ["spaces at a link's edges", '<p>Read the<a href="https://e.com"> docs</a>now</p>', "Read the [docs](https://e.com)now"],
  ["non-breaking spaces", "<p>a&nbsp;&nbsp;&nbsp;b</p>", "a\u00a0\u00a0\u00a0b"],
  ["empty inline code", "<p>x <code></code> y</p>", "x  y"],
];

for (const [name, html, md] of cases) {
  test(`paste: ${name}`, async ({ page }) => {
    expect(await convert(page, html)).toBe(md);
  });
}

test("paste: Google Docs bold and italics convert", async ({ page }) => {
  const span = (style: string, text: string) =>
    `<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;${style}font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">${text}</span>`;
  const html =
    '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">' +
    span("font-weight:700;font-style:normal;", "Bold words") +
    span("font-weight:400;font-style:normal;", " and ") +
    span("font-weight:400;font-style:italic;", "italic words") +
    "</p></b>";
  expect(await matters(page, html)).toBe(true);
  expect(await convert(page, html)).toBe("**Bold words** and *italic words*");
});

test("paste: a document with Apple's tab spans converts", async ({ page }) => {
  expect(await matters(page, '<p><b>bold</b><span class="Apple-tab-span" style="white-space:pre">\t</span>text</p>')).toBe(true);
});

test("paste: code copied from an editor stays plain text", async ({ page }) => {
  const html =
    "<div style=\"color: #d4d4d4;background-color: #1e1e1e;font-family: Menlo, Monaco, 'Courier New', monospace;font-weight: normal;font-size: 12px;line-height: 18px;white-space: pre;\">" +
    '<div><span style="color: #569cd6;font-weight: bold;">const</span><span style="color: #d4d4d4;"> x = </span><span style="color: #b5cea8;">1</span></div></div>';
  expect(await matters(page, html)).toBe(false);
});

test("paste: long runs of spaces convert quickly", async ({ page }) => {
  const spaces = " ".repeat(60000);
  const t0 = Date.now();
  const out = await convert(page, `<p>a${spaces}b <code>c${spaces}d</code> <b>${spaces}e${spaces}</b></p>`);
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(out.startsWith("a b `c")).toBe(true);
});

test("paste: no word is lost from random, often malformed, HTML", async ({ page }) => {
  const lost = await page.evaluate(async (m) => {
    const { htmlToMarkdown } = await import(m);
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const tags = ["p", "div", "span", "b", "i", "code", "pre", "ul", "ol", "li", "blockquote", "h2", "table", "tr", "td", "th", "caption", "a", "mark", "s", "br", "section"];
    let word = 0;
    const gen = (depth: number): string => {
      let out = "";
      for (let k = rnd(4) + 1; k > 0; k--) {
        if (depth > 5 || rnd(3) === 0) out += ` w${word++}${rnd(2) ? " " : ""}`;
        else {
          const t = tags[rnd(tags.length)];
          if (t === "br") out += "<br>";
          else out += `<${t}${t === "a" ? ' href="https://e.com/x"' : ""}>${gen(depth + 1)}</${t}>`;
        }
      }
      return out;
    };
    const missing: string[] = [];
    for (let doc = 0; doc < 3000; doc++) {
      const start = word;
      const html = gen(0);
      const md: string = htmlToMarkdown(html);
      for (let w = start; w < word; w++) if (!new RegExp(`w${w}(?!\\d)`).test(md)) missing.push(`w${w} in ${html}`);
    }
    return missing.slice(0, 5);
  }, MODULE);
  expect(lost).toEqual([]);
});
