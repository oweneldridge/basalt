// A distinct glyph per Obsidian callout type, shared by the editor (Live
// Preview) and the reading-mode renderer so they agree. Emoji (not SVG) so it
// themes with the font and needs no assets.
const ICONS: Record<string, string> = {
  note: "🗒️", info: "ℹ️", abstract: "📋", summary: "📋", tldr: "📋",
  tip: "💡", hint: "💡", important: "❗",
  success: "✅", check: "✅", done: "✅",
  question: "❓", help: "❓", faq: "❓",
  warning: "⚠️", caution: "⚠️", attention: "⚠️", todo: "🔲",
  failure: "❌", fail: "❌", missing: "❌", danger: "⚡", error: "⚡", bug: "🐛",
  example: "📑", quote: "💬", cite: "💬",
};

export function calloutIcon(type: string): string {
  return ICONS[type.toLowerCase()] ?? "🗒️";
}

// Each type's colour, as Obsidian colours them; any other type is a note.
const COLORS: Record<string, string> = {
  abstract: "cyan", summary: "cyan", tldr: "cyan", tip: "cyan", hint: "cyan", important: "cyan",
  success: "green", check: "green", done: "green",
  question: "orange", help: "orange", faq: "orange", warning: "orange", caution: "orange", attention: "orange",
  failure: "red", fail: "red", missing: "red", danger: "red", error: "red", bug: "red",
  example: "purple", quote: "gray", cite: "gray",
};

/** The colour group (`blue`, `cyan`, `green`, …) a callout type shows in. */
export function calloutColor(type: string): string {
  return COLORS[type.toLowerCase()] ?? "blue";
}
