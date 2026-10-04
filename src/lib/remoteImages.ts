// Whether images from the web load in notes. Off means opening a note never
// contacts another server for an image; the image shows as a labelled
// placeholder instead. Local and data: images are unaffected.

let allowed = true;

export function setRemoteImages(on: boolean): void {
  allowed = on;
}

export function remoteImagesAllowed(): boolean {
  return allowed;
}

/** An http(s) or protocol-relative URL. */
export function isRemoteUrl(src: string): boolean {
  return /^(https?:)?\/\//i.test(src.trim());
}

/** The placeholder shown in place of a remote image while they're off. */
export function blockedImage(src: string, alt = ""): HTMLElement {
  const el = document.createElement("span");
  el.className = "md-image-blocked";
  let host = src;
  try {
    host = new URL(src, "https://x.invalid").host;
  } catch {
    /* keep the raw text */
  }
  el.textContent = `🖼 Remote image off${alt ? `: ${alt}` : ""} (${host})`;
  el.title = src;
  return el;
}

/** Swap every remote `<img>` under `root` for a placeholder, if they're off. */
export function blockRemoteImages(root: ParentNode): void {
  if (allowed) return;
  root.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const set = img.getAttribute("srcset") ?? "";
    if (isRemoteUrl(src) || /(^|,)\s*(https?:)?\/\//i.test(set)) img.replaceWith(blockedImage(src || set, img.alt));
  });
}
