import { useEffect, useRef, type ReactNode } from "react";

/** A right-click menu that works from the keyboard too: focus moves to the
 * first item, arrows/Home/End move between items, Escape or Tab closes, and
 * focus goes back to whatever opened it. Children are `.ctx-item` buttons. */
export function ContextMenu({
  x,
  y,
  label,
  onClose,
  children,
}: {
  x: number;
  y: number;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menu.querySelectorAll(".ctx-item").forEach((b) => b.setAttribute("role", "menuitem"));
    menu.querySelector<HTMLElement>(".ctx-item:not(:disabled)")?.focus();
    return () => opener?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(".ctx-item:not(:disabled)") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div className="ctx-overlay" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        className="ctx-menu"
        role="menu"
        aria-label={label}
        style={{ left: x, top: y }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}

/** Shift+F10 or the ContextMenu key on a focused element opens its menu just
 * below it (a keyboard contextmenu event has no useful pointer position). */
export function menuKeyOpens(e: React.KeyboardEvent): { x: number; y: number } | null {
  if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return null;
  e.preventDefault();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: r.left + 8, y: r.bottom };
}
