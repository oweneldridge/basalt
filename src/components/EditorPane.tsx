import { useEffect, useLayoutEffect, useRef } from "react";
import { EditorSelection, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditorState, externalReload, reconfigurePlugins, setEditorTheme, setSourceMode, setSpellcheck, setVimMode, setRtl } from "../editor/setup";
import type { EditorCallbacks } from "../editor/setup";
import type { NoteRef } from "../editor/wikilink";
import type { LinkFormat } from "../lib/rename";
import { toggleBold, toggleItalic } from "../editor/markdownKeys";
import { textChanges } from "../lib/textDiff";

interface Props {
  /** Active note path — changing this rebuilds the editor with fresh content. */
  path: string;
  /** Vault-relative path (with .md) of this note — the self/`this` note for
   * any query block rendered in it. */
  selfRel: string;
  /** Document content for `path`; changing it (same path) reconciles in-place. */
  doc: string;
  /** Changes whenever the app explicitly sets `doc`, so a reload whose text
   * equals an older `doc` prop still reconciles. */
  docRev?: number;
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
  onCursor?: (line: number, col: number, selChars: number) => void;
  onContextMenu?: (x: number, y: number) => void;
  /** 1-based line to scroll to / place the caret on (from search or backlinks). */
  scrollToLine?: number;
  /** Changes when the same line is asked for again. */
  scrollRev?: number;
  /** True = raw Markdown (Live Preview rendering off). */
  sourceMode: boolean;
  /** True = dark editor theme (CM6 dark flag); colors come from CSS vars. */
  dark: boolean;
  spellcheck: boolean;
  vim: boolean;
  rtl: boolean;
  /** Bumps when the plugin registry changes → re-apply plugin editor extensions
   * and re-render plugin code-blocks in this live editor. */
  pluginVersion: number;
  /** When set (the focused pane), receives an imperative handle for actions
   * that must target this live editor — e.g. inserting a template at the caret. */
  apiRef?: { current: EditorApi | null };
  /** The pane (or a pane's stack) this editor lives in, and the path of the
   * note it replaces when a rename or folder move rebuilt it: then the caret,
   * scroll and focus carry over. */
  paneId?: string;
  continuesFrom?: string;
}

// The state of editors as they were torn down, by pane (or stack) and path, for
// the rebuild that follows a rename.
const handoff = new Map<
  string,
  { path: string; text: string; selection: EditorSelection; focused: boolean; reported: number[] }
>();

// The editor that last had keyboard focus. Kept when focus leaves the page or
// its element is removed; cleared once focus moves somewhere else.
let focusedView: EditorView | null = null;

/** A short fingerprint of a text (FNV-1a plus its length). */
function textHash(t: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
  return (h ^ t.length) >>> 0;
}

// Editors built during the current commit; cleared on the next task.
const mountedNow = new Set<Element>();

// Every live editor, by the path of the note it shows (panes and stacked columns).
const openEditors = new Map<string, Set<EditorView>>();

/**
 * Rewrite the text of every open editor on `path` through `fn`, as small edits
 * applied in the editor itself. Typing in progress merges with them instead of
 * overwriting them, and the edit is reported like typing, so it gets saved;
 * it's kept out of undo history. Returns the editors' text afterwards, or null
 * when no editor shows the note.
 */
// Each live editor's hook for text applied to it by showText.
const onShown = new WeakMap<EditorView, (text: string) => void>();

/**
 * Put `text` into every open editor on `path` at once, as an outside change
 * (not reported as typing, kept out of undo history). Updates decided from
 * disk or another pane land here before any later keystroke can be read
 * against the older text; the `doc` prop that follows is then a no-op.
 */
export function showText(path: string, text: string): void {
  for (const v of openEditors.get(path) ?? []) {
    const current = v.state.doc.toString();
    if (current === text) continue;
    v.dispatch({
      changes: textChanges(current, text),
      annotations: [externalReload.of(true), Transaction.addToHistory.of(false)],
    });
    onShown.get(v)?.(text);
  }
}

