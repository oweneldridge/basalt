// KaTeX math rendering. This module statically imports KaTeX (+ its CSS), so
// it is itself LAZY-loaded by consumers (reading view, editor widgets, export)
// via dynamic import — KaTeX stays out of the initial bundle until a note with
// math is actually shown. render.ts only emits placeholders (data-math).
import katex from "katex";
import "katex/dist/katex.min.css";

// Cache rendered output — the same formula recurs across re-renders / a doc.
const cache = new Map<string, string>();
const MAX_CACHE = 500;

/** Render TeX to a string. Never throws — a malformed formula renders as an
 * inline error (like Obsidian), so one bad formula can't blank a note. The app
 * uses KaTeX "html" (its CSS + fonts are loaded); export uses "mathml" so the
 * file is self-contained (browsers render MathML with their own math fonts, no
 * KaTeX CSS/fonts to inline). */
export function renderMath(tex: string, display: boolean, output: "html" | "mathml" = "html"): string {
  const key = (output === "mathml" ? "m" : "") + (display ? "d:" : "i:") + tex;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      output,
      strict: false,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const span = document.createElement("span");
    span.className = "math-error";
    span.textContent = `⚠ ${msg}`;
    html = span.outerHTML;
  }
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, html);
  return html;
}

/** Fill every `[data-math]` placeholder under `root` with rendered KaTeX. The
 * placeholder's text is the (HTML-unescaped by the DOM) TeX source. Pass
 * `mathml` for a self-contained export (no KaTeX CSS/fonts needed). */
export function fillMath(root: HTMLElement, mathml = false): void {
  root.querySelectorAll<HTMLElement>("[data-math]").forEach((el) => {
    if (el.dataset.mathDone) return;
    const tex = el.getAttribute("data-tex") ?? "";
    el.innerHTML = renderMath(tex, el.dataset.math === "block", mathml ? "mathml" : "html");
    el.dataset.mathDone = "1";
  });
}
