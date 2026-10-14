// Parsers that read as @lezer/markdown's own do, in time linear in what they
// read: lezer's link reference definitions read the paragraph again on each
// new line, and its hard breaks a run of spaces again from each space.
import type { BlockContext, Element, InlineContext, LeafBlock, Line, MarkdownConfig } from "@lezer/markdown";

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

function skipSpace(text: string, i: number): number {
  while (i < text.length && isSpace(text.charCodeAt(i))) i++;
  return i;
}

/** A link reference definition (`[a]: url "title"`), read a line at a time. */
export class RefScan {
  /** The label, the URL, after the URL, after the title, or -1: not one. */
  stage = 0;
  len: number;
  label = -1; // where the label ends, past its `]`
  url = { from: -1, to: -1 };
  title = { from: -1, to: -1 };
  private head: string; // the text, until the URL is read
  private skip = -1; // the first non-space past the URL
  private close = 0; // the mark that closes the title
  private escaped = false;
  // Where the URL's line, and the title's, end with only spaces left on it:
  // -2 not known yet, -1 something else is on it.
  private urlLine = -2;
  private titleLine = -2;

  constructor(first: string) {
    this.head = first;
    this.len = first.length;
    this.start();
    if (this.stage === 2) this.decide();
  }

  /** Reads another line; true when the definition ended on the line before. */
  nextLine(text: string): boolean {
    if (this.stage < 0) return false;
    let end: number;
    if (this.stage < 2) {
      this.head += "\n" + text;
      this.len = this.head.length;
      this.start();
      end = this.stage === 2 ? this.decide() : -1;
    } else {
      this.feed("\n" + text, this.len);
      this.len += 1 + text.length;
      end = this.decide();
    }
    if (end >= 0) {
      this.len = end;
      return true;
    }
    return false;
  }

  /** Where the definition ends if its paragraph ends here, or -1. */
  finish(): number {
    if (this.stage === 2 && this.skip < 0) return this.len;
    if (this.stage === 3) return this.len;
    return -1;
  }

  // The label and the URL, which can't run on past a line or so.
  private start() {
    const c = this.head;
    if (this.stage === 0) {
      let blank = true;
      let escaped = false;
      for (let p = 1, end = Math.min(c.length, 1000); p < end; p++) {
        const ch = c.charCodeAt(p);
        if (escaped) escaped = false;
        else if (ch === 93) {
          if (blank) return void (this.stage = -1);
          this.label = p + 1;
          break;
        } else {
          if (!isSpace(ch)) blank = false;
          if (ch === 91) return void (this.stage = -1);
          if (ch === 92) escaped = true;
        }
      }
      if (this.label < 0) {
        if (c.length >= 1000) this.stage = -1;
        return;
      }
      if (c.charCodeAt(this.label) !== 58) return void (this.stage = -1);
      this.stage = 1;
    }
    const from = skipSpace(c, this.label + 1);
    let p = from;
    if (c.charCodeAt(from) === 60) {
      for (p = from + 1; ; p++) {
        if (p >= c.length) return;
        const ch = c.charCodeAt(p);
        if (ch === 62) break;
        if (ch === 60 || ch === 10) return void (this.stage = -1);
      }
      p++;
    } else {
      let depth = 0;
      for (let escaped = false; p < c.length; p++) {
        const ch = c.charCodeAt(p);
        if (isSpace(ch)) break;
        if (escaped) escaped = false;
        else if (ch === 40) depth++;
        else if (ch === 41) {
          if (!depth) break;
          depth--;
        } else if (ch === 92) escaped = true;
      }
      if (p === from) {
        if (p < c.length) this.stage = -1;
        return;
      }
    }
    this.url = { from, to: p };
    this.stage = 2;
    this.head = "";
    this.feed(c.slice(p), p);
  }

  // What follows the URL, read once: the space before a title, the title
  // itself, and what's left on the lines they end.
  private feed(chunk: string, at: number) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk.charCodeAt(i);
      const pos = at + i;
      if (this.urlLine === -2) {
        if (ch === 10) this.urlLine = pos;
        else if (!isSpace(ch)) this.urlLine = -1;
      }
      if (this.skip < 0) {
        if (isSpace(ch)) continue;
        this.skip = pos;
        if (pos > this.url.to && (ch === 34 || ch === 39 || ch === 40)) this.close = ch === 40 ? 41 : ch;
        continue;
      }
      if (this.close && this.title.to < 0) {
        if (this.escaped) this.escaped = false;
        else if (ch === this.close) this.title = { from: this.skip, to: pos + 1 };
        else if (ch === 92) this.escaped = true;
        continue;
      }
      if (this.title.to >= 0 && this.titleLine === -2) {
        if (ch === 10) this.titleLine = pos;
        else if (!isSpace(ch)) this.titleLine = -1;
      }
    }
  }

  // Where the definition ends now (the line break past it), or -2 for not yet
  // and -1 for not on this line, as lezer's reading after the URL finds.
  private decide(): number {
    if (this.stage === 2 && this.title.to >= 0 && this.titleLine !== -1) this.stage = 3;
    return this.stage === 3 ? this.titleLine : this.urlLine;
  }
}

class LinkRefParser {
  private scan: RefScan;
  constructor(private readonly leaf: LeafBlock) {
    this.scan = new RefScan(leaf.content);
  }

  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    // The line past its container marks (lezer's own `scrub`, not in its types).
    return this.scan.nextLine((line as unknown as { scrub(): string }).scrub()) && this.complete(cx, leaf, this.scan.len);
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    const end = this.scan.finish();
    return end >= 0 && this.complete(cx, leaf, end);
  }

  private complete(cx: BlockContext, leaf: LeafBlock, len: number): boolean {
    const s = this.scan;
    const at = this.leaf.start;
    const elts: Element[] = [
      cx.elt("LinkLabel", at, at + s.label),
      cx.elt("LinkMark", at + s.label, at + s.label + 1),
      cx.elt("URL", at + s.url.from, at + s.url.to),
    ];
    if (s.stage === 3) elts.push(cx.elt("LinkTitle", at + s.title.from, at + s.title.to));
    cx.addLeafElement(leaf, cx.elt("LinkReference", at, at + len, elts));
    return true;
  }
}

// The run of spaces each inline context last read, so each space past the
// first in a run isn't read again.
const spaceRuns = new WeakMap<InlineContext, { from: number; to: number }>();

/** lezer's link reference definitions and hard breaks. */
export const LinearParsers: MarkdownConfig = {
  parseBlock: [{ name: "LinkReference", leaf: (_cx, leaf) => (leaf.content.charCodeAt(0) === 91 ? new LinkRefParser(leaf) : null) }],
  parseInline: [
    {
      name: "HardBreak",
      parse(cx, next, start) {
        if (next === 92 && cx.char(start + 1) === 10) return cx.addElement(cx.elt("HardBreak", start, start + 2));
        if (next !== 32 || cx.char(start + 1) !== 32) return -1;
        let run = spaceRuns.get(cx);
        if (!run || start < run.from || start >= run.to) {
          let to = start + 1;
          while (cx.char(to) === 32) to++;
          spaceRuns.set(cx, (run = { from: start, to }));
        }
        return cx.char(run.to) === 10 && run.to >= start + 2 ? cx.addElement(cx.elt("HardBreak", start, run.to + 1)) : -1;
      },
    },
  ],
};
