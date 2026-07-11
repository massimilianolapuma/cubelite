/**
 * Persisted user settings (non-secret — plain localStorage per AGENTS.md).
 */

export type Theme = "dark" | "light" | "system";

/** Auto-refresh interval in seconds; 0 = off. */
export type RefreshInterval = 10 | 30 | 60 | 0;

const PREFIX = "cubelite.";

interface Persisted<T> {
  value: T;
  reset(): void;
}

// window.localStorage explicitly: Node's experimental `localStorage` global
// shadows jsdom's in vitest, and it is undefined without --localstorage-file.
function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function persisted<T>(
  key: string,
  fallback: T,
  validate: (v: unknown) => v is T,
): Persisted<T> {
  const storageKey = PREFIX + key;

  function load(): T {
    try {
      const raw = storage()?.getItem(storageKey) ?? null;
      if (raw === null) return fallback;
      const parsed: unknown = JSON.parse(raw);
      return validate(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  let value = $state(load());

  return {
    get value(): T {
      return value;
    },
    set value(v: T) {
      value = v;
      try {
        storage()?.setItem(storageKey, JSON.stringify(v));
      } catch {
        // Persistence is best-effort; in-memory value still applies.
      }
    },
    reset(): void {
      value = fallback;
      try {
        storage()?.removeItem(storageKey);
      } catch {
        // ignore
      }
    },
  };
}

const isTheme = (v: unknown): v is Theme =>
  v === "dark" || v === "light" || v === "system";

const isRefreshInterval = (v: unknown): v is RefreshInterval =>
  v === 10 || v === 30 || v === 60 || v === 0;

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === "string");

export const settings = {
  theme: persisted<Theme>("theme", "dark", isTheme),
  refreshInterval: persisted<RefreshInterval>("refreshInterval", 30, isRefreshInterval),
  skipTls: persisted<boolean>("skipTls", false, isBoolean),
  onboardingSeen: persisted<boolean>("onboardingSeen", false, isBoolean),
  /** contextName → identity color key; written back on context discovery. */
  identityColors: persisted<Record<string, string>>("identityColors", {}, isStringRecord),
};
