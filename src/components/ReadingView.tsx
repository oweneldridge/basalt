import { useEffect, useRef } from "react";
import { renderMarkdown } from "../lib/render";
import { renderMermaid } from "../lib/mermaid";
import { renderQuerySource } from "../lib/queryHost";
import { codeBlockProcessor } from "../lib/plugins";
import { linkResolves, renderEmbedSource } from "../lib/transclude";
import { internalLinkTarget } from "../lib/markdown";
import { clickedLink } from "../lib/anchors";
import { blockedImage, inertFragment, isRemoteUrl, remoteImagesAllowed } from "../lib/remoteImages";

interface Props {
  doc: string;
  /** Vault-relative path (with .md) of this note — the self note for query blocks. */
  selfRel: string;
  /** Open a wikilink / internal target (bare note name or path). */
  onOpenInternal: (target: string) => void;
  onOpenUrl: (url: string) => void;
  /** Resolve a vault image reference to a displayable URL. */
  resolveImage: (target: string) => Promise<string | null>;
  /** Toggle the task checkbox on the given 0-based source line (interactive
   * checkboxes in reading mode, like Obsidian). */
  onToggleTask: (line: number) => void;
  /** Re-render (e.g. mermaid theme) when the appearance flips. */
  dark: boolean;
  /** 1-based source line to scroll to (a heading or block link). */
  scrollToLine?: number;
  /** Changes when the same line is asked for again. */
  scrollRev?: number;
}

/** The last rendered block starting at or before 0-based source `line`. */
function blockAt(el: HTMLElement, line: number): HTMLElement | null {
  let hit: HTMLElement | null = null;
  el.querySelectorAll<HTMLElement>("[data-line]").forEach((b) => {
    if (Number(b.dataset.line) <= line) hit = b;
  });
  return hit;
}

/** Scroll the view so `target` sits at its top. */
function scrollTo(el: HTMLElement, target: Element) {
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
}

/** Swap a rendered block for what it renders to, keeping its source line. */
function swap(old: HTMLElement, box: HTMLElement) {
  if (old.dataset.line !== undefined) box.dataset.line = old.dataset.line;
  old.replaceWith(box);
}

/** Reading mode: a fully-rendered, read-only HTML view of the note (the CM6
 * editor is virtualized, so it can't show or print the whole document). The
 * rendered HTML is built by the pure, escaped renderer in lib/render.ts; here
 * we resolve vault images and delegate link clicks to the app. */
