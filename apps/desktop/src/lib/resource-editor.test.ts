import { describe, it, expect } from "vitest";
import {
  RESTORE_PROPOSAL,
  buildProposal,
  changeLabel,
  editableContainers,
  fieldFinding,
  findingLook,
  initialDrafts,
  isBlocked,
  managerLabel,
  managerSentence,
  needsConfirmation,
  nodeRows,
  overrideChanges,
  quickStep,
  requestHint,
  rolloutSentence,
  type Drafts,
} from "#lib/resource-editor.ts";
import type {
  ContainerResourcesInfo,
  Finding,
  FindingCode,
  FindingLevel,
  LimitRangeFacts,
  NodeProjection,
  QuantityInfo,
  ResourceChange,
  ResourceEvaluation,
  ResourceFacts,
  TemplateContainerInfo,
  WorkloadFacts,
} from "#lib/tauri.ts";

const Mi = 1024 * 1024;
const Gi = 1024 * Mi;
const q = (text: string, amount: number | null): QuantityInfo => ({ text, amount });

/** api: cpu 250m / 500m, memory 256Mi / 512Mi. */
const API: ContainerResourcesInfo = {
  cpu: { request: q("250m", 250), limit: q("500m", 500) },
  memory: { request: q("256Mi", 256 * Mi), limit: q("512Mi", 512 * Mi) },
};
/** envoy: a CPU request only. */
const ENVOY: ContainerResourcesInfo = {
  cpu: { request: q("100m", 100), limit: null },
  memory: { request: null, limit: null },
};
const NONE: ContainerResourcesInfo = {
  cpu: { request: null, limit: null },
  memory: { request: null, limit: null },
};

const container = (
  name: string,
  resources: ContainerResourcesInfo,
  sidecar = false,
): TemplateContainerInfo => ({ name, image: null, sidecar, resources });

function workload(over: Partial<WorkloadFacts> = {}): WorkloadFacts {
  return {
    namespace: "default",
    name: "api",
    resource_version: "812",
    generation: 7,
    replicas: 3,
    rollout: { recreate: false, max_surge: 1, max_unavailable: 0 },
    containers: [container("api", API), container("envoy", ENVOY)],
    init_containers: [container("migrate", NONE), container("proxy", NONE, true)],
    overhead: { cpu_millis: 0, memory_bytes: 0 },
    manager: { kind: "none", release: null },
    override_annotation: null,
    ...over,
  };
}

function facts(over: Partial<ResourceFacts> = {}, wl: Partial<WorkloadFacts> = {}): ResourceFacts {
  return {
    workload: workload(wl),
    seen: { generation: 7, resources: {}, override_annotation: null },
    pods: [],
    usage: { state: "known", value: null },
    nodes: { state: "known", value: [] },
    limit_ranges: { state: "known", value: [] },
    quotas: { state: "known", value: [] },
    hpas: { state: "known", value: [] },
    vpas: { state: "known", value: [] },
    ...over,
  };
}

function finding(
  code: FindingCode,
  level: FindingLevel,
  over: Partial<Finding> = {},
): Finding {
  return {
    code,
    level,
    message: `${code} message`,
    container: null,
    resource: null,
    field: null,
    node: null,
    ...over,
  };
}

function evaluation(findings: Finding[], nodes: NodeProjection[] = []): ResourceEvaluation {
  return { findings, changes: [], nodes };
}

const ba = (before: number, after: number) => ({ before, after });

function node(name: string, ownPods: number, over: Partial<NodeProjection> = {}): NodeProjection {
  return {
    name,
    schedulable: true,
    own_pods: ownPods,
    cpu_requests: ba(10, 11),
    memory_requests: ba(20, 22),
    cpu_limits: ba(30, 33),
    memory_limits: ba(40, 44),
    memory_if_full: ba(50, 55),
    ...over,
  };
}

describe("editableContainers", () => {
  it("lists the regular containers, then the native sidecars, never a plain init container", () => {
    const list = editableContainers(facts());
    expect(list.map((c) => [c.name, c.sidecar])).toEqual([
      ["api", false],
      ["envoy", false],
      ["proxy", true],
    ]);
    expect(list[0].resources).toEqual(API);
  });
});

describe("initialDrafts", () => {
  it("holds each field as the cluster wrote it, empty when not set", () => {
    expect(initialDrafts(facts())).toEqual({
      api: { "cpu.request": "250m", "cpu.limit": "500m", "memory.request": "256Mi", "memory.limit": "512Mi" },
      envoy: { "cpu.request": "100m", "cpu.limit": "", "memory.request": "", "memory.limit": "" },
      proxy: { "cpu.request": "", "cpu.limit": "", "memory.request": "", "memory.limit": "" },
    });
  });
});

