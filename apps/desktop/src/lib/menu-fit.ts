/**
 * Keeps a hand-rolled toolbar menu inside the window (#624).
 *
 * The menu is placed by its classes (above or below its control, on its left or
 * right edge); this only corrects that placement where it would leave the
 * window: sideways it shifts the menu back in, and a menu that opens downwards
 * gets a maximum height down to the window's bottom edge, so it scrolls inside
 * itself instead.
 */

/** Room kept between a menu and the window's edges, in px. */
export const MENU_MARGIN = 8;

export type MenuBox = { left: number; top: number; width: number };

/**
 * How far to move a menu sideways so that it stays inside a window `width`
 * wide, and, for a menu that opens downwards, the height it may take.
 * A menu wider than the window keeps its left edge in view.
 */
export function menuFit(
  box: MenuBox,
  window: { width: number; height: number },
  down: boolean,
  margin = MENU_MARGIN,
): { shift: number; maxHeight: number | null } {
  let shift = 0;
  const right = box.left + box.width;
  if (right > window.width - margin) shift = window.width - margin - right;
  if (box.left + shift < margin) shift = margin - box.left;
  const maxHeight = down ? Math.max(0, Math.floor(window.height - margin - box.top)) : null;
  return { shift, maxHeight };
}

/**
 * Svelte action for a toolbar menu: applies `menuFit` when the menu opens and
 * whenever the window changes size. The box is read from the layout (the
 * offset parent's box and the menu's offsets), not from the menu's own
 * client rect, which the pop-in animation still scales and moves.
 */
export function fitMenu(menu: HTMLElement, options: { down: boolean }) {
  let down = options.down;
  const apply = () => {
    menu.style.translate = "";
    menu.style.maxHeight = "";
    const parent = menu.offsetParent;
    if (!parent) return;
    const origin = parent.getBoundingClientRect();
    const { shift, maxHeight } = menuFit(
      { left: origin.left + menu.offsetLeft, top: origin.top + menu.offsetTop, width: menu.offsetWidth },
      { width: window.innerWidth, height: window.innerHeight },
      down,
    );
    if (shift) menu.style.translate = `${shift}px 0`;
    if (maxHeight !== null) menu.style.maxHeight = `${maxHeight}px`;
  };
  apply();
  window.addEventListener("resize", apply);
  return {
    update(next: { down: boolean }) {
      down = next.down;
      apply();
    },
    destroy() {
      window.removeEventListener("resize", apply);
    },
  };
}
