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

/** An http(s) or protocol-relative URL. `https:host/x.png` counts too: the
 * browser reads it as `https://host/x.png`. */
export function isRemoteUrl(src: string): boolean {
  return /^(https?:|\/\/)/i.test(src.trim());
}

const remoteInSet = (set: string) => set.split(",").some((c) => isRemoteUrl(c.trim()));
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

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

/** With remote images off, swap each remote `<img>` under `root` for a
 * placeholder and drop every other attribute that would fetch an image or
 * media file from the web: srcset, poster, background, an <input type=image>
 * or <video> src, and the href of an SVG <image>, <use> or <feImage>. Links
 * are left alone. Run it on inert content (a template), before insertion. */
export function blockRemoteImages(root: ParentNode): void {
  if (allowed) return;
  root.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const set = img.getAttribute("srcset") ?? "";
    if (isRemoteUrl(src) || remoteInSet(set)) img.replaceWith(blockedImage(src || set, img.alt));
  });
  root.querySelectorAll<Element>("*").forEach((el) => {
    for (const attr of ["src", "poster", "background", "data"]) {
      const v = el.getAttribute(attr);
      if (v !== null && isRemoteUrl(v)) el.removeAttribute(attr);
    }
    const set = el.getAttribute("srcset");
    if (set !== null && remoteInSet(set)) el.removeAttribute("srcset");
    if (el.namespaceURI === SVG_NS && /^(image|use|feimage)$/i.test(el.localName)) {
      const href = el.getAttribute("href");
      if (href !== null && isRemoteUrl(href)) el.removeAttribute("href");
      const xhref = el.getAttributeNS(XLINK_NS, "href");
      if (xhref !== null && isRemoteUrl(xhref)) el.removeAttributeNS(XLINK_NS, "href");
    }
  });
}
