// Live Preview for fenced code blocks whose language a PLUGIN registered a
// processor for (basalt.registerMarkdownCodeBlockProcessor). Mirrors the query
// widget: render when the caret is outside the block, reveal raw source inside.
// The processor builds the DOM; a throwing processor is contained.
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { codeBlockProcessor, hasCodeBlockProcessor } from "../lib/plugins";
import { notePathFacet } from "./query";

class PluginBlockWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly source: string,
    readonly notePath: string,
  ) {
    super();
  }
  eq(o: PluginBlockWidget): boolean {
    return o.lang === this.lang && o.source === this.source && o.notePath === this.notePath;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-plugin-block";
    const fn = codeBlockProcessor(this.lang);
    if (fn) {
      try {
        fn(this.source, wrap, { notePath: this.notePath });
      } catch (e) {
        wrap.className = "cm-plugin-block cm-plugin-block-error";
        wrap.textContent = `Plugin block error: ${e instanceof Error ? e.message : e}`;
      }
    }
    return wrap;
  }
  ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown" && event.type !== "click" && event.type !== "change";
  }
}

function compute(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = state.selection;
  const notePath = state.facet(notePathFacet);
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      const lang = info ? state.doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
      if (!lang || !hasCodeBlockProcessor(lang)) return false;
      if (sel.ranges.some((r) => r.from <= node.to && r.to >= node.from)) return false;
      const codeText = node.node.getChild("CodeText");
      const source = codeText ? state.doc.sliceString(codeText.from, codeText.to) : "";
      builder.add(
        node.from,
        node.to,
        Decoration.replace({ widget: new PluginBlockWidget(lang, source, notePath), block: true }),
      );
      return false;
    },
  });
  return builder.finish();
}

const pluginBlockField = StateField.define<DecorationSet>({
  create: (state) => compute(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

const pluginBlockClick = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const t = event.target as HTMLElement | null;
    if (!t || t.closest("a, input, button")) return false;
    const el = t.closest(".cm-plugin-block") as HTMLElement | null;
    if (!el) return false;
    const pos = view.posAtDOM(el);
    const line = view.state.doc.lineAt(Math.min(pos + 1, view.state.doc.length));
    view.dispatch({ selection: { anchor: line.from } });
    event.preventDefault();
    return true;
  },
});

export const pluginBlocks: Extension = [pluginBlockField, pluginBlockClick];
