// A port of Obsidian 1.13's getLinkpathDest, quirks included (plain-string
// prefix/suffix tests), so links resolve here exactly as they do in Obsidian.

const lc = (s: string) => s.replace(/\\/g, "/").normalize("NFC").trim().toLowerCase();
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** The file `linkpath` points to from `sourceRel`, among `cands` (files sharing
 * its file name). `defaultExt` is retried when the link omits it. */
export function linkpathDest<T>(
  linkpath: string,
  sourceRel: string | null,
  cands: readonly T[],
  relOf: (c: T) => string,
  defaultExt = "",
): T | null {
  if (cands.length === 0) return null;
  const rels = cands.map((c) => lc(relOf(c)));
  const raw = lc(linkpath);
  const attempt = (start: string): T | null => {
    let n = start;
    let folder = sourceRel ? parentOf(lc(sourceRel)) : "";
    if (n.startsWith("./") || n.startsWith("../")) {
      if (n.startsWith("./../")) n = n.slice(2);
      if (n.startsWith("./")) {
        if (folder) folder += "/";
        n = folder + n.slice(2);
      } else {
        while (n.startsWith("../")) {
          n = n.slice(3);
          folder = parentOf(folder);
        }
        if (folder) folder += "/";
        n = folder + n;
      }
      const i = rels.indexOf(n);
      if (i !== -1) return cands[i];
    }
    if (n.startsWith("/")) n = n.slice(1);
    const exact = rels.indexOf(n);
    if (exact !== -1) return cands[exact];
    if (raw.startsWith("/")) return null;
    const near: number[] = [];
    const far: number[] = [];
    rels.forEach((r, i) => {
      if (r.endsWith(n)) (r.startsWith(folder) ? near : far).push(i);
    });
    const byLength = (a: number, b: number) => rels[a].length - rels[b].length || rels[a].localeCompare(rels[b]);
    const best = near.sort(byLength)[0] ?? far.sort(byLength)[0];
    return best === undefined ? null : cands[best];
  };
  // Obsidian retries with the extension appended whenever the first lookup
  // fails, even if the link already ends in it (a note named "Foo.md").
  return attempt(raw) ?? (defaultExt ? attempt(raw + defaultExt) : null);
}
