import { useEffect, useState } from "react";
import { ReadingView } from "./ReadingView";

interface Tab {
  path: string;
  name: string;
  rel: string;
}

interface Props {
  tabs: Tab[];
  activePath: string | null;
  dark: boolean;
  readNote: (path: string) => Promise<string>;
  onOpenInternal: (target: string) => void;
  onOpenUrl: (url: string) => void;
  resolveImage: (target: string, sourceRel: string) => Promise<string | null>;
  /** Click a column header → make that tab active. */
  onFocusTab: (path: string) => void;
}

/** Stacked tab group (Obsidian's "Stack tab group"): a horizontal spread of a
 * pane's open tabs, each rendered read-only as a column with a title header.
 * Editing happens by focusing a tab (its header) to return to the normal pane.
 * Contents are loaded lazily per tab and cached for the life of the component. */
export function StackedTabs({ tabs, activePath, dark, readNote, onOpenInternal, onOpenUrl, resolveImage, onFocusTab }: Props) {
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
        for (const [p, c] of pairs) next[p] = c;
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
          <button className="stacked-col-head" title={`Focus ${t.name}`} onClick={() => onFocusTab(t.path)}>
            {t.name}
          </button>
          <div className="stacked-col-body">
            {/\.md$/i.test(t.path) ? (
              <ReadingView
                doc={docs[t.path] ?? ""}
                selfRel={t.rel}
                dark={dark}
                onOpenInternal={onOpenInternal}
                onOpenUrl={onOpenUrl}
                onToggleTask={() => {}}
                resolveImage={(target) => resolveImage(target, t.rel)}
              />
            ) : (
              <div className="placeholder">Open this tab to view it.</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
