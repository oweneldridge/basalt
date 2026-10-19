import { foldNodeProp } from "@codemirror/language";
import { Emoji, Subscript, Superscript } from "@lezer/markdown";
import { SafeGFM, ObsidianTables } from "../lib/mdTables";
import { ObsidianTasks } from "../lib/mdTasks";
import { LinearParsers } from "../lib/mdLinear";

/** The editor's syntax on top of CommonMark: markdownLanguage's, with tables that stay quick, then Obsidian's. */
export const editorMarkdown = [...SafeGFM, Subscript, Superscript, Emoji, {
  props: [foldNodeProp.add({ Table: (tree, state) => ({ from: state.doc.lineAt(tree.from).to, to: tree.to }) })],
}, ObsidianTasks, ObsidianTables, LinearParsers];
