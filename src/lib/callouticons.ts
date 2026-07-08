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
