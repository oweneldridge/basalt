// The link/metadata index — a *derived cache* rebuilt from the vault, never a
// canonical store (see ARCHITECTURE.md, Principle 1). It powers backlinks and
// unlinked mentions today, and will feed the graph and tag panes later.
//
// Links resolve to a concrete note PATH (not a bare name), matching Obsidian's
// vault-wide semantics: a bare `[[README]]` resolves to the ROOT-MOST README
// (shortest path wins; alphabetical tie-break as an approximation), regardless
// of the source note's folder. `folder/Note`, `/Note` (root-anchored), and
// `./`/`../` relative forms are all supported.
import type { VaultNote } from "./vault";
import {
  internalMdHref,
  mdLinkRegexGlobal,
  normalizeName,
  parseMarkdownLink,
  proseMask,
  tagRegex,
  targetPathPart,
  wikilinkRegex,
} from "./markdown";

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

export interface GraphNode {
  id: string; // note path
  name: string;
}
export interface GraphLink {
  source: string;
  target: string;
}
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
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

/** Per-line dedupe key for extracted targets. Unlike normalizeRel it KEEPS a
 * leading `./` — resolve() treats `./Note` (source-folder relative) and bare
 * `Note` (vault-wide root-most) differently, so they must not collapse into
 * one occurrence or a real backlink is silently dropped. */
function dedupeKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/\.md$/i, "").normalize("NFC").trim().toLowerCase();
}

function folderOf(normRel: string): string {
  const i = normRel.lastIndexOf("/");
  return i >= 0 ? normRel.slice(0, i) : "";
}

function depthOf(normRel: string): number {
  return (normRel.match(/\//g) ?? []).length;
}

const INLINE_CODE_RE = /`[^`\n]*`/g;

function extractLinks(content: string): LinkOccurrence[] {
  const out: LinkOccurrence[] = [];
  const lines = content.split("\n");
  const prose = proseMask(lines); // skip frontmatter + fenced code
  for (let i = 0; i < lines.length; i++) {
    if (!prose[i]) continue;
    const line = lines[i].replace(INLINE_CODE_RE, " "); // `[[x]]` in code isn't a link
    const re = wikilinkRegex();
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const rawTarget = m[1].trim();
      const pathPart = targetPathPart(rawTarget);
      if (!pathPart) continue; // [[#heading]] self-ref
      const key = dedupeKey(pathPart); // dedupe identical targets, keep distinct paths
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rawTarget, line: i + 1, snippet: lines[i].trim() });
    }
    // Markdown-style internal links: [text](Note.md), [t](folder/My%20Note.md#H)
    // — Obsidian vaults configured with "Use [[Wikilinks]]: off" are full of
    // them, and they must feed backlinks/graph like wikilinks do.
    const mre = mdLinkRegexGlobal();
    while ((m = mre.exec(line))) {
      const parsed = parseMarkdownLink(m[0]);
      if (!parsed) continue;
      const internal = internalMdHref(parsed.href);
      if (!internal) continue;
      const rawTarget = internal.path + internal.fragment;
      const key = dedupeKey(internal.path);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rawTarget, line: i + 1, snippet: lines[i].trim() });
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A `#tag` aggregate row for the tag pane. */
export interface TagCount {
  tag: string; // bare name, no leading '#'
  count: number; // notes containing it
}

/** Tags declared in a leading YAML `tags:`/`tag:` key. Handles the inline
 * (`[a, b]` / `a, b` / `a`) and block-list (`- a`) forms — the same subset the
 * Properties parser understands; richer YAML is left for the body scan. */
function frontmatterTags(lines: string[]): string[] {
  if (lines.length < 2 || lines[0].trim() !== "---") return [];
  let end = -1;
  for (let j = 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === "---" || t === "...") {
      end = j;
      break;
    }
  }
  if (end === -1) return [];
  const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, "").replace(/^#/, "").trim();
  const out: string[] = [];
  for (let j = 1; j < end; j++) {
    const m = /^(tags|tag)\s*:\s*(.*)$/i.exec(lines[j]);
    if (!m) continue;
    const rest = m[2].trim();
    if (rest && rest !== "[]") {
      for (const part of rest.replace(/^\[|\]$/g, "").split(",")) {
        const v = unquote(part);
        if (v) out.push(v);
      }
    } else {
      for (let k = j + 1; k < end; k++) {
        const lm = /^\s*-\s+(.*)$/.exec(lines[k]);
        if (!lm) break;
        const v = unquote(lm[1]);
        if (v) out.push(v);
      }
    }
  }
  return out;
}

