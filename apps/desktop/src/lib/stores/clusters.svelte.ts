/**
 * Kube contexts: discovery, identity colors, active-cluster switching and
 * the derived connection state (connected/unreachable — active cluster only;
 * the backend has no health probe for inactive clusters).
 */

import { listContexts, setContext, type ContextInfo } from "$lib/tauri";
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
   * Switch the active cluster (rail click / palette / ⌘1–5).
   * Shows the connecting overlay, resets namespace + selections, probes the
   * cluster with the initial list and lands connected or unreachable.
   */
  async switchCluster(name: string): Promise<void> {
    if (app.connecting !== null) return;
    app.connecting = name;
    try {
      await resources.stopWatching();
      resources.clear();
      try {
        await setContext(name);
      } catch (e) {
        toasts.push(`Failed to switch context: ${errorMessage(e)}`, "err");
        return;
      }
      app.activeCluster = name;
      app.resetForClusterSwitch();
      this.contexts = this.contexts.map((c) => ({ ...c, is_active: c.name === name }));

      const ok = await resources.load();
      this.connectionState = ok ? "connected" : "unreachable";
      this.unreachableReason = ok ? null : resources.error;
      if (ok) {
        await resources.startWatching();
        resources.applyRefreshInterval();
      }
    } finally {
      app.connecting = null;
    }
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
