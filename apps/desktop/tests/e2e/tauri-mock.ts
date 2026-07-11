/**
 * Browser-side mock of the Tauri v2 IPC layer (`window.__TAURI_INTERNALS__`)
 * with deterministic cluster fixtures. Injected via `page.addInitScript`
 * before the app boots, so `@tauri-apps/api` calls resolve without a Rust
 * backend.
 */

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
};

/** Serializable init script installing the IPC mock. */
export function tauriMockScript(): string {
  const fixtures = JSON.stringify(FIXTURES);
  return `
(() => {
  const fixtures = ${fixtures};
  let callbackId = 1;

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
      case "get_resource_yaml": return "kind: Pod\\nmetadata:\\n  name: " + args.name + "\\n";
      default: return null;
    }
  };

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
      if (cmd.startsWith("plugin:event|")) return callbackId++;
      return responses(cmd, args ?? {});
    },
  };
})();
`;
}
