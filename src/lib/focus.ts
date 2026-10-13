const NOTE = ".cm-content, .reading-view[role='region']";
const TAB = "[role='tab'][tabindex='0'], .pane-body > .placeholder";

/** Focus the first of `sels`' matches that takes it. */
function focusFirst(sels: string[]): boolean {
  for (const sel of sels) {
    for (const to of document.querySelectorAll<HTMLElement>(sel)) {
      to.focus({ preventScroll: true });
      if (document.activeElement === to) return true;
    }
  }
  return false;
}

const inPanes = (scope: string, sel: string) =>
  sel
    .split(", ")
    .map((s) => `${scope} ${s}`)
    .join(", ");

/** When focus was left on the page (what had it is gone), give it to the
 * focused note pane's note or Reading view, else that pane's tab or empty-pane
 * message, else another note pane's; never to a side panel's. It waits a frame past the one where tab
 * bars and editors hand focus on themselves, so it only fills a gap. */
export function refocusIfLost() {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (at && at !== document.body) return;
      focusFirst([
        inPanes(".pane.focused:not(.dock)", NOTE),
        inPanes(".pane.focused:not(.dock)", TAB),
        inPanes(".pane:not(.dock)", NOTE),
        inPanes(".pane:not(.dock)", TAB),
      ]);
    }),
  );
}

/** Put focus in a note pane's note or Reading view once it's shown. */
export function focusNote(paneId: string | null) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!paneId || !focusFirst([inPanes(`.pane[data-pane="${CSS.escape(paneId)}"]`, NOTE)])) refocusIfLost();
    }),
  );
}
