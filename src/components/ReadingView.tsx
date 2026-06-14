import { useEffect, useRef } from "react";
import { renderMarkdown } from "../lib/render";
import { internalMdHref } from "../lib/markdown";

interface Props {
  doc: string;
  /** Open a wikilink / internal target (bare note name or path). */
  onOpenInternal: (target: string) => void;
  onOpenUrl: (url: string) => void;
  /** Resolve a vault image reference to a displayable URL. */
  resolveImage: (target: string) => Promise<string | null>;
}

/** Reading mode: a fully-rendered, read-only HTML view of the note (the CM6
 * editor is virtualized, so it can't show or print the whole document). The
 * rendered HTML is built by the pure, escaped renderer in lib/render.ts; here
 * we resolve vault images and delegate link clicks to the app. */
export function ReadingView({ doc, onOpenInternal, onOpenUrl, resolveImage }: Props) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // Safe: renderMarkdown escapes all user text and emits only known tags.
    el.innerHTML = renderMarkdown(doc);
    el.scrollTop = 0;

    // Resolve vault images asynchronously (external http(s) src pass through).
    let cancelled = false;
    el.querySelectorAll<HTMLImageElement>("img[data-basalt-img]").forEach((img) => {
      const target = img.dataset.basaltImg ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
        img.src = target; // already a URL
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
    };
  }, [doc, resolveImage]);

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
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
    }
  };

  return <div className="reading-view" ref={host} onClick={onClick} />;
}
