import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  parseBase,
  serializeBase,
  normalizeKey,
  runView,
  cellParts,
  columnValue,
  toText,
  asFlatFilter,
  fromFlat,
  rawFilterIsFlat,
  validateExpr,
  type BaseDef,
  type BaseViewDef,
  type BaseRow,
  type ViewResult,
  type CellPart,
  type EvalCtx,
} from "../lib/bases";
import { noteRow, attachmentRow } from "../lib/vaultRows";
import { ExprInput } from "./ExprInput";
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
  /** When provided, the base is EDITABLE: view/column/sort/filter edits are
   * serialized to YAML and passed here (autosaved by the parent). */
  onChange?: (yaml: string) => void;
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
  onChange,
}: Props) {
  const def = useMemo(() => parseBase(doc), [doc]);
  const [viewIdx, setViewIdx] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);

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

  // Property keys the user can add as columns / sort by (row properties +
  // formulas + the file.* builtins). Only computed for the editor.
  const availableKeys = useMemo(() => {
    const keys = new Set<string>([
      "file.name", "file.path", "file.folder", "file.ext",
      "file.size", "file.ctime", "file.mtime", "file.tags", "file.links",
    ]);
    for (const r of rows) for (const k of Object.keys(r.properties)) keys.add(k);
    for (const k of Object.keys(def?.formulas ?? {})) keys.add(`formula.${k}`);
    return [...keys].sort();
  }, [rows, def]);

  const activeIdxSafe = def ? Math.min(viewIdx, def.views.length - 1) : 0;

  // Emit a whole new def as YAML (the parent autosaves it; doc re-parses).
  const emitDef = useCallback(
    (next: BaseDef) => onChange?.(serializeBase(next)),
    [onChange],
  );
  const patchView = useCallback(
    (patch: Partial<BaseViewDef>) => {
      if (!def) return;
      emitDef({ ...def, views: def.views.map((v, i) => (i === activeIdxSafe ? { ...v, ...patch } : v)) });
    },
    [def, activeIdxSafe, emitDef],
  );
  // Formulas are a DOCUMENT-level map (not per-view).
  const patchFormulas = useCallback(
    (next: Record<string, string>) => {
      if (def) emitDef({ ...def, formulas: next });
    },
    [def, emitDef],
  );

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
        {onChange && (
          <button
            className={editing ? "base-edit-btn active" : "base-edit-btn"}
            onClick={() => setEditing((v) => !v)}
            title="Edit this view"
          >
            ✎ Edit
          </button>
        )}
      </div>
      {editing && onChange && (
        <BaseEditor
          def={def}
          view={def.views[activeIdx]}
          columns={result.columns.map((c) => c.key)}
          availableKeys={availableKeys}
          formulas={def.formulas}
          onPatchFormulas={patchFormulas}
          onPatchView={patchView}
          onAddView={() => {
            emitDef({ ...def, views: [...def.views, { type: "table", name: `View ${def.views.length + 1}` }] });
            setViewIdx(def.views.length);
          }}
          onDeleteView={() => {
            if (def.views.length <= 1) return;
            emitDef({ ...def, views: def.views.filter((_, i) => i !== activeIdx) });
            setViewIdx(Math.max(0, activeIdx - 1));
          }}
        />
      )}
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

/** Compact per-view editor: name / type / limit, columns (add/remove/reorder),
 * a single sort key, and a raw filter expression. Structural edits only —
 * formulas, display names, and nested filters round-trip untouched. */
