/**
 * Where the detail panel goes (Tonal spec §5, §8.3): beside the list when
 * the content column is wide enough for both, over the list otherwise. The
 * shell measures the content column, so the rule follows the sidebar and the
 * rail, not the window.
 */

/** Content width from which the panel docks: 628 px of list, 12 px, 360 px of panel. */
export const DOCK_MIN_WIDTH = 1000;

class LayoutStore {
  /** Width of the content column in px; 0 until the shell has measured it. */
  contentWidth = $state(0);

  /** The detail panel sits beside the list instead of over it. */
  get docked(): boolean {
    return this.contentWidth >= DOCK_MIN_WIDTH;
  }
}

export const layout = new LayoutStore();