describe("buildProposal", () => {
  it("is empty when nothing differs from the cluster", () => {
    const f = facts();
    expect(buildProposal(f, initialDrafts(f))).toEqual({ kind: "adjust", containers: [] });
  });

  it("lists only the changed containers, with all four values, untouched ones as the cluster wrote them", () => {
    const f = facts();
    const drafts: Drafts = initialDrafts(f);
    drafts.api["memory.limit"] = "768Mi";
    expect(buildProposal(f, drafts)).toEqual({
      kind: "adjust",
      containers: [
        {
          name: "api",
          resources: {
            cpu: { request: "250m", limit: "500m" },
            memory: { request: "256Mi", limit: "768Mi" },
          },
        },
      ],
    });
  });

  it("sends an unset field as null and keeps the template's order", () => {
    const f = facts();
    const drafts = initialDrafts(f);
    drafts.proxy["cpu.limit"] = "200m";
    drafts.envoy["memory.limit"] = "128Mi";
    const proposal = buildProposal(f, drafts);
    expect(proposal.containers.map((c) => c.name)).toEqual(["envoy", "proxy"]);
    expect(proposal.containers[0].resources).toEqual({
      cpu: { request: "100m", limit: null },
      memory: { request: null, limit: "128Mi" },
    });
  });

  it("sends an emptied field as null", () => {
    const f = facts();
    const drafts = initialDrafts(f);
    drafts.api["cpu.request"] = "";
    const [api] = buildProposal(f, drafts).containers;
    expect(api.resources.cpu).toEqual({ request: null, limit: "500m" });
  });

  it("sends what was typed, without the spaces around it", () => {
    const f = facts();
    const drafts = initialDrafts(f);
    drafts.api["memory.limit"] = " 1.5Gi ";
    drafts.envoy["cpu.request"] = " 100m";
    drafts.proxy["cpu.request"] = "   ";
    const proposal = buildProposal(f, drafts);
    // envoy and proxy only gained spaces: unchanged.
    expect(proposal.containers.map((c) => c.name)).toEqual(["api"]);
    expect(proposal.containers[0].resources.memory.limit).toBe("1.5Gi");
  });

  it("is a restore with no containers for RESTORE_PROPOSAL", () => {
    expect(RESTORE_PROPOSAL).toEqual({ kind: "restore", containers: [] });
  });
});

describe("quickStep", () => {
  it.each([
    ["memory", 512 * Mi, 1.25, "640Mi"],
    ["cpu", 250, 1.25, "320m"],
    ["memory", 1 * Gi, 2, "2Gi"],
    // 1125Mi is above 1Gi: up to the next 128Mi.
    ["memory", 900 * Mi, 1.25, "1152Mi"],
    // Under 1Gi: up to the next 16Mi.
    ["memory", 100 * Mi, 1.5, "160Mi"],
    ["memory", 300 * Mi, 1.25, "384Mi"],
    ["memory", 768 * Mi, 2, "1536Mi"],
    ["memory", 2 * Gi, 1.5, "3Gi"],
    ["cpu", 100, 1.5, "150m"],
    ["cpu", 333, 1.25, "420m"],
    ["cpu", 1500, 2, "3000m"],
    // An amount read from "0.3" is a hair above 300: still 450m, not 460m.
    ["cpu", 300.00000000000006, 1.5, "450m"],
  ] as const)("%s %d × %d is %s", (resource, amount, factor, text) => {
    expect(quickStep(resource, amount, factor)).toBe(text);
  });

  it("is null when the cluster has no readable value", () => {
    expect(quickStep("memory", null, 1.25)).toBeNull();
    expect(quickStep("cpu", null, 2)).toBeNull();
  });
});

