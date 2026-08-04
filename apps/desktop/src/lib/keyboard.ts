/**
 * Global shortcut map (⌘ on macOS ↔ Ctrl on Windows/Linux, same layout):
 *   mod+K   → command palette
 *   mod+1–5 → switch cluster by rail position
 *   mod+,   → preferences
 *   mod+L   → log panel
 *   mod+F   → log panel search (focuses the search input when the panel is open)
 */

export type ShortcutAction =
  | { type: "palette" }
  | { type: "switch-cluster"; index: number }
  | { type: "preferences" }
  | { type: "log-panel" }
  | { type: "log-search" };

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export function matchShortcut(event: KeyLike, mac: boolean): ShortcutAction | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey) return null;

  if (event.key.toLowerCase() === "k") return { type: "palette" };
  if (event.key.toLowerCase() === "l") return { type: "log-panel" };
  if (event.key.toLowerCase() === "f") return { type: "log-search" };
  if (event.key === ",") return { type: "preferences" };
  if (/^[1-5]$/.test(event.key)) {
    return { type: "switch-cluster", index: Number(event.key) - 1 };
  }
  return null;
}
