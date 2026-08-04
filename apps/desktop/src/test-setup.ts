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
// core (LogBody's virtualized list) sizes its viewport from
// `offsetWidth`/`offsetHeight` (not `getBoundingClientRect`), and treats a
// 0-height scroll container as "nothing visible" — it renders zero virtual
// items. Stub a fixed non-zero size so virtualized rows actually mount.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(): number {
    return 400;
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(): number {
    return 800;
  },
});