export function ReadingView({
  doc,
  selfRel,
  onOpenInternal,
  onOpenUrl,
  resolveImage,
  onToggleTask,
  dark,
  scrollToLine,
  scrollRev,
}: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  // The app passes a new resolver on every render; rendering again for each
  // would reset the note (and any selection in it) whenever anything changes.
  const resolver = useRef(resolveImage);
  resolver.current = resolveImage;
  // The note last shown: the same note re-rendering (a ticked task, an outside
  // edit) keeps its scroll position; another note starts at the top.
  const shownRel = useRef<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // Safe: renderMarkdown escapes all user text and emits only known tags.
    const keep = shownRel.current === selfRel ? el.scrollTop : 0;
    el.innerHTML = renderMarkdown(doc, { lines: true });
    el.scrollTop = keep;
    shownRel.current = selfRel;
    // Note links are anchors without an href (the click handler routes them),
    // so make them reachable and announced as links. A link to a file that
    // isn't in the vault shows faded, as in Obsidian.
    el.querySelectorAll<HTMLElement>("a.md-wikilink, a.md-link").forEach((a) => {
      a.tabIndex = 0;
      a.setAttribute("role", "link");
      const target = a.classList.contains("md-wikilink") ? a.dataset.target : internalLinkTarget(a.dataset.href ?? "");
      if (target && !linkResolves(target, selfRel)) a.classList.add("is-unresolved");
    });

    let cancelled = false;

    // Render ```dataview / ```query blocks, replacing their <pre> with the result.
    el.querySelectorAll<HTMLElement>(
      "pre.md-code > code.language-dataview, pre.md-code > code.language-basalt-query, pre.md-code > code.language-query",
    ).forEach((code) => {
      const pre = code.parentElement;
      if (!pre) return;
      swap(pre, renderQuerySource(code.textContent ?? "", selfRel));
    });

    // ```base blocks render their table (read-only); `this` is this note.
    const unmounts: (() => void)[] = [];
    const baseBlocks = [...el.querySelectorAll<HTMLElement>("pre.md-code > code.language-base")];
    if (baseBlocks.length) {
      void import("../lib/baseEmbed").then((m) => {
        if (cancelled) return;
        for (const code of baseBlocks) {
          const pre = code.parentElement;
          if (!pre) continue;
          const box = document.createElement("div");
          box.className = "base-block";
          swap(pre, box);
          unmounts.push(m.mountBaseEmbed(box, { yaml: code.textContent ?? "" }, selfRel));
        }
      });
    }

    // Transclude ![[Note]] / ![[Note#Heading]] / ![[Note#^block]] embeds inline.
    el.querySelectorAll<HTMLElement>("span.md-embed-ref[data-basalt-embed]").forEach((marker) => {
      const target = marker.dataset.basaltEmbed ?? "";
      marker.replaceWith(renderEmbedSource(target, selfRel));
    });

    // Render $…$ / $$…$$ math (lazy-load KaTeX only when a note actually has it).
    if (el.querySelector("[data-math]")) {
      void import("../lib/math").then((mod) => {
        if (!cancelled && el.isConnected) mod.fillMath(el);
      });
    }

    // Sanitize + insert any raw HTML blocks (lazy-load DOMPurify on demand).
    if (el.querySelector("[data-basalt-html]")) {
      void import("../lib/sanitize").then((mod) => {
        if (!cancelled && el.isConnected) mod.fillRawHtml(el);
      });
    }

    // Audio / video / PDF embeds → players (resolved like images).
    if (el.querySelector("[data-basalt-media]")) {
      void import("../lib/media").then((mod) => {
        if (!cancelled && el.isConnected) mod.fillMedia(el, (t) => resolver.current(t));
      });
    }

    // Render fenced blocks a PLUGIN registered a processor for.
    el.querySelectorAll<HTMLElement>("pre.md-code > code[class^='language-']").forEach((code) => {
      const lang = (code.className.match(/language-([\w-]+)/)?.[1] ?? "").toLowerCase();
      const fn = lang ? codeBlockProcessor(lang) : null;
      if (!fn) return;
      const pre = code.parentElement;
      if (!pre) return;
      const box = document.createElement("div");
      box.className = "md-plugin-block";
      try {
        fn(code.textContent ?? "", box, { notePath: selfRel });
        swap(pre, box);
      } catch (e) {
        box.className = "md-plugin-block md-plugin-block-error";
        box.textContent = `Plugin block error: ${e instanceof Error ? e.message : e}`;
        swap(pre, box);
      }
    });

    // Render ```mermaid blocks to SVG, replacing their <pre> with the diagram.
    el.querySelectorAll<HTMLElement>("pre.md-code > code.language-mermaid").forEach((code) => {
      const source = code.textContent ?? "";
      const pre = code.parentElement;
      if (!pre) return;
      void renderMermaid(source).then((r) => {
        if (cancelled || !pre.isConnected) return;
        const box = document.createElement("div");
        if ("svg" in r) {
          box.className = "md-mermaid";
          box.replaceChildren(inertFragment(r.svg)); // sanitized by mermaid (securityLevel: strict)
        } else {
          box.className = "md-mermaid md-mermaid-error";
          box.textContent = `Mermaid error: ${r.error}`;
        }
        swap(pre, box);
      });
    });

    // Colour code blocks as Live Preview does (each language loads on demand).
    if (el.querySelector("pre.md-code > code[class^='language-']")) {
      void import("../lib/codeHighlight").then((m) => m.highlightCodeBlocks(el, () => !cancelled));
    }

    // Resolve vault images asynchronously (external http(s) src pass through).
    el.querySelectorAll<HTMLImageElement>("img[data-basalt-img]").forEach((img) => {
      const target = img.dataset.basaltImg ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
        if (isRemoteUrl(target) && !remoteImagesAllowed()) img.replaceWith(blockedImage(target, img.alt));
        else img.src = target; // already a URL
        return;
      }
      void resolver.current(target).then((url) => {
        if (cancelled) return;
        if (url) img.src = url;
        else {
          img.replaceWith(
            Object.assign(document.createElement("span"), {
              className: "md-image-missing",
              textContent: `🖼 ${target}`,
            }),
          );
        }
      });
    });
    return () => {
      cancelled = true;
      unmounts.forEach((u) => u());
    };
  }, [doc, selfRel, dark]);

  // Scroll to a linked heading or block, holding it in place while images,
  // diagrams and embeds above it load, until the reader scrolls.
  useEffect(() => {
    const el = host.current;
    if (!el || !scrollToLine) return;
    const line = scrollToLine - 1;
    let at = -1;
    const align = () => {
      const b = blockAt(el, line);
      if (b) scrollTo(el, b);
      at = el.scrollTop;
    };
    align();
    const follow = () => {
      if (Math.abs(el.scrollTop - at) < 2) align();
    };
    const observer = new MutationObserver(follow);
    observer.observe(el, { childList: true, subtree: true });
    el.addEventListener("load", follow, true);
    const stop = () => {
      observer.disconnect();
      el.removeEventListener("load", follow, true);
      for (const t of ["wheel", "touchstart", "keydown", "pointerdown"]) el.removeEventListener(t, stop);
      window.clearTimeout(timer);
    };
    for (const t of ["wheel", "touchstart", "keydown", "pointerdown"]) el.addEventListener(t, stop);
    const timer = window.setTimeout(stop, 3000);
    return stop;
  }, [scrollToLine, scrollRev, selfRel]);

  const onClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    // Interactive task checkbox: toggle the source line (Obsidian behavior).
    if (target instanceof HTMLInputElement && target.classList.contains("md-task-check")) {
      const line = Number(target.dataset.taskLine);
      if (Number.isInteger(line)) {
        e.preventDefault();
        onToggleTask(line);
      }
      return;
    }
    const wiki = target.closest<HTMLElement>(".md-wikilink");
    if (wiki) {
      e.preventDefault();
      onOpenInternal(wiki.dataset.target ?? "");
      return;
    }
    const link = target.closest<HTMLElement>(".md-link");
    if (link) {
      e.preventDefault();
      const href = link.dataset.href ?? "";
      // An href that isn't a URL is a vault file or a heading, as in Obsidian.
      const internal = internalLinkTarget(href);
      if (internal !== null) onOpenInternal(internal);
      else onOpenUrl(href);
      return;
    }
    // A link inside raw HTML or an SVG drawing, or a footnote's: open it like
    // any other link instead of navigating the app window away. A `#id` that's
    // on the page (a footnote and its way back) scrolls to it.
    const raw = clickedLink(target);
    if (raw) {
      e.preventDefault();
      const id = raw.href.startsWith("#") ? raw.href.slice(1) : "";
      const dest = id && host.current?.querySelector(`#${CSS.escape(id)}`);
      if (dest && host.current) {
        scrollTo(host.current, dest);
        return;
      }
      const internal = internalLinkTarget(raw.href);
      if (internal !== null) onOpenInternal(internal);
      else if (raw.href) onOpenUrl(raw.href);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.target as HTMLElement).matches(".md-wikilink, .md-link")) onClick(e);
  };

  return <div className="reading-view" data-self-rel={selfRel} ref={host} onClick={onClick} onKeyDown={onKeyDown} />;
}
