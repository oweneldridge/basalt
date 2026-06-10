// Full-text search over the in-memory vault (the index already holds every
// note's content, so no Rust round-trip is needed). Case-insensitive substring
// match, capped so a broad query can't produce an unbounded result list.
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

export function searchVault(notes: VaultNote[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const note of notes) {
    const lines = note.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        hits.push({ path: note.path, name: note.name, line: i + 1, lineText: lines[i].trim() });
        if (hits.length >= MAX_HITS) return hits;
      }
    }
  }
  return hits;
}
