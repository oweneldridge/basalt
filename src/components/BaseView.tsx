import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  parseBase,
  runView,
  cellParts,
  columnValue,
  toText,
  type BaseRow,
  type ViewResult,
  type CellPart,
  type EvalCtx,
} from "../lib/bases";
import { parseProperties } from "../lib/bases";
import type { VaultNote, Attachment } from "../lib/vault";

/** Rows rendered before a "show more" step-up. Bounds DOM node count and
 * per-row image mounts on a large vault (Obsidian paginates similarly). */
const RENDER_CAP = 300;

interface Props {
  /** The .base file's YAML content. */
  doc: string;
  /** This .base file's own vault-relative path (for relative image resolution). */
  sourceRel: string;
  notes: VaultNote[];
  attachments: Attachment[];
  /** Bumps when a note is created/deleted/renamed or externally changed — the
   * only events that alter cross-note tags/link resolution. Per-note content
   * edits invalidate via the note object identity instead. */
  structureVersion: number;
  tagsOf: (path: string) => string[];
  linkKeysOf: (path: string) => string[];
  /** Open a vault file from a cell link (no-create, like the canvas). Receives
   * an exact vault-relative path. */
  onOpenFile: (rel: string) => void;
  /** Resolve a vault image target to a URL, relative to `rel`. */
  resolveImageRel: (target: string, rel: string) => Promise<string | null>;
}

// Per-note row cache. Keyed by the note OBJECT (saves replace only the edited
// note's object, so unchanged notes skip re-parsing their frontmatter), and
// stamped with the indexVersion it was built at (tags/links come from the
// index, which mutates in place).
const rowCache = new WeakMap<object, { v: number; row: BaseRow }>();

function folderOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function noteRow(
  n: VaultNote,
  v: number,
  tagsOf: (p: string) => string[],
  linkKeysOf: (p: string) => string[],
): BaseRow {
  const hit = rowCache.get(n);
  if (hit && hit.v === v) return hit.row;
  const row: BaseRow = {
    name: n.rel.split("/").pop() ?? n.rel,
    basename: n.name,
    path: n.rel,
    folder: folderOf(n.rel),
    ext: "md",
    size: n.size ?? 0,
    ctime: n.ctime ?? 0,
    mtime: n.mtime ?? 0,
    tags: tagsOf(n.path).map((t) => t.replace(/^#/, "").toLowerCase()),
    linkKeys: linkKeysOf(n.path),
    properties: parseProperties(n.content),
  };
  rowCache.set(n, { v, row });
  return row;
}

function attachmentRow(a: Attachment, v: number): BaseRow {
  const hit = rowCache.get(a);
  if (hit && hit.v === v) return hit.row;
  const dot = a.name.lastIndexOf(".");
  const row: BaseRow = {
    name: a.name,
    basename: dot > 0 ? a.name.slice(0, dot) : a.name,
    path: a.rel,
    folder: folderOf(a.rel),
    ext: dot > 0 ? a.name.slice(dot + 1).toLowerCase() : "",
    size: a.size ?? 0,
    ctime: a.ctime ?? 0,
    mtime: a.mtime ?? 0,
    tags: [],
    linkKeys: [],
    properties: {},
  };
  rowCache.set(a, { v, row });
  return row;
}

/** Async cell image: resolves a vault target to a data URL like embeds do. */
function CellImg({ target, resolveImage }: { target: string; resolveImage: (target: string) => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void resolveImage(target).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [target, resolveImage]);
  return src ? <img className="base-cell-img" src={src} alt={target} /> : <span>🖼 {target}</span>;
}

function Cell({
  parts,
  onOpenFile,
  resolveImage,
}: {
  parts: CellPart[];
  onOpenFile: (t: string) => void;
  resolveImage: (target: string) => Promise<string | null>;
}) {
  return (
    <>
      {parts.map((p, i) => {
        switch (p.kind) {
          case "link":
            return (
              <button key={i} className="base-link" onClick={() => onOpenFile(p.target)} title={p.target}>
                {p.text}
              </button>
            );
          case "check":
            return <input key={i} type="checkbox" checked={p.checked} readOnly disabled />;
          case "tag":
            return (
              <span key={i} className="base-tag">
                {p.text}
              </span>
            );
          case "image":
            return <CellImg key={i} target={p.src} resolveImage={resolveImage} />;
          default:
            return <span key={i}>{p.text}</span>;
        }
      })}
    </>
  );
}

/** Read-only Obsidian Bases viewer: tabs per view, table (or cards) over the
 * vault's files. Everything is computed from props — no writes anywhere.
 * Memoized so unrelated App re-renders (autosave ticks, theme, focus) don't
 * re-run the whole view; parent passes stable callbacks. */
export const BaseView = memo(function BaseView({
  doc,
  sourceRel,
  notes,
  attachments,
  structureVersion,
  tagsOf,
  linkKeysOf,
  onOpenFile,
  resolveImageRel,
}: Props) {
  const def = useMemo(() => parseBase(doc), [doc]);
  const [viewIdx, setViewIdx] = useState(0);
  const [expanded, setExpanded] = useState(false);

  // Stable per-pane image resolver (bound to this base's own rel).
  const resolveImage = useCallback(
    (target: string) => resolveImageRel(target, sourceRel),
    [resolveImageRel, sourceRel],
  );

  const rows = useMemo(() => {
    const out: BaseRow[] = notes.map((n) => noteRow(n, structureVersion, tagsOf, linkKeysOf));
    for (const a of attachments) out.push(attachmentRow(a, structureVersion));
    return out;
  }, [notes, attachments, structureVersion, tagsOf, linkKeysOf]);

  const lookupFile = useMemo(() => {
    const byKey = new Map<string, BaseRow>();
    for (const r of rows) {
      for (const k of [r.path.toLowerCase(), r.path.replace(/\.md$/i, "").toLowerCase(), r.basename.toLowerCase()]) {
        if (!byKey.has(k)) byKey.set(k, r);
      }
    }
    return (target: string) => byKey.get(target.replace(/\.md$/i, "").toLowerCase()) ?? byKey.get(target.toLowerCase()) ?? null;
  }, [rows]);

  const result: ViewResult | null = useMemo(() => {
    if (!def) return null;
    const idx = Math.min(viewIdx, def.views.length - 1);
    return runView(def, def.views[idx], rows, { lookupFile });
  }, [def, viewIdx, rows, lookupFile]);

  // Reset the expand toggle whenever the shown view or data changes.
  useEffect(() => setExpanded(false), [viewIdx, doc]);

  if (!def) {
    return <div className="base-view base-empty">Not a valid .base file (YAML parse failed).</div>;
  }
  if (!result) return null;

  const isCards = result.view.type === "cards" || result.view.type === "card";
  const cap = expanded ? Infinity : RENDER_CAP;
  const hidden = Math.max(0, result.rows.length - cap);

  const activeIdx = Math.min(viewIdx, def.views.length - 1);
  return (
    <div className="base-view">
      <div className="base-toolbar">
        {def.views.length > 1 && (
          <div className="base-tabs" role="tablist">
            {def.views.map((v, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === activeIdx}
                className={i === activeIdx ? "base-tab active" : "base-tab"}
                onClick={() => setViewIdx(i)}
              >
                {v.name}
              </button>
            ))}
          </div>
        )}
        <span className="base-count">
          {result.truncated ? `${result.rows.length} of ${result.total}` : `${result.total}`}{" "}
          {result.total === 1 ? "result" : "results"}
        </span>
      </div>
      {result.errors.length > 0 && (
        <div className="base-errors" title={result.errors.join("\n")}>
          ⚠ {result.errors.length} expression {result.errors.length === 1 ? "error" : "errors"} —{" "}
          {result.errors[0]}
        </div>
      )}
      {isCards ? (
        <Cards result={result} cap={cap} onOpenFile={onOpenFile} resolveImage={resolveImage} />
      ) : (
        <Table result={result} cap={cap} onOpenFile={onOpenFile} resolveImage={resolveImage} />
      )}
      {hidden > 0 && (
        <button className="base-showmore" onClick={() => setExpanded(true)}>
          Show {hidden} more {hidden === 1 ? "row" : "rows"}
        </button>
      )}
    </div>
  );
});

function Table({
  result,
  cap,
  onOpenFile,
  resolveImage,
}: {
  result: ViewResult;
  cap: number;
  onOpenFile: (t: string) => void;
  resolveImage: (target: string) => Promise<string | null>;
}) {
  const body = (rows: ViewResult["rows"]) =>
    rows.map((r, i) => (
      <tr key={`${r.row.path}:${i}`}>
        {r.cells.map((c, j) => (
          <td key={j}>
            <Cell parts={cellParts(c)} onOpenFile={onOpenFile} resolveImage={resolveImage} />
          </td>
        ))}
      </tr>
    ));

  // Cap total rendered rows even across groups (Obsidian-style pagination).
  let budget = cap;
  return (
    <div className="base-scroll">
      <table className="base-table">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c.key} title={c.key}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.groups
            ? result.groups.map((g) => {
                if (budget <= 0) return null;
                const slice = g.rows.slice(0, budget);
                budget -= slice.length;
                return (
                  <GroupRows key={g.label} label={g.label} span={result.columns.length}>
                    {body(slice)}
                  </GroupRows>
                );
              })
            : body(result.rows.slice(0, cap))}
        </tbody>
        {result.summary && (
          <tfoot>
            <tr>
              {result.summary.map((s, i) => (
                <td key={i} className="base-summary">
                  {s ?? ""}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** A group header row followed by the group's rows (plain <tr> children keep
 * the table layout — no nested tables). */
function GroupRows({ label, span, children }: { label: string; span: number; children: React.ReactNode }) {
  return (
    <>
      <tr className="base-group-row">
        <td colSpan={span}>{label === "" ? "(none)" : label}</td>
      </tr>
      {children}
    </>
  );
}

function Cards({
  result,
  cap,
  onOpenFile,
  resolveImage,
}: {
  result: ViewResult;
  cap: number;
  onOpenFile: (t: string) => void;
  resolveImage: (target: string) => Promise<string | null>;
}) {
  const imageKey = result.view.image;
  return (
    <div className="base-scroll">
      <div className="base-cards">
        {result.rows.slice(0, cap).map((r, i) => {
          let img: string | null = null;
          if (imageKey) {
            const ctx: EvalCtx = { row: r.row, formulas: {} };
            const v = columnValue(imageKey, ctx);
            const t = toText(v);
            const wl = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(t);
            img = wl ? wl[1] : t || null;
          }
          return (
            <div key={`${r.row.path}:${i}`} className="base-card">
              {img && <CellImg target={img} resolveImage={resolveImage} />}
              <button className="base-link base-card-title" onClick={() => onOpenFile(r.row.path)}>
                {r.row.basename}
              </button>
              <div className="base-card-props">
                {result.columns.slice(0, 4).map((c, j) =>
                  c.key === "file.name" ? null : (
                    <div key={c.key} className="base-card-prop">
                      <span className="base-card-label">{c.label}</span>
                      <Cell parts={cellParts(r.cells[j])} onOpenFile={onOpenFile} resolveImage={resolveImage} />
                    </div>
                  ),
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
