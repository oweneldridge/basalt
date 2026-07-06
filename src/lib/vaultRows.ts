// Shared vault-row construction for the Bases viewer and the query engine.
// Both need every note/attachment as a BaseRow (frontmatter + file metadata).
// Rows are cached per source OBJECT — a save replaces only the edited note's
// object, so unchanged notes skip re-parsing — and stamped with a version that
// bumps when cross-note data (tags/links from the index) can change.

import { parseProperties, type BaseRow } from "./bases";
import { extractTasks, type Task } from "./query";
import type { VaultNote, Attachment } from "./vault";

const rowCache = new WeakMap<object, { v: number; row: BaseRow }>();
const taskCache = new WeakMap<VaultNote, Task[]>();

function folderOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

export function noteRow(
  n: VaultNote,
  v: number,
  tagsOf: (p: string) => string[],
  linkKeysOf: (p: string) => string[],
): BaseRow {
  const hit = rowCache.get(n);
  if (hit && hit.v === v) return hit.row;
  const row: BaseRow = {
    name: n.rel.split("/").pop() ?? n.rel,
    basename: n.name,
    path: n.rel,
    folder: folderOf(n.rel),
    ext: "md",
    size: n.size ?? 0,
    ctime: n.ctime ?? 0,
    mtime: n.mtime ?? 0,
    tags: tagsOf(n.path).map((t) => t.replace(/^#/, "").toLowerCase()),
    linkKeys: linkKeysOf(n.path),
    properties: parseProperties(n.content),
  };
  rowCache.set(n, { v, row });
  return row;
}

export function attachmentRow(a: Attachment, v: number): BaseRow {
  const hit = rowCache.get(a);
  if (hit && hit.v === v) return hit.row;
  const dot = a.name.lastIndexOf(".");
  const row: BaseRow = {
    name: a.name,
    basename: dot > 0 ? a.name.slice(0, dot) : a.name,
    path: a.rel,
    folder: folderOf(a.rel),
    ext: dot > 0 ? a.name.slice(dot + 1).toLowerCase() : "",
    size: a.size ?? 0,
    ctime: a.ctime ?? 0,
    mtime: a.mtime ?? 0,
    tags: [],
    linkKeys: [],
    properties: {},
  };
  rowCache.set(a, { v, row });
  return row;
}

/** A note's checkbox tasks, cached by the note object (invalidated on save,
 * which replaces the object). Keyed by vault-relative path. */
export function tasksForNote(n: VaultNote): Task[] {
  const hit = taskCache.get(n);
  if (hit) return hit;
  const tasks = extractTasks(n.content, n.rel);
  taskCache.set(n, tasks);
  return tasks;
}
