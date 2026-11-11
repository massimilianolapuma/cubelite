/**
 * Class strings shared by controls that are not components of their own
 * (bits-ui parts, native inputs). Tonal design system, spec §7.
 */

/** Dropdown and context menu panel. */
export const MENU_CONTENT =
  "animate-popin z-50 rounded-lg bg-surface-overlay p-1.5 shadow-overlay";

/**
 * One row of a menu. `data-highlighted` is bits-ui's keyboard and hover state;
 * `.menu-item` (app.css) paints it as a layer of the text colour, which shows on
 * the overlay where a surface tone one step away does not.
 */
export const MENU_ITEM =
  "menu-item flex cursor-default items-center gap-3 rounded-md px-3 py-2 type-body text-text-muted outline-none data-highlighted:text-text";

/**
 * Text input inside a form: outlined, so it reads as a field on any surface.
 * 36 px in both densities: forms live in dialogs, where 44 px fields would
 * double the length of Preferences.
 */
export const FIELD =
  "focus-ring h-(--control-h-compact) w-full rounded-md border border-outline-strong bg-transparent px-3 type-body-sm text-text placeholder:text-text-subtle";

/**
 * Round icon toggle (pin, group by namespace). Pressed is the full primary fill:
 * the tonal container is one step from the resting surface and would not show.
 */
export function iconToggle(pressed: boolean): string {
  return `focus-ring flex h-(--control-inline-h) w-(--control-inline-h) shrink-0 items-center justify-center rounded-full disabled:opacity-45 ${
    pressed
      ? "bg-primary text-on-primary "
      : "bg-surface-container-high text-text-muted hover:brightness-110"
  }`;
}
