import { useEffect, useRef } from "react";
import { EditorSelection, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditorState, externalReload, reconfigurePlugins, setEditorTheme, setSourceMode, setSpellcheck } from "../editor/setup";
import type { EditorCallbacks } from "../editor/setup";
import type { NoteRef } from "../editor/wikilink";
import type { LinkFormat } from "../lib/rename";

interface Props {
  /** Active note path — changing this rebuilds the editor with fresh content. */
  path: string;
  /** Vault-relative path (with .md) of this note — the self/`this` note for
   * any query block rendered in it. */
  selfRel: string;
  /** Document content for `path`; changing it (same path) reconciles in-place. */
  doc: string;
  getNotes: () => NoteRef[];
  getLinkFormat: () => LinkFormat;
  getActiveRel: () => string | null;
  getHeadings: (name: string) => string[];
  getBlockIds: (name: string) => { id: string; snippet: string }[];
  onOpenWikilink: (target: string) => void;
  onOpenUrl: (url: string) => void;
  resolveImage: (target: string) => Promise<string | null>;
  saveAttachment: (file: File) => Promise<string | null>;
  replacePlaceholder: (placeholder: string, replacement: string) => void;
  onChange: (doc: string) => void;
  /** 1-based line to scroll to / place the caret on (from search or backlinks). */
  scrollToLine?: number;
  /** True = raw Markdown (Live Preview rendering off). */
  sourceMode: boolean;
  /** True = dark editor theme (CM6 dark flag); colors come from CSS vars. */
  dark: boolean;
  spellcheck: boolean;
  /** Bumps when the plugin registry changes → re-apply plugin editor extensions
   * and re-render plugin code-blocks in this live editor. */
  pluginVersion: number;
  /** When set (the focused pane), receives an imperative handle for actions
   * that must target this live editor — e.g. inserting a template at the caret. */
  apiRef?: { current: EditorApi | null };
}

export interface EditorApi {
  /** Replace the selection with `text`; place the caret at `caretOffset` into
   * the inserted text (default: end). */
  insertAtCursor: (text: string, caretOffset?: number) => void;
}

export function EditorPane({
  path,
  selfRel,
  doc,
  getNotes,
  getLinkFormat,
  getActiveRel,
  getHeadings,
  getBlockIds,
  onOpenWikilink,
  onOpenUrl,
  resolveImage,
  saveAttachment,
  replacePlaceholder,
  onChange,
  scrollToLine,
  sourceMode,
  dark,
  spellcheck,
  pluginVersion,
  apiRef,
}: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // Keep the latest callbacks in refs so the editor (rebuilt only per `path`)
  // always calls through to fresh closures without being torn down on every render.
  const cbs = useRef({ getNotes, getLinkFormat, getActiveRel, getHeadings, getBlockIds, onOpenWikilink, onOpenUrl, resolveImage, saveAttachment, replacePlaceholder, onChange });
  cbs.current = { getNotes, getLinkFormat, getActiveRel, getHeadings, getBlockIds, onOpenWikilink, onOpenUrl, resolveImage, saveAttachment, replacePlaceholder, onChange };
  // A stable adapter that always calls through to the freshest closures — used
  // for both editor construction and source-mode reconfiguration.
  const adapter = useRef<EditorCallbacks>({
    getNotes: () => cbs.current.getNotes(),
    getLinkFormat: () => cbs.current.getLinkFormat(),
    getActiveRel: () => cbs.current.getActiveRel(),
    getHeadings: (name: string) => cbs.current.getHeadings(name),
    getBlockIds: (name: string) => cbs.current.getBlockIds(name),
    onOpenWikilink: (t) => cbs.current.onOpenWikilink(t),
    onOpenUrl: (u) => cbs.current.onOpenUrl(u),
    resolveImage: (t) => cbs.current.resolveImage(t),
    saveAttachment: (f) => cbs.current.saveAttachment(f),
    replacePlaceholder: (ph, rep) => cbs.current.replacePlaceholder(ph, rep),
    onChange: (d) => cbs.current.onChange(d),
  });
  const sourceModeRef = useRef(sourceMode);
  sourceModeRef.current = sourceMode;
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const spellcheckRef = useRef(spellcheck);
  spellcheckRef.current = spellcheck;
  const selfRelRef = useRef(selfRel);
  selfRelRef.current = selfRel;

  // Build the editor when the note (path) changes.
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      state: createEditorState(doc, adapter.current, sourceModeRef.current, darkRef.current, selfRelRef.current, spellcheckRef.current),
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

  // Re-apply plugin editor extensions + re-render plugin code-blocks when the
  // plugin registry changes (enable/disable), without rebuilding the editor.
  useEffect(() => {
    if (view.current) reconfigurePlugins(view.current);
  }, [pluginVersion]);

  // Publish an imperative handle while this is the focused pane (apiRef set).
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      insertAtCursor: (text, caretOffset) => {
        const v = view.current;
        if (!v) return;
        const sel = v.state.selection.main;
        const caret = sel.from + (caretOffset ?? text.length);
        v.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: EditorSelection.cursor(caret),
          scrollIntoView: true,
        });
        v.focus();
      },
    };
    return () => {
      if (apiRef.current) apiRef.current = null;
    };
  }, [apiRef, path]);

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

  // Toggle Live Preview rendering in place (no remount, caret preserved).
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    setSourceMode(v, adapter.current, sourceMode);
  }, [sourceMode]);

  // Swap the editor theme in place when the app theme changes (no remount).
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    setEditorTheme(v, dark);
  }, [dark]);

  // Toggle spellcheck in place.
  useEffect(() => {
    if (view.current) setSpellcheck(view.current, spellcheck);
  }, [spellcheck]);

  return <div className="editor-host" data-self-rel={selfRel} ref={host} />;
}
