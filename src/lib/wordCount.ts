// The status bar's word and character counts, counted as Obsidian counts them:
// the frontmatter is left out; a word is a number (`1,000.50`) or a run of
// letters, hyphens and apostrophes; and each Chinese or Japanese character is
// a word of its own.

const PER_CHAR = "\\u3041-\\u3096\\u309D-\\u309F\\u30A1-\\u30FA\\u30FC-\\u30FF\\u4E00-\\u9FD5";
const WORD = new RegExp(
  `[0-9]+(?:[,.][0-9]+)*|(?:(?![${PER_CHAR}])[-'’\\p{L}\\p{M}])+|[${PER_CHAR}]`,
  "gu",
);

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/** The part of a note that's counted: all of it but a leading frontmatter. */
export function countableText(doc: string): string {
  if (!/^---[ \t]*\r?\n/.test(doc)) return doc;
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;
  const rest = doc.slice(doc.indexOf("\n") + 1);
  const m = close.exec(rest);
  return m ? rest.slice(m.index + m[0].length) : doc;
}
