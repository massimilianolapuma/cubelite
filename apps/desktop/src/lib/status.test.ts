import { describe, it, expect } from "vitest";
import { deploymentStatus, podStatusLabel, podTone } from "./status";
import type { DeploymentInfo, PodInfo } from "$lib/tauri";

function pod(phase: string | null, ready = true): PodInfo {
  return {
    name: "p",
    namespace: "default",
    phase,
    ready,
    restarts: 0,
    ready_containers: ready ? 1 : 0,
    total_containers: 1,
    node: null,
    pod_ip: null,
    qos_class: null,
    containers: [],
    labels: {},
    creation_timestamp: null,
  };
}

describe("podTone", () => {
  it("maps phases to spec tones", () => {
    expect(podTone(pod("Running"))).toBe("ok");
    expect(podTone(pod("Running", false))).toBe("warn");
    expect(podTone(pod("Succeeded", false))).toBe("ok");
    expect(podTone(pod("Pending", false))).toBe("warn");
    expect(podTone(pod("Failed", false))).toBe("err");
    expect(podTone(pod(null, false))).toBe("neutral");
  });
});

describe("podStatusLabel", () => {
  it("flags running-but-not-ready pods", () => {
    expect(podStatusLabel(pod("Running", false))).toBe("NotReady");
    expect(podStatusLabel(pod(null))).toBe("Unknown");
    expect(podStatusLabel(pod("Succeeded"))).toBe("Succeeded");
  });
});

describe("deploymentStatus", () => {
  const dep = (replicas: number, ready: number): DeploymentInfo => ({
    name: "d",
    namespace: "default",
    replicas,
    ready_replicas: ready,
    images: [],
    selector: {},
    strategy: null,
    conditions: [],
    creation_timestamp: null,
  });
  it("is Available only when every replica is ready", () => {
    expect(deploymentStatus(dep(2, 2))).toEqual({ label: "Available", tone: "ok" });
    expect(deploymentStatus(dep(2, 1))).toEqual({ label: "Progressing", tone: "warn" });
  });
});
