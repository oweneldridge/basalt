// Assembles the CodeMirror 6 extension stack. New editor-wide features are
// wired in here.
import { Annotation, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  rectangularSelection,
  highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { indentOnInput, bracketMatching } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";

import { basaltTheme, basaltHighlight } from "./theme";
import { livePreview } from "./livePreview";
import { tables } from "./tables";
import { frontmatter } from "./frontmatter";
import { wikilinks } from "./wikilink";

// Marks a transaction as an external-content reconcile (a live-reload from disk)
// so the change listener doesn't treat it as a user edit and trigger a save-back.
export const externalReload = Annotation.define<boolean>();

export interface EditorCallbacks {
  /** Provides current note names for wikilink autocomplete. */
  getNotes: () => string[];
  /** Open the target of a clicked wikilink. */
  onOpenWikilink: (target: string) => void;
  /** Open an external URL from a clicked Markdown link. */
  onOpenUrl: (url: string) => void;
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
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: GFM }),
    basaltHighlight,
    basaltTheme,
    frontmatter,
    tables,
    livePreview({ onOpenUrl: cb.onOpenUrl }),
    wikilinks({ getNotes: cb.getNotes, onOpen: cb.onOpenWikilink }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...completionKeymap,
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
