// Regression tests for the single-pass folder-move link rewrite. These use the
// REAL VaultIndex resolver against a hand-built mini-vault, so they exercise the
// exact decision the app makes: rewrite ONLY the links whose resolution the move
// changed, leaving intra-folder and still-resolving links untouched. This is a
// shared-vault write path — the bugs here silently break links.
import { describe, expect, it } from "vitest";
import { VaultIndex } from "./vaultIndex";
import { folderMoveMapper, rewriteLinks, type FolderMoveCtx } from "./rename";
import type { LinkFormat } from "./rename";
import { resolveAttachment } from "./attachments";
import type { VaultNote } from "./vault";

const note = (rel: string, content = ""): VaultNote => ({
  path: `/v/${rel}`,
  rel,
  name: rel.split("/").pop()!.replace(/\.md$/, ""),
  content,
});

/** Simulate moving folder `from`→`to` and rewrite `source`'s links. Returns the
 * new content (or the original if nothing changed). */
function moveAndRewrite(
  preNotes: VaultNote[],
  from: string,
  to: string,
  sourceRel: string,
  format: LinkFormat = "shortest",
): string {
  const swap = (rel: string) => (rel.startsWith(`${from}/`) ? to + rel.slice(from.length) : rel);
  const movedNewPathByOld = new Map<string, string>();
  const postNotes = preNotes.map((n) => {
    if (!n.rel.startsWith(`${from}/`)) return n;
    const nrel = swap(n.rel);
    const np = `/v/${nrel}`;
    movedNewPathByOld.set(n.path, np);
    return { ...n, rel: nrel, path: np, name: nrel.split("/").pop()!.replace(/\.md$/, "") };
  });
  const preIndex = new VaultIndex();
  preIndex.build(preNotes);
  const postIndex = new VaultIndex();
  postIndex.build(postNotes);
  const postByPath = new Map(postNotes.map((n) => [n.path, n]));
  const ctx: FolderMoveCtx = {
    resolvePre: (raw, f) => preIndex.resolve(raw, f),
    resolvePost: (raw, f) => postIndex.resolve(raw, f),
    movedNewPathByOld,
    noteAt: (p) => postByPath.get(p),
    nameTaken: (name, except) =>
      postNotes.some((n) => n.path !== except && n.name.toLowerCase() === name.toLowerCase()),
    format,
  };
  const srcPre = preNotes.find((n) => n.rel === sourceRel)!;
  const srcPost = postNotes.find((n) => n.path === (movedNewPathByOld.get(srcPre.path) ?? srcPre.path))!;
  const mapper = folderMoveMapper(ctx, srcPre.path, srcPost.path, srcPost.rel);
  return rewriteLinks(srcPost.content, mapper) ?? srcPost.content;
}

describe("folder-move link rewrite (shortest format)", () => {
  it("leaves a bare link to a moved note alone (name unchanged → still resolves)", () => {
    const notes = [note("proj/a.md", "see [[b]]"), note("proj/b.md"), note("top.md")];
    // move proj → archive/proj; a's bare [[b]] still resolves (both moved together)
    expect(moveAndRewrite(notes, "proj", "archive/proj", "proj/a.md")).toBe("see [[b]]");
  });

  it("leaves an intra-folder relative link untouched (moved as a unit)", () => {
    const notes = [note("proj/a.md", "see [[./b]]"), note("proj/b.md")];
    expect(moveAndRewrite(notes, "proj", "archive/proj", "proj/a.md")).toBe("see [[./b]]");
  });

  it("leaves a folder-qualified link that still suffix-resolves to the moved note", () => {
    const notes = [note("top.md", "see [[proj/b]]"), note("proj/b.md")];
    // Obsidian resolves `proj/b` by path SUFFIX, so it still reaches
    // archive/proj/b.md after the move — no rewrite needed (and none made).
    const out = moveAndRewrite(notes, "proj", "archive/proj", "top.md");
    expect(out).toBe("see [[proj/b]]");
    const post = [note("top.md", out), note("archive/proj/b.md")];
    const idx = new VaultIndex();
    idx.build(post);
    expect(idx.resolve("proj/b", "/v/top.md")).toBe("/v/archive/proj/b.md");
  });

  it("rewrites a ROOT-ANCHORED link that breaks (exact rel, not suffix)", () => {
    const notes = [note("top.md", "see [[/proj/b]]"), note("proj/b.md")];
    const out = moveAndRewrite(notes, "proj", "archive/proj", "top.md");
    expect(out).not.toBe("see [[/proj/b]]"); // /proj/b.md no longer exists → rewritten
    const target = /\[\[([^\]]+)\]\]/.exec(out)![1];
    const post = [note("top.md", out), note("archive/proj/b.md")];
    const idx = new VaultIndex();
    idx.build(post);
    expect(idx.resolve(target, "/v/top.md")).toBe("/v/archive/proj/b.md");
  });

  it("rewrites a link that would now MIS-resolve to a same-named unmoved note", () => {
    // A second proj/b outside the moved folder: after the move, [[proj/b]] from
    // top could suffix-match the unmoved deep/proj/b instead → must rewrite.
    const notes = [note("top.md", "see [[proj/b]]"), note("proj/b.md"), note("deep/proj/b.md")];
    const out = moveAndRewrite(notes, "proj", "aa/proj", "top.md");
    const target = /\[\[([^\]]+)\]\]/.exec(out)![1];
    const post = [note("top.md", out), note("aa/proj/b.md"), note("deep/proj/b.md")];
    const idx = new VaultIndex();
    idx.build(post);
    expect(idx.resolve(target, "/v/top.md")).toBe("/v/aa/proj/b.md"); // the moved one
  });

  it("rewrites a relative link that pointed OUT of the moved folder", () => {
    // proj/a links to a sibling OUTSIDE proj via ../top; after moving proj deeper
    // that relative path breaks and must be rewritten to still reach top.
    const notes = [note("proj/a.md", "up [[../top]]"), note("top.md")];
    const out = moveAndRewrite(notes, "proj", "archive/proj", "proj/a.md");
    const post = [note("archive/proj/a.md", out), note("top.md")];
    const idx = new VaultIndex();
    idx.build(post);
    const target = /\[\[([^\]]+)\]\]/.exec(out)![1];
    expect(idx.resolve(target, "/v/archive/proj/a.md")).toBe("/v/top.md");
  });

});

