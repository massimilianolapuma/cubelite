/**
 * Browser-side mock of the Tauri v2 IPC layer (`window.__TAURI_INTERNALS__`)
 * with deterministic cluster fixtures. Injected via `page.addInitScript`
 * before the app boots, so `@tauri-apps/api` calls resolve without a Rust
 * backend.
 */
import type { Page } from "@playwright/test";

declare global {
  interface Window {
    /** Test hook installed by the mock script: fires a Tauri event to every
     * listener registered for `name` via `@tauri-apps/api/event`'s `listen`. */
    __emitTauriEvent?: (name: string, payload: unknown) => void;
    /** Test hook: looks up the stream id the mock last handed out for a
     * `stream_pod_log` call with this container name (see `emitPodLogLine`). */
    __streamIdFor?: (container: string) => string | null;
  }
}

export const FIXTURES = {
  contexts: [
    { name: "prod-aks", cluster_server: "https://prod.azmk8s.io:443", namespace: "default", is_active: true },
    { name: "staging", cluster_server: "https://staging:6443", namespace: "default", is_active: false },
  ],
  pods: [
    {
      name: "api-0",
      namespace: "default",
      phase: "Running",
      ready: true,
      restarts: 0,
      ready_containers: 1,
      total_containers: 1,
      node: "node-1",
      pod_ip: "10.0.0.5",
      qos_class: "Burstable",
      containers: [{ name: "api", image: "ghcr.io/x/api:2.1", ready: true }],
      labels: { app: "api" },
      creation_timestamp: "2026-07-10T09:00:00Z",
    },
    {
      name: "worker-0",
      namespace: "default",
      phase: "Pending",
      ready: false,
      restarts: 5,
      ready_containers: 0,
      total_containers: 1,
      node: null,
      pod_ip: null,
      qos_class: null,
      containers: [{ name: "worker", image: "ghcr.io/x/worker:2.1", ready: false }],
      labels: { app: "worker" },
      creation_timestamp: "2026-07-11T08:00:00Z",
    },
  ],
  namespaces: [
    { name: "default", phase: "Active" },
    { name: "kube-system", phase: "Active" },
  ],
  deployments: [
    {
      name: "api",
      namespace: "default",
      replicas: 2,
      ready_replicas: 2,
      images: ["ghcr.io/x/api:2.1"],
      selector: { app: "api" },
      strategy: "RollingUpdate",
      conditions: [{ condition_type: "Available", status: "True", reason: "MinimumReplicasAvailable" }],
      creation_timestamp: "2026-07-01T09:00:00Z",
    },
  ],
  podContainers: [
    {
      name: "worker",
      init: false,
      sidecar: false,
      restarts: 3,
      ready: true,
      state: "running",
      state_reason: null,
      last_terminated_reason: null,
      last_terminated_at: null,
    },
    {
      name: "envoy",
      init: false,
      sidecar: false,
      restarts: 0,
      ready: true,
      state: "running",
      state_reason: null,
      last_terminated_reason: null,
      last_terminated_at: null,
    },
    {
      name: "init-migrate",
      init: true,
      sidecar: false,
      restarts: 0,
      ready: true,
      state: "terminated",
      state_reason: null,
      last_terminated_reason: null,
      last_terminated_at: null,
    },
  ],
};

