import { parseViewPath, type BuiltinView } from "../lib/leafViews";

// Line drawings on a 24-unit grid, stroked in the text colour.
const PATHS: Record<BuiltinView, string> = {
  filetree: "M3 6h6l2 2h10v11H3z",
  search: "M11 5a6 6 0 1 0 0 12a6 6 0 1 0 0-12M15.5 15.5L20 20",
  backlinks: "M13 4h7v16h-7M3 12h11M7 8l-4 4l4 4",
  links: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  outline: "M9 6h12M9 12h12M9 18h12M4 6h1M4 12h1M4 18h1",
  tags: "M5 9h15M4 15h15M10 4L8 20M16 4l-2 16",
  bookmarks: "M6 3h12v18l-6-4l-6 4z",
  properties: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
};
// Only straight lines across and down: drawn on whole pixels, they stay sharp.
const SQUARE = new Set<BuiltinView>(["outline", "properties"]);

/** The icon for a built-in view tab's path, or null. */
export function ViewIcon({ path }: { path: string }) {
  const spec = parseViewPath(path);
  if (!spec || spec.type === "plugin") return null;
  return (
    <svg className="tab-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d={PATHS[spec.type]}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        shapeRendering={SQUARE.has(spec.type) ? "crispEdges" : undefined}
      />
    </svg>
  );
}
