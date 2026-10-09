// Live Preview for raw-HTML blocks (e.g. Obsidian daily-note headers like
// `<font color=…><center>…</center></font>`): render the sanitized HTML when
// the caret is outside the block, reveal the raw markup for editing when it's
// inside. A block replacement, so it comes from a StateField. Block boundaries
// come from the same scanner the Reading view uses, so both agree.
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension, Text, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { htmlBlockRanges } from "../lib/htmlBlocks";
import { sanitizeToFragment } from "../lib/sanitize";
import { getTranscludeHost } from "../lib/transclude";
import { notePathFacet } from "./query";

class HtmlBlockWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly notePath: string,
  ) {
    super();
  }
  eq(other: HtmlBlockWidget): boolean {
    return other.source === this.source && other.notePath === this.notePath;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-html-block";
    wrap.replaceChildren(sanitizeToFragment(this.source)); // DOMPurify: no scripts, styles or handlers
    // A vault image in it loads through the note's resolver.
    const host = getTranscludeHost();
    wrap.querySelectorAll<HTMLImageElement>("img[data-basalt-img]").forEach((img) => {
      const target = img.dataset.basaltImg ?? "";
      img.removeAttribute("data-basalt-img");
      void host?.resolveImage(target, this.notePath).then((url) => {
        if (url) img.src = url;
      });
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

interface Block {
  from: number;
  to: number;
}
interface HtmlBlocks {
  blocks: Block[];
  deco: DecorationSet;
}

function scan(doc: Text): Block[] {
  return htmlBlockRanges(doc.toString()).map((r) => ({ from: doc.line(r.fromLine + 1).from, to: doc.line(r.toLine + 1).to }));
}

function decorate(state: EditorState, blocks: Block[]): HtmlBlocks {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = state.selection;
  for (const { from, to } of blocks) {
    // Editing inside the block → leave it raw.
    if (sel.ranges.some((r) => r.from <= to && r.to >= from)) continue;
    const source = state.doc.sliceString(from, to);
    const widget = new HtmlBlockWidget(source, state.facet(notePathFacet));
    builder.add(from, to, Decoration.replace({ widget, block: true }));
  }
  return { blocks, deco: builder.finish() };
}

/** Where a leading frontmatter ends (-1 when there's none). */
function frontmatterEnd(doc: Text): number {
  if (doc.line(1).text.trim() !== "---") return -1;
  for (let n = 2; n <= doc.lines; n++) {
    const t = doc.line(n).text.trim();
    if (t === "---" || t === "...") return doc.line(n).to;
  }
  return doc.length;
}

/** Whether an edit can move where HTML blocks are: it adds or removes a tag
 * bracket, a fence, `$$` or a line break, edits a line holding one (a tag's
 * name, or a fence, can change), a block or the lines either side of it (a
 * blank line ends one), the first line or the frontmatter. Any other edit only
 * shifts the blocks, so a long note isn't scanned again on every keystroke. */
function moves(tr: Transaction, blocks: Block[]): boolean {
  const start = tr.startState.doc;
  const fm = Math.max(frontmatterEnd(start), start.line(1).to);
  const near = blocks.map((b) => ({
    from: start.lineAt(Math.max(0, b.from - 1)).from,
    to: start.lineAt(Math.min(start.length, b.to + 1)).to,
  }));
  let yes = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (yes) return;
    yes =
      /[<>`~$\n]/.test(start.sliceString(fromA, toA) + inserted.toString()) ||
      /[<>`~$]/.test(start.lineAt(fromA).text) ||
      /[<>`~$]/.test(start.lineAt(toA).text) ||
      fromA <= fm ||
      near.some((b) => fromA <= b.to && toA >= b.from);
  });
  return yes;
}

/** Exported for tests: the HTML blocks the field holds. */
export const htmlBlockField = StateField.define<HtmlBlocks>({
  create: (state) => decorate(state, scan(state.doc)),
  update: (value, tr) => {
    if (tr.docChanged) {
      if (moves(tr, value.blocks)) return decorate(tr.state, scan(tr.state.doc));
      const blocks = value.blocks.map((b) => ({ from: tr.changes.mapPos(b.from, 1), to: tr.changes.mapPos(b.to, -1) }));
      return decorate(tr.state, blocks);
    }
    return tr.selection ? decorate(tr.state, value.blocks) : value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// Click the rendered HTML to place the caret inside the block (reveal raw).
const htmlBlockClick = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const el = (event.target as HTMLElement | null)?.closest(".cm-html-block") as HTMLElement | null;
    if (!el) return false;
    // Caret after the block, not in front of its opening tag: typing there
    // would break the tag (and with it the whole block).
    const pos = view.posAtDOM(el);
    let end = view.state.doc.lineAt(Math.min(pos + 1, view.state.doc.length)).to;
    view.state.field(htmlBlockField).deco.between(pos, pos + 1, (_from, to) => {
      end = to;
    });
    view.dispatch({ selection: { anchor: end } });
    view.focus();
    event.preventDefault();
    return true;
  },
});

export const htmlBlock: Extension = [htmlBlockField, htmlBlockClick];
