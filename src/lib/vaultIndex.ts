// The link/metadata index — a *derived cache* rebuilt from the vault, never a
// canonical store (see ARCHITECTURE.md, Principle 1). It powers backlinks and
// unlinked mentions today, and will feed the graph and tag panes later.
//
// KNOWN LIMITATION (tracked): links resolve by bare note name, so two notes with
// the same basename in different folders are conflated. Phase 2.5 will resolve
// links to a concrete note path (Obsidian-style shortest-unique-path) instead.
import type { VaultNote } from "./vault";
import { normalizeName, targetNoteName, wikilinkRegex } from "./markdown";

/** One wikilink occurrence within a note (deduped per target per line). */
export interface LinkOccurrence {
  /** Normalized name of the note this link points to. */
  target: string;
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

function extractLinks(content: string): LinkOccurrence[] {
  const out: LinkOccurrence[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const re = wikilinkRegex();
    const seen = new Set<string>(); // dedupe identical targets on the same line
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const target = normalizeName(targetNoteName(m[1]));
      if (!target || seen.has(target)) continue; // skip [[#heading]] self-refs + dupes
      seen.add(target);
      out.push({ target, line: i + 1, snippet: line.trim() });
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

  build(notes: VaultNote[]): void {
    this.occ.clear();
    this.meta.clear();
    for (const note of notes) this.setNote(note);
  }

  /** Insert or replace a single note's entry (incremental update on save). */
  setNote(note: VaultNote): void {
    this.meta.set(note.path, { rel: note.rel, name: note.name });
    this.occ.set(note.path, extractLinks(note.content));
  }

  /** Remove a note (call before setNote on a move, since entries are path-keyed). */
  removeNote(path: string): void {
    this.occ.delete(path);
    this.meta.delete(path);
  }

  /** Every wikilink in any other note that resolves to `noteName`. */
  backlinksFor(noteName: string, excludePath?: string): Backlink[] {
    const target = normalizeName(noteName);
    if (!target) return [];
    const out: Backlink[] = [];
    for (const [path, occs] of this.occ) {
      if (path === excludePath) continue;
      const meta = this.meta.get(path);
      if (!meta) continue;
      for (const o of occs) {
        if (o.target === target) {
          out.push({ path, name: meta.name, line: o.line, snippet: o.snippet });
        }
      }
    }
    return out;
  }

  /**
   * Notes that mention `noteName` as plain prose on a line that does not link
   * it. Wikilinks and inline code are blanked before matching, and fenced code
   * blocks are skipped, so only genuine, actionable mentions surface.
   * Computed on demand from the in-memory note contents.
   */
  unlinkedMentionsFor(
    noteName: string,
    notes: VaultNote[],
    excludePath?: string,
  ): Backlink[] {
    const needle = noteName.trim();
    if (!needle) return [];
    // Unicode-aware word boundary: the name must not be flanked by letters,
    // numbers, or underscores (so "Note" doesn't match inside "Notebook").
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
        // Blank wikilinks (incl. ones to this note) and inline code so a link's
        // display text or a code token can't masquerade as an unlinked mention.
        const stripped = raw.replace(linkRe, " ").replace(inlineCodeRe, " ");
        if (!boundary.test(stripped)) continue;
        out.push({ path: note.path, name: note.name, line: i + 1, snippet: raw.trim() });
      }
    }
    return out;
  }
}
