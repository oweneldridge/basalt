// Mermaid diagram rendering for ```mermaid fenced blocks (Live Preview, Reading
// mode, export). Mermaid is heavy, so it's loaded lazily on first use and the
// rendered SVG is cached by (theme, source). securityLevel "strict" sanitizes
// the output and disables HTML labels / click handlers — the source is user
// content, so the produced SVG must be safe to inject.

import { isRemoteUrl, remoteImagesAllowed } from "./remoteImages";

type MermaidApi = {
  initialize: (cfg: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi> | null = null;
let counter = 0;
const cache = new Map<string, string>();

/** Mermaid theme tracking Basalt's appearance (read from the document root). */
export function mermaidTheme(): "dark" | "default" {
  return document.documentElement.dataset.theme === "light" ? "default" : "dark";
}

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => (m.default ?? m) as unknown as MermaidApi);
  }
  return mermaidPromise;
}

export type MermaidResult = { svg: string } | { error: string };

// Mermaid draws into the live page while laying a diagram out, so a remote
// image in it would load before the SVG could be checked. With remote images
// off, image nodes, label <img> sources and url() references that point off
// this site become a blank image first.
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
export function withoutRemoteImages(src: string): string {
  const blank = (m: string, pre: string, q: string, url: string) => (isRemoteUrl(url) ? `${pre}${q}${BLANK}${q}` : m);
  return src
    .replace(/(\bimg\s*:\s*)(["'])(.*?)\2/gi, blank)
    .replace(/(\bsrc\s*=\s*)(["'])(.*?)\2/gi, blank)
    .replace(/url\(\s*['"]?\s*(?:https?:|[\\/]{2})[^)]*\)/gi, "none");
}

/** Render Mermaid source to an SVG string (cached). Never throws. */
export async function renderMermaid(source: string): Promise<MermaidResult> {
  const trimmed = source.trim();
  if (!trimmed) return { error: "empty diagram" };
  const src = remoteImagesAllowed() ? trimmed : withoutRemoteImages(trimmed);
  const theme = mermaidTheme();
  const key = `${theme}\n${src}`;
  const hit = cache.get(key);
  if (hit) return { svg: hit };
  try {
    const mermaid = await getMermaid();
    mermaid.initialize({
      startOnLoad: false,
      theme,
      securityLevel: "strict",
      fontFamily: "inherit",
    });
    const { svg } = await mermaid.render(`basalt-mermaid-${(counter += 1)}`, src);
    cache.set(key, svg);
    return { svg };
  } catch (e) {
    return { error: (e as Error)?.message ?? String(e) };
  }
}