/** How many open editors show `path`. */
export function editorCount(path: string): number {
  return openEditors.get(path)?.size ?? 0;
}

/** The text of an open editor on `path`, if one shows it (newest there is). */
export function editorText(path: string): string | undefined {
  for (const v of openEditors.get(path) ?? []) return v.state.doc.toString();
  return undefined;
}

export function fixOpenEditors(path: string, fn: (text: string) => string): string | null {
  const views = openEditors.get(path);
  if (!views || views.size === 0) return null;
  // Fixing one editor syncs the others on the note (showText). Each is fixed
  // from the text it had before, and one already synced is left alone: a fix
  // applied twice can point a link somewhere else.
  const before = new Map([...views].map((v) => [v, v.state.doc.toString()]));
  let text: string | null = null;
  for (const v of views) {
    const current = v.state.doc.toString();
    if (current !== before.get(v)) {
      text = current;
      continue;
    }
    const changes = textChanges(current, fn(current));
    if (changes.length) v.dispatch({ changes, annotations: Transaction.addToHistory.of(false) });
    text = v.state.doc.toString();
  }
  return text;
}

export interface EditorApi {
  /** Replace the selection with `text`; place the caret at `caretOffset` into
   * the inserted text (default: end). */
  insertAtCursor: (text: string, caretOffset?: number) => void;
  /** True when the selection starts at the very top of the note. */
  atStart: () => boolean;
  /** The note's text and where the selection starts. */
  getText: () => string;
  selectionFrom: () => number;
  /** Insert `text` at `pos` (not at the caret) and put the caret `caretOffset` into it. */
  insertAt: (pos: number, text: string, caretOffset?: number) => void;
  /** Rewrite the note through `fn`, applied as the smallest edit so the caret stays put. */
  transformDoc: (fn: (doc: string) => string) => void;
  /** True when the editor has a non-empty selection. */
  hasSelection: () => boolean;
  /** Put keyboard focus back in the editor. */
  focus: () => void;
  /** Editor context-menu actions (operate on the current selection/caret). */
  copy: () => void;
  cut: () => void;
  paste: () => void;
  bold: () => void;
  italic: () => void;
}

