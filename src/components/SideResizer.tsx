import { useRef } from "react";

/** A vertical drag handle between the sidebar and the editor area. Reports the
 * horizontal drag delta in px; the app adjusts the adjacent sidebar's width. */
export function SideResizer({ onDelta }: { onDelta: (dx: number) => void }) {
  const last = useRef(0);
  return (
    <div
      className="side-resizer"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        last.current = e.clientX;
      }}
      onPointerMove={(e) => {
        if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
        onDelta(e.clientX - last.current);
        last.current = e.clientX;
      }}
    />
  );
}
