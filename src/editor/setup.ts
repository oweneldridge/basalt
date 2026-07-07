// Assembles the CodeMirror 6 extension stack. New editor-wide features are
// wired in here.
import { Annotation, Compartment, EditorSelection, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  rectangularSelection,
  highlightActiveLine,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentMore,
  indentLess,
  insertTab,
} from "@codemirror/commands";
import { indentOnInput, bracketMatching, indentUnit } from "@codemirror/language";
import {
  acceptCompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";

import { markdownKeys } from "./markdownKeys";

// Context-aware Tab (Obsidian-like): accept an open completion; indent list
// items and multi-line selections; otherwise insert a literal tab at the caret
// (indentMore would indent the LINE, and a tab-indented paragraph is an
// indented code block in Markdown).
const LIST_LINE = /^\s*([-*+>]|\d+[.)])\s/;
const smartTab = (view: EditorView): boolean => {
  if (acceptCompletion(view)) return true;
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  const multiline = !sel.empty && state.doc.lineAt(sel.to).number !== line.number;
  if (multiline || LIST_LINE.test(line.text)) return indentMore(view);
  return insertTab(view);
};

// Typing an emphasis marker over a NON-EMPTY selection wraps it. (Adding these
// chars to closeBrackets instead would also auto-pair them at an empty caret,
// turning a `* ` bullet into `* |*`.)
const wrapSelectionOnType = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (text !== "*" && text !== "_" && text !== "`") return false;
  if (view.state.selection.ranges.every((r) => r.empty)) return false;
  const tr = view.state.changeByRange((range) => {
    if (range.empty) {
      return {
        changes: { from: range.from, insert: text },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const inverted = range.head < range.anchor;
    const a = range.from + 1;
    const b = range.to + 1;
    return {
      changes: [
        { from: range.from, insert: text },
        { from: range.to, insert: text },
      ],
      range: inverted ? EditorSelection.range(b, a) : EditorSelection.range(a, b),
    };
  });
  view.dispatch(view.state.update(tr, { scrollIntoView: true, userEvent: "input.type" }));
  return true;
});

import { basaltThemeFor, basaltHighlight } from "./theme";
import { livePreview } from "./livePreview";
import { tables } from "./tables";
import { frontmatter } from "./frontmatter";
import { codeBlocks } from "./codeBlocks";
import { callouts } from "./callouts";
import { highlight } from "./highlight";
import { tags } from "./tags";
import { embeds } from "./embeds";
import { attachments } from "./attachments";
import { wikilinkAutocomplete, wikilinkDecorations, wikilinkModClickFollow, type NoteRef } from "./wikilink";
import { headingFold, foldKeymap } from "./headingFold";
import { mermaid } from "./mermaid";
import { math } from "./math";
import { query, notePathFacet } from "./query";
import { pluginBlocks } from "./pluginBlocks";
import { transcludeBlocks } from "./transcludeBlocks";
import { pasteLink } from "./pasteLink";
import { pluginEditorExtensions } from "../lib/plugins";
import type { LinkFormat } from "../lib/rename";

// Marks a transaction as an external-content reconcile (a live-reload from disk)
// so the change listener doesn't treat it as a user edit and trigger a save-back.
export const externalReload = Annotation.define<boolean>();

export interface EditorCallbacks {
  /** Current notes (name + rel) for wikilink autocomplete. */
  getNotes: () => NoteRef[];
  /** Obsidian's newLinkFormat setting (default "shortest"). */
  getLinkFormat: () => LinkFormat;
  /** Rel (with .md) of the note being edited — for "relative" link format. */
  getActiveRel: () => string | null;
  /** Headings of a note (by name/alias) — for `[[Note#…` autocomplete. */
  getHeadings: (name: string) => string[];
  /** Open the target of a clicked wikilink / note embed. */
  onOpenWikilink: (target: string) => void;
  /** Open an external URL from a clicked Markdown link. */
  onOpenUrl: (url: string) => void;
  /** Resolve an image reference (relative to the active note) to a URL. */
  resolveImage: (target: string) => Promise<string | null>;
  /** Persist a pasted/dropped file; resolves to the link target or null. */
  saveAttachment: (file: File) => Promise<string | null>;
  /** Replace an upload placeholder in whichever note holds it (the live editor
   * no longer does — note switch / external reload mid-upload). */
  replacePlaceholder: (placeholder: string, replacement: string) => void;
  /** Fired (on every edit) with the full document text. */
  onChange: (doc: string) => void;
}

// Source mode: all Live Preview rendering lives in one Compartment so it can
// be toggled off (raw Markdown) without rebuilding the editor.
const renderCompartment = new Compartment();
// The editor theme lives in its own compartment so a light/dark switch only
// reconfigures CM6's `dark` flag (the colors are CSS vars) — no remount.
const themeCompartment = new Compartment();
// Plugin-contributed CM6 extensions live in a compartment so enabling/disabling
// a plugin can add/remove them from LIVE editors without a remount.
const pluginCompartment = new Compartment();
// Spellcheck lives in its own compartment so it can be toggled without a remount.
const spellcheckCompartment = new Compartment();

/** Toggle native spellcheck on a live editor. */
export function setSpellcheck(view: EditorView, on: boolean): void {
  view.dispatch({
    effects: spellcheckCompartment.reconfigure(
      EditorView.contentAttributes.of({ spellcheck: on ? "true" : "false" }),
    ),
  });
}

