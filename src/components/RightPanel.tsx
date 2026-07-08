import type { Backlink, TagCount } from "../lib/vaultIndex";
import type { Bookmark } from "../lib/vault";
import { Backlinks } from "./Backlinks";
import { Outline } from "./Outline";
import { Tags } from "./Tags";
import { Bookmarks } from "./Bookmarks";

export type RightTab = "backlinks" | "links" | "outline" | "tags" | "bookmarks";

const TABS: { id: RightTab; label: string }[] = [
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
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  // Backlinks
  noteName: string | null;
  backlinks: Backlink[];
  unlinked: Backlink[];
  outgoing: OutgoingLinks;
  onOpenRef: (path: string, line: number) => void;
  // Outline
  outlineDoc: string | null;
  onJumpLine: (line: number) => void;
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
  noteName,
  backlinks,
  unlinked,
  outgoing,
  onOpenRef,
  outlineDoc,
  onJumpLine,
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
      </div>
      <div className="right-body">
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
