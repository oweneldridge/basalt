// Editor test harness (dev-only, no Tauri): mounts the real editor stack with
// stub callbacks and exposes hooks for browser automation. See harness.html.
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { startCompletion, currentCompletions } from "@codemirror/autocomplete";
import { createEditorState, setSourceMode } from "./editor/setup";
import type { EditorCallbacks } from "./editor/setup";
import type { LinkFormat } from "./lib/rename";
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
      setSource: (on: boolean) => void;
      setLinkFormat: (f: LinkFormat) => void;
      setActiveRel: (rel: string | null) => void;
      startCompletion: () => void;
      completions: () => string[];
    };
  }
}

const parent = document.getElementById("harness")!;
const opened: string[] = [];
const urls: string[] = [];
let linkFormat: LinkFormat = "shortest";
let activeRel: string | null = null;

const cb: EditorCallbacks = {
  getNotes: () => [
    { name: "Alpha Note", rel: "Alpha Note.md" },
    { name: "Beta Note", rel: "Beta Note.md" },
    { name: "Getting Started Guide", rel: "guides/Getting Started Guide.md" },
  ],
  getLinkFormat: () => linkFormat,
  getActiveRel: () => activeRel,
  getHeadings: (name) => (name === "Beta Note" ? ["Overview", "Details", "Summary"] : []),
  getBlockIds: (name) => (name === "Beta Note" ? [{ id: "b1", snippet: "first block" }, { id: "quote2", snippet: "second block" }] : []),
  onOpenWikilink: (t) => opened.push(t),
  onOpenUrl: (u) => urls.push(u),
  resolveImage: () => Promise.resolve(null),
  saveAttachment: () => Promise.resolve(null),
  replacePlaceholder: () => {},
  onChange: () => {},
};

const view = new EditorView({ state: createEditorState("hello world", cb), parent });
view.focus();

window.__harness = {
  view,
  opened,
  urls,
  reset(doc, anchor, head) {
    view.setState(createEditorState(doc, cb));
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
  setSource: (on) => setSourceMode(view, cb, on),
  setLinkFormat: (f) => {
    linkFormat = f;
  },
  setActiveRel: (rel) => {
    activeRel = rel;
  },
  startCompletion: () => startCompletion(view),
  completions: () => currentCompletions(view.state).map((c) => c.label),
};
