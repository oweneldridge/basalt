// KaTeX loads on first use. A formula drawn before it arrives shows its TeX
// source; once it arrives, every editor that drew one gets `mathLoaded`, and the
// math and table fields draw those widgets again with the formula in place. The
// same happens when KaTeX's fonts finish loading, which shifts each formula's
// height a little. Only a redraw makes CodeMirror measure a widget's new height:
// a formula that grows inside a widget it has already measured would leave every
// line below it out of step with where clicks land.
import { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

type MathLib = typeof import("../lib/math");

let lib: MathLib | null = null;
let loading: Promise<void> | null = null;
let generation = 0;
const drawn = new Set<EditorView>();

export const mathLoaded = StateEffect.define<null>();

/** Changes whenever formulas should be drawn again; widgets compare it in `eq`. */
export function mathGeneration(): number {
  return generation;
}

function redraw(): void {
  generation++;
  for (const v of drawn) {
    if (v.dom.isConnected) v.dispatch({ effects: mathLoaded.of(null) });
    else drawn.delete(v);
  }
}

if (typeof document !== "undefined") {
  document.fonts?.addEventListener("loadingdone", () => {
    if (lib && drawn.size) redraw();
  });
}

/** Fill `el` with rendered TeX now if KaTeX is loaded; otherwise show the
 * source and redraw `view` once it is. */
export function fillMath(el: HTMLElement, tex: string, display: boolean, view?: EditorView): void {
  if (view) drawn.add(view);
  if (lib) {
    el.innerHTML = lib.renderMath(tex, display);
    return;
  }
  el.textContent = tex;
  loading ??= import("../lib/math").then(
    (m) => {
      lib = m;
      redraw();
    },
    () => {
      loading = null; // try again on the next formula
    },
  );
}

export function hasMathLoaded(effects: readonly StateEffect<unknown>[]): boolean {
  return effects.some((e) => e.is(mathLoaded));
}
