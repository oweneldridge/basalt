// A workspace leaf (pane) holds tabs. A tab is normally a note — its path. To
// let non-note VIEWS (file tree, backlinks, outline, plugin views…) live as tabs
// anywhere in the layout (Obsidian's "everything is a leaf" model), a view tab
// is represented by a sentinel "path" that no real file can have. All knowledge
// of that encoding lives here so the rest of the app can ask isViewPath() /
// parseViewPath() rather than pattern-matching strings in a dozen places.
//
// The sentinel starts with a NUL char (like the quick-switcher's "create"
// sentinel), which is illegal in a real filesystem path, so a view tab can never
// collide with or be mistaken for a note.

export const BUILTIN_VIEWS = [
  "filetree",
  "search",
  "backlinks",
  "links",
  "outline",
  "tags",
  "bookmarks",
  "properties",
] as const;

export type BuiltinView = (typeof BUILTIN_VIEWS)[number];

/** A view tab's kind: a built-in panel, or a plugin-registered view (registerView). */
export type ViewSpec = { type: BuiltinView } | { type: "plugin"; viewId: string };

// NUL + "view:" — NUL can't appear in a real path, so this never collides with a note.
const PREFIX = String.fromCharCode(0) + "view:";
const PLUGIN_PREFIX = "plugin:";

/** The sentinel tab-path for a view. */
export function viewPath(spec: ViewSpec): string {
  return spec.type === "plugin" ? `${PREFIX}${PLUGIN_PREFIX}${spec.viewId}` : `${PREFIX}${spec.type}`;
}

/** True when a tab path is a view sentinel (not a real note/attachment). */
export function isViewPath(path: string): boolean {
  return path.startsWith(PREFIX);
}

/** Decode a view sentinel back to its spec, or null if it isn't one / is unknown. */
export function parseViewPath(path: string): ViewSpec | null {
  if (!path.startsWith(PREFIX)) return null;
  const body = path.slice(PREFIX.length);
  if (body.startsWith(PLUGIN_PREFIX)) {
    const viewId = body.slice(PLUGIN_PREFIX.length);
    return viewId ? { type: "plugin", viewId } : null;
  }
  return (BUILTIN_VIEWS as readonly string[]).includes(body) ? { type: body as BuiltinView } : null;
}

const BUILTIN_LABELS: Record<BuiltinView, string> = {
  filetree: "Files",
  search: "Search",
  backlinks: "Backlinks",
  links: "Links",
  outline: "Outline",
  tags: "Tags",
  bookmarks: "Bookmarks",
  properties: "Properties",
};

/** A human label for a built-in view. Plugin views resolve their name elsewhere
 * (from the plugin registry), so this returns the viewId as a fallback. */
export function viewLabel(spec: ViewSpec): string {
  return spec.type === "plugin" ? spec.viewId : BUILTIN_LABELS[spec.type];
}
