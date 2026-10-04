// Turn one text into another with small, separate edits, so an editor applying
// them keeps the caret where it was: unchanged lines between two edits move by
// the edits before them, and a caret on a changed line stays near its column.

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** The smallest single edit turning `a` into `b`, or null when equal. */
export function minimalChange(a: string, b: string): TextChange | null {
  if (a === b) return null;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) };
}

const lines = (t: string) => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Edits (in `a`'s coordinates, sorted, non-overlapping) turning `a` into `b`,
 * one per run of changed lines. Large differences fall back to one edit. */
export function textChanges(a: string, b: string): TextChange[] {
  if (a === b) return [];
  const A = lines(a);
  const B = lines(b);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const am = A.slice(p, A.length - s);
  const bm = B.slice(p, B.length - s);
  if (am.length * bm.length > 200_000) return [minimalChange(a, b)!];
  // Longest common subsequence of the middle lines.
  const n = am.length;
  const m = bm.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = am[i] === bm[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  let offset = 0;
  for (let k = 0; k < p; k++) offset += A[k].length;
  const out: TextChange[] = [];
  let i = 0;
  let j = 0;
  let pos = offset;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      pos += am[i].length;
      i++;
      j++;
      continue;
    }
    const start = pos;
    let removed = "";
    let added = "";
    while ((i < n || j < m) && !(i < n && j < m && am[i] === bm[j])) {
      if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) added += bm[j++];
      else {
        removed += am[i];
        pos += am[i++].length;
      }
    }
    // One line for one line: edit just the characters that differ.
    const fine = lines(removed).length <= 1 && lines(added).length <= 1 ? minimalChange(removed, added) : null;
    out.push(fine ? { from: start + fine.from, to: start + fine.to, insert: fine.insert } : { from: start, to: start + removed.length, insert: added });
  }
  return out;
}