/** Swap the editor theme between dark and light without rebuilding the editor. */
export function setEditorTheme(view: EditorView, dark: boolean): void {
  view.dispatch({ effects: themeCompartment.reconfigure(basaltThemeFor(dark)) });
}

/** Re-apply the current set of plugin editor extensions to a live editor, and
 * force plugin/query block widgets to recompute (so a just-enabled plugin's
 * code-block processor renders in an already-open note). */
export function reconfigurePlugins(view: EditorView): void {
  view.dispatch({
    effects: pluginCompartment.reconfigure(pluginEditorExtensions()),
    selection: view.state.selection, // re-set → block StateFields recompute
  });
}

function renderExtensions(cb: EditorCallbacks): Extension[] {
  return [
    frontmatter,
    tables,
    mermaid,
    math,
    query,
    pluginBlocks,
    transcludeBlocks,
    codeBlocks,
    callouts,
    highlight,
    tags,
    embeds({ resolveImage: cb.resolveImage, onOpen: cb.onOpenWikilink }),
    livePreview({ onOpenUrl: cb.onOpenUrl, resolveImage: cb.resolveImage }),
    wikilinkDecorations({ onOpen: cb.onOpenWikilink }),
  ];
}

/** Toggle Live Preview rendering on an existing editor (true = source mode).
 * Idempotent — EditorPane calls this once on mount with the already-correct
 * state, and a redundant reconfigure would tear down and rebuild every
 * decoration plugin for nothing. */
export function setSourceMode(view: EditorView, cb: EditorCallbacks, on: boolean): void {
  const current = renderCompartment.get(view.state);
  const currentlyOff = Array.isArray(current) && current.length === 0;
  if (currentlyOff === on) return;
  view.dispatch({
    effects: [
      renderCompartment.reconfigure(on ? [] : renderExtensions(cb)),
      // Block widgets above the caret change height across the toggle.
      EditorView.scrollIntoView(view.state.selection.main.head),
    ],
  });
}

// Where the caret should start when a note opens: just past the frontmatter, so
// the Properties view renders instead of the raw YAML being revealed for editing.
function initialCursor(doc: string): number {
  const lines = doc.split("\n");
  if (lines.length < 2 || lines[0].trim() !== "---") return 0;
  let offset = lines[0].length + 1; // start of line 1
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") {
      return Math.min(offset + lines[i].length + 1, doc.length);
    }
    offset += lines[i].length + 1;
  }
  return 0;
}

export function createEditorState(
  doc: string,
  cb: EditorCallbacks,
  sourceMode = false,
  dark = true,
  selfRel = "",
  spellcheck = true,
): EditorState {
  const extensions: Extension[] = [
    notePathFacet.of(selfRel),
    // CM6 extensions contributed by enabled plugins — in a compartment so
    // enable/disable reflects into live editors via reconfigurePlugins().
    pluginCompartment.of(pluginEditorExtensions()),
    history(),
    drawSelection(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    EditorView.lineWrapping,
    // Multi-cursor (Cmd-D via searchKeymap's selectNextOccurrence, Alt-drag).
    EditorState.allowMultipleSelections.of(true),
    // Obsidian-style tab indentation for nested lists.
    indentUnit.of("\t"),
    wrapSelectionOnType,
    pasteLink,
    // Native autocorrect/-capitalize (static); spellcheck is in a compartment
    // so it can be toggled live.
    EditorView.contentAttributes.of({ autocorrect: "on", autocapitalize: "on" }),
    spellcheckCompartment.of(
      EditorView.contentAttributes.of({ spellcheck: spellcheck ? "true" : "false" }),
    ),
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: GFM }),
    basaltHighlight,
    themeCompartment.of(basaltThemeFor(dark)),
    // Heading folding — outside the render compartment, so it works in both
    // Live Preview and source mode.
    headingFold,
    renderCompartment.of(sourceMode ? [] : renderExtensions(cb)),
    // Always on, even in source mode: paste/drop and [[ completion.
    attachments({ save: cb.saveAttachment, fallbackReplace: cb.replacePlaceholder }),
    wikilinkAutocomplete({
      getNotes: cb.getNotes,
      getLinkFormat: cb.getLinkFormat,
      getActiveRel: cb.getActiveRel,
      getHeadings: cb.getHeadings,
    }),
    // Cmd/Ctrl-click follows a raw [[link]] — the only navigation affordance
    // that must survive source mode (Obsidian behaves the same).
    wikilinkModClickFollow(cb.onOpenWikilink),
    // Real key precedence (higher first): completionKeymap (Prec.highest, injected
    // by autocompletion() in wikilink.ts) > markdownKeymap (Prec.high, injected by
    // markdown() — Enter continues lists/quotes/tasks, Backspace eats markup) >
    // this flat keymap.
    keymap.of([
      ...closeBracketsKeymap,
      ...markdownKeys, // Mod-B/I/K formatting
      { key: "Tab", run: smartTab, shift: indentLess },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap, // includes Mod-D select-next-occurrence (multi-cursor)
      ...foldKeymap, // Ctrl/Cmd-Shift-[ fold, -] unfold; Ctrl-Alt-[/] fold/unfold all
    ]),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      // Ignore reconciles (external reloads) — only user edits should autosave.
      if (update.transactions.some((t) => t.annotation(externalReload))) return;
      cb.onChange(update.state.doc.toString());
    }),
  ];
  return EditorState.create({ doc, selection: { anchor: initialCursor(doc) }, extensions });
}
