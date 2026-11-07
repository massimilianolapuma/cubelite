/**
 * Global shortcut map (⌘ on macOS ↔ Ctrl on Windows/Linux, same layout):
 *   mod+K   → command palette
 *   mod+1–5 → switch cluster by rail position
 *   mod+alt+1–9 → switch profile by menu position (physical key: ⌥ changes event.key on macOS)
 *   mod+,   → preferences
 *   mod+L   → log panel
 *   mod+F   → log panel search (focuses the search input when the panel is open)
 */

export type ShortcutAction =
  | { type: "palette" }
  | { type: "switch-cluster"; index: number }
  | { type: "switch-profile"; index: number }
  | { type: "preferences" }
  | { type: "log-panel" }
  | { type: "log-search" };

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** Physical key, e.g. "Digit1". */
  code?: string;
}

export function matchShortcut(event: KeyLike, mac: boolean): ShortcutAction | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (!mod) return null;
  if (event.altKey) {
    // Off macOS, AltGr arrives as Ctrl+Alt: a key that typed a character
    // ("{" from AltGr+7 on a German layout) is text, not a shortcut.
    if (!mac && !/^[1-9]$/.test(event.key)) return null;
    const digit = /^Digit([1-9])$/.exec(event.code ?? "");
    return digit ? { type: "switch-profile", index: Number(digit[1]) - 1 } : null;
  }

  if (event.key.toLowerCase() === "k") return { type: "palette" };
  if (event.key.toLowerCase() === "l") return { type: "log-panel" };
  if (event.key.toLowerCase() === "f") return { type: "log-search" };
  if (event.key === ",") return { type: "preferences" };
  if (/^[1-5]$/.test(event.key)) {
    return { type: "switch-cluster", index: Number(event.key) - 1 };
  }
  return null;
}
