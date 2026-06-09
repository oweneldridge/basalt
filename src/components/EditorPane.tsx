import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { createEditorState } from "../editor/setup";

interface Props {
  /** Active note path — changing this rebuilds the editor with fresh content. */
  path: string;
  /** Initial document content for `path`. */
  doc: string;
  getNotes: () => string[];
  onOpenWikilink: (target: string) => void;
  onOpenUrl: (url: string) => void;
  onChange: (doc: string) => void;
}

export function EditorPane({ path, doc, getNotes, onOpenWikilink, onOpenUrl, onChange }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  // Keep the latest callbacks in refs so the editor (rebuilt only per `path`)
  // always calls through to fresh closures without being torn down on every render.
  const cbs = useRef({ getNotes, onOpenWikilink, onOpenUrl, onChange });
  cbs.current = { getNotes, onOpenWikilink, onOpenUrl, onChange };

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      state: createEditorState(doc, {
        getNotes: () => cbs.current.getNotes(),
        onOpenWikilink: (t) => cbs.current.onOpenWikilink(t),
        onOpenUrl: (u) => cbs.current.onOpenUrl(u),
        onChange: (d) => cbs.current.onChange(d),
      }),
      parent: host.current,
    });
    view.focus();
    return () => view.destroy();
    // Rebuild only when the note changes; `doc` is the initial content for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return <div className="editor-host" ref={host} />;
}
