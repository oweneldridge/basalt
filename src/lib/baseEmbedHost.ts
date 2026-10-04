// The app-side half of embedded bases: App installs the host and signals vault
// changes here without loading the renderer (baseEmbed.tsx), which pulls in the
// YAML engine and is only fetched once a note actually embeds a base.
import type { Attachment, VaultNote } from "./vault";

export interface BaseEmbedHost {
  notes: () => VaultNote[];
  attachments: () => Attachment[];
  structureVersion: () => number;
  tagsOf: (path: string) => string[];
  linkKeysOf: (path: string) => string[];
  backlinksOf: (path: string) => string[];
  embedsOf: (path: string) => string[];
  onOpenFile: (rel: string) => void;
  resolveImageRel: (target: string, rel: string) => Promise<string | null>;
  /** The .base file a link points to from the note at `fromRel`. */
  resolveBase: (target: string, fromRel: string) => Attachment | null;
  read: (path: string) => Promise<string>;
}

let host: BaseEmbedHost | null = null;
const listeners = new Set<() => void>();

export function setBaseEmbedHost(h: BaseEmbedHost | null): void {
  host = h;
  notifyBaseEmbeds();
}

export function getBaseEmbedHost(): BaseEmbedHost | null {
  return host;
}

/** Call after the vault changes so mounted embeds re-render. */
export function notifyBaseEmbeds(): void {
  listeners.forEach((l) => l());
}

export function onBaseEmbedsChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
