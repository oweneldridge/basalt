import { useEffect, useRef } from "react";
import { pluginStatusBarItems } from "../lib/plugins";

interface Props {
  /** Caret position (1-based) in the focused editor, or null. */
  cursor: { line: number; col: number } | null;
  /** The note's word and character counts, or the selection's; null when no
   * note is shown. */
  counts: { words: number; chars: number } | null;
  /** Bumps when the plugin registry changes, so mounted items refresh. */
  pluginVersion: number;
}

const plural = (n: number, noun: string) => `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;

/** The bottom status bar: caret position, word/char count, and any plugin
 * status-bar items (mounted from their owning plugins). */
export function StatusBar({ cursor, counts, pluginVersion }: Props) {
  const pluginMount = useRef<HTMLDivElement | null>(null);

  // Re-mount the current plugin status items whenever the registry changes.
  useEffect(() => {
    const host = pluginMount.current;
    if (!host) return;
    host.replaceChildren(...pluginStatusBarItems());
    return () => host.replaceChildren();
  }, [pluginVersion]);

  return (
    <div className="status-bar">
      <div className="status-bar-plugins" ref={pluginMount} />
      <div className="status-bar-spacer" />
      {cursor && (
        <span className="status-bar-item">
          Ln {cursor.line}, Col {cursor.col}
        </span>
      )}
      {counts && (
        <>
          <span className="status-bar-item">{plural(counts.words, "word")}</span>
          <span className="status-bar-item">{plural(counts.chars, "character")}</span>
        </>
      )}
    </div>
  );
}