/** Distinct tags in a note (frontmatter `tags:` + body `#tag`), deduped
 * case-insensitively, preserving first-seen display casing. */
export function extractTags(content: string): string[] {
  const lines = content.split("\n");
  const prose = proseMask(lines);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const t = raw.replace(/^#/, "").trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  for (const t of frontmatterTags(lines)) add(t);
  for (let i = 0; i < lines.length; i++) {
    if (!prose[i]) continue;
    const line = lines[i].replace(INLINE_CODE_RE, " "); // `#x` in code isn't a tag
    const re = tagRegex();
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) add(m[2]); // group 2 = bare name
  }
  return out;
}

export class VaultIndex {
  private occ = new Map<string, LinkOccurrence[]>();
  private meta = new Map<string, Meta>();
  // Resolution: normalized basename -> paths (an array, so case/Unicode-distinct
  // notes that share a basename all coexist). Slashed targets filter by path.
  private byName = new Map<string, string[]>();
  // Per-note distinct tags, for the vault-wide tag pane (incremental like occ).
  private tags = new Map<string, string[]>();

  build(notes: VaultNote[]): void {
    this.occ.clear();
    this.meta.clear();
    this.byName.clear();
    this.tags.clear();
    for (const note of notes) this.setNote(note);
  }

  /** Insert or replace a single note's entry (incremental update on save). */
  setNote(note: VaultNote): void {
    this.removeFromMaps(note.path); // drop the old name/rel entry for this path
    this.meta.set(note.path, { rel: note.rel, name: note.name });
    this.occ.set(note.path, extractLinks(note.content));
    this.tags.set(note.path, extractTags(note.content));
    this.addToMaps(note.path, note.rel, note.name);
  }

  removeNote(path: string): void {
    this.removeFromMaps(path);
    this.occ.delete(path);
    this.tags.delete(path);
    this.meta.delete(path);
  }

