// Links inside a note's rendered HTML, SVG drawings included. A click on one
// must never navigate the app's own tab: it opens like any other link.

const XLINK = "http://www.w3.org/1999/xlink";

/** The link a click landed in, HTML `<a href>` or SVG `<a xlink:href>`, with
 * its target ("" when it has none). Null when the click wasn't on a link. */
export function clickedLink(target: EventTarget | null): { href: string } | null {
  const el = target instanceof Element ? target.closest("a") : null;
  if (!el) return null;
  return { href: el.getAttribute("href") ?? el.getAttributeNS(XLINK, "href") ?? "" };
}
