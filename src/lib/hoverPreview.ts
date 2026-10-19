// Hover preview (Obsidian's page preview): hovering a wikilink shows a popup of
// the target note, or of the section it links to, rendered as an embed is.
// Reuses the transclusion host; a single delegated document listener finds
// `[data-target]` wikilinks and the nearest `[data-self-rel]` ancestor for
// relative-link resolution.
import { internalLinkTarget, targetPathPart } from "./markdown";
import { clickedLink } from "./anchors";
import { embedBody, getTranscludeHost, splitSubpath } from "./transclude";

const SHOW_DELAY = 280;
const HIDE_DELAY = 220;
const MAX_PREVIEW_CHARS = 8000;

let popup: HTMLElement | null = null;
let showTimer: number | undefined;
let hideTimer: number | undefined;
let currentAnchor: HTMLElement | null = null;

function ensurePopup(): HTMLElement {
  if (popup) return popup;
  popup = document.createElement("div");
  popup.className = "hover-preview";
  popup.style.display = "none";
  popup.addEventListener("mouseenter", () => window.clearTimeout(hideTimer));
  popup.addEventListener("mouseleave", scheduleHide);
  // A note link in the preview opens its note; links in the preview's rendered
  // HTML never navigate the app's own tab.
  popup.addEventListener("click", (e) => {
    const hit = hoverTarget(e.target as HTMLElement | null);
    if (hit) {
      e.preventDefault();
      getTranscludeHost()?.onOpen(hit.target);
      hide();
      return;
    }
    if (clickedLink(e.target)) e.preventDefault();
  });
  document.body.append(popup);
  return popup;
}

function scheduleHide(): void {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hide, HIDE_DELAY);
}

function hide(): void {
  window.clearTimeout(showTimer);
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

function show(anchor: HTMLElement, rawTarget: string, sourceRel: string): void {
  const host = getTranscludeHost();
  // A link that went away (it was clicked, or its note re-rendered) shows nothing.
  if (!host || !anchor.isConnected) return;
  // `[[#Heading]]` is a section of the note the link is in.
  const resolved = host.resolve(targetPathPart(rawTarget) === "" ? sourceRel : rawTarget, sourceRel);
  if (!resolved) return;
  const { subpath } = splitSubpath(rawTarget);

  const el = ensurePopup();
  const title = document.createElement("div");
  title.className = "hover-preview-title";
  title.textContent = resolved.name + (subpath ? ` › ${subpath}` : "");
  const body = embedBody(resolved, subpath, host, [], { n: 0 }, MAX_PREVIEW_CHARS);
  body.classList.add("hover-preview-body", "reading-view");
  el.replaceChildren(title, body);
  position(el, anchor);
}

/** The note target to preview for a hovered element: a wikilink's `data-target`,
 * or an INTERNAL markdown-style `.md-link` (`[text](Note#h)`). null otherwise. */
function hoverTarget(t: HTMLElement | null): { anchor: HTMLElement; target: string } | null {
  const wiki = t?.closest("[data-target]") as HTMLElement | null;
  if (wiki?.dataset.target) return { anchor: wiki, target: wiki.dataset.target };
  const md = t?.closest(".md-link") as HTMLElement | null;
  if (md?.dataset.href) {
    const internal = internalLinkTarget(md.dataset.href);
    if (internal) return { anchor: md, target: internal };
  }
  return null;
}

/** Install the global hover-preview listener (call once). */
export function installHoverPreview(): void {
  document.addEventListener("mouseover", (e) => {
    const hit = hoverTarget(e.target as HTMLElement | null);
    // Links in the preview itself open on click, not in another preview.
    if (!hit || hit.anchor === currentAnchor || popup?.contains(hit.anchor)) return;
    const link = hit.anchor;
    currentAnchor = link;
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    const sourceRel = (link.closest("[data-self-rel]") as HTMLElement | null)?.dataset.selfRel ?? "";
    showTimer = window.setTimeout(() => {
      if (currentAnchor === link) show(link, hit.target, sourceRel);
    }, SHOW_DELAY);
  });
  // A click, a key or a scroll anywhere but in the preview puts it away, as
  // following a link removes the link before the pointer can leave it.
  const away = (e: Event) => {
    if (popup && e.target instanceof Node && popup.contains(e.target)) return;
    hide();
  };
  document.addEventListener("mousedown", away, true);
  document.addEventListener("keydown", away, true);
  document.addEventListener("wheel", away, { capture: true, passive: true });
  document.addEventListener("mouseout", (e) => {
    const hit = hoverTarget(e.target as HTMLElement | null);
    if (!hit || popup?.contains(hit.anchor)) return;
    window.clearTimeout(showTimer);
    if (currentAnchor === hit.anchor) currentAnchor = null;
    scheduleHide();
  });
}
