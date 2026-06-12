// Editor test harness (dev-only, no Tauri): mounts the real editor stack with
// stub callbacks and exposes hooks for browser automation. See harness.html.
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { createEditorState } from "./editor/setup";
import "./styles.css";

declare global {
  interface Window {
    __harness: {
      view: EditorView;
      reset: (doc: string, anchor?: number, head?: number) => void;
      doc: () => string;
      select: (anchor: number, head?: number) => void;
      opened: string[]; // wikilink targets clicked
      urls: string[]; // external URLs clicked
    };
  }
}

const parent = document.getElementById("harness")!;
const opened: string[] = [];
const urls: string[] = [];

function makeState(doc: string) {
  return createEditorState(doc, {
    getNotes: () => [
      { name: "Alpha Note", rel: "Alpha Note.md" },
      { name: "Beta Note", rel: "Beta Note.md" },
      { name: "Getting Started Guide", rel: "guides/Getting Started Guide.md" },
    ],
    getLinkFormat: () => "shortest" as const,
    getActiveRel: () => null,
    onOpenWikilink: (t) => opened.push(t),
    onOpenUrl: (u) => urls.push(u),
    resolveImage: () => Promise.resolve(null),
    saveAttachment: () => Promise.resolve(null),
    replacePlaceholder: () => {},
    onChange: () => {},
  });
}

const view = new EditorView({ state: makeState("hello world"), parent });
view.focus();

window.__harness = {
  view,
  opened,
  urls,
  reset(doc, anchor, head) {
    view.setState(makeState(doc));
    if (anchor !== undefined) {
      view.dispatch({ selection: EditorSelection.single(anchor, head ?? anchor) });
    }
    view.focus();
  },
  doc: () => view.state.doc.toString(),
  select(anchor, head) {
    view.dispatch({ selection: EditorSelection.single(anchor, head ?? anchor) });
    view.focus();
  },
};
