// HTML sanitization for raw HTML embedded in notes. DOMPurify needs a DOM, so
// this module is browser-only and LAZY-loaded by the reading view / export
// (render.ts only emits placeholders and stays node-testable).
import DOMPurify, { type Config } from "dompurify";

// Belt-and-braces on top of DOMPurify's safe defaults: never allow scripts,
// event handlers, or javascript: URLs; keep target=_blank links safe.
const CONFIG: Config = {
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "base"],
  FORBID_ATTR: ["style"],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["target"],
  RETURN_TRUSTED_TYPE: false,
};

let hooked = false;
function ensureHook(): void {
  if (hooked) return;
  hooked = true;
  // Any link that opens a new tab gets rel=noopener (no reverse-tabnabbing).
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.getAttribute("target") === "_blank") {
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

/** Sanitize an untrusted HTML string to a safe HTML string. */
export function sanitizeHtml(dirty: string): string {
  ensureHook();
  return DOMPurify.sanitize(dirty, CONFIG) as unknown as string;
}

/** Fill every `[data-basalt-html]` placeholder under `root` with the sanitized
 * raw HTML it carries (the placeholder text is the source HTML). */
export function fillRawHtml(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("[data-basalt-html]").forEach((el) => {
    const raw = el.getAttribute("data-basalt-html") ?? "";
    el.removeAttribute("data-basalt-html");
    el.innerHTML = sanitizeHtml(raw);
  });
}
