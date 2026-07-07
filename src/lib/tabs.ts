// Pure tab-order math for drag-to-reorder. `toIndex` is a slot in the ORIGINAL
// `tabs` array (0..tabs.length) — the position the drop indicator sat before.
// When the dragged tab moves rightward, removing it first shifts the later
// slots down by one, so the insert index is adjusted to land where intended.
export function reorderTabs(tabs: string[], path: string, toIndex: number): string[] {
  const origIdx = tabs.indexOf(path);
  if (origIdx === -1) return tabs;
  const rest = tabs.filter((p) => p !== path);
  let idx = toIndex;
  if (origIdx < toIndex) idx -= 1; // compensate for the removed element
  idx = Math.min(Math.max(0, idx), rest.length);
  rest.splice(idx, 0, path);
  return rest;
}

/** Insert `path` (not currently present) into `tabs` at slot `toIndex`. */
export function insertTab(tabs: string[], path: string, toIndex: number): string[] {
  const rest = tabs.filter((p) => p !== path);
  const idx = Math.min(Math.max(0, toIndex), rest.length);
  rest.splice(idx, 0, path);
  return rest;
}
