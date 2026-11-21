/**
 * Where the focus goes back after a dialog opened from where it is now: the
 * focused element, or, for an item of a menu, the button that opened the menu
 * (through a submenu, the outermost one): the item goes with its menu. Null
 * when nothing has the focus.
 *
 * Call it while the menu is still open (in the item's select handler): a
 * closed bits-ui menu no longer names its trigger (`aria-controls`).
 */
export function focusOrigin(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  let at = active;
  for (;;) {
    const menu = at.closest<HTMLElement>('[role="menu"]');
    if (!menu?.id) return at;
    const trigger = document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`);
    if (trigger === null) return at;
    at = trigger;
  }
}
