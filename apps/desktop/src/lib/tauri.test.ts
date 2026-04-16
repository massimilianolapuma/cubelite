import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core before importing tauri.ts
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  listContexts,
  getCurrentContext,
  setContext,
  listPods,
  listNamespaces,
  listDeployments,
  watchResources,
  unwatchResources,
} from "$lib/tauri";
import type {
  ContextInfo,
  PodInfo,
  NamespaceInfo,
  DeploymentInfo,
} from "$lib/tauri";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// listContexts
// ---------------------------------------------------------------------------

describe("listContexts", () => {
  it("invokes list_contexts and returns contexts", async () => {
    const mockContexts: ContextInfo[] = [
      {
        name: "minikube",
        cluster_server: "https://127.0.0.1:8443",
        namespace: "default",
        is_active: true,
      },
      {
        name: "production",
        cluster_server: "https://k8s.example.com",
        namespace: "default",
        is_active: false,
      },
    ];
    mockedInvoke.mockResolvedValueOnce(mockContexts);

    const result = await listContexts();

    expect(mockedInvoke).toHaveBeenCalledWith("list_contexts");
    expect(result).toEqual(mockContexts);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no contexts", async () => {
    mockedInvoke.mockResolvedValueOnce([]);

    const result = await listContexts();

    expect(result).toEqual([]);
  });

  it("propagates errors from invoke", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("No kubeconfig found"));

    await expect(listContexts()).rejects.toThrow("No kubeconfig found");
  });
});

// ---------------------------------------------------------------------------
// getCurrentContext
// ---------------------------------------------------------------------------

describe("getCurrentContext", () => {
  it("invokes get_current_context and returns name", async () => {
    mockedInvoke.mockResolvedValueOnce("minikube");

    const result = await getCurrentContext();

    expect(mockedInvoke).toHaveBeenCalledWith("get_current_context");
    expect(result).toBe("minikube");
  });

  it("returns null when no active context", async () => {
    mockedInvoke.mockResolvedValueOnce(null);

    const result = await getCurrentContext();

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setContext
// ---------------------------------------------------------------------------

describe("setContext", () => {
  it("invokes set_context with context name", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);

    await setContext("production");

    expect(mockedInvoke).toHaveBeenCalledWith("set_context", {
      contextName: "production",
    });
  });

  it("rejects when context does not exist", async () => {
    mockedInvoke.mockRejectedValueOnce(
      new Error("context 'nonexistent' not found"),
    );

    await expect(setContext("nonexistent")).rejects.toThrow(
      "context 'nonexistent' not found",
    );
  });
});

// ---------------------------------------------------------------------------
// listPods
// ---------------------------------------------------------------------------

describe("listPods", () => {
  const kubeconfigPath = "/home/user/.kube/config";

  it("invokes list_pods with all parameters", async () => {
    const mockPods: PodInfo[] = [
      {
        name: "nginx-abc",
        namespace: "default",
        phase: "Running",
        ready: true,
        restarts: 0,
      },
    ];
    mockedInvoke.mockResolvedValueOnce(mockPods);

    const result = await listPods(kubeconfigPath, "default", "minikube");

    expect(mockedInvoke).toHaveBeenCalledWith("list_pods", {
      kubeconfigPath,
      namespace: "default",
      context: "minikube",
    });
    expect(result).toEqual(mockPods);
  });

  it("passes null for optional parameters when omitted", async () => {
    mockedInvoke.mockResolvedValueOnce([]);

    await listPods(kubeconfigPath);

    expect(mockedInvoke).toHaveBeenCalledWith("list_pods", {
      kubeconfigPath,
      namespace: null,
      context: null,
    });
  });

  it("handles pods with null phase", async () => {
    const mockPods: PodInfo[] = [
      {
        name: "unknown-pod",
        namespace: "default",
        phase: null,
        ready: false,
        restarts: 3,
      },
    ];
    mockedInvoke.mockResolvedValueOnce(mockPods);

    const result = await listPods(kubeconfigPath);

    expect(result[0].phase).toBeNull();
    expect(result[0].ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listNamespaces
// ---------------------------------------------------------------------------

describe("listNamespaces", () => {
  const kubeconfigPath = "/home/user/.kube/config";

  it("invokes list_namespaces with context", async () => {
    const mockNamespaces: NamespaceInfo[] = [
      { name: "default", phase: "Active" },
      { name: "kube-system", phase: "Active" },
    ];
    mockedInvoke.mockResolvedValueOnce(mockNamespaces);

    const result = await listNamespaces(kubeconfigPath, "minikube");

    expect(mockedInvoke).toHaveBeenCalledWith("list_namespaces", {
      kubeconfigPath,
      context: "minikube",
    });
    expect(result).toHaveLength(2);
  });

  it("passes null context when omitted", async () => {
    mockedInvoke.mockResolvedValueOnce([]);

    await listNamespaces(kubeconfigPath);

    expect(mockedInvoke).toHaveBeenCalledWith("list_namespaces", {
      kubeconfigPath,
      context: null,
    });
  });
});

// ---------------------------------------------------------------------------
// listDeployments
// ---------------------------------------------------------------------------

describe("listDeployments", () => {
  const kubeconfigPath = "/home/user/.kube/config";

  it("invokes list_deployments with all parameters", async () => {
    const mockDeployments: DeploymentInfo[] = [
      { name: "nginx", namespace: "default", replicas: 3, ready_replicas: 3 },
    ];
    mockedInvoke.mockResolvedValueOnce(mockDeployments);

    const result = await listDeployments(kubeconfigPath, "default", "minikube");

    expect(mockedInvoke).toHaveBeenCalledWith("list_deployments", {
      kubeconfigPath,
      namespace: "default",
      context: "minikube",
    });
    expect(result).toEqual(mockDeployments);
  });

  it("handles degraded deployments", async () => {
    const mockDeployments: DeploymentInfo[] = [
      { name: "api", namespace: "prod", replicas: 5, ready_replicas: 2 },
    ];
    mockedInvoke.mockResolvedValueOnce(mockDeployments);

    const result = await listDeployments(kubeconfigPath, "prod");

    expect(result[0].ready_replicas).toBeLessThan(result[0].replicas);
  });
});

// ---------------------------------------------------------------------------
// watchResources / unwatchResources
// ---------------------------------------------------------------------------

describe("watchResources", () => {
  it("invokes watch_resources and returns watch ID", async () => {
    mockedInvoke.mockResolvedValueOnce("watch-abc-123");

    const result = await watchResources(
      "/kube/config",
      "pods",
      "default",
      "minikube",
    );

    expect(mockedInvoke).toHaveBeenCalledWith("watch_resources", {
      kubeconfigPath: "/kube/config",
      resourceType: "pods",
      namespace: "default",
      context: "minikube",
    });
    expect(result).toBe("watch-abc-123");
  });

  it("passes null for optional parameters", async () => {
    mockedInvoke.mockResolvedValueOnce("watch-xyz");

    await watchResources("/kube/config", "deployments");

    expect(mockedInvoke).toHaveBeenCalledWith("watch_resources", {
      kubeconfigPath: "/kube/config",
      resourceType: "deployments",
      namespace: null,
      context: null,
    });
  });
});

describe("unwatchResources", () => {
  it("invokes unwatch_resources with watch ID", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);

    await unwatchResources("watch-abc-123");

    expect(mockedInvoke).toHaveBeenCalledWith("unwatch_resources", {
      watchId: "watch-abc-123",
    });
  });
});
