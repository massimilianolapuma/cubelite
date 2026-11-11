/**
 * Guard for the explicit start-dragging fallback of the window's drag regions
 * (the top bar, the strip over the rail on macOS): a mousedown
 * may begin a window drag only when it lands on inert chrome, never on an
 * interactive control (or anything opted out via `data-no-drag`).
 */
const NON_DRAG_SELECTOR = "button, input, select, textarea, a, [role='menu'], [data-no-drag]";

export function isDragSurface(target: Element | null): boolean {
  if (!target) return false;
  return target.closest(NON_DRAG_SELECTOR) === null;
}

/**
 * mousedown handler for a drag region. Tauri's injected data-tauri-drag-region
 * handler is unreliable with the Overlay title bar on macOS (#317), so the drag
 * is started explicitly; a double click toggles maximise.
 */
export function beginWindowDrag(event: MouseEvent): void {
  if (event.button !== 0) return;
  if (!isDragSurface(event.target as Element | null)) return;
  // Imported lazily: the Tauri window API is not there in unit tests.
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    const window = getCurrentWindow();
    if (event.detail === 2) void window.toggleMaximize();
    else void window.startDragging();
  });
}
