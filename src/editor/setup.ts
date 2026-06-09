// Assembles the CodeMirror 6 extension stack. New editor-wide features are
// wired in here.
import { EditorState } from "@codemirror/state";
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
import { wikilinks } from "./wikilink";

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
      if (update.docChanged) cb.onChange(update.state.doc.toString());
    }),
  ];
  return EditorState.create({ doc, extensions });
}
