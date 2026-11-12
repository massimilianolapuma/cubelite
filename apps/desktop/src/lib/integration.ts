/**
 * Pure helpers of the integration preferences (Elasticsearch #501,
 * Prometheus #510): URL checks, credential binding, saving rules.
 */
import type { IntegrationTarget, ServiceRef } from "#lib/tauri.ts";
import { CHECKBOX, FIELD } from "#lib/ui-classes.ts";

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

// Form controls of the integration settings, in the Tonal look (spec §7).
export const INPUT_CLASS = FIELD;
export const CHECKBOX_CLASS = CHECKBOX;
export const BUTTON_CLASS =
  "focus-ring forced-edge type-body-sm h-(--control-inline-h) shrink-0 rounded-full bg-primary-container px-3.5 font-semibold text-on-primary-container hover:brightness-110 disabled:opacity-45";
/** Borderless link that opens a web UI (Kibana, Grafana). */
export const UI_LINK_CLASS =
  "focus-ring forced-edge type-body-sm flex items-center gap-1 rounded-full text-text-subtle hover:text-text-muted";
/** Borderless link in the primary colour ("Set up"). */
export const ACCENT_LINK_CLASS = "focus-ring forced-edge type-body-sm rounded-full font-semibold text-primary hover:brightness-110";

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

/** A detected service as stored on an endpoint (`kibanaService`, `grafanaService`). */
export function serviceRef(found: { namespace: string; name: string; port: number; https: boolean }): ServiceRef {
  return { namespace: found.namespace, service: found.name, port: found.port, https: found.https };
}

/**
 * Whether a web UI can be opened: a configured URL wins, else an in-cluster
 * service reached through a port-forward (Kibana #505, Grafana #525).
 */
export function canOpenWebUi(
  url: string | null | undefined,
  target: IntegrationTarget,
  service: ServiceRef | null | undefined,
): boolean {
  return !!url?.trim() || (target.kind === "in-cluster" && !!service);
}

/**
 * Base URL of a web UI (Kibana #505, Grafana #525): the configured URL, else
 * the in-cluster service through the backend's port-forward, which listens
 * on IPv4 loopback only; null when there is neither.
 */
export async function webUiBase(
  url: string | null | undefined,
  service: ServiceRef | null | undefined,
  forward: (service: ServiceRef) => Promise<number>,
): Promise<string | null> {
  const configured = url?.trim();
  if (configured) return configured;
  if (!service) return null;
  const port = await forward(service);
  return `${service.https ? "https" : "http"}://127.0.0.1:${port}`;
}
