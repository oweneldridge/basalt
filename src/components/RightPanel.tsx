import type { Backlink, TagCount } from "../lib/vaultIndex";
import type { Bookmark } from "../lib/vault";
import { Backlinks } from "./Backlinks";
import { Outline } from "./Outline";
import { Tags } from "./Tags";
import { Bookmarks } from "./Bookmarks";

import { useEffect, useRef } from "react";
import { Properties } from "./Properties";
import type { PluginView } from "../lib/plugins";

export type RightTab = "properties" | "backlinks" | "links" | "outline" | "tags" | "bookmarks";

/** Mounts a plugin's custom right-panel view into a container (runs its cleanup
 * on hide/unmount), mirroring how the settings-tab API mounts. */
function PluginViewMount({ view }: { view: PluginView }) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const cleanup = view.mount(el);
    return () => {
      if (typeof cleanup === "function") cleanup();
      el.replaceChildren();
    };
  }, [view]);
  return <div className="plugin-view-mount" ref={host} />;
}

const TABS: { id: RightTab; label: string }[] = [
  { id: "properties", label: "Properties" },
  { id: "backlinks", label: "Backlinks" },
  { id: "links", label: "Links" },
  { id: "outline", label: "Outline" },
  { id: "tags", label: "Tags" },
  { id: "bookmarks", label: "Bookmarks" },
];

export interface OutgoingLinks {
  resolved: { target: string; path: string; name: string }[];
  unresolved: string[];
}

interface Props {
  tab: string;
  onTab: (tab: string) => void;
  /** Plugin-registered custom views, shown as extra tabs after the built-ins. */
  pluginViews: PluginView[];
  // Backlinks
  noteName: string | null;
  backlinks: Backlink[];
  unlinked: Backlink[];
  outgoing: OutgoingLinks;
  onOpenRef: (path: string, line: number) => void;
  // Outline
  outlineDoc: string | null;
  onJumpLine: (line: number) => void;
  /** The focused pane's LIVE note content — Properties edits reflect at once. */
  propertiesDoc: string | null;
  /** Commit an edited version of the active note (from the Properties panel). */
  onEditProperties: (nextDoc: string) => void;
  // Tags
  tags: TagCount[];
  onSelectTag: (tag: string) => void;
  // Bookmarks
  bookmarks: Bookmark[];
  onOpenBookmark: (b: Bookmark) => void;
  onSearch: (query: string) => void;
  /** Open-or-create an unresolved outgoing link's target (Obsidian: click to create). */
  onOpenUnresolved: (target: string) => void;
  onLinkMention: (m: Backlink) => void;
  onLinkAllMentions: (m: Backlink[]) => void;
}

export function RightPanel({
  tab,
  onTab,
  pluginViews,
  noteName,
  backlinks,
  unlinked,
  outgoing,
  onOpenRef,
  outlineDoc,
  onJumpLine,
  propertiesDoc,
  onEditProperties,
  tags,
  onSelectTag,
  bookmarks,
  onOpenBookmark,
  onOpenUnresolved,
  onLinkMention,
  onLinkAllMentions,
  onSearch,
}: Props) {
  return (
    <aside className="right-panel">
      <div className="right-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "right-tab active" : "right-tab"}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        {pluginViews.map((v) => (
          <button
            key={v.id}
            className={tab === v.id ? "right-tab active" : "right-tab"}
            onClick={() => onTab(v.id)}
          >
            {v.name}
          </button>
        ))}
      </div>
      <div className="right-body">
        {pluginViews.filter((v) => v.id === tab).map((v) => (
          <PluginViewMount key={v.id} view={v} />
        ))}
        {tab === "properties" && <Properties doc={propertiesDoc} onChange={onEditProperties} />}
        {tab === "backlinks" && (
          <Backlinks
            noteName={noteName}
            backlinks={backlinks}
            unlinked={unlinked}
            onOpen={onOpenRef}
            onLink={onLinkMention}
            onLinkAll={onLinkAllMentions}
          />
        )}
        {tab === "links" && (
          <div className="outgoing">
            {outgoing.resolved.length === 0 && outgoing.unresolved.length === 0 && (
              <div className="panel-empty">No outgoing links</div>
            )}
            {outgoing.resolved.map((l, i) => (
              <button key={`r${i}`} className="outgoing-item" onClick={() => onOpenRef(l.path, 1)} title={l.path}>
                {l.name}
              </button>
            ))}
            {outgoing.unresolved.length > 0 && (
              <>
                <div className="outgoing-head">Unresolved</div>
                {outgoing.unresolved.map((t, i) => (
                  <button
                    key={`u${i}`}
                    className="outgoing-item unresolved"
                    onClick={() => onOpenUnresolved(t)}
                    title={`Create “${t}”`}
                  >
                    {t}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
        {tab === "outline" && <Outline doc={outlineDoc} onJump={onJumpLine} />}
        {tab === "tags" && <Tags tags={tags} onSelect={onSelectTag} />}
        {tab === "bookmarks" && (
          <Bookmarks bookmarks={bookmarks} onOpen={onOpenBookmark} onSearch={onSearch} />
        )}
      </div>
    </aside>
  );
}
