import type { Backlink, TagCount } from "../lib/vaultIndex";
import type { Bookmark } from "../lib/vault";
import { Backlinks } from "./Backlinks";
import { Outline } from "./Outline";
import { Tags } from "./Tags";
import { Bookmarks } from "./Bookmarks";

export type RightTab = "backlinks" | "outline" | "tags" | "bookmarks";

const TABS: { id: RightTab; label: string }[] = [
  { id: "backlinks", label: "Backlinks" },
  { id: "outline", label: "Outline" },
  { id: "tags", label: "Tags" },
  { id: "bookmarks", label: "Bookmarks" },
];

interface Props {
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  // Backlinks
  noteName: string | null;
  backlinks: Backlink[];
  unlinked: Backlink[];
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
}

export function RightPanel({
  tab,
  onTab,
  noteName,
  backlinks,
  unlinked,
  onOpenRef,
  outlineDoc,
  onJumpLine,
  tags,
  onSelectTag,
  bookmarks,
  onOpenBookmark,
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
          />
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
