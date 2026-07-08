import { useEffect, useRef } from "react";
import { pluginStatusBarItems } from "../lib/plugins";

interface Props {
  /** Caret position (1-based) + selection length for the focused editor, or null. */
  cursor: { line: number; col: number; sel: number } | null;
  words: number;
  chars: number;
  /** Bumps when the plugin registry changes, so mounted items refresh. */
  pluginVersion: number;
}

/** The bottom status bar: caret position, word/char count, and any plugin
 * status-bar items (mounted from their owning plugins). */
export function StatusBar({ cursor, words, chars, pluginVersion }: Props) {
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
          {cursor.sel > 0 ? `${cursor.sel} selected · ` : ""}Ln {cursor.line}, Col {cursor.col}
        </span>
      )}
      <span className="status-bar-item">{words} words</span>
      <span className="status-bar-item">{chars} characters</span>
    </div>
  );
}