function BaseEditor({
  def,
  view,
  columns,
  availableKeys,
  formulas,
  onPatchFormulas,
  onPatchView,
  onAddView,
  onDeleteView,
}: {
  def: BaseDef;
  view: BaseViewDef;
  columns: string[];
  availableKeys: string[];
  formulas: Record<string, string>;
  onPatchFormulas: (next: Record<string, string>) => void;
  onPatchView: (patch: Partial<BaseViewDef>) => void;
  onAddView: () => void;
  onDeleteView: () => void;
}) {
  // Text fields keep LOCAL draft state and commit on blur/Enter — otherwise
  // every keystroke would re-emit the whole YAML and re-run the view over the
  // entire vault. Re-sync when the underlying view changes (e.g. tab switch).
  const [nameDraft, setNameDraft] = useState(view.name);
  useEffect(() => setNameDraft(view.name), [view.name]);
  // Filter builder: a flat and/or list of string conditions (a deeper/`not`
  // tree — or one whose raw had an unmodeled element — stays read-only, so an
  // edit can't silently drop what parse couldn't represent). Local draft,
  // committed on blur/add/remove.
  const flat = rawFilterIsFlat(view.raw?.filters) ? asFlatFilter(view.filters) : null;
  const [conds, setConds] = useState<string[]>(flat?.conditions ?? []);
  const [combinator, setCombinator] = useState<"and" | "or">(flat?.combinator ?? "and");
  useEffect(() => {
    const f = asFlatFilter(view.filters);
    setConds(f?.conditions ?? []);
    setCombinator(f?.combinator ?? "and");
  }, [view.filters]);
  const commitFilter = (nextConds: string[], nextComb: "and" | "or") =>
    onPatchView({ filters: fromFlat({ combinator: nextComb, conditions: nextConds }) });

  // Formula rows (document-level `formulas` map). Local draft, committed on blur.
  const [fRows, setFRows] = useState(() => Object.entries(formulas).map(([name, expr]) => ({ name, expr })));
  useEffect(() => {
    setFRows(Object.entries(formulas).map(([name, expr]) => ({ name, expr })));
  }, [formulas]);
  const commitFormulas = (rows: { name: string; expr: string }[]) => {
    const map: Record<string, string> = {};
    for (const r of rows) {
      const n = r.name.trim();
      if (n) map[n] = r.expr;
    }
    onPatchFormulas(map);
  };

  // The column list to edit: the explicit order, or the currently-shown columns
  // materialized so the first edit is non-destructive.
  const order = view.order && view.order.length ? view.order : columns;
  // Normalize both sides: an order key may be `note.status` while availableKeys
  // lists the bare `status` — the same property, so it must not be re-offered.
  const orderNorm = new Set(order.map(normalizeKey));
  const unused = availableKeys.filter((k) => !orderNorm.has(normalizeKey(k)));
  const moveCol = (i: number, d: number) => {
    const next = [...order];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onPatchView({ order: next });
  };
  const addCol = (k: string) => {
    if (!k || orderNorm.has(normalizeKey(k))) return;
    onPatchView({ order: [...order, k] });
  };
  // A filter is text-editable only when it's a simple string (or absent); a
  // nested and/or/not tree is preserved but shown read-only.

  return (
    <div className="base-editor">
      <div className="base-editor-row">
        <label>
          Name
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => nameDraft !== view.name && nameDraft.trim() && onPatchView({ name: nameDraft.trim() })}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </label>
        <label>
          Type
          <select value={view.type} onChange={(e) => onPatchView({ type: e.target.value })}>
            <option value="table">Table</option>
            <option value="cards">Cards</option>
          </select>
        </label>
        <label>
          Limit
          <input
            type="number"
            min={0}
            value={view.limit ?? ""}
            placeholder="none"
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              onPatchView({ limit: Number.isFinite(n) && n > 0 ? n : undefined });
            }}
          />
        </label>
      </div>

      <div className="base-editor-section">
        <div className="base-editor-title">Columns</div>
        <ul className="base-col-list">
          {order.map((k, i) => (
            <li key={k}>
              <span className="base-col-key" title={k}>{def.display[k] ?? k}</span>
              <button title="Move up" disabled={i === 0} onClick={() => moveCol(i, -1)}>↑</button>
              <button title="Move down" disabled={i === order.length - 1} onClick={() => moveCol(i, 1)}>↓</button>
              <button title="Remove column" onClick={() => onPatchView({ order: order.filter((c) => c !== k) })}>✕</button>
            </li>
          ))}
        </ul>
        {unused.length > 0 && (
          <select className="base-add-col" value="" onChange={(e) => addCol(e.target.value)}>
            <option value="">+ Add column…</option>
            {unused.map((k) => (
              <option key={k} value={k}>{def.display[k] ?? k}</option>
            ))}
          </select>
        )}
      </div>

      <div className="base-editor-section">
        <div className="base-editor-title">Filter</div>
        {flat ? (
          <div className="base-filter-builder">
            {conds.length > 1 && (
              <label className="base-filter-combinator">
                Match
                <select
                  value={combinator}
                  onChange={(e) => {
                    const c = e.target.value as "and" | "or";
                    setCombinator(c);
                    commitFilter(conds, c);
                  }}
                >
                  <option value="and">all</option>
                  <option value="or">any</option>
                </select>
                of:
              </label>
            )}
            {conds.map((c, i) => (
              <div className="base-filter-cond" key={i}>
                <div className="base-formula-exprwrap">
                  <ExprInput
                    className="base-filter-input"
                    value={c}
                    placeholder='e.g. status != "done"'
                    onChange={(v) => setConds((prev) => prev.map((x, j) => (j === i ? v : x)))}
                    onBlur={() => commitFilter(conds, combinator)}
                  />
                  {validateExpr(c) && <div className="expr-error">⚠ {validateExpr(c)}</div>}
                </div>
                <button
                  title="Remove condition"
                  onClick={() => {
                    const next = conds.filter((_, j) => j !== i);
                    setConds(next);
                    commitFilter(next, combinator);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <button className="base-filter-add" onClick={() => setConds((prev) => [...prev, ""])}>
              + Add condition
            </button>
          </div>
        ) : (
          <div className="base-filter-readonly">Nested filter (edit in the .base file directly)</div>
        )}
      </div>

      <div className="base-editor-section">
        <div className="base-editor-title">Group by</div>
        <div className="base-editor-row">
          <select
            value={view.groupBy?.property ?? ""}
            onChange={(e) => {
              const property = e.target.value;
              onPatchView({ groupBy: property ? { property, direction: view.groupBy?.direction ?? "ASC" } : undefined });
            }}
          >
            <option value="">None</option>
            {availableKeys.map((k) => (
              <option key={k} value={k}>{def.display[k] ?? k}</option>
            ))}
          </select>
          {view.groupBy && (
            <button
              className="base-sort-dir"
              title={view.groupBy.direction === "ASC" ? "Ascending" : "Descending"}
              onClick={() =>
                onPatchView({
                  groupBy: { property: view.groupBy!.property, direction: view.groupBy!.direction === "ASC" ? "DESC" : "ASC" },
                })
              }
            >
              {view.groupBy.direction === "ASC" ? "↑ Asc" : "↓ Desc"}
            </button>
          )}
        </div>
      </div>

      <div className="base-editor-section">
        <div className="base-editor-title">Formulas</div>
        <div className="base-formula-list">
          {fRows.map((row, i) => (
            <div className="base-formula-row" key={i}>
              <input
                className="base-formula-name"
                type="text"
                placeholder="name"
                value={row.name}
                onChange={(e) => setFRows((prev) => prev.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                onBlur={() => commitFormulas(fRows)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              <span className="base-formula-eq">=</span>
              <div className="base-formula-exprwrap">
                <ExprInput
                  className="base-formula-expr"
                  value={row.expr}
                  placeholder="e.g. price / quantity"
                  onChange={(v) => setFRows((prev) => prev.map((r, j) => (j === i ? { ...r, expr: v } : r)))}
                  onBlur={() => commitFormulas(fRows)}
                />
                {validateExpr(row.expr) && <div className="expr-error">⚠ {validateExpr(row.expr)}</div>}
              </div>
              <button
                title="Remove formula"
                onClick={() => {
                  const next = fRows.filter((_, j) => j !== i);
                  setFRows(next);
                  commitFormulas(next);
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="base-filter-add" onClick={() => setFRows((prev) => [...prev, { name: "", expr: "" }])}>
            + Add formula
          </button>
        </div>
        <div className="base-formula-hint">Use as a column via <code>formula.name</code>.</div>
      </div>

      <div className="base-editor-actions">
        <button onClick={onAddView}>+ Add view</button>
        <button onClick={onDeleteView} disabled={def.views.length <= 1}>Delete view</button>
      </div>
    </div>
  );
}

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
