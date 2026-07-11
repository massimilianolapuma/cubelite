/**
 * Background reachability probes for every kube context, so the rail
 * badges and the All-Clusters dashboard show real health instead of
 * "unknown" for inactive clusters.
 */

import { probeCluster } from "$lib/tauri";
import { app } from "./app.svelte";
import { clusters } from "./clusters.svelte";
import { settings } from "./settings.svelte";

const PROBE_INTERVAL_MS = 60_000;

export interface ClusterHealth {
  state: "connected" | "unreachable" | "unknown";
  version: string | null;
  nodeCount: number | null;
  reason: string | null;
  /** RFC 3339 of the last successful probe (persisted across restarts). */
  lastSeen: string | null;
}

class HealthStore {
  byContext = $state<Record<string, ClusterHealth>>({});

  #timer: ReturnType<typeof setInterval> | null = null;
  #probing = false;

  for(contextName: string): ClusterHealth {
    return (
      this.byContext[contextName] ?? {
        state: "unknown",
        version: null,
        nodeCount: null,
        reason: null,
        lastSeen: settings.lastSeen.value[contextName] ?? null,
      }
    );
  }

  /** Probe every discovered context in parallel (skips if already running). */
  async probeAll(): Promise<void> {
    const kc = app.kubeconfigPath;
    if (!kc || this.#probing) return;
    this.#probing = true;
    try {
      const results = await Promise.all(
        clusters.contexts.map((c) =>
          probeCluster(kc, c.name).catch((e: unknown) => ({
            context: c.name,
            reachable: false,
            version: null,
            node_count: null,
            error: e instanceof Error ? e.message : String(e),
          })),
        ),
      );

      const now = new Date().toISOString();
      const next: Record<string, ClusterHealth> = {};
      const seen = { ...settings.lastSeen.value };
      for (const r of results) {
        if (r.reachable) seen[r.context] = now;
        next[r.context] = {
          state: r.reachable ? "connected" : "unreachable",
          version: r.version,
          nodeCount: r.node_count,
          reason: r.error,
          lastSeen: seen[r.context] ?? null,
        };
      }
      this.byContext = next;
      settings.lastSeen.value = seen;
    } finally {
      this.#probing = false;
    }
  }

  /** Start periodic probing (immediate first run). */
  start(): void {
    this.stop();
    void this.probeAll();
    this.#timer = setInterval(() => void this.probeAll(), PROBE_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

export const health = new HealthStore();
