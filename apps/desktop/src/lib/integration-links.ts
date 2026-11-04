/**
 * Links to the integrations' web UIs and the hints that make the
 * integrations discoverable (#526): Kibana and Grafana for the active
 * context, from the log toolbar, the Metrics section, the pod and
 * deployment drawers and the command palette.
 */
import { errorMessage } from "#lib/errors.ts";
import { canOpenWebUi, webUiBase } from "#lib/integration.ts";
import { app } from "#lib/stores/app.svelte.ts";
import { toasts } from "#lib/stores/toasts.svelte.ts";
import {
  grafanaPortForward,
  kibanaPortForward,
  openGrafanaHome,
  openGrafanaWorkload,
  openKibanaDiscover,
  openKibanaHome,
  openKibanaWorkload,
  type EsEndpoint,
  type PromEndpoint,
  type Workload,
} from "#lib/tauri.ts";

/** Workloads with a Kibana link: pods, and other workloads by a regexp on their pod names. */
export type LinkedWorkload = Workload;

/** Help text of the disabled History segment. */
export const HISTORY_HINT = "Connect Elasticsearch in Settings → Integrations to see older logs";
export const METRICS_HINT = "CPU, memory, restarts and network history from Prometheus.";

/** A hint replaces a feature while its integration is not configured, unless hints are off. */
export function showsIntegrationHint(endpoint: unknown, hints: boolean): boolean {
  return endpoint === null && hints;
}

export function canOpenKibana(endpoint: EsEndpoint | null): endpoint is EsEndpoint {
  return !!endpoint && canOpenWebUi(endpoint.kibanaUrl, endpoint.target, endpoint.kibanaService);
}

export function canOpenGrafana(endpoint: PromEndpoint | null): endpoint is PromEndpoint {
  return !!endpoint && canOpenWebUi(endpoint.grafanaUrl, endpoint.target, endpoint.grafanaService);
}

/** The active context's Kibana: its URL, else the in-cluster one through a port-forward. */
export function kibanaBase(endpoint: EsEndpoint): Promise<string | null> {
  const context = app.activeCluster;
  if (!context) return Promise.resolve(null);
  const service = endpoint.target.kind === "in-cluster" ? endpoint.kibanaService : null;
  return webUiBase(endpoint.kibanaUrl, service, (s) => kibanaPortForward(app.kubeconfigPath, context, s));
}

/** The active context's Grafana: its URL, else the in-cluster one through a port-forward. */
export function grafanaBase(endpoint: PromEndpoint): Promise<string | null> {
  const context = app.activeCluster;
  if (!context) return Promise.resolve(null);
  const service = endpoint.target.kind === "in-cluster" ? endpoint.grafanaService : null;
  return webUiBase(endpoint.grafanaUrl, service, (s) => grafanaPortForward(app.kubeconfigPath, context, s));
}

/** Runs `action`, reporting a failure as an error toast. */
export async function toastErrors(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (e) {
    toasts.push(errorMessage(e), "err");
  }
}

/**
 * Kibana Discover on a pod's, a workload's pods' or (without a workload) a
 * namespace's logs since `from` (#526, #529): the history's filter.
 */
export async function openKibanaFor(
  endpoint: EsEndpoint,
  namespace: string,
  workload: LinkedWorkload | null,
  from = "now-1h",
): Promise<void> {
  const kibanaUrl = await kibanaBase(endpoint);
  if (!kibanaUrl) return;
  const common = {
    kibanaUrl,
    preset: endpoint.preset,
    namespace,
    from,
    to: "now",
    clusterFilter: endpoint.clusterFilter ?? null,
  };
  if (workload?.kind === "pod") await openKibanaDiscover({ ...common, pod: workload.name, container: null });
  else await openKibanaWorkload({ ...common, workload });
}

/** Grafana Explore on a workload's CPU over the last hour. */
export async function openGrafanaFor(endpoint: PromEndpoint, namespace: string, workload: Workload): Promise<void> {
  const grafanaUrl = await grafanaBase(endpoint);
  if (!grafanaUrl) return;
  await openGrafanaWorkload({
    grafanaUrl,
    datasource: endpoint.grafanaDatasource,
    cluster: endpoint.cluster,
    namespace,
    workload,
    range: "1h",
  });
}

/** Kibana Discover without a filter. */
export async function openKibanaStart(endpoint: EsEndpoint): Promise<void> {
  const kibanaUrl = await kibanaBase(endpoint);
  if (kibanaUrl) await openKibanaHome(kibanaUrl);
}

/** Grafana's home page. */
export async function openGrafanaStart(endpoint: PromEndpoint): Promise<void> {
  const grafanaUrl = await grafanaBase(endpoint);
  if (grafanaUrl) await openGrafanaHome(grafanaUrl);
}
