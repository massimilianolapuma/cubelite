import { describe, it, expect } from "vitest";
import {
  deploymentStatus,
  helmTone,
  needsAttention,
  podChip,
  podGlyph,
  podStatusLabel,
  podTone,
  toneGlyph,
} from "./status";
import type { DeploymentInfo, PodInfo } from "#lib/tauri.ts";

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

describe("helmTone", () => {
  it("is the one mapping for the pill, the sort and the group marker (#547)", () => {
    expect(helmTone("deployed")).toBe("ok");
    expect(helmTone("superseded")).toBe("ok");
    expect(helmTone("pending-upgrade")).toBe("warn");
    expect(helmTone("failed")).toBe("err");
    expect(helmTone("unknown")).toBe("err");
    expect(helmTone("Failed")).toBe("err");
    expect(helmTone("uninstalling")).toBe("neutral");
    expect(helmTone(null)).toBe("neutral");
  });
});

describe("toneGlyph", () => {
  it("gives every tone a shape; neutral is the unknown ring", () => {
    expect(["ok", "warn", "err", "neutral"].map((t) => toneGlyph(t as never))).toEqual(["ok", "warn", "err", "unknown"]);
  });
});

describe("podGlyph", () => {
  it("shows a completed pod as finished, not as healthy", () => {
    expect(podGlyph(pod("Succeeded", false))).toBe("done");
  });

  it("follows the tone otherwise", () => {
    expect(podGlyph(pod("Running"))).toBe("ok");
    expect(podGlyph(pod("Running", false))).toBe("warn");
    expect(podGlyph(pod("CrashLoopBackOff", false))).toBe("err");
    expect(podGlyph(pod(null, false))).toBe("unknown");
  });
});

describe("podChip", () => {
  it("sorts pods into Failing, Pending, Running and Completed", () => {
    expect(podChip(pod("Failed", false))).toBe("err");
    expect(podChip(pod("Pending", false))).toBe("warn");
    expect(podChip(pod("Running"))).toBe("ok");
    expect(podChip(pod("Succeeded", false))).toBe("done");
  });

  it("counts a running pod that is not ready or restarts hard as failing", () => {
    expect(podChip(pod("Running", false))).toBe("err");
    expect(podChip({ ...pod("Running"), restarts: 4 })).toBe("err");
  });

  it("Failing plus Pending is exactly the pods needing attention", () => {
    const pods = [
      pod("Failed", false),
      pod("Pending", false),
      pod("Running"),
      pod("Running", false),
      pod("Succeeded", false),
      pod(null, false),
      { ...pod("Running"), restarts: 9 },
      { ...pod("Pending", false), restarts: 9 },
    ];
    for (const p of pods) {
      expect(["err", "warn"].includes(podChip(p))).toBe(needsAttention(p));
    }
  });
});
