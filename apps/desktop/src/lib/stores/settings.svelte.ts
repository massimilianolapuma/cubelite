/**
 * Persisted user settings (non-secret — plain localStorage per AGENTS.md).
 */
import { isDismissals, type IntegrationKind } from "#lib/integration-suggest.ts";

export type Theme = "dark" | "light" | "system";

/** Table row density (spec: 9px default, 5px compact). */
export type Density = "default" | "compact";


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

export function persisted<T>(
  key: string,
  fallback: T,
  validate: (v: unknown) => v is T,
  options: {
    /**
     * Follow writes made by another window of the app (a pop-out log window
     * and the main window share this storage): the browser tells the other
     * windows with a `storage` event, never the one that wrote.
     */
    shared?: boolean;
  } = {},
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

  if (options.shared && typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      // A null key means the whole storage was cleared.
      if (event.key === storageKey || event.key === null) value = load();
    });
  }

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

const isDensity = (v: unknown): v is Density => v === "default" || v === "compact";


const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === "string");

export const settings = {
  theme: persisted<Theme>("theme", "dark", isTheme),
  refreshInterval: persisted<RefreshInterval>("refreshInterval", 30, isRefreshInterval),
  density: persisted<Density>("density", "default", isDensity),
  skipTls: persisted<boolean>("skipTls", false, isBoolean),
  onboardingSeen: persisted<boolean>("onboardingSeen", false, isBoolean),
  /** Placeholders for integrations that are not configured yet (#526). */
  integrationHints: persisted<boolean>("integrationHints", true, isBoolean),
  /** contextName → integrations whose detection banner was dismissed (#527). */
  integrationDismissals: persisted<Record<string, IntegrationKind[]>>("integrationDismissals", {}, isDismissals),
  /** Custom kubeconfig file list; empty = follow KUBECONFIG / ~/.kube. */
  kubeconfigPaths: persisted<string[]>("kubeconfigPaths", [], isStringArray),
  /** contextName → identity color key; written back on context discovery. */
  /** Shared: a pop-out log window follows a colour changed in the main window. */
  identityColors: persisted<Record<string, string>>("identityColors", {}, isStringRecord, { shared: true }),
  /** contextName → RFC 3339 of the last successful reachability probe. */
  lastSeen: persisted<Record<string, string>>("lastSeen", {}, isStringRecord),
};
