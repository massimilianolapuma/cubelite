/**
 * Vitest global setup: fill jsdom gaps that bits-ui internals rely on.
 * Runs only under the jsdom test environment.
 */

// jsdom does not implement scrollIntoView (used by Command to keep the
// selected item visible).
Element.prototype.scrollIntoView ??= () => {
  // no-op: layout does not exist in jsdom
};

// jsdom has no ResizeObserver (used by Command.Viewport).
class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    // no-op: layout does not exist in jsdom
  }
  unobserve(): void {
    // no-op: layout does not exist in jsdom
  }
  disconnect(): void {
    // no-op: layout does not exist in jsdom
  }
}
globalThis.ResizeObserver ??= ResizeObserverStub;

// jsdom performs no layout, so every element reports 0x0. @tanstack/virtual-
// core (LogBody's virtualized list) sizes its viewport from the element's
// own size properties (not `getBoundingClientRect`): `offsetWidth`/
// `offsetHeight` up to 3.19.5, `clientWidth`/`clientHeight` from 3.19.7. It
// treats a 0-height scroll container as "nothing visible" and renders zero
// virtual items. Stub a fixed non-zero size on both pairs so virtualized
// rows actually mount whichever one the installed version reads.
for (const [prop, value] of [
  ["offsetHeight", 400],
  ["clientHeight", 400],
  ["offsetWidth", 800],
  ["clientWidth", 800],
] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(): number {
      return value;
    },
  });
}
