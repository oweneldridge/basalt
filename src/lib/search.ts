// Full-text search over the in-memory vault (the index already holds every
// note's content, so no Rust round-trip is needed). Case/Unicode-insensitive
// substring match (NFC-normalized — NFD filenames/content are routine on
// macOS), ranked before truncation so the cap can't hide better matches.
import type { VaultNote } from "./vault";

export interface SearchHit {
  path: string;
  name: string;
  /** 1-based line number of the match. */
  line: number;
  /** The matching line, trimmed, for display. */
  lineText: string;
}

const MAX_HITS = 300;
const MAX_HITS_PER_NOTE = 20;

const norm = (s: string) => s.normalize("NFC").toLowerCase();

// Normalized lines per note, keyed by the note OBJECT — notes are replaced
// (new object) whenever content changes, so this self-invalidates.
const lineCache = new WeakMap<VaultNote, string[]>();

function normLines(note: VaultNote): string[] {
  let lines = lineCache.get(note);
  if (!lines) {
    lines = note.content.split("\n").map(norm);
    lineCache.set(note, lines);
  }
  return lines;
}

export function searchVault(notes: VaultNote[], query: string): SearchHit[] {
  const q = norm(query.trim());
  if (!q) return [];
  const scored: { hit: SearchHit; score: number }[] = [];
  for (const note of notes) {
    // Title matches rank first — an exact-name query should surface the note.
    const nameIdx = norm(note.name).indexOf(q);
    if (nameIdx !== -1) {
      scored.push({
        hit: { path: note.path, name: note.name, line: 1, lineText: note.name },
        score: 1000 - nameIdx - note.name.length * 0.01,
      });
    }
    const lines = normLines(note);
    const rawLines = note.content.split("\n");
    let inNote = 0;
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].indexOf(q);
      if (idx === -1) continue;
      scored.push({
        hit: { path: note.path, name: note.name, line: i + 1, lineText: rawLines[i].trim() },
        score: 100 - idx * 0.1 - i * 0.001,
      });
      if (++inNote >= MAX_HITS_PER_NOTE) break;
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_HITS).map((s) => s.hit);
}