  /** Every tag in the vault with the number of notes using it. Sorted by count
   * (desc), then name — the order the tag pane shows. */
  allTags(): TagCount[] {
    const counts = new Map<string, { display: string; count: number }>();
    for (const tags of this.tags.values()) {
      for (const t of tags) {
        const key = t.toLowerCase();
        const e = counts.get(key);
        if (e) e.count++;
        else counts.set(key, { display: t, count: 1 });
      }
    }
    return [...counts.values()]
      .map((e) => ({ tag: e.display, count: e.count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
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

  /** Pick the best of several same-basename candidates: root-most (shortest
   * path) wins, alphabetical tie-break — matching Obsidian's vault-wide
   * semantics (Obsidian does NOT prefer the source's folder). */
  private pickBest(paths: string[]): string {
    if (paths.length === 1) return paths[0];
    return [...paths].sort((a, b) => {
      const ra = normalizeRel(this.meta.get(a)?.rel ?? "");
      const rb = normalizeRel(this.meta.get(b)?.rel ?? "");
      return depthOf(ra) - depthOf(rb) || ra.localeCompare(rb);
    })[0];
  }

  /** Find candidates whose normalized rel exactly equals `wantRel`. */
  private exactRel(candidates: string[], wantRel: string): string[] {
    return candidates.filter((path) => normalizeRel(this.meta.get(path)?.rel ?? "") === wantRel);
  }

  /**
   * Resolve a raw wikilink target (from `sourcePath`) to a concrete note path,
   * or null if no such note exists. Forms supported (all Obsidian-compatible):
   * bare `[[Note]]` (vault-wide, root-most wins), `[[folder/Note]]` (path
   * suffix), `[[/Note]]` (root-anchored exact), and `[[./N]]`/`[[../N]]`
   * (relative to the source note's folder).
   */
  resolve(rawTarget: string, sourcePath: string): string | null {
    const p = targetPathPart(rawTarget);
    if (!p) return null;
    const segments = p.split(/[/\\]/);
    // byName is keyed by extension-less note names; targets may carry .md
    // (markdown-style links always do, wikilinks occasionally). Strip-first,
    // unstripped-second matches Obsidian's exact-file-first precedence: a note
    // literally named "Foo.md" (file Foo.md.md) is keyed as "foo.md" and only
    // reachable via the unstripped fallback.
    const lastSeg = segments[segments.length - 1] ?? "";
    const basename = normalizeName(lastSeg.replace(/\.md$/i, ""));
    let candidates = basename ? this.byName.get(basename) : undefined;
    if ((!candidates || candidates.length === 0) && /\.md$/i.test(lastSeg)) {
      candidates = this.byName.get(normalizeName(lastSeg));
    }
    if (!candidates || candidates.length === 0) return null;

    // Root-anchored: [[/folder/Note]] or [[/Note]] — exact path from the root.
    if (p.startsWith("/") || p.startsWith("\\")) {
      const wantRel = normalizeRel(p.replace(/^[/\\]+/, ""));
      const matches = this.exactRel(candidates, wantRel);
      return matches.length ? this.pickBest(matches) : null;
    }

    // Relative: any `.`/`..` segment — join against the source note's folder.
    if (segments.some((s) => s === "." || s === "..")) {
      const srcFolder = folderOf(normalizeRel(this.meta.get(sourcePath)?.rel ?? ""));
      const stack = srcFolder ? srcFolder.split("/") : [];
      for (const seg of segments) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") {
          if (stack.length === 0) return null; // escapes the vault root
          stack.pop();
        } else {
          stack.push(seg);
        }
      }
      const wantRel = normalizeRel(stack.join("/"));
      const matches = this.exactRel(candidates, wantRel);
      return matches.length ? this.pickBest(matches) : null;
    }

    if (segments.length > 1) {
      // Folder-qualified: keep only notes whose path ends with the given path.
      const wantRel = normalizeRel(p);
      const matches = candidates.filter((path) => {
        const rel = normalizeRel(this.meta.get(path)?.rel ?? "");
        return rel === wantRel || rel.endsWith(`/${wantRel}`);
      });
      return matches.length ? this.pickBest(matches) : null;
    }
    return this.pickBest(candidates);
  }

  /** The whole vault as a graph: a node per note, an edge per resolved link. */
  graph(): GraphData {
    const nodes: GraphNode[] = [];
    for (const [path, m] of this.meta) nodes.push({ id: path, name: m.name });
    const links: GraphLink[] = [];
    const seen = new Set<string>();
    for (const [sourcePath, occs] of this.occ) {
      for (const o of occs) {
        const target = this.resolve(o.rawTarget, sourcePath);
        if (!target || target === sourcePath) continue;
        const key = `${sourcePath}\u0000${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: sourcePath, target });
      }
    }
    return { nodes, links };
  }

  /** The neighborhood of `centerPath` out to `depth` hops (undirected). */
  localGraph(centerPath: string, depth = 1): GraphData {
    const full = this.graph();
    const adj = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      let s = adj.get(a);
      if (!s) {
        s = new Set();
        adj.set(a, s);
      }
      s.add(b);
    };
    for (const l of full.links) {
      add(l.source, l.target);
      add(l.target, l.source);
    }
    const keep = new Set<string>([centerPath]);
    let frontier = [centerPath];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const m of adj.get(n) ?? []) {
          if (!keep.has(m)) {
            keep.add(m);
            next.push(m);
          }
        }
      }
      frontier = next;
    }
    return {
      nodes: full.nodes.filter((n) => keep.has(n.id)),
      links: full.links.filter((l) => keep.has(l.source) && keep.has(l.target)),
    };
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
    const out: Backlink[] = [];
    for (const note of notes) {
      if (note.path === excludePath) continue;
      const lines = note.content.split("\n");
      const prose = proseMask(lines); // skip frontmatter + fenced code
      for (let i = 0; i < lines.length; i++) {
        if (!prose[i]) continue;
        const raw = lines[i];
        // Code FIRST, then links — the same order as extractLinks, so a link
        // straddling one backtick of a code span (CommonMark gives code
        // precedence) can't surface a false mention from inside code.
        const stripped = raw
          .replace(INLINE_CODE_RE, " ")
          .replace(linkRe, " ")
          .replace(mdLinkRegexGlobal(), " ");
        if (!boundary.test(stripped)) continue;
        out.push({ path: note.path, name: note.name, line: i + 1, snippet: raw.trim() });
      }
    }
    return out;
  }
}
