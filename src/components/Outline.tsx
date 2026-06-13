import { useMemo } from "react";
import { proseMask } from "../lib/markdown";

interface Heading {
  level: number;
  text: string;
  line: number; // 1-based
}

interface Props {
  /** Active note content, or null when nothing is open. */
  doc: string | null;
  onJump: (line: number) => void;
}

/** ATX headings (`# … ###### …`) outside fenced code / frontmatter. */
function headings(doc: string): Heading[] {
  const lines = doc.split("\n");
  const prose = proseMask(lines);
  const out: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!prose[i]) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 });
  }
  return out;
}

export function Outline({ doc, onJump }: Props) {
  const items = useMemo(() => (doc ? headings(doc) : []), [doc]);
  // Indent relative to the shallowest heading present, so a note whose top
  // heading is ## still starts flush-left.
  const minLevel = items.reduce((m, h) => Math.min(m, h.level), 6);

  if (doc === null) return <div className="empty">No note selected</div>;
  if (items.length === 0) return <div className="empty">No headings</div>;
  return (
    <div className="outline">
      {items.map((h, i) => (
        <button
          key={`${h.line}:${i}`}
          className="outline-row"
          style={{ paddingLeft: `${8 + (h.level - minLevel) * 14}px` }}
          onClick={() => onJump(h.line)}
          title={h.text}
        >
          {h.text}
        </button>
      ))}
    </div>
  );
}
