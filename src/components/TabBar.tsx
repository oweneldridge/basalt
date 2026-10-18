import { useEffect, useRef, useState } from "react";
import { parseViewPath } from "../lib/leafViews";
import { menuKeyOpens } from "./ContextMenu";
import { ViewIcon } from "./ViewIcon";

export interface TabItem {
  path: string;
  name: string;
  pinned?: boolean;
  /** True for a view tab (file tree, outline, plugin view…) vs a note tab. */
  view?: boolean;
}

interface Props {
  /** This pane's id — carried in the drag payload so a drop knows the source. */
  paneId: string;
  tabs: TabItem[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onNew: () => void;
  /** Toggle a tab's pinned state (right-click / the pin glyph). */
  onTogglePin: (path: string) => void;
  /** A tab was dropped: move `path` from `fromPaneId` into this pane at `index`. */
  onTabDrop: (fromPaneId: string, path: string, toIndex: number) => void;
  /** Right-click a tab → open a context menu at (x, y). */
  onContextMenu: (path: string, x: number, y: number) => void;
  /** Fired when a tab drag starts (true) / ends (false) — drives the pane edge
   * drop-zones for drag-to-split. */
  onDragStateChange: (active: boolean) => void;
  /** Whether this pane is "linked" (follows notes opened elsewhere). */
  linked: boolean;
  onToggleLink: () => void;
  /** Whether this pane's tabs are shown as a stacked spread. */
  stacked: boolean;
  onToggleStacked: () => void;
  /** A sidebar dock pane — hides editor-only affordances (+, link, stack). */
  dock?: boolean;
  /** "pane 2" when there are other note panes, so their tab lists' names differ. */
  where?: string;
}

// A tab drag carries "<paneId>\n<path>" under this private MIME type.
const TAB_MIME = "application/x-basalt-tab";

export function TabBar({ paneId, tabs, activePath, onSelect, onClose, onNew, onTogglePin, onTabDrop, onContextMenu, onDragStateChange, linked, onToggleLink, stacked, onToggleStacked, dock, where }: Props) {
  // Index the drop indicator sits before (null = none, tabs.length = at end).
  const [dropAt, setDropAt] = useState<number | null>(null);
  // Whether focus is on this bar (a tab, or a menu one opened), so closing the
  // focused tab hands focus to the tab now active rather than to the page.
  const strip = useRef<HTMLDivElement>(null);
  const holdsFocus = useRef(false);
  useEffect(() => {
    if (!holdsFocus.current) return;
    const frame = requestAnimationFrame(() => {
      const at = document.activeElement;
      // Focus that went on elsewhere (the next note's editor) ends the claim.
      if (at && at !== document.body) holdsFocus.current = !!(strip.current?.contains(at) || at.closest(".ctx-menu"));
      else if (holdsFocus.current) strip.current?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [tabs, activePath]);

  const readDrag = (dt: DataTransfer): { from: string; path: string } | null => {
    const raw = dt.getData(TAB_MIME);
    if (!raw) return null;
    const nl = raw.indexOf("\n");
    return nl < 0 ? null : { from: raw.slice(0, nl), path: raw.slice(nl + 1) };
  };

  return (
    <div
      className="tab-bar"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TAB_MIME)) {
          e.preventDefault();
          if (dropAt === null) setDropAt(tabs.length); // over empty space → end
        }
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the bar itself, not moving between children.
        if (e.currentTarget === e.target) setDropAt(null);
      }}
      onDrop={(e) => {
        const d = readDrag(e.dataTransfer);
        const at = dropAt ?? tabs.length;
        setDropAt(null);
        if (d) {
          e.preventDefault();
          onTabDrop(d.from, d.path, at);
        }
      }}
    >
      <div
        ref={strip}
        className="tab-strip"
        role="tablist"
        aria-label={dock ? "Panel views" : where ? `Open notes, ${where}` : "Open notes"}
        onFocus={() => (holdsFocus.current = true)}
        onBlur={(e) => {
          const to = e.relatedTarget;
          if (to instanceof Element) holdsFocus.current = !!(strip.current?.contains(to) || to.closest(".ctx-menu"));
          else {
            // Gone with its tab, it keeps the bar's claim; still there, it was clicked away from.
            const from = e.target;
            queueMicrotask(() => {
              if (from.isConnected) holdsFocus.current = false;
            });
          }
        }}
      >
      {tabs.map((t, i) => {
        // A built-in view in a side dock is its icon, named in its tooltip, so all
        // fit; a plugin's view shows its name. It closes from its menu, a middle
        // click or Delete, as in Obsidian.
        const iconOnly = !!dock && !!t.view && parseViewPath(t.path)?.type !== "plugin";
        return (
        <div
          key={t.path}
          // One Tab stop per bar (the active tab); arrows move between tabs.
          tabIndex={t.path === activePath || (i === 0 && !tabs.some((x) => x.path === activePath)) ? 0 : -1}
          aria-keyshortcuts={t.pinned ? undefined : "Delete"}
          onFocus={
            iconOnly
              ? (e) => {
                  // Its name shows under this tab, kept inside the bar.
                  const tab = e.currentTarget;
                  const bar = tab.parentElement;
                  const name = tab.querySelector<HTMLElement>(".tab-name");
                  if (!bar || !name) return;
                  const x = Math.max(4, Math.min(tab.offsetLeft, bar.clientWidth - name.offsetWidth - 4));
                  bar.style.setProperty("--name-x", `${x}px`);
                }
              : undefined
          }
          onKeyDown={(e) => {
            const list = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
            const at = list.indexOf(e.currentTarget);
            const go = (j: number) => list[(j + list.length) % list.length]?.focus();
            if (e.key === "ArrowRight") go(at + 1);
            else if (e.key === "ArrowLeft") go(at - 1);
            else if (e.key === "Home") go(0);
            else if (e.key === "End") go(list.length - 1);
            else if (e.key === "Enter" || e.key === " ") onSelect(t.path);
            else if ((e.key === "Delete" || e.key === "Backspace") && !t.pinned) {
              onClose(t.path);
            }
            else {
              const at = menuKeyOpens(e);
              if (at) onContextMenu(t.path, at.x, at.y);
              return;
            }
            e.preventDefault();
          }}
          className={`tab${t.path === activePath ? " active" : ""}${t.pinned ? " pinned" : ""}${t.view ? " view-tab" : ""}${dropAt === i ? " drop-before" : ""}`}
          role="tab"
          aria-selected={t.path === activePath}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(TAB_MIME, `${paneId}\n${t.path}`);
            // WKWebView (the Tauri webview) drops a drag that carries ONLY a
            // custom MIME type — a text/plain payload keeps it a valid drag.
            e.dataTransfer.setData("text/plain", t.name);
            e.dataTransfer.effectAllowed = "move";
            onDragStateChange(true);
          }}
          onDragEnd={() => onDragStateChange(false)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(TAB_MIME)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            // Drop before this tab or after it, based on which half we're over.
            const r = e.currentTarget.getBoundingClientRect();
            setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
          }}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              if (!t.pinned) onClose(t.path); // middle-click closes (unless pinned)
            } else if (e.button === 0) {
              onSelect(t.path);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu(t.path, e.clientX, e.clientY);
          }}
        >
          {t.pinned && (
            <button
              className="tab-pin"
              tabIndex={-1}
              aria-hidden="true"
              aria-label={`Unpin ${t.name}`}
              title="Unpin"
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onTogglePin(t.path);
              }}
            >
              📌
            </button>
          )}
          {/* The tooltip sits on a label filling the tab, not on the tab, so it
              isn't read out again as the tab's description. */}
          <span className="tab-label" title={t.pinned ? `${t.name} (pinned)` : t.name}>
            {iconOnly && <ViewIcon path={t.path} />}
            <span className={iconOnly ? "tab-name sr-only" : "tab-name"}>{t.name}</span>
            {t.pinned && <span className="sr-only"> (pinned)</span>}
          </span>
          {!t.pinned && !(dock && t.view) && (
            <button
              className="tab-close"
              tabIndex={-1}
              aria-hidden="true"
              aria-label={`Close ${t.name}`}
              title={`Close ${t.name}`}
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onClose(t.path);
              }}
            >
              ×
            </button>
          )}
        </div>
        );
      })}
      </div>
      <span className={`tab-drop-end${dropAt === tabs.length ? " active" : ""}`} aria-hidden />
      {!dock && (
        <button className="tab-new" title="Open a note (⌘O)" aria-label="Open a note (⌘O)" onClick={onNew}>
          +
        </button>
      )}
      {!dock && (
        <button
          className={`tab-link${linked ? " active" : ""}`}
          title={linked ? "Linked: follows notes opened elsewhere (click to unlink)" : "Link this pane (follow notes opened elsewhere)"} aria-label={linked ? "Linked: follows notes opened elsewhere (click to unlink)" : "Link this pane (follow notes opened elsewhere)"}
          aria-pressed={linked}
          onClick={onToggleLink}
        >
          🔗
        </button>
      )}
      {!dock && tabs.length > 1 && (
        <button
          className={`tab-link tab-stack${stacked ? " active" : ""}`}
          title={stacked ? "Unstack tabs" : "Stack tabs (spread all open notes)"} aria-label={stacked ? "Unstack tabs" : "Stack tabs (spread all open notes)"}
          aria-pressed={stacked}
          onClick={onToggleStacked}
        >
          ▤
        </button>
      )}
    </div>
  );
}
