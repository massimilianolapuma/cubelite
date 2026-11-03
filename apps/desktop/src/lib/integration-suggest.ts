/**
 * What the integrations banner offers when a context connects (#527, spec
 * docs/superpowers/specs/2026-11-03-integrations-one-click-design.md): the
 * endpoints built from the detected services, with the defaults of a
 * one-click Enable, and the banner's copy (same on macOS).
 */
import { newEndpoint } from "#lib/elastic.ts";
import { serviceRef } from "#lib/integration.ts";
import type {
  DetectedIntegrations,
  DetectedPrometheus,
  DetectedService,
  EsEndpoint,
  IntegrationTarget,
  PromEndpoint,
} from "#lib/tauri.ts";

export type IntegrationKind = "elasticsearch" | "prometheus";

export const INTEGRATION_KINDS: readonly IntegrationKind[] = ["elasticsearch", "prometheus"];

export const INTEGRATION_LABELS: Record<IntegrationKind, string> = {
  elasticsearch: "Elasticsearch",
  prometheus: "Prometheus",
};

export const NOTHING_DETECTED: DetectedIntegrations = {
  elasticsearch: null,
  kibana: null,
  prometheus: null,
  grafana: null,
};

function inCluster(found: DetectedService | DetectedPrometheus): IntegrationTarget {
  return { kind: "in-cluster", namespace: found.namespace, service: found.name, port: found.port, https: found.https };
}

/** ECK's HTTP service (`{cluster}-es-http`): its `elastic` user can be used. */
export function isEck(found: DetectedService | null): boolean {
  return !!found?.name.endsWith("-es-http");
}

/** Elasticsearch in the cluster with the default index pattern, ECS and the detected Kibana. */
export function suggestedElastic(found: DetectedIntegrations): EsEndpoint | null {
  if (!found.elasticsearch) return null;
  return {
    ...newEndpoint(inCluster(found.elasticsearch)),
    kibanaService: found.kibana ? serviceRef(found.kibana) : null,
  };
}

/** Prometheus in the cluster with the detected Grafana and its default datasource. */
export function suggestedPrometheus(found: DetectedIntegrations): PromEndpoint | null {
  if (!found.prometheus) return null;
  return {
    target: inCluster(found.prometheus),
    cluster: null,
    grafanaUrl: null,
    grafanaDatasource: null,
    grafanaService: found.grafana ? serviceRef(found.grafana) : null,
    skipTlsVerify: false,
  };
}

/** "Elasticsearch and Prometheus found in this cluster". */
export function bannerTitle(kinds: readonly IntegrationKind[]): string {
  return `${kinds.map((k) => INTEGRATION_LABELS[k]).join(" and ")} found in this cluster`;
}

/** The banner's text after a failed Enable; nothing was saved. */
export function failureText(kind: IntegrationKind, reason: string, eck: boolean): string {
  const hint = kind === "elasticsearch" && !eck ? " (credentials may be needed)" : "";
  return `Couldn't connect to ${INTEGRATION_LABELS[kind]}: ${reason}${hint}`;
}

export function enabledText(kind: IntegrationKind, context: string): string {
  return `${INTEGRATION_LABELS[kind]} enabled for ${context}`;
}

/** Persisted dismissals: context → integrations hidden from the banner. */
export function isDismissals(v: unknown): v is Record<string, IntegrationKind[]> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((kinds) => Array.isArray(kinds) && kinds.every((k) => INTEGRATION_KINDS.includes(k)))
  );
}

/** Status line of a form pre-filled by Review. */
export const SUGGESTED_TEXT = "Found in this cluster: Test, then Save.";