describe("folder-move link rewrite (absolute format)", () => {
  it("rewrites a broken root-anchored link to the moved note's full path", () => {
    const notes = [note("top.md", "see [[/proj/b]]"), note("proj/b.md")];
    const out = moveAndRewrite(notes, "proj", "archive/proj", "top.md", "absolute");
    expect(out).toContain("archive/proj/b");
  });
});

/** Move helper that also rewrites ATTACHMENT-referencing links. */
function moveWithAtts(
  preNotes: VaultNote[],
  atts: { rel: string }[],
  from: string,
  to: string,
  sourceRel: string,
): string {
  const swap = (rel: string) => (rel.startsWith(`${from}/`) ? to + rel.slice(from.length) : rel);
  const preAtts = atts.map((a) => ({ path: `/v/${a.rel}`, rel: a.rel, name: a.rel.split("/").pop()! }));
  const postAtts = preAtts.map((a) =>
    a.rel.startsWith(`${from}/`) ? { ...a, rel: swap(a.rel), path: `/v/${swap(a.rel)}` } : a,
  );
  const movedAttNewPathByOld = new Map<string, string>();
  for (const a of preAtts) if (a.rel.startsWith(`${from}/`)) movedAttNewPathByOld.set(a.path, `/v/${swap(a.rel)}`);
  const postAttByPath = new Map(postAtts.map((a) => [a.path, a]));
  const preIndex = new VaultIndex();
  preIndex.build(preNotes);
  const postNotes = preNotes.map((n) =>
    n.rel.startsWith(`${from}/`) ? { ...n, rel: swap(n.rel), path: `/v/${swap(n.rel)}` } : n,
  );
  const postIndex = new VaultIndex();
  postIndex.build(postNotes);
  const ctx: FolderMoveCtx = {
    resolvePre: (raw, f) => preIndex.resolve(raw, f),
    resolvePost: (raw, f) => postIndex.resolve(raw, f),
    movedNewPathByOld: new Map(),
    noteAt: () => undefined,
    nameTaken: () => false,
    format: "shortest",
    resolveAttPre: (raw) => resolveAttachment(preAtts, raw)?.path ?? null,
    resolveAttPost: (raw) => resolveAttachment(postAtts, raw)?.path ?? null,
    movedAttNewPathByOld,
    attAt: (p) => postAttByPath.get(p),
    attNameTaken: (name, except) =>
      postAtts.some((a) => a.path !== except && a.name.toLowerCase() === name.toLowerCase()),
  };
  const src = preNotes.find((n) => n.rel === sourceRel)!;
  const srcPost = postNotes.find((n) => n.path === (n.rel === sourceRel ? src.path : n.path))!;
  const mapper = folderMoveMapper(ctx, src.path, srcPost.path, srcPost.rel);
  return rewriteLinks(src.content, mapper) ?? src.content;
}

describe("folder-move attachment link rewrite", () => {
  it("rewrites a folder-qualified embed to a moved attachment on a RENAME", () => {
    // proj → newproj: the folder segment changes, so `proj/pic.png` no longer
    // suffix-resolves; the embed must be rewritten to reach newproj/pic.png.
    const out = moveWithAtts([note("top.md", "![[proj/pic.png]]")], [{ rel: "proj/pic.png" }], "proj", "newproj", "top.md");
    expect(out).not.toBe("![[proj/pic.png]]");
    expect(out).toContain("pic.png");
  });

  it("leaves a bare attachment embed alone (name still resolves)", () => {
    const out = moveWithAtts([note("top.md", "![[pic.png]]")], [{ rel: "proj/pic.png" }], "proj", "newproj", "top.md");
    expect(out).toBe("![[pic.png]]");
  });

  it("leaves a folder-qualified embed alone on a MOVE (suffix survives)", () => {
    // proj → archive/proj keeps `proj` in the path, so `proj/pic.png` still resolves.
    const out = moveWithAtts(
      [note("top.md", "![[proj/pic.png]]")],
      [{ rel: "proj/pic.png" }],
      "proj",
      "archive/proj",
      "top.md",
    );
    expect(out).toBe("![[proj/pic.png]]");
  });
});
