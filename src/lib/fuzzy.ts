// Tiny dependency-free fuzzy matcher for the quick switcher. Returns a score
// (higher = better) if every query char appears in order, else null. Bonuses for
// consecutive matches, word-boundary matches, and shorter targets.
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 0;

  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    let s = 1;
    if (at === prev + 1) s += 3; // consecutive run
    const before = at > 0 ? t[at - 1] : "";
    if (at === 0 || /[\s/\-_.]/.test(before)) s += 2; // start of a word
    score += s;
    prev = at;
    from = at + 1;
  }
  return score - t.length * 0.01; // gentle preference for shorter targets
}

/** Rank items by the best fuzzy score across their search keys; drops non-matches. */
export function fuzzyRank<T>(query: string, items: T[], keys: (item: T) => string[]): T[] {
  if (!query.trim()) return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    let best = -Infinity;
    for (const key of keys(item)) {
      const s = fuzzyScore(query, key);
      if (s !== null && s > best) best = s;
    }
    if (best > -Infinity) scored.push({ item, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
