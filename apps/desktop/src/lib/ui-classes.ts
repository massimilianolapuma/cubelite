/**
 * Class strings shared by controls that are not components of their own
 * (bits-ui parts, native inputs). Tonal design system, spec §7.
 */

/** Dropdown and context menu panel. */
export const MENU_CONTENT =
  "card animate-popin z-50 rounded-lg bg-surface-overlay p-1.5 shadow-overlay";

/**
 * One row of a menu. `data-highlighted` is bits-ui's keyboard and hover state;
 * `.menu-item` (app.css) paints it as a layer of the text colour, which shows on
 * the overlay where a surface tone one step away does not.
 */
export const MENU_ITEM =
  "menu-item flex cursor-default items-center gap-3 rounded-md px-3 py-2 type-body text-text-muted outline-none data-highlighted:text-text";

/**
 * Text input inside a form, without a width: outlined, so it reads as a field on any surface.
 * 36 px in both densities: forms live in dialogs, where 44 px fields would
 * double the length of Preferences.
 */
export const FIELD_BASE =
  "focus-ring h-(--control-h-compact) min-w-0 rounded-md border border-outline-strong bg-transparent px-3 type-body-sm text-text placeholder:text-text-subtle";

/** A form field that takes its row's width. */
export const FIELD = `${FIELD_BASE} w-full`;

/**
 * Native checkbox in a form: its box keeps the browser's outline (3:1 on the
 * overlay in both themes), the tick takes the primary colour.
 */
export const CHECKBOX = "focus-ring h-4 w-4 shrink-0 accent-primary";

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
 * The edge of a filled field: a 1 px `outline-strong` ring drawn inside, so it
 * takes no room. The fill alone is 1.2:1 from the card; the edge reaches 3:1
 * (WCAG 1.4.11, spec §4.2: outline-strong is the input border).
 */
const FIELD_EDGE = "inset-ring inset-ring-outline-strong";

/**
 * Filter field in a list's title row: a filled pill, as tall as the chips
 * beside it, with a field's edge.
 */
export const SEARCH_FIELD = `focus-ring h-(--chip-h) w-56 max-w-full min-w-0 rounded-full bg-surface-container-high ${FIELD_EDGE} px-4 type-body-sm text-text placeholder:text-text-subtle`;

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
export const PANEL_CARD = "card rounded-lg bg-surface-container-top";

/** Heading of a section of the detail panel. */
export const PANEL_SECTION = "type-label mb-2 text-text-muted";

/**
 * Log toolbars (Tonal §8.5): the Logs view, the log panel and the pop-out
 * window share chips and pill fields as tall as the segmented groups beside
 * them, so a toolbar stays one row where it fits.
 */
export const TOOLBAR_CHIP =
  "focus-ring forced-edge type-body-sm relative inline-flex h-(--control-inline-h) max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-full px-3";

/** A resting toolbar chip: a quiet surface that opens or toggles something. */
export const TOOLBAR_CHIP_REST = `${TOOLBAR_CHIP} bg-surface-container-high text-text hover:brightness-110`;

/**
 * A toolbar chip that toggles (previous instance, filter mode). Pressed it takes
 * the tonal fill, a weight and the 1.5 px primary ring of a pressed chip
 * (`ui/Chip.svelte`): where the toolbar is narrow its label is read out only,
 * and the fill alone is 1.2–1.6:1 from the resting one.
 */
export function toolbarToggle(pressed: boolean): string {
  return `${TOOLBAR_CHIP} ${
    pressed
      ? "bg-primary-container font-semibold text-on-primary-container inset-ring-[1.5px] inset-ring-primary"
      : "bg-surface-container-high text-text-muted hover:brightness-110"
  }`;
}

/** Text fields and selects of a toolbar: a filled pill with a field's edge. */
const TOOLBAR_FILL = `focus-ring h-(--control-inline-h) rounded-full bg-surface-container-high ${FIELD_EDGE} type-body-sm text-text`;

/** Text field in a log toolbar: a filled pill. */
export const TOOLBAR_FIELD = `${TOOLBAR_FILL} w-44 max-w-full min-w-0 px-3.5 placeholder:text-text-subtle`;

/**
 * Text field that takes the room a toolbar row has left: from 6 rem up to
 * 15 rem. Its basis is the minimum, so it never pushes the row's other
 * controls onto a second row.
 */
export const TOOLBAR_FIELD_FLEX = `${TOOLBAR_FILL} min-w-24 max-w-60 grow basis-24 px-3.5 placeholder:text-text-subtle`;

/** Native select in a log toolbar (its popup stays native). */
export const TOOLBAR_SELECT = `${TOOLBAR_FILL} max-w-full min-w-0 pr-2 pl-3.5`;

/** Icon-only control in a toolbar: a disc with a layer of its own colour on hover. */
export const TOOLBAR_ICON =
  "focus-ring forced-edge hover-layer relative flex h-(--control-inline-h) w-(--control-inline-h) shrink-0 items-center justify-center rounded-full text-text-muted";

/**
 * A menu of a toolbar control (hand-rolled, not bits-ui). It opens with
 * `TOOLBAR_MENU_UP` or `TOOLBAR_MENU_DOWN`, and `fitMenu` (menu-fit.ts) keeps it
 * inside the window.
 */
export const TOOLBAR_MENU =
  "card animate-popin absolute z-20 rounded-lg bg-surface-overlay p-1.5 shadow-overlay";

/** Opens above its control: the log panel, whose toolbar sits low in the window. */
export const TOOLBAR_MENU_UP = "bottom-full mb-1";

/**
 * Opens below its control: the pop-out log window, whose toolbar sits at the top
 * (#624). Scrolls inside itself where the window is too short for it.
 */
export const TOOLBAR_MENU_DOWN = "top-full mt-1 overflow-y-auto overscroll-contain";

/** One row of a `TOOLBAR_MENU`. */
export const TOOLBAR_MENU_ITEM =
  "focus-ring-inset hover-layer flex w-full items-center gap-3 rounded-md px-3 py-2 text-left type-body text-text";

/** A small text action inside a block, e.g. Copy JSON above an expanded log line. */
export const INLINE_ACTION = "focus-ring forced-edge hover-layer type-label rounded-full px-2.5 py-1 text-text-muted";
