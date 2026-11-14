import { describe, it, expect } from "vitest";
import {
  deploymentChip,
  deploymentProblem,
  deploymentStatus,
  helmTone,
  STATUS_CHIPS,
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
  /** A deployment with its rollout counts, settled unless an override says otherwise. */
  const live = (o: Partial<DeploymentInfo> = {}): DeploymentInfo => ({
    ...dep(2, 2),
    total_replicas: 2,
    updated_replicas: 2,
    available_replicas: 2,
    unavailable_replicas: 0,
    generation: 3,
    observed_generation: 3,
    ...o,
  });
  const progressing = (reason: string, status = "True") => [
    { condition_type: "Available", status: "True", reason: "MinimumReplicasAvailable" },
    { condition_type: "Progressing", status, reason },
  ];
  const pick = (d: DeploymentInfo) => {
    const s = deploymentStatus(d);
    return { state: s.state, label: s.label, tone: s.tone, glyph: s.glyph, badge: s.badge };
  };

  it("is Available when settled with every replica ready", () => {
    expect(pick(live())).toEqual({ state: "available", label: "Available", tone: "ok", glyph: "ok", badge: "Available" });
    expect(deploymentStatus(live()).detail).toBeNull();
    expect(deploymentStatus(live()).title).toBe("Available");
  });

  it("reads a payload without the rollout counts as settled (an older core, a fixture)", () => {
    expect(pick(dep(2, 2))).toMatchObject({ state: "available", tone: "ok" });
    expect(pick(dep(2, 1))).toMatchObject({ state: "degraded", label: "Degraded", tone: "warn", glyph: "warn" });
    expect(deploymentStatus(dep(2, 1)).detail).toBe("1 of 2 replicas ready");
  });

  it("is Scaled to 0, neutral, when no replica is wanted and none runs", () => {
    expect(pick(live({ replicas: 0, ready_replicas: 0, total_replicas: 0, updated_replicas: 0, available_replicas: 0 }))).toEqual({
      state: "scaled",
      label: "Scaled to 0",
      tone: "neutral",
      glyph: "done",
      badge: "Scaled to 0",
    });
    expect(pick(dep(0, 0))).toMatchObject({ state: "scaled", tone: "neutral" });
    expect(deploymentStatus(dep(0, 0)).title).toBe("Scaled to 0: no replicas requested, none running");
  });

  it("is not Scaled to 0 while the old pods still run", () => {
    expect(pick(live({ replicas: 0, ready_replicas: 2, total_replicas: 2, updated_replicas: 0, available_replicas: 2 }))).toMatchObject({
      state: "updating",
      tone: "neutral",
      badge: "Updating",
    });
    // Not ready any more, but still there.
    expect(pick(live({ replicas: 0, ready_replicas: 0, total_replicas: 1, updated_replicas: 0, available_replicas: 0 }))).toMatchObject({
      state: "updating",
    });
  });

  it("is Stalled, an error, once the rollout passed its progress deadline", () => {
    const stalled = live({
      total_replicas: 3,
      updated_replicas: 1,
      ready_replicas: 2,
      available_replicas: 2,
      conditions: progressing("ProgressDeadlineExceeded", "False"),
    });
    expect(pick(stalled)).toEqual({ state: "stalled", label: "Stalled", tone: "err", glyph: "err", badge: "Stalled 1/2" });
    expect(deploymentStatus(stalled).detail).toBe(
      "Progress deadline exceeded with 1 of 2 updated, 2 old replicas still running, 2 of 2 available",
    );
    expect(deploymentStatus(stalled).title).toBe(
      "Stalled: progress deadline exceeded with 1 of 2 updated, 2 old replicas still running, 2 of 2 available",
    );
  });

  it("is a starting rollout, not a stalled one, when a new change is not observed yet", () => {
    const d = live({ generation: 4, observed_generation: 3, conditions: progressing("ProgressDeadlineExceeded", "False") });
    expect(pick(d)).toEqual({ state: "updating", label: "Updating", tone: "neutral", glyph: "ok", badge: "Updating" });
    expect(deploymentStatus(d).detail).toBe("The controller has not picked up the change yet");
    expect(deploymentStatus(d).title).toBe("Updating: the controller has not picked up the change yet");
  });

  it("counts the updated replicas first: a healthy surge is neutral, not a problem (#660)", () => {
    // Two new pods coming up, the two old ones still ready.
    const d = live({ total_replicas: 3, updated_replicas: 1, ready_replicas: 2, available_replicas: 2, unavailable_replicas: 1 });
    expect(pick(d)).toEqual({ state: "updating", label: "Updating", tone: "neutral", glyph: "ok", badge: "Updating 1/2" });
    expect(deploymentStatus(d).detail).toBe("1 of 2 updated, 2 old replicas still running, 2 of 2 available");
    expect(deploymentStatus(d).rollout).toEqual({ observed: true, desired: 2, updated: 1, old: 2, available: 2 });
  });

  it("then the old replicas left once every replica is updated", () => {
    const d = live({ total_replicas: 3, updated_replicas: 2, ready_replicas: 3, available_replicas: 3 });
    expect(pick(d)).toMatchObject({ state: "updating", tone: "neutral", badge: "Updating 2/2" });
    expect(deploymentStatus(d).detail).toBe("2 of 2 updated, 1 old replica still running, 3 available");
  });

  it("never counts more updated than desired in the badge (scaled down mid-rollout)", () => {
    const d = live({ total_replicas: 5, updated_replicas: 3, ready_replicas: 5, available_replicas: 5 });
    expect(pick(d)).toMatchObject({ state: "updating", badge: "Updating 2/2" });
  });

  it("then the updated replicas not available yet", () => {
    const d = live({ total_replicas: 2, updated_replicas: 2, ready_replicas: 1, available_replicas: 1, unavailable_replicas: 1 });
    expect(pick(d)).toEqual({ state: "updating", label: "Updating", tone: "warn", glyph: "warn", badge: "Updating 2/2" });
    expect(deploymentStatus(d).detail).toBe("2 of 2 updated, 1 of 2 available");
  });

  it("warns while a rollout runs with fewer replicas available than desired", () => {
    const d = live({ total_replicas: 3, updated_replicas: 1, ready_replicas: 1, available_replicas: 1 });
    expect(pick(d)).toMatchObject({ state: "updating", tone: "warn", glyph: "warn", badge: "Updating 1/2" });
  });

  it("reads missing replicas after a completed rollout as Degraded, not as a rollout", () => {
    // A pod crashed once the controller declared the rollout complete.
    const d = live({ ready_replicas: 1, available_replicas: 1, unavailable_replicas: 1, conditions: progressing("NewReplicaSetAvailable") });
    expect(pick(d)).toEqual({ state: "degraded", label: "Degraded", tone: "warn", glyph: "warn", badge: "Degraded" });
    expect(deploymentStatus(d).detail).toBe("1 of 2 replicas ready");
    expect(deploymentStatus(d).rollout).toBeNull();
  });
});

