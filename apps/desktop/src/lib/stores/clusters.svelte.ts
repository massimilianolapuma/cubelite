/**
 * Kube contexts: discovery, identity colors, active-cluster switching and
 * the derived connection state (connected/unreachable — active cluster only;
 * the backend has no health probe for inactive clusters).
 */

import { homeDir } from "@tauri-apps/api/path";
import {
  kubeconfigSources,
  listContexts,
  probeCluster,
  setContext,
  unwatchKubeconfig,
  watchKubeconfig,
  type ContextInfo,
} from "#lib/tauri.ts";
import { assignIdentityColors, type IdentityColor } from "#lib/cluster-identity.ts";
import { errorMessage } from "#lib/errors.ts";
import { app } from "./app.svelte";
import { logPanel } from "./logPanel.svelte";
import { portforward } from "./portforward.svelte";
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

  /** User override of a context's identity color (persisted). */
  setIdentityColor(contextName: string, color: IdentityColor): void {
    this.identityColors = { ...this.identityColors, [contextName]: color };
    settings.identityColors.value = this.identityColors;
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.contexts = await listContexts(app.kubeconfigPath || undefined);
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
      // Forward sessions target pods of the old cluster — tear them down.
      void portforward.stopAll();
      // Log sessions are pod-scoped too — same story.
      void logPanel.closeAll();
      try {
        await setContext(name, app.kubeconfigPath || undefined);
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

  #kubeconfigWatchId: string | null = null;

  /**
   * Re-resolve the kubeconfig list (custom list → KUBECONFIG → ~/.kube),
   * refresh contexts, keep or re-pick the active cluster and restart the
   * on-disk watcher. Single entry point for startup, Preferences edits and
   * `kubeconfig-changed` events.
   */
  async reloadKubeconfig(reason: "startup" | "preferences" | "file-change"): Promise<void> {
    try {
      const { spec, sources, origin } = await kubeconfigSources(settings.kubeconfigPaths.value);
      app.kubeconfigPath = spec;
      app.kubeconfigSources = sources;
      app.kubeconfigOrigin = origin;
    } catch {
      // No readable kubeconfig yet: keep the default path so onboarding can explain it.
      app.kubeconfigPath = `${await homeDir()}/.kube/config`;
      app.kubeconfigSources = [];
      app.kubeconfigOrigin = settings.kubeconfigPaths.value.length > 0 ? "custom" : "default";
    }
    await this.refresh();
    await this.#restartKubeconfigWatch();

    const names = this.contexts.map((c) => c.name);
    const activeSurvives = app.activeCluster !== null && names.includes(app.activeCluster);
    if (reason === "startup") return; // +page.svelte picks the initial cluster
    if (!activeSurvives) {
      const next = this.contexts.find((c) => c.is_active)?.name ?? this.contexts[0]?.name ?? null;
      if (next) await this.switchCluster(next);
      else app.activeCluster = null;
    } else if (reason === "file-change") {
      await resources.load();
    }
    if (reason === "file-change") toasts.push("Kubeconfig updated", "ok");
  }

  async stopKubeconfigWatch(): Promise<void> {
    if (this.#kubeconfigWatchId) {
      const id = this.#kubeconfigWatchId;
      this.#kubeconfigWatchId = null;
      await unwatchKubeconfig(id).catch(() => undefined);
    }
  }

  async #restartKubeconfigWatch(): Promise<void> {
    // The backend keeps a single kubeconfig watch: a new call replaces the old one.
    const paths = app.kubeconfigSources.map((s) => s.path);
    if (paths.length === 0) {
      await this.stopKubeconfigWatch();
      return;
    }
    try {
      this.#kubeconfigWatchId = await watchKubeconfig(paths);
    } catch {
      // Watching is best-effort (e.g. no listed directory exists yet).
      this.#kubeconfigWatchId = null;
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
