/**
 * Prometheus endpoints per kube context and the list sparklines (#510,
 * spec docs/superpowers/specs/2026-11-03-prometheus-grafana-design.md §3,
 * §5.2). Sparklines load after the rows, at most every 30 s, and fail
 * silently (the reason is kept for the column tooltip).
 */
import { errorMessage } from "#lib/errors.ts";
import { prometheusSparklines, type PromEndpoint, type Point, type Sparklines } from "#lib/tauri.ts";
import { app } from "./app.svelte";
import { EndpointStore } from "./endpoints.svelte";

/** Minimum time between two sparkline loads for the same scope. */
export const SPARKLINE_INTERVAL_MS = 30_000;

/** A context's own settings on the shared default endpoint (#528). */
export type PrometheusContextSettings = { cluster: string | null };

class PrometheusStore extends EndpointStore<PromEndpoint, PrometheusContextSettings> {
  sparklines = $state<Sparklines | null>(null);
  sparklineError = $state<string | null>(null);
  #scope: string | null = null;
  #loadedAt = 0;

  /** The active context's endpoint. */
  get active(): PromEndpoint | null {
    return this.endpointFor(app.activeCluster);
  }

  /**
   * Loads the last hour of CPU and memory for `namespace` (null = every
   * namespace) unless a recent load covers the same scope.
   */
  async loadSparklines(namespace: string | null, now = Date.now()): Promise<void> {
    const context = app.activeCluster;
    const endpoint = this.endpointFor(context);
    const scope = context && endpoint ? `${context}|${namespace ?? "*"}|${JSON.stringify(endpoint)}` : null;
    if (scope !== this.#scope) {
      // Another cluster, namespace or endpoint: nothing of the old one stays,
      // and a late answer for it is dropped below.
      this.#scope = scope;
      this.#loadedAt = 0;
      this.sparklines = null;
      this.sparklineError = null;
    }
    if (!scope || !context || !endpoint || now - this.#loadedAt < SPARKLINE_INTERVAL_MS) return;
    this.#loadedAt = now;
    try {
      const data = await prometheusSparklines(app.kubeconfigPath, context, endpoint, namespace);
      if (scope !== this.#scope) return;
      this.sparklines = data;
      this.sparklineError = null;
    } catch (e) {
      if (scope === this.#scope) this.sparklineError = errorMessage(e);
    }
  }

  cpuFor(namespace: string, pod: string): Point[] | null {
    return this.sparklines?.cpu[`${namespace}/${pod}`] ?? null;
  }

  memoryFor(namespace: string, pod: string): Point[] | null {
    return this.sparklines?.memory[`${namespace}/${pod}`] ?? null;
  }
}

/** The context's `cluster` label wins over the default's (#528). */
export const prometheus = new PrometheusStore("prometheus.endpoints", (fallback, settings) => ({
  ...fallback,
  cluster: settings.cluster || fallback.cluster,
}));
