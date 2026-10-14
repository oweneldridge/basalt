import { useEffect, useRef, useState } from "react";

interface Props {
  /** The note's basename (no folder, no extension). */
  name: string;
  /** Commit a new basename (already validated non-empty + changed). */
  onRename: (newName: string) => void;
  /** Enter or Escape: carry on in the note below. */
  onDone?: () => void;
}

/** Obsidian's "inline title": the note's filename shown as an editable heading
 * above the content; committing it renames the note (staying in its folder). */
export function InlineTitle({ name, onRename, onDone }: Props) {
  const [draft, setDraft] = useState(name);
  const ref = useRef<HTMLInputElement | null>(null);
  // Escape blurs before React has applied its reset, so the blur must not commit.
  const cancelled = useRef(false);
  useEffect(() => setDraft(name), [name]);

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = draft.trim();
    if (!next || next === name) {
      setDraft(name);
      return;
    }
    if (/[#^[\]|/\\]/.test(next)) {
      setDraft(name); // illegal filename chars — revert
      return;
    }
    onRename(next);
  };

  return (
    <input
      ref={ref}
      className="inline-title"
      value={draft}
      spellCheck={false}
      aria-label="Note title"
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
          onDone?.();
        } else if (e.key === "Escape") {
          cancelled.current = true;
          setDraft(name);
          e.currentTarget.blur();
          onDone?.();
        }
      }}
    />
  );
}
