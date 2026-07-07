// Vault-wide link rewriting for note rename/move. Pure logic (tested in
// rename.test.ts); the App orchestrates: snapshot resolution, perform the
// filesystem rename, then read-modify-write each affected source FROM DISK.
import {
  encodeMdPath,
  internalMdHref,
  mdLinkRegexGlobal,
  proseMask,
  targetPathPart,
  wikilinkRegex,
} from "./markdown";

const INLINE_CODE_RE = /`[^`\n]*`/g;

// Splits one markdown-link match into (prefix)(url-token)(title+close). Same
// one-level-bracket text class as mdLinkRegexGlobal so the scanner and this
// parser agree on every match. The three groups span the match exactly, which
// the masked-offset splicing below relies on.
const MD_PARTS =
  /^(!?\[(?:[^\][\n]|\[[^\][\n]*\])*\]\(\s*)(<[^>]+>|(?:[^()\s]|\([^()\s]*\))+)((?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\))$/;

/** Rewrite internal markdown-style links on a single (code-masked) line. */
function rewriteMdLine(
  original: string,
  masked: string,
  mapTarget: (rawTarget: string) => string | null,
): string | null {
  const re = mdLinkRegexGlobal();
  let m: RegExpExecArray | null;
  let out = "";
  let last = 0;
  let changed = false;
  while ((m = re.exec(masked))) {
    const parts = MD_PARTS.exec(m[0]);
    if (!parts) continue;
    let urlToken = parts[2];
    const angled = urlToken.startsWith("<") && urlToken.endsWith(">");
    const href = angled ? urlToken.slice(1, -1) : urlToken;
    const internal = internalMdHref(href);
    if (!internal) continue;
    const newPathPart = mapTarget(internal.path + internal.fragment);
    if (newPathPart === null) continue;
    // A raw fragment with whitespace/parens is only valid inside <…>; keep the
    // angle form there (raw path, the way angled hrefs are authored).
    urlToken =
      angled && /[\s()]/.test(internal.fragment)
        ? `<${newPathPart}.md${internal.fragment}>`
        : encodeMdPath(`${newPathPart}.md`) + internal.fragment;
    // `parts` matched the code-MASKED copy: splice the prefix (link text) and
    // tail (title + close) from `original` BY OFFSET — the mask is
    // length-preserving — so inline code inside them survives on disk.
    out +=
      original.slice(last, m.index) +
      original.slice(m.index, m.index + parts[1].length) +
      urlToken +
      original.slice(m.index + parts[1].length + parts[2].length, m.index + m[0].length);
    last = m.index + m[0].length;
    changed = true;
  }
  if (!changed) return null;
  return out + original.slice(last);
}

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
      // m matched the code-MASKED copy; the suffix (#heading / ^block) and
      // alias are re-emitted, so slice them from `original` BY OFFSET (the
      // mask is length-preserving) — else inline code in them would be
      // written back to disk as blanks. The target itself is safe: a
      // code-masked target fails resolution and is skipped above.
      const targetEnd = m.index + 2 + m[1].length;
      const suffixStart =
        m.index +
        2 +
        (m[1].length - m[1].trimStart().length) +
        raw.indexOf(pathPart) +
        pathPart.length;
      const suffix = original.slice(suffixStart, targetEnd).trimEnd();
      const aliasText =
        alias !== undefined
          ? original.slice(targetEnd + 1, m.index + m[0].length - 2)
          : undefined;
      out +=
        original.slice(last, m.index) +
        `[[${newPathPart}${suffix}${aliasText !== undefined ? `|${aliasText}` : ""}]]`;
      last = m.index + m[0].length;
      changed = true;
    }
    if (last > 0) lines[i] = out + original.slice(last);
    // Second pass: markdown-style internal links on the (possibly updated) line.
    const current = lines[i];
    const maskedNow = current.replace(INLINE_CODE_RE, (mm) => " ".repeat(mm.length));
    const mdRewritten = rewriteMdLine(current, maskedNow, mapTarget);
    if (mdRewritten !== null) {
      lines[i] = mdRewritten;
      changed = true;
    }
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

/** Context for a single-pass folder move's link rewrite. The resolvers answer
 * "what note does this link text point to" in the PRE- and POST-move vault
 * (both share the SAME content — only paths moved). The optional `att*` fields
 * mirror this for ATTACHMENTS (image/PDF/etc. targets), which the note index
 * doesn't cover — needed because a folder RENAME changes the folder segment, so
 * a folder-qualified `![[proj/pic.png]]` stops resolving once proj is renamed. */
export interface FolderMoveCtx {
  resolvePre: (raw: string, fromPath: string) => string | null;
  resolvePost: (raw: string, fromPath: string) => string | null;
  /** oldPath → newPath for every note the move relocated. */
  movedNewPathByOld: Map<string, string>;
  /** The post-move note at a path (rel + name), or undefined. */
  noteAt: (path: string) => { rel: string; name: string } | undefined;
  /** Whether another note (≠ exceptPath) shares `name` in the post-move vault. */
  nameTaken: (name: string, exceptPath: string) => boolean;
  format: LinkFormat;
  // --- attachments (optional) ---
  resolveAttPre?: (raw: string) => string | null;
  resolveAttPost?: (raw: string) => string | null;
  movedAttNewPathByOld?: Map<string, string>;
  attAt?: (path: string) => { rel: string; name: string } | undefined;
  attNameTaken?: (name: string, exceptPath: string) => boolean;
}

/** Build the per-source link mapper for a folder move. It rewrites EXACTLY the
 * links whose resolution the move changed (the resolver decides — so relative /
 * absolute / bare / alias forms are handled uniformly; a link that still
 * resolves to its intended note, e.g. an intra-folder relative link or a bare
 * shortest link, is left untouched). `sourceOldPath`/`sourcePostPath` are the
 * source note's pre/post paths; `sourcePostRel` seeds the relative format. */
export function folderMoveMapper(
  ctx: FolderMoveCtx,
  sourceOldPath: string,
  sourcePostPath: string,
  sourcePostRel: string,
): (raw: string) => string | null {
  return (raw: string): string | null => {
    const destOld = ctx.resolvePre(raw, sourceOldPath);
    if (destOld) {
      const destPost = ctx.movedNewPathByOld.get(destOld) ?? destOld;
      if (ctx.resolvePost(raw, sourcePostPath) === destPost) return null; // still resolves
      const dest = ctx.noteAt(destPost);
      if (!dest) return null;
      return linkTargetForFormat(
        ctx.format,
        dest.rel.replace(/\.md$/i, ""),
        ctx.nameTaken(dest.name, destPost),
        sourcePostRel,
      );
    }
    // Not a note target — maybe an attachment (image/PDF/audio/video) that moved.
    if (ctx.resolveAttPre && ctx.resolveAttPost && ctx.movedAttNewPathByOld && ctx.attAt && ctx.attNameTaken) {
      const attOld = ctx.resolveAttPre(raw);
      if (!attOld) return null;
      const attPost = ctx.movedAttNewPathByOld.get(attOld) ?? attOld;
      if (ctx.resolveAttPost(raw) === attPost) return null; // still resolves
      const att = ctx.attAt(attPost);
      if (!att) return null;
      // Attachments keep their extension — pass the full rel as the "toRel".
      return linkTargetForFormat(ctx.format, att.rel, ctx.attNameTaken(att.name, attPost), sourcePostRel);
    }
    return null;
  };
}