describe("requestHint", () => {
  const limitRange = (name: string, cpu: number | null, memory: number | null): LimitRangeFacts => ({
    name,
    items: [
      // A Pod item has no defaults for a container.
      {
        kind: "Pod",
        min: { cpu: null, memory: null },
        max: { cpu: null, memory: null },
        default: { cpu: null, memory: null },
        default_request: { cpu: 7, memory: 7 * Mi },
        max_ratio: { cpu: null, memory: null },
      },
      {
        kind: "Container",
        min: { cpu: null, memory: null },
        max: { cpu: null, memory: null },
        default: { cpu: null, memory: null },
        default_request: { cpu, memory },
        max_ratio: { cpu: null, memory: null },
      },
    ],
  });

  it("is '= limit' when the draft has a limit", () => {
    const f = facts();
    const drafts = initialDrafts(f);
    drafts.api["cpu.request"] = "";
    expect(requestHint(f, drafts, "api", "cpu")).toBe("= limit");
    drafts.proxy["memory.limit"] = "64Mi";
    expect(requestHint(f, drafts, "proxy", "memory")).toBe("= limit");
  });

  it("is the LimitRange default when there is no limit", () => {
    const f = facts({
      limit_ranges: {
        state: "known",
        value: [limitRange("zz-late", 999, 999 * Mi), limitRange("defaults", 50, 128 * Mi)],
      },
    });
    const drafts = initialDrafts(f);
    expect(requestHint(f, drafts, "envoy", "memory")).toBe("= 128Mi");
    expect(requestHint(f, drafts, "proxy", "cpu")).toBe("= 50m");
  });

  it("is empty with neither a limit nor a default", () => {
    const f = facts();
    expect(requestHint(f, initialDrafts(f), "envoy", "memory")).toBe("");
    const missing = facts({ limit_ranges: { state: "missing", reason: "not allowed to read LimitRange" } });
    expect(requestHint(missing, initialDrafts(missing), "envoy", "memory")).toBe("");
  });
});

describe("changeLabel", () => {
  const change = (resource: "cpu" | "memory", field: "request" | "limit"): ResourceChange => ({
    container: "api",
    sidecar: false,
    resource,
    field,
    before: null,
    after: null,
  });
  it("names the field", () => {
    expect(changeLabel(change("memory", "limit"))).toBe("Memory limit");
    expect(changeLabel(change("cpu", "request"))).toBe("CPU request");
    expect(changeLabel(change("cpu", "limit"))).toBe("CPU limit");
    expect(changeLabel(change("memory", "request"))).toBe("Memory request");
  });
});

describe("rolloutSentence", () => {
  const rolling = (replicas: number, max_surge: number, max_unavailable: number) =>
    workload({ replicas, rollout: { recreate: false, max_surge, max_unavailable } });

  it("says how many pods are replaced and how many at a time", () => {
    expect(rolloutSentence(rolling(3, 1, 0))).toBe(
      "The deployment rolls out: 3 pods are replaced (RollingUpdate, 1 at a time).",
    );
    expect(rolloutSentence(rolling(10, 3, 2))).toBe(
      "The deployment rolls out: 10 pods are replaced (RollingUpdate, 5 at a time).",
    );
  });

  it("counts at least one at a time, and never more than the replicas", () => {
    expect(rolloutSentence(rolling(4, 0, 0))).toBe(
      "The deployment rolls out: 4 pods are replaced (RollingUpdate, 1 at a time).",
    );
    expect(rolloutSentence(rolling(2, 2, 1))).toBe(
      "The deployment rolls out: 2 pods are replaced (RollingUpdate, 2 at a time).",
    );
  });

  it("reads one pod in the singular", () => {
    expect(rolloutSentence(rolling(1, 1, 0))).toBe(
      "The deployment rolls out: 1 pod is replaced (RollingUpdate, 1 at a time).",
    );
  });

  it("says all pods stop first for Recreate", () => {
    const recreate = (replicas: number) =>
      workload({ replicas, rollout: { recreate: true, max_surge: 0, max_unavailable: 0 } });
    expect(rolloutSentence(recreate(3))).toBe(
      "The deployment rolls out: all 3 pods stop first, then new ones start (Recreate).",
    );
    expect(rolloutSentence(recreate(1))).toBe(
      "The deployment rolls out: the pod stops first, then a new one starts (Recreate).",
    );
  });

  it("says no pod is replaced with no replicas", () => {
    expect(rolloutSentence(rolling(0, 1, 0))).toBe(
      "The deployment has no replicas: no pod is replaced now.",
    );
    expect(
      rolloutSentence(workload({ replicas: 0, rollout: { recreate: true, max_surge: 0, max_unavailable: 0 } })),
    ).toBe("The deployment has no replicas: no pod is replaced now.");
  });
});

