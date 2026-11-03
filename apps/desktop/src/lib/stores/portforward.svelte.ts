/**
 * Active port-forward sessions. The backend owns the listeners; this
 * store is the UI's source of truth for what is forwarding where.
 */

import { kibanaPortForward, startPortForward, stopPortForward, type KibanaService } from "#lib/tauri.ts";
import { errorMessage } from "#lib/errors.ts";
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

  /**
   * Base URL of an in-cluster Kibana (#505): reuses this cluster's forward to
   * the service or starts one (listed with the other sessions as
   * `svc/<name>`). Null (with a toast) when it cannot be forwarded.
   */
  async kibanaBase(service: KibanaService): Promise<string | null> {
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    if (!kc || !cluster) return null;
    const pod = `svc/${service.service}`;
    let session = this.sessions.find(
      (s) => s.namespace === service.namespace && s.pod === pod && s.remotePort === service.port,
    );
    if (!session) {
      try {
        const result = await kibanaPortForward(kc, cluster, service);
        session = { id: result.id, namespace: service.namespace, pod, localPort: result.localPort, remotePort: service.port };
        this.sessions = [...this.sessions, session];
      } catch (e) {
        toasts.push(`Kibana port forward failed: ${errorMessage(e)}`, "err");
        return null;
      }
    }
    return `${service.https ? "https" : "http"}://localhost:${session.localPort}`;
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
