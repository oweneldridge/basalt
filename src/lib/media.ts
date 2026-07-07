// Media embeds: `![[file.mp3]]` → an audio player; video → <video>; pdf →
// <embed>. Kind detection is pure (tested); buildMediaElement builds the DOM
// once a consumer has resolved the target to a URL (via resolveImage, whose
// Rust side serves any vault file as a data URL with the right MIME).

export type MediaKind = "audio" | "video" | "pdf";

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|flac)$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;
const PDF_EXT = /\.pdf$/i;

/** Media kind for an embed target (path part only — strip #subpath first). */
export function mediaKind(pathPart: string): MediaKind | null {
  if (AUDIO_EXT.test(pathPart)) return "audio";
  if (VIDEO_EXT.test(pathPart)) return "video";
  if (PDF_EXT.test(pathPart)) return "pdf";
  return null;
}

/** Build the player element for a resolved media URL. */
export function buildMediaElement(kind: MediaKind, url: string): HTMLElement {
  if (kind === "audio") {
    const el = document.createElement("audio");
    el.controls = true;
    el.preload = "metadata";
    el.src = url;
    el.className = "md-media md-media-audio";
    return el;
  }
  if (kind === "video") {
    const el = document.createElement("video");
    el.controls = true;
    el.preload = "metadata";
    el.src = url;
    el.className = "md-media md-media-video";
    return el;
  }
  const el = document.createElement("embed");
  el.type = "application/pdf";
  el.src = url;
  el.className = "md-media md-media-pdf";
  return el;
}

/** Replace every `[data-basalt-media]` marker under `root` with a player,
 * resolving each target through `resolve` (relative to the note). */
export function fillMedia(
  root: HTMLElement,
  resolve: (target: string) => Promise<string | null>,
): void {
  root.querySelectorAll<HTMLElement>("[data-basalt-media]").forEach((marker) => {
    const target = marker.dataset.basaltMedia ?? "";
    marker.removeAttribute("data-basalt-media");
    const kind = mediaKind(target.split("#")[0]);
    if (!kind) return;
    void resolve(target).then((url) => {
      if (!marker.isConnected) return;
      if (!url) {
        marker.textContent = `🎬 ${target} (not found)`;
        marker.className = "md-media-missing";
        return;
      }
      marker.replaceWith(buildMediaElement(kind, url));
    });
  });
}
