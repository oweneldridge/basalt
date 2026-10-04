import { useEffect, useRef } from "react";
import { renderMarkdown } from "../lib/render";
import { renderMermaid } from "../lib/mermaid";
import { renderQuerySource } from "../lib/queryHost";
import { codeBlockProcessor } from "../lib/plugins";
import { renderEmbedSource } from "../lib/transclude";
import { internalMdHref } from "../lib/markdown";
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
}

/** Reading mode: a fully-rendered, read-only HTML view of the note (the CM6
 * editor is virtualized, so it can't show or print the whole document). The
 * rendered HTML is built by the pure, escaped renderer in lib/render.ts; here
 * we resolve vault images and delegate link clicks to the app. */
export function ReadingView({ doc, selfRel, onOpenInternal, onOpenUrl, resolveImage, onToggleTask, dark }: Props) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // Safe: renderMarkdown escapes all user text and emits only known tags.
    el.innerHTML = renderMarkdown(doc);
    el.scrollTop = 0;
    // Note links are anchors without an href (the click handler routes them),
    // so make them reachable and announced as links.
    el.querySelectorAll<HTMLElement>("a.md-wikilink, a.md-link").forEach((a) => {
      a.tabIndex = 0;
      a.setAttribute("role", "link");
    });

    let cancelled = false;

    // Render ```dataview / ```query blocks, replacing their <pre> with the result.
    el.querySelectorAll<HTMLElement>(
      "pre.md-code > code.language-dataview, pre.md-code > code.language-basalt-query, pre.md-code > code.language-query",
    ).forEach((code) => {
      const pre = code.parentElement;
      if (!pre) return;
      pre.replaceWith(renderQuerySource(code.textContent ?? "", selfRel));
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
          pre.replaceWith(box);
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
        if (!cancelled && el.isConnected) mod.fillMedia(el, resolveImage);
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
        pre.replaceWith(box);
      } catch (e) {
        box.className = "md-plugin-block md-plugin-block-error";
        box.textContent = `Plugin block error: ${e instanceof Error ? e.message : e}`;
        pre.replaceWith(box);
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
        pre.replaceWith(box);
      });
    });

    // Resolve vault images asynchronously (external http(s) src pass through).
    el.querySelectorAll<HTMLImageElement>("img[data-basalt-img]").forEach((img) => {
      const target = img.dataset.basaltImg ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
        if (isRemoteUrl(target) && !remoteImagesAllowed()) img.replaceWith(blockedImage(target, img.alt));
        else img.src = target; // already a URL
        return;
      }
      void resolveImage(target).then((url) => {
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
  }, [doc, selfRel, resolveImage, dark]);

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
      // A relative `.md` href is an internal note (decoded for resolution);
      // everything else is external.
      const internal = internalMdHref(href);
      if (internal) onOpenInternal(internal.path + internal.fragment);
      else onOpenUrl(href);
      return;
    }
    // A link inside raw HTML: open it like any external link instead of
    // navigating the app window away.
    const anchor = target.closest<HTMLAnchorElement>("a[href]");
    if (anchor) {
      e.preventDefault();
      onOpenUrl(anchor.getAttribute("href") ?? "");
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.target as HTMLElement).matches(".md-wikilink, .md-link")) onClick(e);
  };

  return <div className="reading-view" data-self-rel={selfRel} ref={host} onClick={onClick} onKeyDown={onKeyDown} />;
}
