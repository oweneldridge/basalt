// Bases shown inside notes: `![[Tasks.base#View]]` embeds and ```base code
// blocks. Read-only. Mounted as React roots inside editor widgets and the
// reading view; loaded lazily so the YAML engine stays out of the main bundle.
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BaseView } from "../components/BaseView";
import { getBaseEmbedHost, onBaseEmbedsChanged } from "./baseEmbedHost";

export type BaseEmbedSource = { target: string } | { yaml: string };

const mounted = new Set<{ el: HTMLElement; root: Root; render: () => void }>();

/** Re-render every embed after the vault changes, and drop the ones whose
 * element left the page (the reading view replaces its HTML wholesale). */
function refreshBaseEmbeds(): void {
  for (const m of [...mounted]) {
    if (!m.el.isConnected) {
      mounted.delete(m);
      m.root.unmount();
    } else {
      m.render();
    }
  }
}

onBaseEmbedsChanged(refreshBaseEmbeds);

/** Render a base into `el`; returns a function that unmounts it. */
export function mountBaseEmbed(el: HTMLElement, source: BaseEmbedSource, thisRel: string): () => void {
  const root = createRoot(el);
  let version = 0;
  const entry = { el, root, render: () => root.render(<BaseEmbed source={source} thisRel={thisRel} version={++version} />) };
  mounted.add(entry);
  entry.render();
  return () => {
    // Unmounting synchronously inside another root's render is not allowed.
    if (mounted.delete(entry)) queueMicrotask(() => root.unmount());
  };
}

function splitView(target: string): { file: string; view?: string } {
  const i = target.indexOf("#");
  return i === -1 ? { file: target } : { file: target.slice(0, i), view: target.slice(i + 1) || undefined };
}

function BaseEmbed({ source, thisRel, version }: { source: BaseEmbedSource; thisRel: string; version: number }) {
  const h = getBaseEmbedHost();
  const target = "target" in source ? splitView(source.target) : null;
  const file = h && target ? h.resolveBase(target.file, thisRel) : null;
  const [doc, setDoc] = useState<string | null>("yaml" in source ? source.yaml : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!h || !file) return;
    let live = true;
    h.read(file.path).then(
      (text) => {
        if (!live) return;
        setDoc(text);
        setFailed(false);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [h, file?.path, version]);

  useEffect(() => {
    if ("yaml" in source) setDoc(source.yaml);
  }, [source]);

  if (!h) return null;
  if (target && !file) return <div className="embed-missing">Cannot find "{target.file}" to embed</div>;
  if (failed) return <div className="embed-error">Couldn't read {file?.name}</div>;
  if (doc === null) return <div className="embed-loading">Loading base…</div>;
  return (
    <BaseView
      doc={doc}
      sourceRel={file?.rel ?? thisRel}
      notes={h.notes()}
      attachments={h.attachments()}
      structureVersion={h.structureVersion()}
      tagsOf={h.tagsOf}
      linkKeysOf={h.linkKeysOf}
      backlinksOf={h.backlinksOf}
      embedsOf={h.embedsOf}
      onOpenFile={h.onOpenFile}
      resolveImageRel={h.resolveImageRel}
      initialView={target?.view}
      thisRel={thisRel}
    />
  );
}
