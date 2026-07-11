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
