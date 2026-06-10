// Resolve an image reference to a displayable URL. Remote/data URLs pass
// through; local vault paths are read (once) via the Rust read_image command and
// cached as base64 data URLs so re-renders don't re-read the file.
//
// Misses are cached only briefly (so an image referenced before it exists, or a
// transient read error, recovers), the cache is size-bounded, and it's cleared
// on vault switch.
import { invoke } from "@tauri-apps/api/core";

interface Entry {
  url: string | null;
  at: number;
}

const cache = new Map<string, Entry>();
const NEG_TTL_MS = 4000;
const MAX_ENTRIES = 256;

export function clearImageCache(): void {
  cache.clear();
}

export async function resolveImage(
  vault: string,
  target: string,
  sourceRel: string,
): Promise<string | null> {
  if (/^(https?:|data:)/i.test(target)) return target;
  const key = `${vault} ${sourceRel} ${target}`;
  const hit = cache.get(key);
  if (hit) {
    if (hit.url !== null) return hit.url;
    if (Date.now() - hit.at < NEG_TTL_MS) return null;
    cache.delete(key); // stale miss — re-attempt
  }
  try {
    const url = await invoke<string>("read_image", { vault, target, sourceRel });
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { url, at: Date.now() });
    return url;
  } catch {
    cache.set(key, { url: null, at: Date.now() });
    return null;
  }
}
