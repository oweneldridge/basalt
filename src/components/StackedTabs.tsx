import { useEffect, useState } from "react";
import type { ReactNode } from "react";

interface Tab {
  path: string;
  name: string;
  rel: string;
}

interface Props {
  tabs: Tab[];
  activePath: string | null;
  readNote: (path: string) => Promise<string>;
  /** Click a column header → make that tab active, carrying its live (possibly
   * edited) doc so unstacking shows the current content. */
  onFocusTab: (path: string, doc: string | undefined) => void;
  /** Render a column's body for a markdown tab. `onDocChange` keeps the loaded
   * copy current as the user edits (so re-renders don't reset it). */
  renderBody: (tab: Tab, doc: string, onDocChange: (doc: string) => void) => ReactNode;
}

/** Stacked tab group (Obsidian's "Stack tab group"): a horizontal spread of a
 * pane's open tabs as columns with title headers. Each markdown tab's content
 * is loaded lazily, cached, and rendered by the parent via `renderBody` (an
 * editable EditorPane) so edits in any column save back to that note. */
export function StackedTabs({ tabs, activePath, readNote, onFocusTab, renderBody }: Props) {
  const [docs, setDocs] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const missing = tabs.filter((t) => docs[t.path] === undefined && /\.md$/i.test(t.path));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (t) => {
        try {
          return [t.path, await readNote(t.path)] as const;
        } catch {
          return [t.path, "*Couldn't load this note.*"] as const;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setDocs((prev) => {
        const next = { ...prev };
        for (const [p, c] of pairs) if (next[p] === undefined) next[p] = c;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [tabs, docs, readNote]);

  return (
    <div className="stacked-tabs">
      {tabs.map((t) => (
        <div key={t.path} className={`stacked-col${t.path === activePath ? " active" : ""}`}>
          <button className="stacked-col-head" title={`Focus ${t.name}`} onClick={() => onFocusTab(t.path, docs[t.path])}>
            {t.name}
          </button>
          <div className="stacked-col-body">
            {/\.md$/i.test(t.path) && docs[t.path] !== undefined ? (
              renderBody(t, docs[t.path], (d) => setDocs((prev) => ({ ...prev, [t.path]: d })))
            ) : (
              <div className="placeholder">{/\.md$/i.test(t.path) ? "Loading…" : "Open this tab to view it."}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
