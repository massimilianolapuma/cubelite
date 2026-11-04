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
  elasticsearchOneClick: false,
  prometheusOneClick: false,
  elasticServices: [],
  prometheusServices: [],
};

/** The best guess for `kind`: what Enable would use. */
export function bestGuess(found: DetectedIntegrations, kind: IntegrationKind): DetectedService | DetectedPrometheus | null {
  return kind === "elasticsearch" ? found.elasticsearch : found.prometheus;
}

/**
 * Whether Enable may save `kind` without a review: exactly one
 * operator-managed service (anyone may create a look-alike Service).
 */
export function isOneClick(found: DetectedIntegrations, kind: IntegrationKind): boolean {
  return kind === "elasticsearch" ? found.elasticsearchOneClick : found.prometheusOneClick;
}

/** Help of Review when Enable is not offered. */
export const REVIEW_ONLY_HINT = "Several candidates or not operator-managed: review before enabling";

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

/**
 * "Elasticsearch found (logging/quickstart-es-http) and Prometheus
 * (monitoring/prometheus-operated)": always the services Enable would use.
 */
export function bannerTitle(found: DetectedIntegrations, kinds: readonly IntegrationKind[]): string {
  return kinds
    .map((k, i) => {
      const svc = bestGuess(found, k);
      const where = svc ? ` (${svc.namespace}/${svc.name})` : "";
      return i === 0 ? `${INTEGRATION_LABELS[k]} found${where}` : `${INTEGRATION_LABELS[k]}${where}`;
    })
    .join(" and ");
}

/** The banner's text after a failed Enable; nothing was saved. */
export function failureText(kind: IntegrationKind, reason: string, eck: boolean): string {
  const hint = kind === "elasticsearch" && !eck ? " (credentials may be needed)" : "";
  return `Couldn't connect to ${INTEGRATION_LABELS[kind]}: ${reason}${hint}`;
}

export function enabledText(kind: IntegrationKind, context: string): string {
  return `${INTEGRATION_LABELS[kind]} enabled for ${context}`;
}

/** Prometheus answered but has no cAdvisor series: saved, with a warning. */
export function noCadvisorText(context: string): string {
  return `Prometheus enabled for ${context} — no container metrics (cAdvisor) found yet`;
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