describe("deploymentChip", () => {
  it("puts each state under one chip; a rollout short of replicas is Degraded", () => {
    const at = (o: Partial<DeploymentInfo>) => deploymentChip({ ...dep(2, 2), ...o });
    expect(at({})).toBe("available");
    expect(at({ ready_replicas: 1 })).toBe("degraded");
    expect(at({ replicas: 0, ready_replicas: 0 })).toBe("scaled");
    expect(at({ total_replicas: 3, updated_replicas: 1, available_replicas: 2 })).toBe("updating");
    expect(at({ total_replicas: 2, updated_replicas: 1, available_replicas: 1 })).toBe("degraded");
    expect(at({ updated_replicas: 1, conditions: [{ condition_type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }] })).toBe("stalled");
  });

  it("has a chip for every key it returns", () => {
    expect(STATUS_CHIPS.deployments.map((c) => c.key)).toEqual(["stalled", "degraded", "updating", "available", "scaled"]);
  });
});

describe("deploymentProblem", () => {
  it("counts stalled and short deployments, never a healthy rollout or one scaled to 0", () => {
    const at = (o: Partial<DeploymentInfo>) => deploymentProblem({ ...dep(2, 2), ...o });
    expect(at({})).toBe(false);
    expect(at({ replicas: 0, ready_replicas: 0 })).toBe(false);
    expect(at({ total_replicas: 3, updated_replicas: 1, available_replicas: 2, ready_replicas: 3 })).toBe(false);
    expect(at({ ready_replicas: 1 })).toBe(true);
    expect(at({ updated_replicas: 1, conditions: [{ condition_type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }] })).toBe(true);
  });
});

function dep(replicas: number, ready: number): DeploymentInfo {
  return {
    name: "d",
    namespace: "default",
    replicas,
    ready_replicas: ready,
    images: [],
    selector: {},
    strategy: null,
    conditions: [],
    creation_timestamp: null,
  };
}

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

  it("a completed pod needs no attention, however often it restarted", () => {
    expect(needsAttention({ ...pod("Succeeded", false), restarts: 9 })).toBe(false);
    expect(podChip({ ...pod("Succeeded", false), restarts: 9 })).toBe("done");
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
      { ...pod("Succeeded", false), restarts: 9 },
    ];
    for (const p of pods) {
      expect(["err", "warn"].includes(podChip(p))).toBe(needsAttention(p));
    }
  });
});