describe("managerSentence", () => {
  it("is the sentence of spec §5 for each manager", () => {
    expect(managerSentence({ kind: "argo_cd", release: null })).toBe(
      "Argo CD manages this workload. If self-heal is on, it will undo this change at its next sync.",
    );
    expect(managerSentence({ kind: "flux_kustomization", release: null })).toBe(
      "Flux manages this workload. It will undo this change at its next reconciliation.",
    );
    expect(managerSentence({ kind: "flux_helm_release", release: null })).toBe(
      "Flux manages this workload through a Helm release. The change stays until the next upgrade of the release, or sooner if drift detection is on.",
    );
    expect(managerSentence({ kind: "helm", release: "orders" })).toBe(
      "Helm release `orders` manages this workload. The change stays until an upgrade of the release sets these values.",
    );
    expect(managerSentence({ kind: "possibly_managed", release: null })).toBe(
      "This workload carries labels that GitOps tools use, but no tool was recognised. If one applies it (Argo CD with label tracking, for example), the change will be undone.",
    );
    expect(managerSentence({ kind: "none", release: null })).toBe(
      "Nothing that manages this workload was recognised. The change stays until something applies it again.",
    );
  });

  it("names no release when a Helm manager comes without one", () => {
    expect(managerSentence({ kind: "helm", release: null })).toBe(
      "A Helm release manages this workload. The change stays until an upgrade of the release sets these values.",
    );
  });
});

describe("managerLabel", () => {
  it("is the short form of the header line, null when nothing manages the workload", () => {
    expect(managerLabel({ kind: "argo_cd", release: null })).toBe("managed by Argo CD");
    expect(managerLabel({ kind: "flux_kustomization", release: null })).toBe("managed by Flux");
    expect(managerLabel({ kind: "flux_helm_release", release: null })).toBe(
      "managed by Flux (Helm release)",
    );
    expect(managerLabel({ kind: "helm", release: "orders" })).toBe("managed by Helm release `orders`");
    expect(managerLabel({ kind: "helm", release: null })).toBe("managed by Helm");
    expect(managerLabel({ kind: "possibly_managed", release: null })).toBe("possibly managed");
    expect(managerLabel({ kind: "none", release: null })).toBeNull();
  });
});

describe("findingLook", () => {
  it("gives each level its glyph and weight", () => {
    expect(findingLook(finding("b3", "blocked"))).toEqual({ glyph: "err", lead: null, strong: true });
    expect(findingLook(finding("w2", "warning"))).toEqual({ glyph: "warn", lead: null, strong: true });
    expect(findingLook(finding("w9", "not_checked"))).toEqual({
      glyph: "unknown",
      lead: null,
      strong: false,
    });
    expect(findingLook(finding("note_fits", "note"))).toEqual({ glyph: "ok", lead: null, strong: false });
    expect(findingLook(finding("note_qos", "note"))).toEqual({ glyph: "done", lead: null, strong: false });
    expect(findingLook(finding("note_cpu_limits", "note"))).toEqual({
      glyph: "done",
      lead: null,
      strong: false,
    });
  });
});

describe("needsConfirmation and isBlocked", () => {
  it("asks for confirmation on a warning or a lone not-checked finding, not on notes", () => {
    expect(needsConfirmation(evaluation([finding("note_fits", "note")]))).toBe(false);
    expect(needsConfirmation(evaluation([finding("w2", "warning")]))).toBe(true);
    expect(needsConfirmation(evaluation([finding("w9", "not_checked")]))).toBe(true);
    expect(needsConfirmation(evaluation([]))).toBe(false);
  });

  it("is blocked only with a blocked finding", () => {
    expect(isBlocked(evaluation([finding("w2", "warning"), finding("w9", "not_checked")]))).toBe(false);
    expect(isBlocked(evaluation([finding("b1", "blocked")]))).toBe(true);
  });
});

describe("fieldFinding", () => {
  const onField = (code: FindingCode, level: FindingLevel, containerName: string) =>
    finding(code, level, { container: containerName, resource: "memory", field: "limit" });

  it("is the blocked finding on that field", () => {
    const b3 = onField("b3", "blocked", "api");
    const e = evaluation([onField("b3", "blocked", "envoy"), b3]);
    expect(fieldFinding(e, "api", "memory.limit")).toBe(b3);
  });

  it("ignores warnings, other fields and other containers", () => {
    const e = evaluation([
      onField("w4", "warning", "api"),
      finding("b3", "blocked", { container: "api", resource: "memory", field: "request" }),
      finding("b3", "blocked", { container: "api", resource: "cpu", field: "limit" }),
      onField("b3", "blocked", "envoy"),
    ]);
    expect(fieldFinding(e, "api", "memory.limit")).toBeNull();
    expect(fieldFinding(null, "api", "memory.limit")).toBeNull();
  });
});

