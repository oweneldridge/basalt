import { useEffect, useRef, useState } from "react";

interface Props {
  /** The note's basename (no folder, no extension). */
  name: string;
  /** Commit a new basename (already validated non-empty + changed). */
  onRename: (newName: string) => void;
}

/** Obsidian's "inline title": the note's filename shown as an editable heading
 * above the content; committing it renames the note (staying in its folder). */
export function InlineTitle({ name, onRename }: Props) {
  const [draft, setDraft] = useState(name);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => setDraft(name), [name]);

  const commit = () => {
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
        } else if (e.key === "Escape") {
          setDraft(name);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
