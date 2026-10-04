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
): Attachment | null {
  const p = targetPathPart(rawTarget);
  if (!p) return null;
  const file = norm(p.replace(/\\/g, "/").split("/").pop() ?? "");
  const cands = attachments.filter((a) => norm(a.name) === file);
  return linkpathDest(p, sourceRel, cands, (a) => a.rel);
}

/** True if the link target looks like a file with a non-md extension. */
export function looksLikeAttachment(pathPart: string): boolean {
  return /\.[a-z0-9]{1,8}$/i.test(pathPart) && !/\.md$/i.test(pathPart);
}
