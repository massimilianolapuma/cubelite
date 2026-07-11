/** Platform detection for shortcut labels and titlebar layout. */
export const isMac: boolean =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** Modifier key label for the current platform (⌘ on macOS ↔ Ctrl elsewhere). */
export const modLabel: string = isMac ? "⌘" : "Ctrl+";
