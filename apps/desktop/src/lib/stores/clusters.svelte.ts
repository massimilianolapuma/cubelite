/**
 * Kube contexts: discovery, identity colors, active-cluster switching and
 * the derived connection state (connected/unreachable — active cluster only;
 * the backend has no health probe for inactive clusters).
 */

import { listContexts, probeCluster, setContext, type ContextInfo } from "$lib/tauri";
import { assignIdentityColors, type IdentityColor } from "$lib/cluster-identity";
import { errorMessage } from "$lib/errors";
import { app } from "./app.svelte";
import { resources } from "./resources.svelte";
import { settings } from "./settings.svelte";
import { toasts } from "./toasts.svelte";

export type ConnectionState = "unknown" | "connected" | "unreachable";

class ClustersStore {
  contexts = $state<ContextInfo[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  /** Connection state of the ACTIVE cluster (others are always unknown). */
  connectionState = $state<ConnectionState>("unknown");
  unreachableReason = $state<string | null>(null);
  identityColors = $state<Record<string, IdentityColor>>({});

  identityFor(contextName: string): IdentityColor {
    return this.identityColors[contextName] ?? "blue";
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.contexts = await listContexts();
      this.identityColors = assignIdentityColors(
        this.contexts.map((c) => c.name),
        settings.identityColors.value,
      );
      settings.identityColors.value = this.identityColors;
    } catch (e) {
      this.error = errorMessage(e);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Monotonic switch epoch: bumping it invalidates every in-flight switch,
   * so a newer switch (or a cancel) preempts instead of waiting for the old
   * one to time out (#308). Stale switches drop their results silently.
   */
  #switchEpoch = 0;

  /**
   * Switch the active cluster (rail click / palette / ⌘1–5).
   * Shows the connecting overlay (cancellable), resets namespace +
   * selections, fail-fast probes the cluster (short-timeout client) and
   * lands connected or unreachable. Calling it again while a switch is in
   * flight preempts the previous one.
   */
  async switchCluster(name: string): Promise<void> {
    if (app.connecting === name) return;
    const epoch = ++this.#switchEpoch;
    app.connecting = name;
    try {
      await resources.stopWatching();
      if (epoch !== this.#switchEpoch) return;
      resources.clear();
      try {
        await setContext(name);
      } catch (e) {
        if (epoch !== this.#switchEpoch) return;
        toasts.push(`Failed to switch context: ${errorMessage(e)}`, "err");
        return;
      }
      if (epoch !== this.#switchEpoch) return;
      app.activeCluster = name;
      app.resetForClusterSwitch();
      this.contexts = this.contexts.map((c) => ({ ...c, is_active: c.name === name }));

      // Fail fast on dead clusters: the probe uses the short-timeout client
      // (3s connect / 5s read) instead of blocking on a full resource load.
      const health = await probeCluster(app.kubeconfigPath, name).catch(() => null);
      if (epoch !== this.#switchEpoch) return;
      if (health && !health.reachable) {
        this.connectionState = "unreachable";
        this.unreachableReason = health.error;
        return;
      }

      const ok = await resources.load();
      if (epoch !== this.#switchEpoch) return;
      this.connectionState = ok ? "connected" : "unreachable";
      this.unreachableReason = ok ? null : resources.error;
      if (ok) {
        await resources.startWatching();
        resources.applyRefreshInterval();
      }
    } finally {
      if (epoch === this.#switchEpoch) {
        app.connecting = null;
      }
    }
  }

  /** Abort the in-flight switch (overlay Cancel / backdrop click). */
  cancelSwitch(): void {
    this.#switchEpoch++;
    app.connecting = null;
  }

  /** Re-probe the active cluster (Retry on the unreachable screen). */
  async retry(): Promise<void> {
    const ok = await resources.load();
    this.connectionState = ok ? "connected" : "unreachable";
    this.unreachableReason = ok ? null : resources.error;
    if (ok) {
      await resources.startWatching();
      resources.applyRefreshInterval();
    }
  }
}

export const clusters = new ClustersStore();