describe("nodeRows", () => {
  const nodes = [node("aks-pool-1", 3), node("aks-pool-2", 0), node("aks-pool-3", 1)];

  it("is null when the projection is empty", () => {
    expect(nodeRows(evaluation([finding("w9", "not_checked")]))).toBeNull();
  });

  it("puts the hosting nodes first, the others apart, each in the evaluation's order", () => {
    const rows = nodeRows(evaluation([], nodes));
    expect(rows?.hosting.map((r) => [r.name, r.ownPods])).toEqual([
      ["aks-pool-1", 3],
      ["aks-pool-3", 1],
    ]);
    expect(rows?.others.map((r) => r.name)).toEqual(["aks-pool-2"]);
  });

  it("shows memory limits with no finding about a node", () => {
    const rows = nodeRows(evaluation([finding("note_qos", "note")], nodes));
    expect(rows?.caption).toBe("memory limits");
    expect(rows?.hosting[0]).toEqual({
      name: "aks-pool-1",
      ownPods: 3,
      schedulable: true,
      before: 40,
      after: 44,
    });
  });

  it.each([
    ["w3", null, "memory, if the pods use their limit", 50, 55],
    ["w2", "memory", "memory limits", 40, 44],
    ["note_cpu_limits", "cpu", "CPU limits", 30, 33],
    ["w0", "memory", "memory requests", 20, 22],
    ["w0", "cpu", "CPU requests", 10, 11],
    ["w1", null, "memory requests", 20, 22],
    ["w1r", null, "memory requests", 20, 22],
  ] as const)("a %s finding (%s) shows %s", (code, resource, caption, before, after) => {
    const level: FindingLevel = code.startsWith("note") ? "note" : "warning";
    const rows = nodeRows(
      evaluation([finding("b1", "blocked"), finding(code, level, { resource })], nodes),
    );
    expect(rows?.caption).toBe(caption);
    expect(rows?.hosting[0].before).toBe(before);
    expect(rows?.hosting[0].after).toBe(after);
  });

  it("takes the measure of the first finding about the nodes, the evaluation's worst first", () => {
    const rows = nodeRows(
      evaluation(
        [
          finding("w1", "warning"),
          finding("w3", "warning", { resource: "memory" }),
          finding("note_cpu_limits", "note", { resource: "cpu" }),
        ],
        nodes,
      ),
    );
    expect(rows?.caption).toBe("memory requests");
  });

  it("gives no 'after' when it equals 'before'", () => {
    const rows = nodeRows(evaluation([], [node("aks-pool-1", 2, { memory_limits: ba(40, 40) })]));
    expect(rows?.hosting[0].after).toBeNull();
    expect(rows?.hosting[0].before).toBe(40);
  });

  it("falls back to a node's memory limits when it has no usage", () => {
    const rows = nodeRows(
      evaluation(
        [finding("w3", "warning", { resource: "memory" })],
        [node("aks-pool-1", 3), node("aks-pool-2", 1, { memory_if_full: null })],
      ),
    );
    expect(rows?.caption).toBe("memory, if the pods use their limit");
    expect(rows?.hosting[1]).toMatchObject({ name: "aks-pool-2", before: 40, after: 44 });
  });

  it("carries whether a node is schedulable", () => {
    const rows = nodeRows(evaluation([], [node("aks-pool-1", 0, { schedulable: false })]));
    expect(rows?.others[0].schedulable).toBe(false);
  });
});

describe("overrideChanges", () => {
  it("lists only the fields whose original and applied texts differ, in field order", () => {
    const changes = overrideChanges({
      at: "2026-11-13T11:20:00Z",
      containers: [
        {
          name: "api",
          original: { cpu: { request: "250m", limit: "500m" }, memory: { request: "256Mi", limit: "512Mi" } },
          applied: { cpu: { request: "250m", limit: "1" }, memory: { request: "256Mi", limit: "768Mi" } },
        },
        {
          name: "envoy",
          original: { cpu: { request: "100m", limit: null }, memory: { request: null, limit: null } },
          applied: { cpu: { request: "100m", limit: null }, memory: { request: null, limit: "128Mi" } },
        },
        {
          name: "same",
          original: { cpu: { request: "1", limit: null }, memory: { request: null, limit: null } },
          applied: { cpu: { request: "1", limit: null }, memory: { request: null, limit: null } },
        },
      ],
    });
    expect(changes).toEqual([
      { container: "api", label: "CPU limit", before: "500m", after: "1" },
      { container: "api", label: "Memory limit", before: "512Mi", after: "768Mi" },
      { container: "envoy", label: "Memory limit", before: null, after: "128Mi" },
    ]);
  });
});
