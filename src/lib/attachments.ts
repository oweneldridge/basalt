// Attachment link resolution: [[Report.pdf]] / ![[diagram.png]] targets match
// attachments by filename (bare) or by vault-relative path suffix, mirroring
// note resolution (root-most wins on ambiguity).
import type { Attachment } from "./vault";
import { targetPathPart } from "./markdown";
import { linkpathDest } from "./linkpath";

const norm = (s: string) => s.normalize("NFC").trim().toLowerCase();

export function resolveAttachment(
  attachments: Attachment[],
  rawTarget: string,
  sourceRel: string | null = null,
  literal = false,
): Attachment | null {
  const p = literal ? rawTarget.trim() : targetPathPart(rawTarget);
  if (!p) return null;
  const file = norm(p.replace(/\\/g, "/").split("/").pop() ?? "");
  return linkpathDest(p, sourceRel, named(attachments, file), (a) => a.rel);
}

// Each list's attachments by file name, made once per list (lists are never
// changed in place), so resolving many links doesn't scan the list each time.
const byName = new WeakMap<Attachment[], Map<string, Attachment[]>>();
function named(attachments: Attachment[], file: string): Attachment[] {
  let names = byName.get(attachments);
  if (!names) {
    names = new Map();
    for (const a of attachments) {
      const key = norm(a.name);
      const same = names.get(key);
      if (same) same.push(a);
      else names.set(key, [a]);
    }
    byName.set(attachments, names);
  }
  return names.get(file) ?? [];
}

/** True if the link target looks like a file with a non-md extension. */
export function looksLikeAttachment(pathPart: string): boolean {
  return /\.[a-z0-9]{1,8}$/i.test(pathPart) && !/\.md$/i.test(pathPart);
}
