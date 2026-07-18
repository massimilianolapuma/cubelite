/**
 * Active port-forward sessions. The backend owns the listeners; this
 * store is the UI's source of truth for what is forwarding where.
 */

import { startPortForward, stopPortForward } from "$lib/tauri";
import { errorMessage } from "$lib/errors";
import { app } from "./app.svelte";
import { toasts } from "./toasts.svelte";

export interface ForwardSession {
  id: string;
  namespace: string;
  pod: string;
  localPort: number;
  remotePort: number;
}

class PortForwardStore {
  sessions = $state<ForwardSession[]>([]);

  sessionsFor(namespace: string, pod: string): ForwardSession[] {
    return this.sessions.filter((s) => s.namespace === namespace && s.pod === pod);
  }

  /** Starts a forward; `localPort === 0` auto-assigns. Toasts on failure. */
  async start(
    namespace: string,
    pod: string,
    localPort: number,
    remotePort: number,
  ): Promise<boolean> {
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    if (!kc || !cluster) return false;
    try {
      const result = await startPortForward(kc, namespace, pod, localPort, remotePort, cluster);
      this.sessions = [
        ...this.sessions,
        { id: result.id, namespace, pod, localPort: result.localPort, remotePort },
      ];
      return true;
    } catch (e) {
      toasts.push(`Port forward failed: ${errorMessage(e)}`, "err");
      return false;
    }
  }

  async stop(id: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    try {
      await stopPortForward(id);
    } catch {
      // Backend may already have dropped the session.
    }
  }

  /** Stops every session (cluster switch). */
  async stopAll(): Promise<void> {
    const ids = this.sessions.map((s) => s.id);
    this.sessions = [];
    await Promise.allSettled(ids.map((id) => stopPortForward(id)));
  }
}

export const portforward = new PortForwardStore();
