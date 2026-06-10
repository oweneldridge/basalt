// The link/metadata index — a *derived cache* rebuilt from the vault, never a
// canonical store (see ARCHITECTURE.md, Principle 1). It powers backlinks and
// unlinked mentions today, and will feed the graph and tag panes later.
//
// Links resolve to a concrete note PATH (not a bare name): `[[README]]` from
// `work/note` resolves to `work/README` if it exists, else the shortest-path
// README — so two same-named notes in different folders are no longer conflated.
import type { VaultNote } from "./vault";
import { normalizeName, targetPathPart, wikilinkRegex } from "./markdown";

/** One wikilink occurrence within a note (deduped per resolved target per line). */
export interface LinkOccurrence {
  /** The raw link target as written (may include `folder/`, `#heading`, `^block`). */
  rawTarget: string;
  /** 1-based line number. */
  line: number;
  /** Trimmed text of the line, for display. */
  snippet: string;
}

/** A reference from one note to another, for the backlinks UI. */
export interface Backlink {
  path: string;
  name: string;
  line: number;
  snippet: string;
}

interface Meta {
  rel: string;
  name: string;
}

/** Reduce a vault-relative path to a comparison key: forward slashes, no `./`
 * prefix, no `.md`, NFC + lowercase. */
function normalizeRel(rel: string): string {
  return rel
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\.md$/i, "")
    .normalize("NFC")
    .trim()
    .toLowerCase();
}

function folderOf(normRel: string): string {
  const i = normRel.lastIndexOf("/");
  return i >= 0 ? normRel.slice(0, i) : "";
}

function depthOf(normRel: string): number {
  return (normRel.match(/\//g) ?? []).length;
}

function extractLinks(content: string): LinkOccurrence[] {
  const out: LinkOccurrence[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const re = wikilinkRegex();
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const rawTarget = m[1].trim();
      const pathPart = targetPathPart(rawTarget);
      if (!pathPart) continue; // [[#heading]] self-ref
      const key = normalizeRel(pathPart); // dedupe identical targets, keep distinct paths
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rawTarget, line: i + 1, snippet: line.trim() });
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FENCE_RE = /^\s*(```|~~~)/;

export class VaultIndex {
  private occ = new Map<string, LinkOccurrence[]>();
  private meta = new Map<string, Meta>();
  // Resolution: normalized basename -> paths (an array, so case/Unicode-distinct
  // notes that share a basename all coexist). Slashed targets filter by path.
  private byName = new Map<string, string[]>();

  build(notes: VaultNote[]): void {
    this.occ.clear();
    this.meta.clear();
    this.byName.clear();
    for (const note of notes) this.setNote(note);
  }

  /** Insert or replace a single note's entry (incremental update on save). */
  setNote(note: VaultNote): void {
    this.removeFromMaps(note.path); // drop the old name/rel entry for this path
    this.meta.set(note.path, { rel: note.rel, name: note.name });
    this.occ.set(note.path, extractLinks(note.content));
    this.addToMaps(note.path, note.rel, note.name);
  }

  removeNote(path: string): void {
    this.removeFromMaps(path);
    this.occ.delete(path);
    this.meta.delete(path);
  }

  private addToMaps(path: string, _rel: string, name: string): void {
    const nn = normalizeName(name);
    const arr = this.byName.get(nn) ?? [];
    if (!arr.includes(path)) arr.push(path);
    this.byName.set(nn, arr);
  }

  private removeFromMaps(path: string): void {
    const m = this.meta.get(path);
    if (!m) return;
    const nn = normalizeName(m.name);
    const arr = this.byName.get(nn);
    if (arr) {
      const i = arr.indexOf(path);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) this.byName.delete(nn);
    }
  }

  /** Pick the best of several same-basename candidates: prefer the source's
   * folder, then the shortest path, then alphabetical. Deterministic. */
  private pickBest(paths: string[], sourcePath: string): string {
    if (paths.length === 1) return paths[0];
    const srcFolder = folderOf(normalizeRel(this.meta.get(sourcePath)?.rel ?? ""));
    return [...paths].sort((a, b) => {
      const ra = normalizeRel(this.meta.get(a)?.rel ?? "");
      const rb = normalizeRel(this.meta.get(b)?.rel ?? "");
      const sa = folderOf(ra) === srcFolder ? 0 : 1;
      const sb = folderOf(rb) === srcFolder ? 0 : 1;
      return sa - sb || depthOf(ra) - depthOf(rb) || ra.localeCompare(rb);
    })[0];
  }

  /**
   * Resolve a raw wikilink target (from `sourcePath`) to a concrete note path,
   * or null if no such note exists. Folder-qualified targets (`folder/Note`)
   * match notes whose path ends with that path; bare names match by basename.
   * Both prefer the source's folder, then the shortest path, then alphabetical.
   */
  resolve(rawTarget: string, sourcePath: string): string | null {
    const p = targetPathPart(rawTarget);
    if (!p) return null;
    const segments = p.split(/[/\\]/);
    const basename = normalizeName(segments[segments.length - 1] ?? "");
    if (!basename) return null;
    const candidates = this.byName.get(basename);
    if (!candidates || candidates.length === 0) return null;

    if (segments.length > 1) {
      // Folder-qualified: keep only notes whose path matches the given path.
      const wantRel = normalizeRel(p);
      const matches = candidates.filter((path) => {
        const rel = normalizeRel(this.meta.get(path)?.rel ?? "");
        return rel === wantRel || rel.endsWith(`/${wantRel}`);
      });
      return matches.length ? this.pickBest(matches, sourcePath) : null;
    }
    return this.pickBest(candidates, sourcePath);
  }

  /** Every wikilink in any other note that resolves to the note at `targetPath`. */
  backlinksFor(targetPath: string): Backlink[] {
    const out: Backlink[] = [];
    for (const [sourcePath, occs] of this.occ) {
      if (sourcePath === targetPath) continue; // ignore self-links
      const meta = this.meta.get(sourcePath);
      if (!meta) continue;
      for (const o of occs) {
        if (this.resolve(o.rawTarget, sourcePath) === targetPath) {
          out.push({ path: sourcePath, name: meta.name, line: o.line, snippet: o.snippet });
        }
      }
    }
    return out;
  }

  /**
   * Notes that mention `noteName` as plain prose on a line that does not link
   * it. Wikilinks and inline code are blanked before matching, and fenced code
   * blocks are skipped, so only genuine, actionable mentions surface.
   */
  unlinkedMentionsFor(
    noteName: string,
    notes: VaultNote[],
    excludePath?: string,
  ): Backlink[] {
    const needle = noteName.trim();
    if (!needle) return [];
    const boundary = new RegExp(
      `(^|[^\\p{L}\\p{N}_])${escapeRegex(needle)}([^\\p{L}\\p{N}_]|$)`,
      "iu",
    );
    const linkRe = wikilinkRegex();
    const inlineCodeRe = /`[^`]*`/g;
    const out: Backlink[] = [];
    for (const note of notes) {
      if (note.path === excludePath) continue;
      const lines = note.content.split("\n");
      let inFence = false;
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (FENCE_RE.test(raw)) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;
        const stripped = raw.replace(linkRe, " ").replace(inlineCodeRe, " ");
        if (!boundary.test(stripped)) continue;
        out.push({ path: note.path, name: note.name, line: i + 1, snippet: raw.trim() });
      }
    }
    return out;
  }
}
