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

class PrometheusStore extends EndpointStore<PromEndpoint> {
  sparklines = $state<Sparklines | null>(null);
  sparklineError = $state<string | null>(null);
  #scope: string | null = null;
  #loadedAt = 0;
  #inFlight = false;

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
    if (!context || !endpoint) {
      this.sparklines = null;
      return;
    }
    const scope = `${context}|${namespace ?? "*"}|${JSON.stringify(endpoint)}`;
    if (this.#inFlight || (scope === this.#scope && now - this.#loadedAt < SPARKLINE_INTERVAL_MS)) return;
    if (scope !== this.#scope) this.sparklines = null;
    this.#scope = scope;
    this.#loadedAt = now;
    this.#inFlight = true;
    try {
      const data = await prometheusSparklines(app.kubeconfigPath, context, endpoint, namespace);
      if (scope !== this.#scope) return;
      this.sparklines = data;
      this.sparklineError = null;
    } catch (e) {
      if (scope === this.#scope) this.sparklineError = errorMessage(e);
    } finally {
      this.#inFlight = false;
    }
  }

  cpuFor(namespace: string, pod: string): Point[] | null {
    return this.sparklines?.cpu[`${namespace}/${pod}`] ?? null;
  }

  memoryFor(namespace: string, pod: string): Point[] | null {
    return this.sparklines?.memory[`${namespace}/${pod}`] ?? null;
  }
}

export const prometheus = new PrometheusStore("prometheus.endpoints");
