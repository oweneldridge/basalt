import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
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
  /** A line above the results (a search's total), given every result and how
   * many are shown. */
  summary?: (all: T[], shown: number) => string;
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
  summary,
}: PaletteProps<T>) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const all = useMemo(() => getItems(query), [query, getItems]);
  const items = useMemo(() => all.slice(0, MAX_RENDER), [all]);

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

  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;
  return (
    <Modal className="palette-overlay" label={placeholder} onClose={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items.length ? optionId(active) : undefined}
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        {summary && query.trim() && all.length > 0 && (
          <div className="palette-summary" role="status">
            {summary(all, items.length)}
          </div>
        )}
        <div className="palette-list" ref={listRef} id={listId} role="listbox" aria-label={placeholder}>
          {items.map((item, i) => (
            <button
              key={itemKey(item, i)}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
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
    </Modal>
  );
}