export function EditorPane({
  path,
  selfRel,
  doc,
  docRev,
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
  onCursor,
  onContextMenu,
  scrollToLine,
  scrollRev,
  sourceMode,
  dark,
  spellcheck,
  vim,
  rtl,
  pluginVersion,
  apiRef,
  paneId,
  continuesFrom,
}: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // Keep the latest callbacks in refs so the editor (rebuilt only per `path`)
  // always calls through to fresh closures without being torn down on every render.
  // Fingerprints of the texts this editor reported lately, oldest first. A `doc`
  // prop equal to one of them, with no new docRev, is an echo of its own typing
  // and must not be applied. Echoes come back in order, so a text older than
  // one already echoed was put back by someone else (another pane or device).
  const reported = useRef<{ hash: number; seq: number }[]>([]);
  const reportSeq = useRef(0);
  const echoFloor = useRef(0);
  // The text showText last put in this editor: a `doc` prop equal to it has
  // been applied already, and typing since must stay.
  const shownText = useRef<string | null>(null);
  const lastDocRev = useRef(docRev);
  // The `doc` prop the editor has already accounted for: it's synced when the
  // editor is built, so the reconcile below acts only on later changes.
  const docSeen = useRef(doc);
  const cbs = useRef({ getNotes, getLinkFormat, getActiveRel, getHeadings, getBlockIds, onOpenWikilink, onOpenUrl, resolveImage, saveAttachment, replacePlaceholder, onChange, onCursor, onContextMenu });
  cbs.current = { getNotes, getLinkFormat, getActiveRel, getHeadings, getBlockIds, onOpenWikilink, onOpenUrl, resolveImage, saveAttachment, replacePlaceholder, onChange, onCursor, onContextMenu };
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
    onChange: (d) => {
      reported.current.push({ hash: textHash(d), seq: reportSeq.current++ });
      if (reported.current.length > 64) reported.current.shift();
      cbs.current.onChange(d);
    },
    onCursor: (l, c, s) => cbs.current.onCursor?.(l, c, s),
    onContextMenu: (x, y) => cbs.current.onContextMenu?.(x, y),
  });
  const sourceModeRef = useRef(sourceMode);
  sourceModeRef.current = sourceMode;
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const spellcheckRef = useRef(spellcheck);
  spellcheckRef.current = spellcheck;
  const vimRef = useRef(vim);
  vimRef.current = vim;
  const rtlRef = useRef(rtl);
  rtlRef.current = rtl;
  const selfRelRef = useRef(selfRel);
  selfRelRef.current = selfRel;

  // Build the editor when the note (path) changes. A layout effect: the old
  // editor's element leaves the page at commit, and a keystroke arriving before
  // the new one exists would land nowhere.
  useLayoutEffect(() => {
    if (!host.current) return;
    // Rebuilt by a rename: start from the old editor's text, which has anything
    // typed after the repoint captured `doc`.
    const prevKey = paneId && continuesFrom ? `${paneId}|${continuesFrom}` : null;
    const prev = prevKey ? handoff.get(prevKey) : undefined;
    if (prevKey) handoff.delete(prevKey);
    const continuing = prev !== undefined;
    const v = new EditorView({
      state: createEditorState(continuing ? prev.text : doc, adapter.current, sourceModeRef.current, darkRef.current, selfRelRef.current, spellcheckRef.current, vimRef.current, rtlRef.current),
      parent: host.current,
    });
    view.current = v;
    const registered = openEditors.get(path) ?? new Set<EditorView>();
    registered.add(v);
    onShown.set(v, (text) => {
      shownText.current = text;
      echoFloor.current = reportSeq.current;
    });
    openEditors.set(path, registered);
    const onFocus = () => (focusedView = v);
    const onBlur = (e: FocusEvent) => {
      if (focusedView === v && e.relatedTarget) focusedView = null;
    };
    v.contentDOM.addEventListener("focus", onFocus);
    v.contentDOM.addEventListener("blur", onBlur);
    // Rebuilt by a rename: keep the place, and take focus only if the old editor
    // had it (else typing in another pane would land here). A note being opened
    // takes focus as usual.
    if (continuing) {
      v.dispatch({ selection: prev.selection, effects: EditorView.scrollIntoView(prev.selection.main.head, { y: "center" }) });
      // `doc` is then an earlier text of this same editor, unless another
      // editor on the note typed it: that one is applied now, like any edit.
      if (prev.text !== doc && !prev.reported.includes(textHash(doc))) {
        v.dispatch({
          changes: textChanges(prev.text, doc),
          annotations: [externalReload.of(true), Transaction.addToHistory.of(false)],
        });
      }
    }
    docSeen.current = doc;
    // Never pull focus out of another editor someone is typing in. One built in
    // this same commit doesn't count: the last of those takes focus, as before.
    mountedNow.add(v.dom);
    setTimeout(() => mountedNow.delete(v.dom), 0);
    const other = document.activeElement?.closest?.(".cm-editor");
    const inOtherEditor = !!other && other !== v.dom && !mountedNow.has(other);
    if (continuing ? prev.focused : !inOtherEditor) v.focus();
    return () => {
      if (paneId) {
        if (handoff.size > 100) handoff.delete(handoff.keys().next().value!);
        handoff.set(`${paneId}|${path}`, {
          path,
          text: v.state.doc.toString(),
          selection: v.state.selection,
          focused: focusedView === v,
          reported: reported.current.map((r) => r.hash),
        });
      }
      if (focusedView === v) focusedView = null;
      registered.delete(v);
      if (registered.size === 0 && openEditors.get(path) === registered) openEditors.delete(path);
      v.contentDOM.removeEventListener("focus", onFocus);
      v.contentDOM.removeEventListener("blur", onBlur);
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
      atStart: () => view.current?.state.selection.main.from === 0,
      getText: () => view.current?.state.doc.toString() ?? "",
      selectionFrom: () => view.current?.state.selection.main.from ?? 0,
      insertAt: (pos, text, caretOffset) => {
        const v = view.current;
        if (!v) return;
        const at = Math.min(pos, v.state.doc.length);
        v.dispatch({
          changes: { from: at, insert: text },
          selection: EditorSelection.cursor(at + (caretOffset ?? text.length)),
          scrollIntoView: true,
        });
        v.focus();
      },
      transformDoc: (fn) => {
        const v = view.current;
        if (!v) return;
        const doc = v.state.doc.toString();
        const changes = textChanges(doc, fn(doc));
        if (changes.length) v.dispatch({ changes });
      },
      hasSelection: () => {
        const v = view.current;
        return !!v && !v.state.selection.main.empty;
      },
      focus: () => view.current?.focus(),
      copy: () => {
        const v = view.current;
        if (!v) return;
        const m = v.state.selection.main;
        const text = v.state.sliceDoc(m.from, m.to);
        if (text) void navigator.clipboard?.writeText(text);
        v.focus();
      },
      cut: () => {
        const v = view.current;
        if (!v) return;
        const m = v.state.selection.main;
        const text = v.state.sliceDoc(m.from, m.to);
        if (!text) return;
        void navigator.clipboard?.writeText(text);
        v.dispatch({ changes: { from: m.from, to: m.to, insert: "" }, selection: EditorSelection.cursor(m.from) });
        v.focus();
      },
      paste: () => {
        const v = view.current;
        if (!v) return;
        void navigator.clipboard?.readText().then((text) => {
          if (!text || !view.current) return;
          const vv = view.current;
          const m = vv.state.selection.main;
          vv.dispatch({
            changes: { from: m.from, to: m.to, insert: text },
            selection: EditorSelection.cursor(m.from + text.length),
            scrollIntoView: true,
          });
          vv.focus();
        });
      },
      bold: () => {
        const v = view.current;
        if (v) {
          toggleBold(v);
          v.focus();
        }
      },
      italic: () => {
        const v = view.current;
        if (v) {
          toggleItalic(v);
          v.focus();
        }
      },
    };
    return () => {
      if (apiRef.current) apiRef.current = null;
    };
  }, [apiRef, path]);

  // Reconcile an external live-reload into the existing editor WITHOUT remounting,
  // and without triggering a save-back. Applied as separate small edits, so the
  // caret maps through them and stays on the text it was on.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const explicit = docRev !== lastDocRev.current;
    lastDocRev.current = docRev;
    if (!explicit && doc === docSeen.current) return;
    docSeen.current = doc;
    if (doc === shownText.current) return;
    shownText.current = null;
    if (!explicit) {
      const h = textHash(doc);
      const echo = [...reported.current].reverse().find((r) => r.hash === h);
      if (echo && echo.seq >= echoFloor.current) {
        echoFloor.current = echo.seq;
        return;
      }
    }
    const changes = textChanges(v.state.doc.toString(), doc);
    if (!changes.length) return;
    echoFloor.current = reportSeq.current;
    // Keep the reconcile OUT of undo history: Cmd-Z must never resurrect
    // pre-reload content (which would then autosave over the external edit).
    v.dispatch({
      changes,
      annotations: [externalReload.of(true), Transaction.addToHistory.of(false)],
    });
  }, [doc, docRev]);

  // Scroll to (and place the caret on) a target line — search hits, backlinks.
  // A layout effect, like the build above: a key typed as the note opens goes
  // to the target line, not the top.
  useLayoutEffect(() => {
    const v = view.current;
    if (!v || !scrollToLine) return;
    const lineNo = Math.min(Math.max(1, scrollToLine), v.state.doc.lines);
    const pos = v.state.doc.line(lineNo).from;
    v.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    v.focus();
  }, [scrollToLine, scrollRev, path]);

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

  // Toggle Vim keybindings in place.
  useEffect(() => {
    if (view.current) setVimMode(view.current, vim);
  }, [vim]);

  // Toggle right-to-left text direction in place.
  useEffect(() => {
    if (view.current) setRtl(view.current, rtl);
  }, [rtl]);

  return <div className="editor-host" data-self-rel={selfRel} ref={host} />;
}
