import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

interface PaletteProps<T> {
  placeholder: string;
  /** Compute the (already filtered + ranked) items for a query. */
  getItems: (query: string) => T[];
  itemKey: (item: T, index: number) => string;
  renderItem: (item: T, active: boolean) => ReactNode;
  onSelect: (item: T) => void;
  onClose: () => void;
  emptyText?: string;
  /** Seed the query box (e.g. opening search pre-filled with a clicked tag). */
  initialQuery?: string;
}

const MAX_RENDER = 100;

export function Palette<T>({
  placeholder,
  getItems,
  itemKey,
  renderItem,
  onSelect,
  onClose,
  emptyText = "No results",
  initialQuery = "",
}: PaletteProps<T>) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const items = useMemo(() => getItems(query).slice(0, MAX_RENDER), [query, getItems]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active];
      if (item) onSelect(item);
    }
  };

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          placeholder={placeholder}
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" ref={listRef}>
          {items.map((item, i) => (
            <button
              key={itemKey(item, i)}
              className={`palette-item${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => onSelect(item)}
            >
              {renderItem(item, i === active)}
            </button>
          ))}
          {items.length === 0 && <div className="palette-empty">{emptyText}</div>}
        </div>
      </div>
    </div>
  );
}
