/**
 * Pure helpers of the integration preferences (Elasticsearch #501,
 * Prometheus #510): URL checks, credential binding, saving rules.
 */
import type { IntegrationTarget } from "#lib/tauri.ts";

export type TargetMode = "off" | "in-cluster" | "external";

export const MODE_SEGMENTS: { value: TargetMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "in-cluster", label: "In cluster" },
  { value: "external", label: "External" },
];

/** Credentials embedded in a URL would bypass the keychain. */
export function urlProblem(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (!["http:", "https:"].includes(u.protocol)) return "Use an http:// or https:// URL.";
    if (u.username || u.password) return "Remove the credentials from the URL; use the authentication fields.";
    return null;
  } catch {
    return "Not a valid URL.";
  }
}

/** What stored credentials are bound to (mirrors the backend's binding). */
export function bindingOf(target: IntegrationTarget, skipTlsVerify: boolean): string {
  let origin: string;
  if (target.kind === "external") {
    try {
      origin = new URL(target.url).origin;
    } catch {
      origin = target.url;
    }
  } else {
    origin = `in-cluster:${target.namespace}/${target.service}:${target.port}:${target.https}`;
  }
  return `${origin}|${skipTlsVerify}`;
}

/** One-line description of a target for status lines. */
export function describeTarget(target: IntegrationTarget): string {
  return target.kind === "external" ? target.url : `${target.namespace}/${target.service}:${target.port}`;
}

export type FormResult = { ok: boolean; text: string };

export const INPUT_CLASS =
  "focus-ring h-7 w-full rounded-md border border-border-default bg-surface-window px-2.5 type-caption text-text-primary placeholder:text-text-disabled";
export const BUTTON_CLASS =
  "focus-ring type-caption rounded-md border border-border-default bg-surface-raised px-2.5 py-1 text-text-secondary hover:brightness-110 disabled:opacity-50";

/**
 * Stores the credentials typed for `endpoint` (or removes them when the
 * integration is turned off). Returns an error result instead of saving
 * when the endpoint moved and the stored secret would no longer apply.
 */
export async function saveCredentials<E extends { target: IntegrationTarget; skipTlsVerify: boolean }, A>(args: {
  saved: E | null;
  endpoint: E | null;
  typed: A | null;
  storedMethod: string | null;
  none: A;
  save: (endpoint: E, auth: A) => Promise<void>;
  /** Handles a method that is not a typed secret (ECK user); true when it did. */
  special?: (endpoint: E, moved: boolean) => Promise<boolean>;
}): Promise<FormResult | null> {
  const { saved, endpoint, typed, storedMethod, none, save, special } = args;
  if (!endpoint) {
    // Turning it off also removes the stored secret and open connection.
    if (saved) await save(saved, none);
    return null;
  }
  const moved =
    saved !== null && bindingOf(saved.target, saved.skipTlsVerify) !== bindingOf(endpoint.target, endpoint.skipTlsVerify);
  if (special && (await special(endpoint, moved))) return null;
  if (typed) {
    await save(endpoint, typed);
    return null;
  }
  if (moved && storedMethod && storedMethod !== "none") {
    // Stored secrets only work with the endpoint they were saved for.
    return {
      ok: false,
      text: "The endpoint or TLS setting changed: enter the credentials again (or choose No authentication).",
    };
  }
  return null;
}
