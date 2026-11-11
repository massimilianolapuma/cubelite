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

/**
 * Filter field in a list's title row: a filled pill, as tall as the chips
 * beside it.
 */
export const SEARCH_FIELD =
  "focus-ring h-(--chip-h) w-56 max-w-full min-w-0 rounded-full bg-surface-container-high px-4 type-body-sm text-text placeholder:text-text-subtle";

/**
 * Column header of a list: stays at the top of the card's scroller. Its cells
 * and the rows share the card's `--list-cols` tracks.
 */
export const LIST_HEAD =
  "list-head sticky top-0 z-10 grid grid-cols-(--list-cols) items-center gap-x-3 bg-surface-container px-3 py-2 type-label text-text-muted";

/**
 * One row of a list (Tonal §7): fixed height, rounded, no separators. `.list-row`
 * (app.css) paints hover and, with `data-selected="true"`, the selection.
 */
export const LIST_ROW =
  "list-row grid h-(--row-h) w-full shrink-0 grid-cols-(--list-cols) items-center gap-x-3 rounded-md px-3 text-left";

/**
 * A row that opens something. Its focus ring is drawn by `.list-row` above the
 * cells, where the sticky name cell cannot cover it.
 */
export const LIST_ROW_ACTION = `${LIST_ROW} cursor-default`;

/** Stays in view, as wide as the scroller, while the columns scroll sideways. */
export const LIST_PINNED = "sticky left-0 w-[100cqw]";

/**
 * First cell of a row and of the column header: stays in view while the
 * columns scroll sideways. It takes its row's background, so the cells that
 * pass under it do not show through.
 */
export const LIST_STICKY = "sticky left-0 z-[1] bg-inherit";

/** A block inside the detail panel: one surface above the panel's own, in both its modes. */
export const PANEL_CARD = "rounded-lg bg-surface-container-top";

/** Heading of a section of the detail panel. */
export const PANEL_SECTION = "type-label mb-2 text-text-muted";
