// Paste/drop attachments into the editor: insert unique placeholders
// synchronously (safe against concurrent edits — completion locates the
// placeholder STRING rather than trusting stale offsets), save each file via
// the backend, then swap the placeholder for the real ![[name]] embed. If the
// editor was destroyed or reloaded meanwhile (note switch, external reconcile),
// completion falls back to an app-level replace against the note on disk.
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export interface AttachmentOptions {
  /** Persist the file; resolves to the link target (filename) or null. */
  save: (file: File) => Promise<string | null>;
  /** App-level fallback: replace `placeholder` with `replacement` in whichever
   * note contains it (the live editor no longer does). */
  fallbackReplace: (placeholder: string, replacement: string) => void;
}

let counter = 0;
const session = Math.random().toString(36).slice(2, 8);

async function complete(
  view: EditorView,
  placeholder: string,
  file: File,
  opts: AttachmentOptions,
): Promise<void> {
  let target: string | null = null;
  try {
    target = await save_safe(opts, file);
  } catch {
    target = null;
  }
  const replacement = target ? `![[${target}]]` : "";
  // Try the live view first (preserves caret/undo); fall back to app state if
  // the view is gone or the placeholder text is no longer in this document.
  if (view.dom.isConnected) {
    const doc = view.state.doc.toString();
    const at = doc.indexOf(placeholder);
    if (at !== -1) {
      view.dispatch({
        changes: { from: at, to: at + placeholder.length, insert: replacement },
        userEvent: "input.paste",
      });
      return;
    }
  }
  opts.fallbackReplace(placeholder, replacement);
}

function save_safe(opts: AttachmentOptions, file: File): Promise<string | null> {
  return opts.save(file);
}

function pastable(files: FileList | undefined | null): File[] {
  if (!files) return [];
  return [...files].filter(
    (f) =>
      f.type.startsWith("image/") ||
      f.type === "application/pdf" ||
      f.type.startsWith("audio/") ||
      f.type.startsWith("video/"),
  );
}

function insertAll(view: EditorView, files: File[], pos: number, opts: AttachmentOptions): void {
  const placeholders = files.map(
    (f) => `![[uploading-${session}-${++counter}-${f.size}]]`,
  );
  // One dispatch, in order, newline-separated — multiple un-awaited inserts at
  // the same position would land in reverse with no separators.
  view.dispatch({
    changes: { from: pos, insert: placeholders.join("\n") },
    userEvent: "input.paste",
  });
  files.forEach((f, i) => void complete(view, placeholders[i], f, opts));
}

export function attachments(opts: AttachmentOptions): Extension {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const files = pastable(event.clipboardData?.files);
      if (files.length === 0) return false;
      event.preventDefault();
      insertAll(view, files, view.state.selection.main.head, opts);
      return true;
    },
    drop: (event, view) => {
      const files = pastable(event.dataTransfer?.files);
      if (files.length === 0) return false;
      event.preventDefault();
      const pos =
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
        view.state.selection.main.head;
      insertAll(view, files, pos, opts);
      return true;
    },
  });
}
