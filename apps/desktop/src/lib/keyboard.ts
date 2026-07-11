/**
 * Global shortcut map (⌘ on macOS ↔ Ctrl on Windows/Linux, same layout):
 *   mod+K   → command palette
 *   mod+1–5 → switch cluster by rail position
 *   mod+,   → preferences
 */

export type ShortcutAction =
  | { type: "palette" }
  | { type: "switch-cluster"; index: number }
  | { type: "preferences" };

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
  if (event.key === ",") return { type: "preferences" };
  if (/^[1-5]$/.test(event.key)) {
    return { type: "switch-cluster", index: Number(event.key) - 1 };
  }
  return null;
}