/** Serializable init script installing the IPC mock. */
export function tauriMockScript(): string {
  const fixtures = JSON.stringify(FIXTURES);
  return `
(() => {
  const fixtures = ${fixtures};
  let callbackId = 1;
  // stream_pod_log id counter + the container each id was last handed out
  // for, so tests can target the right sub-stream in merged ("all
  // containers") mode, where LogSession opens one ContainerStream per
  // container and each gets its own stream id.
  let streamIdCounter = 1;
  const streamIdsByContainer = {};

  const responses = (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return fixtures.contexts;
      case "get_current_context": return "prod-aks";
      case "set_context": {
        fixtures.contexts = fixtures.contexts.map((c) => ({ ...c, is_active: c.name === args.contextName }));
        return null;
      }
      case "list_pods": return args.namespace && args.namespace !== "default" ? [] : fixtures.pods;
      case "list_namespaces": return fixtures.namespaces;
      case "list_deployments": return args.namespace === "default" ? fixtures.deployments : [];
      case "list_events": return [];
      case "list_pod_metrics": return [];
      case "cluster_capacity": return [];
      case "list_services":
      case "list_ingresses":
      case "list_configmaps":
      case "list_secrets":
      case "list_helm_releases":
      case "list_jobs":
      case "list_cronjobs":
      case "list_statefulsets":
      case "list_pvcs":
      case "list_nodes":
        return [];
      case "probe_cluster":
        return { context: args.context, reachable: args.context !== "staging", version: "v1.30.2", node_count: 3, error: args.context === "staging" ? "connection timed out" : null };
      case "watch_resources": return "w1";
      case "unwatch_resources": return null;
      case "stream_logs": return "l1";
      case "stop_logs": return null;
      case "get_pod_containers": return fixtures.podContainers;
      case "stream_pod_log": {
        const id = String(streamIdCounter++);
        streamIdsByContainer[args.container ?? ""] = id;
        return id;
      }
      case "export_log": return "/home/test/Downloads/" + args.filename;
      case "get_resource_yaml": return "kind: Pod\\nmetadata:\\n  name: " + args.name + "\\n";
      default: return null;
    }
  };

  // event name -> Map<eventId, handlerCallbackId>, mirroring the registry
  // Tauri's real event plugin keeps so listen/unlisten/emit round-trip.
  const eventListeners = {};

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    plugins: {},
    transformCallback(callback) {
      const id = callbackId++;
      window["_" + id] = callback;
      return id;
    },
    async invoke(cmd, args) {
      if (cmd.startsWith("plugin:path|")) return "/home/test";
      if (cmd === "plugin:event|listen") {
        const eventId = callbackId++;
        const handlers = eventListeners[args.event] ?? (eventListeners[args.event] = new Map());
        handlers.set(eventId, args.handler);
        return eventId;
      }
      if (cmd === "plugin:event|unlisten") {
        eventListeners[args.event]?.delete(args.eventId);
        return null;
      }
      if (cmd.startsWith("plugin:event|")) return callbackId++;
      return responses(cmd, args ?? {});
    },
  };

  // Test hook: fire a Tauri event to every listener registered for the
  // given event name via @tauri-apps/api/event's listen(), e.g.
  // window.__emitTauriEvent("pod-log-line:1", { ... }).
  window.__emitTauriEvent = (name, payload) => {
    const handlers = eventListeners[name];
    if (!handlers) return;
    for (const [eventId, handlerId] of handlers) {
      const callback = window["_" + handlerId];
      callback?.({ event: name, id: eventId, payload });
    }
  };

  // Test hook: look up the stream id last handed out for a given container
  // by the mocked stream_pod_log, e.g. window.__streamIdFor("worker").
  window.__streamIdFor = (container) => streamIdsByContainer[container] ?? null;
})();
`;
}

/**
 * Emits a `pod-log-line` event on whichever stream id the mock last assigned
 * to `container` via `stream_pod_log` — the per-container sub-stream that
 * `ContainerStream` opens for each pod container in merged ("all
 * containers") mode. Waits for that sub-stream to have opened first.
 */
export async function emitPodLogLine(
  page: Page,
  container: string,
  message: string,
  overrides: Partial<{ pod: string; namespace: string; time: string; level: string }> = {},
): Promise<void> {
  await page.waitForFunction((c) => Boolean(window.__streamIdFor?.(c)), container);
  const { pod = "api-0", namespace = "default", time = "2026-08-04T10:00:00Z", level = "info" } =
    overrides;
  await page.evaluate(
    ({ container, message, pod, namespace, time, level }) => {
      const id = window.__streamIdFor?.(container);
      window.__emitTauriEvent?.(`pod-log-line:${id}`, { pod, namespace, time, level, message });
    },
    { container, message, pod, namespace, time, level },
  );
}
