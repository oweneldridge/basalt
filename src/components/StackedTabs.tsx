import { useEffect, useRef, useState } from "react";
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
  /** The app's current text for a note (unsaved edits, another pane's live
   * text, or what was last seen on disk), so a column follows external and
   * other-pane changes instead of its first load. */
  liveDoc?: (path: string) => string | undefined;
}

/** Stacked tab group (Obsidian's "Stack tab group"): a horizontal spread of a
 * pane's open tabs as columns with title headers. Each markdown tab's content
 * is loaded lazily, cached, and rendered by the parent via `renderBody` (an
 * editable EditorPane) so edits in any column save back to that note. */
export function StackedTabs({ tabs, activePath, readNote, onFocusTab, renderBody, liveDoc }: Props) {
  // null = the read failed; never hand that to an editable editor.
  const [docs, setDocs] = useState<Record<string, string | null>>({});

  // Reads in flight, so a re-render (every keystroke in another column) doesn't
  // ask again for a note that's still loading.
  const loading = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const missing = tabs.filter((t) => docs[t.path] === undefined && /\.md$/i.test(t.path) && !loading.current.has(t.path));
    if (missing.length === 0) return;
    for (const t of missing) loading.current.add(t.path);
    void Promise.all(
      missing.map(async (t) => {
        try {
          return [t.path, await readNote(t.path)] as const;
        } catch {
          return [t.path, null] as const;
        }
      }),
    ).then((pairs) => {
      for (const [p] of pairs) loading.current.delete(p);
      if (!mounted.current) return;
      setDocs((prev) => {
        const next = { ...prev };
        for (const [p, c] of pairs) if (next[p] === undefined) next[p] = c;
        return next;
      });
    });
  }, [tabs, docs, readNote]);

  // A failed read may have been a network blip: read again every few seconds,
  // keeping the error up meanwhile (the app's own copy may be decoded lossily).
  const [attempt, setAttempt] = useState(0);
  const failedKey = tabs.filter((t) => docs[t.path] === null).map((t) => t.path).join("\n");
  useEffect(() => {
    if (!failedKey) return;
    const failed = failedKey.split("\n");
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all(
        failed.map(async (path) => {
          try {
            return [path, await readNote(path)] as const;
          } catch {
            return null;
          }
        }),
      ).then((pairs) => {
        if (cancelled) return;
        const read = pairs.filter((p) => p !== null);
        if (read.length === 0) {
          setAttempt((a) => a + 1);
          return;
        }
        setDocs((prev) => {
          const next = { ...prev };
          for (const [p, c] of read) if (next[p] === null) next[p] = c;
          return next;
        });
      });
    }, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [failedKey, readNote, attempt]);

  return (
    <div className="stacked-tabs">
      {tabs.map((t) => {
        const md = /\.md$/i.test(t.path);
        // Text the app already holds (a renamed note, another pane's) shows at
        // once, so a column rebuilt by a rename keeps the caret and typing. A
        // failed read wins: the app's copy of such a note may be decoded lossily.
        const doc = !md ? undefined : docs[t.path] === null ? null : (liveDoc?.(t.path) ?? docs[t.path]);
        return (
          <div key={t.path} className={`stacked-col${t.path === activePath ? " active" : ""}`}>
            <button className="stacked-col-head" title={`Focus ${t.name}`} onClick={() => onFocusTab(t.path, doc ?? undefined)}>
              {t.name}
            </button>
            <div className="stacked-col-body">
              {doc === null ? (
                <div className="placeholder">Couldn't load this note.</div>
              ) : doc !== undefined ? (
                renderBody(t, doc, (d) => setDocs((prev) => ({ ...prev, [t.path]: d })))
              ) : (
                <div className="placeholder">{md ? "Loading…" : "Open this tab to view it."}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
