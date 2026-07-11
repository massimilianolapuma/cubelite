/**
 * Vitest global setup: fill jsdom gaps that bits-ui internals rely on.
 */

// jsdom does not implement scrollIntoView (used by Command to keep the
// selected item visible).
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom has no ResizeObserver (used by Command.Viewport).
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub;
}
