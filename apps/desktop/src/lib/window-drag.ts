/**
 * Guard for the Titlebar's explicit start-dragging fallback: a mousedown
 * may begin a window drag only when it lands on inert chrome, never on an
 * interactive control (or anything opted out via `data-no-drag`).
 */
const NON_DRAG_SELECTOR = "button, input, select, textarea, a, [role='menu'], [data-no-drag]";

export function isDragSurface(target: Element | null): boolean {
  if (!target) return false;
  return target.closest(NON_DRAG_SELECTOR) === null;
}
