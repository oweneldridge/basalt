// Vault-wide link rewriting for note rename/move. Pure logic (tested in
// rename.test.ts); the App orchestrates: snapshot resolution, perform the
// filesystem rename, then read-modify-write each affected source FROM DISK.
import { proseMask, targetPathPart, wikilinkRegex } from "./markdown";

const INLINE_CODE_RE = /`[^`\n]*`/g;

/**
 * Rewrite every wikilink/embed in `content` whose target `mapTarget` maps to a
 * new path part. The `#heading`/`^block` suffix and `|alias` are preserved.
 * Skipped — exactly matching how links are EXTRACTED, so a rewrite can never
 * touch text the backlinks pane didn't show: fenced code blocks, frontmatter,
 * and inline code spans (matches are found against a code-masked copy of the
 * line and spliced back into the original). Returns null when nothing changed.
 */
export function rewriteLinks(
  content: string,
  mapTarget: (rawTarget: string) => string | null,
): string | null {
  const lines = content.split("\n");
  const prose = proseMask(lines);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!prose[i]) continue;
    const original = lines[i];
    // Mask inline code with same-length blanks; offsets stay identical, so
    // matches found in the masked copy splice cleanly into the original.
    const masked = original.replace(INLINE_CODE_RE, (m) => " ".repeat(m.length));
    const re = wikilinkRegex();
    let m: RegExpExecArray | null;
    let out = "";
    let last = 0;
    while ((m = re.exec(masked))) {
      const raw = m[1].trim();
      const alias = m[2];
      const pathPart = targetPathPart(raw);
      if (!pathPart) continue; // [[#heading]] self-ref
      const newPathPart = mapTarget(raw);
      if (newPathPart === null) continue;
      const suffix = raw.slice(raw.indexOf(pathPart) + pathPart.length); // #heading / ^block
      out +=
        original.slice(last, m.index) +
        `[[${newPathPart}${suffix}${alias !== undefined ? `|${alias}` : ""}]]`;
      last = m.index + m[0].length;
      changed = true;
    }
    if (last > 0) lines[i] = out + original.slice(last);
  }
  return changed ? lines.join("\n") : null;
}

/**
 * The link text Obsidian would write for a renamed note: the bare name when
 * the basename is unique in the vault, else the folder-qualified path.
 * `newRel` is vault-relative without `.md`; `basenameTaken` is true when
 * another note (not the renamed one) shares the new basename.
 */
export function linkTargetFor(newRel: string, basenameTaken: boolean): string {
  const base = newRel.split("/").pop() ?? newRel;
  return basenameTaken ? newRel : base;
}

export type LinkFormat = "shortest" | "relative" | "absolute";

/** A `./`/`../` link from the note at `fromRel` (with .md) to `toRelNoExt`. */
export function relativeLinkTarget(fromRel: string, toRelNoExt: string): string {
  const fromParts = fromRel.split("/").slice(0, -1);
  const toParts = toRelNoExt.split("/");
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  const ups = fromParts.length - common;
  const rest = toParts.slice(common);
  if (ups === 0) return `./${rest.join("/")}`;
  return [...Array(ups).fill(".."), ...rest].join("/");
}

/** The link text to write for `toRelNoExt` under an Obsidian newLinkFormat. */
export function linkTargetForFormat(
  format: LinkFormat,
  toRelNoExt: string,
  basenameTaken: boolean,
  fromRel: string | null,
): string {
  if (format === "absolute") return toRelNoExt;
  if (format === "relative" && fromRel) return relativeLinkTarget(fromRel, toRelNoExt);
  return linkTargetFor(toRelNoExt, basenameTaken);
}
