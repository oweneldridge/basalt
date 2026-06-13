import type { TagCount } from "../lib/vaultIndex";

interface Props {
  tags: TagCount[];
  /** Search the vault for this tag (the bare name, without '#'). */
  onSelect: (tag: string) => void;
}

export function Tags({ tags, onSelect }: Props) {
  if (tags.length === 0) return <div className="empty">No tags</div>;
  return (
    <div className="tag-list">
      {tags.map((t) => (
        <button
          key={t.tag.toLowerCase()}
          className="tag-row"
          onClick={() => onSelect(t.tag)}
          title={`Search for #${t.tag}`}
        >
          <span className="tag-name">#{t.tag}</span>
          <span className="count">{t.count}</span>
        </button>
      ))}
    </div>
  );
}
