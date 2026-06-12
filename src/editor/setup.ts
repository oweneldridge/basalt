// Assembles the CodeMirror 6 extension stack. New editor-wide features are
// wired in here.
import { Annotation, EditorSelection, EditorState } from "@codemirror/state";
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

import { basaltTheme, basaltHighlight } from "./theme";
import { livePreview } from "./livePreview";
import { tables } from "./tables";
import { frontmatter } from "./frontmatter";
import { codeBlocks } from "./codeBlocks";
import { callouts } from "./callouts";
import { highlight } from "./highlight";
import { tags } from "./tags";
import { embeds } from "./embeds";
import { attachments } from "./attachments";
import { wikilinks } from "./wikilink";

// Marks a transaction as an external-content reconcile (a live-reload from disk)
// so the change listener doesn't treat it as a user edit and trigger a save-back.
export const externalReload = Annotation.define<boolean>();

export interface EditorCallbacks {
  /** Provides current note names for wikilink autocomplete. */
  getNotes: () => string[];
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

export function createEditorState(doc: string, cb: EditorCallbacks): EditorState {
  const extensions: Extension[] = [
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
    // Native spellcheck/autocorrect in the editor, like Obsidian.
    EditorView.contentAttributes.of({
      spellcheck: "true",
      autocorrect: "on",
      autocapitalize: "on",
    }),
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: GFM }),
    basaltHighlight,
    basaltTheme,
    frontmatter,
    tables,
    codeBlocks,
    callouts,
    highlight,
    tags,
    embeds({ resolveImage: cb.resolveImage, onOpen: cb.onOpenWikilink }),
    attachments({ save: cb.saveAttachment, fallbackReplace: cb.replacePlaceholder }),
    livePreview({ onOpenUrl: cb.onOpenUrl, resolveImage: cb.resolveImage }),
    wikilinks({ getNotes: cb.getNotes, onOpen: cb.onOpenWikilink }),
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
