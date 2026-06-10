import { useEffect, useRef } from "react";
import { EditorSelection, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditorState, externalReload } from "../editor/setup";

interface Props {
  /** Active note path — changing this rebuilds the editor with fresh content. */
  path: string;
  /** Document content for `path`; changing it (same path) reconciles in-place. */
  doc: string;
  getNotes: () => string[];
  onOpenWikilink: (target: string) => void;
  onOpenUrl: (url: string) => void;
  resolveImage: (target: string) => Promise<string | null>;
  onChange: (doc: string) => void;
  /** 1-based line to scroll to / place the caret on (from search or backlinks). */
  scrollToLine?: number;
}

export function EditorPane({
  path,
  doc,
  getNotes,
  onOpenWikilink,
  onOpenUrl,
  resolveImage,
  onChange,
  scrollToLine,
}: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // Keep the latest callbacks in refs so the editor (rebuilt only per `path`)
  // always calls through to fresh closures without being torn down on every render.
  const cbs = useRef({ getNotes, onOpenWikilink, onOpenUrl, resolveImage, onChange });
  cbs.current = { getNotes, onOpenWikilink, onOpenUrl, resolveImage, onChange };

  // Build the editor when the note (path) changes.
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      state: createEditorState(doc, {
        getNotes: () => cbs.current.getNotes(),
        onOpenWikilink: (t) => cbs.current.onOpenWikilink(t),
        onOpenUrl: (u) => cbs.current.onOpenUrl(u),
        resolveImage: (t) => cbs.current.resolveImage(t),
        onChange: (d) => cbs.current.onChange(d),
      }),
      parent: host.current,
    });
    view.current = v;
    v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
    // Rebuild only when the note changes; `doc` is the initial content for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Reconcile an external live-reload into the existing editor WITHOUT remounting,
  // preserving the caret (clamped) and not triggering a save-back.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === doc) return;
    const head = Math.min(v.state.selection.main.head, doc.length);
    // Keep the reconcile OUT of undo history: Cmd-Z must never resurrect
    // pre-reload content (which would then autosave over the external edit).
    v.dispatch({
      changes: { from: 0, to: current.length, insert: doc },
      selection: EditorSelection.cursor(head),
      annotations: [externalReload.of(true), Transaction.addToHistory.of(false)],
    });
  }, [doc]);

  // Scroll to (and place the caret on) a target line — search hits, backlinks.
  useEffect(() => {
    const v = view.current;
    if (!v || !scrollToLine) return;
    const lineNo = Math.min(Math.max(1, scrollToLine), v.state.doc.lines);
    const pos = v.state.doc.line(lineNo).from;
    v.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    v.focus();
  }, [scrollToLine, path]);

  return <div className="editor-host" ref={host} />;
}
