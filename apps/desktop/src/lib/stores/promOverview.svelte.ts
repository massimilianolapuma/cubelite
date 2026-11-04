/**
 * The Overview's Prometheus data (#530): cluster CPU and memory history
 * and the firing alerts of the active context. Loaded on the Overview's
 * refresh cadence (the resource auto-refresh), at most every 30 s like the
 * list sparklines; a range change loads the history at once. Another
 * context or endpoint clears everything, and a late answer for it is dropped.
 */
import { errorMessage } from "#lib/errors.ts";
import { prometheusAlerts, prometheusClusterUsage, type Alert, type HostMetrics, type MetricsRange } from "#lib/tauri.ts";
import { app } from "./app.svelte";
import { prometheus } from "./prometheus.svelte";

/** Minimum time between two loads of the same data. */
export const OVERVIEW_INTERVAL_MS = 30_000;

class PromOverviewStore {
  range = $state<MetricsRange>("1h");
  usage = $state<HostMetrics | null>(null);
  /** Range of `usage` (the selection may already be another one). */
  usageRange = $state<MetricsRange>("1h");
  usageError = $state<string | null>(null);
  usageLoading = $state(false);
  alerts = $state<Alert[] | null>(null);
  alertsError = $state<string | null>(null);
  #scope: string | null = null;
  #usageAt = 0;
  #usageLoaded: MetricsRange | null = null;
  #alertsAt = 0;

  /**
   * Loads what is due: the history when older than 30 s or for another
   * range, the alerts when older than 30 s.
   */
  async load(now = Date.now()): Promise<void> {
    const context = app.activeCluster;
    const endpoint = prometheus.endpointFor(context);
    const range = this.range;
    const scope = context && endpoint ? `${context}|${JSON.stringify(endpoint)}` : null;
    if (scope !== this.#scope) {
      this.#scope = scope;
      this.#usageAt = 0;
      this.#usageLoaded = null;
      this.#alertsAt = 0;
      this.usage = null;
      this.usageError = null;
      this.usageLoading = false;
      this.alerts = null;
      this.alertsError = null;
    }
    if (!scope || !context || !endpoint) return;
    const tasks: Promise<void>[] = [];
    if (range !== this.#usageLoaded || now - this.#usageAt >= OVERVIEW_INTERVAL_MS) {
      this.#usageAt = now;
      this.#usageLoaded = range;
      tasks.push(this.#loadUsage(scope, context, endpoint, range));
    }
    if (now - this.#alertsAt >= OVERVIEW_INTERVAL_MS) {
      this.#alertsAt = now;
      tasks.push(this.#loadAlerts(scope, context, endpoint));
    }
    await Promise.all(tasks);
  }

  async #loadUsage(
    scope: string,
    context: string,
    endpoint: NonNullable<ReturnType<typeof prometheus.endpointFor>>,
    range: MetricsRange,
  ): Promise<void> {
    this.usageLoading = true;
    try {
      const data = await prometheusClusterUsage(app.kubeconfigPath, context, endpoint, range);
      if (scope !== this.#scope || range !== this.#usageLoaded) return;
      this.usage = data;
      this.usageRange = range;
      this.usageError = null;
    } catch (e) {
      if (scope === this.#scope && range === this.#usageLoaded) this.usageError = errorMessage(e);
    } finally {
      if (scope === this.#scope && range === this.#usageLoaded) this.usageLoading = false;
    }
  }

  async #loadAlerts(
    scope: string,
    context: string,
    endpoint: NonNullable<ReturnType<typeof prometheus.endpointFor>>,
  ): Promise<void> {
    try {
      const data = await prometheusAlerts(app.kubeconfigPath, context, endpoint);
      if (scope !== this.#scope) return;
      this.alerts = data.alerts;
      this.alertsError = null;
    } catch (e) {
      if (scope === this.#scope) this.alertsError = errorMessage(e);
    }
  }
}

export const promOverview = new PromOverviewStore();
