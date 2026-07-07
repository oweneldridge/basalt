// Hover preview (Obsidian's page preview): hovering a wikilink shows a popup of
// the target note. Reuses the transclusion host (resolve + content + images) —
// a single delegated document listener finds `[data-target]` wikilinks and the
// nearest `[data-self-rel]` ancestor for relative-link resolution.
import { renderMarkdown } from "./render";
import { getTranscludeHost } from "./transclude";

const SHOW_DELAY = 280;
const HIDE_DELAY = 220;
const MAX_PREVIEW_CHARS = 8000;

let popup: HTMLElement | null = null;
let showTimer: number | undefined;
let hideTimer: number | undefined;
let currentAnchor: HTMLElement | null = null;
let token = 0;

function ensurePopup(): HTMLElement {
  if (popup) return popup;
  popup = document.createElement("div");
  popup.className = "hover-preview";
  popup.style.display = "none";
  popup.addEventListener("mouseenter", () => window.clearTimeout(hideTimer));
  popup.addEventListener("mouseleave", scheduleHide);
  document.body.append(popup);
  return popup;
}

function scheduleHide(): void {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hide, HIDE_DELAY);
}

function hide(): void {
  token++;
  currentAnchor = null;
  if (popup) popup.style.display = "none";
}

function position(el: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  el.style.display = "block";
  el.style.visibility = "hidden";
  const pw = el.offsetWidth;
  const ph = el.offsetHeight;
  let left = r.left;
  let top = r.bottom + 6;
  if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6); // flip above
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.visibility = "visible";
}

async function show(anchor: HTMLElement, rawTarget: string, sourceRel: string): Promise<void> {
  const host = getTranscludeHost();
  if (!host) return;
  const resolved = host.resolve(rawTarget, sourceRel);
  if (!resolved) return;
  const my = ++token;
  const content = host.content(resolved.path) ?? (await host.readContent(resolved.path).catch(() => null));
  if (content === null || my !== token || currentAnchor !== anchor) return;

  const el = ensurePopup();
  el.innerHTML = "";
  const title = document.createElement("div");
  title.className = "hover-preview-title";
  title.textContent = resolved.name;
  const body = document.createElement("div");
  body.className = "hover-preview-body reading-view";
  body.innerHTML = renderMarkdown(content.slice(0, MAX_PREVIEW_CHARS)); // escaped-safe
  el.append(title, body);

  // Resolve vault images relative to the previewed note.
  body.querySelectorAll<HTMLImageElement>("img[data-basalt-img]").forEach((img) => {
    const t = img.dataset.basaltImg ?? "";
    img.removeAttribute("data-basalt-img");
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//")) img.src = t;
    else void host.resolveImage(t, resolved.rel).then((u) => u && (img.src = u));
  });
  // Render math + sanitize raw HTML if present.
  if (body.querySelector("[data-math]")) {
    void import("./math").then((m) => my === token && m.fillMath(body));
  }
  if (body.querySelector("[data-basalt-html]")) {
    void import("./sanitize").then((m) => my === token && m.fillRawHtml(body));
  }
  position(el, anchor);
}

/** Install the global hover-preview listener (call once). */
export function installHoverPreview(): void {
  document.addEventListener("mouseover", (e) => {
    const t = e.target as HTMLElement | null;
    const link = t?.closest("[data-target]") as HTMLElement | null;
    if (!link || !link.dataset.target) return;
    if (link === currentAnchor) return;
    currentAnchor = link;
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    const rawTarget = link.dataset.target;
    const sourceRel = (link.closest("[data-self-rel]") as HTMLElement | null)?.dataset.selfRel ?? "";
    showTimer = window.setTimeout(() => {
      if (currentAnchor === link) void show(link, rawTarget, sourceRel);
    }, SHOW_DELAY);
  });
  document.addEventListener("mouseout", (e) => {
    const t = e.target as HTMLElement | null;
    const link = t?.closest("[data-target]") as HTMLElement | null;
    if (!link) return;
    window.clearTimeout(showTimer);
    if (currentAnchor === link) currentAnchor = null;
    scheduleHide();
  });
}
