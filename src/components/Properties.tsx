import { useState } from "react";
import { parseFm, setProp, deleteProp, scalarType, boolValue, type FmProp } from "../lib/frontmatter";

interface Props {
  /** The active note's full content (with any frontmatter), or null. */
  doc: string | null;
  /** Commit a new note content (frontmatter edited). */
  /** Receives the edit as a transform so it applies to the editor's live text. */
  onChange: (edit: (doc: string) => string) => void;
}

/** One property row's value editor (type-appropriate for scalars; lists edit as
 * comma-separated; complex/unknown shapes are read-only). */
function ValueEditor({ prop, onChange }: { prop: FmProp; onChange: (edit: (doc: string) => string) => void }) {
  if (prop.kind === "complex") {
    return <span className="prop-complex">{prop.values.join(", ") || "(complex)"}</span>;
  }
  if (prop.kind === "list" || prop.kind === "inline") {
    const [draft, setDraft] = useStateFromProp(prop.values.join(", "));
    return (
      <input
        className="prop-value"
        value={draft}
        placeholder="a, b, c"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => onChange((d) => setProp(d, prop.key, draft.split(",").map((s) => s.trim()).filter(Boolean), true))}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    );
  }
  // Scalar
  const raw = prop.values[0] ?? "";
  const type = prop.type ?? scalarType(raw);
  if (type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={boolValue(raw)}
        onChange={(e) => {
          const checked = e.currentTarget.checked;
          onChange((d) => setProp(d, prop.key, [checked ? "true" : "false"]));
        }}
      />
    );
  }
  const [draft, setDraft] = useStateFromProp(raw);
  return (
    <input
      className="prop-value"
      type={type === "date" ? "date" : type === "number" ? "number" : "text"}
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => onChange((d) => setProp(d, prop.key, [draft], false, type === "text"))}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

// Re-sync local draft when the underlying value changes (note switch / reload).
function useStateFromProp(value: string): [string, (v: string) => void] {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  return [draft, setDraft];
}

/** The active note's frontmatter as an editable key/value list (Obsidian's
 * Properties view). Add / edit / remove; writes back to the YAML frontmatter. */
export function Properties({ doc, onChange }: Props) {
  const [newKey, setNewKey] = useState("");
  if (doc === null) return <div className="empty">No note selected</div>;
  const fm = parseFm(doc);
  const props = fm?.props ?? [];

  return (
    <div className="properties">
      {props.length === 0 && <div className="empty">No properties</div>}
      {props.map((p) => (
        <div className="prop-row" key={p.key}>
          <span className="prop-key" title={p.key}>{p.key}</span>
          <ValueEditor prop={p} onChange={onChange} />
          <button className="prop-del" title={`Remove ${p.key}`} onClick={() => onChange((d) => deleteProp(d, p.key))}>
            ✕
          </button>
        </div>
      ))}
      <form
        className="prop-add"
        onSubmit={(e) => {
          e.preventDefault();
          const k = newKey.trim();
          if (!k || props.some((p) => p.key === k)) return;
          setNewKey("");
          onChange((d) => setProp(d, k, [""], false, true));
        }}
      >
        <input
          className="prop-value"
          placeholder="Add property…"
          value={newKey}
          onChange={(e) => setNewKey(e.currentTarget.value)}
        />
        <button className="prop-add-btn" type="submit" disabled={!newKey.trim()}>
          +
        </button>
      </form>
    </div>
  );
}
