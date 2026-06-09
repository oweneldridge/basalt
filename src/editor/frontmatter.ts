// Live Preview for YAML frontmatter: render the leading `---…---` block as an
// Obsidian-style Properties view (key / typed-value rows) when the cursor is
// outside it; reveal the raw YAML for editing when the cursor is inside.
//
// Like tables, this is a block decoration, so it must come from a StateField.
// We use a deliberately small YAML reader (no dependency): `key: value`,
// `key: [a, b]`, and `key:` followed by `- item` lines. Anything fancier falls
// back to showing the raw value text.
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, EditorSelection, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { frontmatterRange } from "./regions";

interface Prop {
  key: string;
  values: string[];
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFrontmatter(source: string): Prop[] {
  const lines = source.split("\n");
  // Drop the opening and closing `---` fences.
  const body = lines.slice(1, Math.max(1, lines.length - 1));
  const props: Prop[] = [];
  let current: Prop | null = null;
  for (const raw of body) {
    if (!raw.trim()) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(raw);
    if (listItem && current) {
      current.values.push(stripQuotes(listItem[1].trim()));
      continue;
    }
    const kv = /^([^:\s][^:]*?):\s*(.*)$/.exec(raw);
    if (kv) {
      const key = kv[1].trim();
      const val = kv[2].trim();
      current = { key, values: [] };
      props.push(current);
      if (val.startsWith("[") && val.endsWith("]")) {
        current.values = val
          .slice(1, -1)
          .split(",")
          .map((s) => stripQuotes(s.trim()))
          .filter(Boolean);
      } else if (val) {
        current.values = [stripQuotes(val)];
      }
      continue;
    }
    if (current) current.values.push(raw.trim());
  }
  return props;
}

class PropertiesWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: PropertiesWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-properties";
    const props = parseFrontmatter(this.source);
    if (props.length === 0) {
      wrap.classList.add("cm-properties-empty");
      wrap.textContent = "No properties";
      return wrap;
    }
    for (const p of props) {
      const row = document.createElement("div");
      row.className = "cm-prop-row";
      const key = document.createElement("div");
      key.className = "cm-prop-key";
      key.textContent = p.key;
      const values = document.createElement("div");
      values.className = "cm-prop-values";
      if (p.values.length <= 1) {
        values.textContent = p.values[0] ?? "";
      } else {
        for (const v of p.values) {
          const pill = document.createElement("span");
          pill.className = "cm-prop-pill";
          pill.textContent = v;
          values.append(pill);
        }
      }
      row.append(key, values);
      wrap.append(row);
    }
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

interface FmState {
  deco: DecorationSet;
  range: { from: number; to: number } | null;
}

function compute(state: EditorState): FmState {
  const range = frontmatterRange(state);
  if (!range) return { deco: Decoration.none, range: null };
  const touched = state.selection.ranges.some((r) => r.from <= range.to && r.to >= range.from);
  if (touched) return { deco: Decoration.none, range }; // editing: show raw
  const builder = new RangeSetBuilder<Decoration>();
  const source = state.doc.sliceString(range.from, range.to);
  builder.add(
    range.from,
    range.to,
    Decoration.replace({ widget: new PropertiesWidget(source), block: true }),
  );
  return { deco: builder.finish(), range };
}

function touches(range: { from: number; to: number } | null, sel: EditorSelection): boolean {
  if (!range) return false;
  return sel.ranges.some((r) => r.from <= range.to && r.to >= range.from);
}

const fmField = StateField.define<FmState>({
  create: (state) => compute(state),
  update: (value, tr) => {
    if (tr.docChanged) return compute(tr.state);
    if (tr.selection) {
      const before = touches(value.range, tr.startState.selection);
      const after = touches(value.range, tr.state.selection);
      if (before !== after) return compute(tr.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
});

// A click on the block-replaced properties maps to its boundary, not inside, so
// it never reveals for editing. Place the caret inside instead.
const fmClick = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const target = event.target as HTMLElement | null;
    if (!target) return false;
    const wrap = target.closest(".cm-properties");
    if (!wrap) return false;
    const pos = view.posAtDOM(wrap as HTMLElement);
    event.preventDefault();
    view.dispatch({ selection: { anchor: pos } });
    return true;
  },
});

export const frontmatter: Extension = [fmField, fmClick];
