import { useEffect, useState } from "react";
import { ReadingView } from "./ReadingView";

/** Split a note into slides on `---` separator lines (Obsidian's slides),
 * dropping leading YAML frontmatter. Always yields at least one slide. */
export function splitSlides(doc: string): string[] {
  let body = doc;
  if (/^---\r?\n/.test(body)) {
    // Skip the frontmatter block (up to and including its closing `---`).
    const close = body.search(/\r?\n---[ \t]*(\r?\n|$)/);
    if (close !== -1) {
      const nl = body.indexOf("\n", close + 1);
      body = nl !== -1 ? body.slice(nl + 1) : "";
    }
  }
  const slides = body
    .split(/\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return slides.length ? slides : [body.trim()];
}

interface Props {
  doc: string;
  selfRel: string;
  dark: boolean;
  onOpenInternal: (target: string) => void;
  onOpenUrl: (url: string) => void;
  resolveImage: (target: string) => Promise<string | null>;
  onClose: () => void;
}

/** Fullscreen presentation of the active note, one `---`-separated slide at a
 * time. ←/→ (or Space) navigate, Esc exits. */
export function SlidesView({ doc, selfRel, dark, onOpenInternal, onOpenUrl, resolveImage, onClose }: Props) {
  const slides = splitSlides(doc);
  const [i, setI] = useState(0);
  const idx = Math.min(i, slides.length - 1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        setI((n) => Math.min(n + 1, slides.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        setI((n) => Math.max(n - 1, 0));
      } else if (e.key === "Home") setI(0);
      else if (e.key === "End") setI(slides.length - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slides.length, onClose]);

  return (
    <div className="slides-overlay">
      <div className="slides-bar">
        <span className="slides-count">
          {idx + 1} / {slides.length}
        </span>
        <button className="slides-close" title="Exit (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="slides-stage">
        <button className="slides-nav prev" title="Previous (←)" disabled={idx === 0} onClick={() => setI((n) => Math.max(n - 1, 0))}>
          ‹
        </button>
        <div className="slides-content">
          <ReadingView
            key={idx}
            doc={slides[idx]}
            selfRel={selfRel}
            dark={dark}
            onOpenInternal={onOpenInternal}
            onOpenUrl={onOpenUrl}
            onToggleTask={() => {}}
            resolveImage={resolveImage}
          />
        </div>
        <button
          className="slides-nav next"
          title="Next (→)"
          disabled={idx === slides.length - 1}
          onClick={() => setI((n) => Math.min(n + 1, slides.length - 1))}
        >
          ›
        </button>
      </div>
    </div>
  );
}
