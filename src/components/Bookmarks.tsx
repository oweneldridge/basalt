import type { Bookmark } from "../lib/vault";

interface Props {
  bookmarks: Bookmark[];
  /** Open a bookmarked note/heading/block (search bookmarks route to onSearch). */
  onOpen: (b: Bookmark) => void;
  onSearch: (query: string) => void;
}

const ICON: Record<string, string> = {
  file: "📄",
  folder: "📁",
  heading: "#",
  block: "❡",
  search: "🔍",
  graph: "🕸",
};

export function Bookmarks({ bookmarks, onOpen, onSearch }: Props) {
  if (bookmarks.length === 0) return <div className="empty">No bookmarks</div>;

  // Preserve file order; group headers appear inline when the group changes.
  let lastGroup: string | null | undefined;
  return (
    <div className="bookmark-list">
      {bookmarks.map((b, i) => {
        const groupHeader =
          b.group && b.group !== lastGroup ? (
            <div className="bookmark-group" key={`g:${b.group}:${i}`}>
              {b.group}
            </div>
          ) : null;
        lastGroup = b.group;
        const openable = b.type !== "graph" && (b.path != null || b.type === "search");
        return (
          <div key={`${b.type}:${b.path ?? b.query ?? ""}:${i}`}>
            {groupHeader}
            <button
              className="bookmark-row"
              disabled={!openable}
              onClick={() => (b.type === "search" ? onSearch(b.query ?? "") : onOpen(b))}
              title={b.path ?? b.query ?? b.title}
            >
              <span className="bookmark-icon">{ICON[b.type] ?? "•"}</span>
              <span className="bookmark-title">{b.title}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
