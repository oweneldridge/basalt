// Tasks with any status character, as Obsidian reads them: `- [ ]`, `- [x]`,
// `- [/]`, `- [-]`, `- [>]`, and in numbered lists too. GFM's TaskList knows
// only a space or an x, so this replaces it, building the same Task and
// TaskMarker nodes.
import type { BlockContext, LeafBlock, LeafBlockParser, MarkdownConfig } from "@lezer/markdown";

/** A task line's marker, `[` + one status character + `]`. */
export const TASK_MARKER = /^\[[^\]\n]\][ \t]/;

class TaskParser implements LeafBlockParser {
  nextLine(): boolean {
    return false;
  }
  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    cx.addLeafElement(
      leaf,
      cx.elt("Task", leaf.start, leaf.start + leaf.content.length, [
        cx.elt("TaskMarker", leaf.start, leaf.start + 3),
        ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3),
      ]),
    );
    return true;
  }
}

export const ObsidianTasks: MarkdownConfig = {
  remove: ["TaskList"],
  parseBlock: [
    {
      name: "ObsidianTaskList",
      leaf: (cx, leaf) => (TASK_MARKER.test(leaf.content) && cx.parentType().name === "ListItem" ? new TaskParser() : null),
      after: "SetextHeading",
    },
  ],
};
