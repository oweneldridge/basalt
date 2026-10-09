// Content that arrives after CodeMirror measured it (a diagram, an image, an
// embedded note, a query result) changes a line's or widget's height, and
// CodeMirror only reads heights again when it redraws content. Without that,
// every line below sits out of step with where clicks land and where the
// arrow keys go. So every line and block widget on screen is watched, and a
// real change of height flips an attribute on a line decoration at the top of
// the document: that counts as a redraw, and the measure that follows reads
// every visible line and widget again.
import { StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";

const bump = StateEffect.define<null>();

const generation = StateField.define<number>({
  create: () => 0,
  update: (n, tr) => (tr.effects.some((e) => e.is(bump)) ? n + 1 : n),
  provide: (f) =>
    EditorView.decorations.from(f, (n) =>
      Decoration.set(Decoration.line({ attributes: { "data-measure": String(n) } }).range(0)),
    ),
});

const watcher = ViewPlugin.fromClass(
  class {
    private readonly heights = new WeakMap<Element, number>();
    private readonly watched = new Set<Element>();
    private readonly observer: ResizeObserver | null;
    private scheduled = false;

    constructor(readonly view: EditorView) {
      this.observer =
        typeof ResizeObserver === "function" ? new ResizeObserver((entries) => this.resized(entries)) : null;
      this.watch();
    }

    update() {
      // After this update's DOM changes are in place.
      queueMicrotask(() => this.watch());
    }

    private watch() {
      if (!this.observer) return;
      for (const el of this.watched) {
        if (el.isConnected) continue;
        this.observer.unobserve(el);
        this.watched.delete(el);
      }
      for (const el of this.view.contentDOM.children) {
        if (this.watched.has(el)) continue;
        this.watched.add(el);
        this.observer.observe(el);
      }
    }

    private resized(entries: ResizeObserverEntry[]) {
      let changed = false;
      for (const e of entries) {
        const h = e.contentRect.height;
        const before = this.heights.get(e.target);
        this.heights.set(e.target, h);
        if (before !== undefined && Math.abs(before - h) > 0.5 && e.target.isConnected) changed = true;
      }
      if (!changed || this.scheduled) return;
      this.scheduled = true;
      requestAnimationFrame(() => {
        this.scheduled = false;
        if (this.view.dom.isConnected) this.view.dispatch({ effects: bump.of(null) });
      });
    }

    destroy() {
      this.observer?.disconnect();
    }
  },
);

export const remeasure: Extension = [generation, watcher];
