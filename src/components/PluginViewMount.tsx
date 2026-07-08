import { useEffect, useRef } from "react";
import type { PluginView } from "../lib/plugins";

/** Mounts a plugin's custom view into a container (running its cleanup on
 * hide/unmount). Shared by the right panel and by view leaves. */
export function PluginViewMount({ view }: { view: PluginView }) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const cleanup = view.mount(el);
    return () => {
      if (typeof cleanup === "function") cleanup();
      el.replaceChildren();
    };
  }, [view]);
  return <div className="plugin-view-mount" ref={host} />;
}
