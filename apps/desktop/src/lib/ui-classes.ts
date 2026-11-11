/**
 * Class strings shared by controls that are not components of their own
 * (bits-ui parts, native inputs). Tonal design system, spec §7.
 */

/** Dropdown and context menu panel. */
export const MENU_CONTENT =
  "animate-popin z-50 rounded-lg bg-surface-overlay p-1.5 shadow-overlay";

/** One row of a menu; `data-highlighted` is bits-ui's keyboard/hover state. */
export const MENU_ITEM =
  "flex cursor-default items-center gap-3 rounded-md px-3 py-2 type-body text-text-muted data-highlighted:bg-surface-container-high data-highlighted:text-text";

/** Text input inside a form: outlined, so it reads as a field on any surface. */
export const FIELD =
  "focus-ring h-(--control-h-compact) w-full rounded-md border border-outline-strong bg-transparent px-3 type-body-sm text-text placeholder:text-text-subtle";

/** Search or filter field in a toolbar: a filled pill. */
export const SEARCH_FIELD =
  "focus-ring h-(--control-inline-h) rounded-full bg-surface-container-high px-3.5 type-body-sm text-text placeholder:text-text-subtle";

/** Round icon toggle (pin, group by namespace): filled with the tonal colour when pressed. */
export function iconToggle(pressed: boolean): string {
  return `focus-ring flex h-(--control-inline-h) w-(--control-inline-h) shrink-0 items-center justify-center rounded-full disabled:opacity-45 ${
    pressed
      ? "bg-primary-container text-on-primary-container"
      : "bg-surface-container-high text-text-muted hover:brightness-110"
  }`;
}
