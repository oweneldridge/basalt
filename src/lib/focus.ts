/** When focus was left on the page (what had it is gone), give it to the
 * focused note pane's note or Reading view, else that pane's tab or empty-pane
 * message, else another note pane's; never to a side panel's. It waits a frame past the one where tab
 * bars and editors hand focus on themselves, so it only fills a gap. */
export function refocusIfLost() {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (at && at !== document.body) return;
      for (const sel of [
        ".pane.focused:not(.dock) .cm-content, .pane.focused:not(.dock) .reading-view",
        ".pane.focused:not(.dock) [role='tab'][tabindex='0'], .pane.focused:not(.dock) .pane-body > .placeholder",
        ".pane:not(.dock) .cm-content, .pane:not(.dock) .reading-view",
        ".pane:not(.dock) [role='tab'][tabindex='0'], .pane:not(.dock) .pane-body > .placeholder",
      ]) {
        const to = document.querySelector<HTMLElement>(sel);
        if (to) return to.focus({ preventScroll: true });
      }
    }),
  );
}
