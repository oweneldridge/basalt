// Attachment link resolution: [[Report.pdf]] / ![[diagram.png]] targets match
// attachments by filename (bare) or by vault-relative path suffix, mirroring
// note resolution (root-most wins on ambiguity).
import type { Attachment } from "./vault";
import { targetPathPart } from "./markdown";

const norm = (s: string) => s.normalize("NFC").trim().toLowerCase();

export function resolveAttachment(
  attachments: Attachment[],
  rawTarget: string,
): Attachment | null {
  const p = targetPathPart(rawTarget);
  if (!p) return null;
  const want = norm(p.replace(/^[/\\]+/, "")).replace(/\\/g, "/");
  const matches = attachments.filter((a) => {
    const rel = norm(a.rel).replace(/\\/g, "/");
    return rel === want || rel.endsWith(`/${want}`) || norm(a.name) === want;
  });
  if (matches.length === 0) return null;
  return matches.sort((a, b) => {
    const da = (a.rel.match(/\//g) ?? []).length;
    const db = (b.rel.match(/\//g) ?? []).length;
    return da - db || a.rel.localeCompare(b.rel);
  })[0];
}

/** True if the link target looks like a file with a non-md extension. */
export function looksLikeAttachment(pathPart: string): boolean {
  return /\.[a-z0-9]{1,8}$/i.test(pathPart) && !/\.md$/i.test(pathPart);
}
