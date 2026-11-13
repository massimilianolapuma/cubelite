import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushSync } from "svelte";

vi.mock("#lib/tauri.ts", () => ({
  resourceFacts: vi.fn(),
  evaluateResources: vi.fn(),
  applyResources: vi.fn(),
  clearResourcesOverride: vi.fn(async () => undefined),
  listPods: vi.fn(async () => []),
  listNamespaces: vi.fn(async () => [{ name: "default", phase: "Active" }]),
  listDeployments: vi.fn(async () => []),
  listEvents: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  listServices: vi.fn(async () => []),
  listIngresses: vi.fn(async () => []),
  listConfigMaps: vi.fn(async () => []),
  listSecrets: vi.fn(async () => []),
  listHelmReleases: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  applyResources,
  clearResourcesOverride,
  evaluateResources,
  listDeployments,
  resourceFacts,
  type DeploymentInfo,
  type Finding,
  type ResourceEvaluation,
  type ResourceFacts,
} from "#lib/tauri.ts";
import { RESTORE_PROPOSAL } from "#lib/resource-editor.ts";
import { EVALUATE_DEBOUNCE_MS, resourceEditor } from "./resourceEditor.svelte";
import { app } from "./app.svelte";
import { resources } from "./resources.svelte";
import { toasts } from "./toasts.svelte";

const KC = "/home/u/.kube/config";
const Mi = 1024 * 1024;

const DEPLOYMENT: DeploymentInfo = {
  name: "api",
  namespace: "default",
  replicas: 2,
  ready_replicas: 2,
  images: [],
  selector: {},
  strategy: null,
  conditions: [],
  creation_timestamp: null,
};

const API_RESOURCES = {
  cpu: { request: { text: "250m", amount: 250 }, limit: { text: "500m", amount: 500 } },
  memory: { request: { text: "256Mi", amount: 256 * Mi }, limit: { text: "512Mi", amount: 512 * Mi } },
};

function facts(): ResourceFacts {
  return {
    workload: {
      namespace: "default",
      name: "api",
      resource_version: "812",
      generation: 7,
      replicas: 2,
      rollout: { recreate: false, max_surge: 1, max_unavailable: 0 },
      containers: [
        { name: "api", image: null, sidecar: false, resources: API_RESOURCES },
        {
          name: "envoy",
          image: null,
          sidecar: false,
          resources: {
            cpu: { request: { text: "100m", amount: 100 }, limit: null },
            memory: { request: null, limit: null },
          },
        },
      ],
      init_containers: [],
      overhead: { cpu_millis: 0, memory_bytes: 0 },
      manager: { kind: "none", release: null },
      override_annotation: null,
    },
    seen: { generation: 7, resources: { api: API_RESOURCES }, override_annotation: null },
    pods: [],
    usage: { state: "known", value: null },
    nodes: { state: "known", value: [] },
    limit_ranges: { state: "known", value: [] },
    quotas: { state: "known", value: [] },
    hpas: { state: "known", value: [] },
    vpas: { state: "known", value: [] },
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    code: "note_fits",
    level: "note",
    message: "Fits: 2 of 2 replicas have room by their requests.",
    container: null,
    resource: null,
    field: null,
    node: null,
    ...over,
  };
}

function evaluation(findings: Finding[] = [finding()]): ResourceEvaluation {
  return { findings, changes: [], nodes: [] };
}

/** The core's check of a proposal: a change for each container it lists (as amounts, they differ). */
function checked(proposal: { containers: { name: string }[] }, findings: Finding[] = [finding()]): ResourceEvaluation {
  return {
    findings,
    changes: proposal.containers.map((c) => ({
      container: c.name,
      sidecar: false,
      resource: "memory" as const,
      field: "limit" as const,
      before: "512Mi",
      after: "768Mi",
    })),
    nodes: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every settled promise run its continuation. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

/** Open the editor on `api` and wait for the facts and the first check. */
async function openApi(mode?: "adjust" | "restore"): Promise<void> {
  await resourceEditor.open(DEPLOYMENT, mode);
  await settle();
}

/** Type a value and let the debounced check answer. */
async function type(container: string, key: "memory.limit" | "cpu.limit", text: string): Promise<void> {
  resourceEditor.setField(container, key, text);
  await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
}

/** The arguments of the calls of applyResources with this dryRun flag. */
function applyCalls(dryRun: boolean) {
  return vi.mocked(applyResources).mock.calls.filter((call) => call[5] === dryRun);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resourceEditor.close();
  resources.clear();
  toasts.items = [];
  app.kubeconfigPath = KC;
  app.activeCluster = "prod";
  app.namespace = "default";
  app.view = "deployments";
  vi.mocked(resourceFacts).mockImplementation(async () => facts());
  vi.mocked(evaluateResources).mockImplementation(async (_facts, proposal) => checked(proposal));
  vi.mocked(applyResources).mockImplementation(async () => evaluation());
  vi.mocked(listDeployments).mockResolvedValue([DEPLOYMENT]);
});

afterEach(() => {
  resourceEditor.close();
  vi.useRealTimers();
});

describe("open", () => {
  it("reads the facts with the active kubeconfig and cluster, drafts as the cluster wrote them", async () => {
    const pending = resourceEditor.open(DEPLOYMENT);
    expect(resourceEditor.target).toEqual({ namespace: "default", name: "api" });
    expect(resourceEditor.loading).toBe(true);
    await pending;
    await settle();
    expect(resourceFacts).toHaveBeenCalledWith(KC, "default", "api", "prod");
    expect(resourceEditor.loading).toBe(false);
    expect(resourceEditor.mode).toBe("adjust");
    expect(resourceEditor.step).toBe("edit");
    expect(resourceEditor.facts?.workload.name).toBe("api");
    expect(resourceEditor.drafts.api["memory.limit"]).toBe("512Mi");
    expect(resourceEditor.drafts.envoy["memory.limit"]).toBe("");
  });

  it("checks the cluster's values at once, so the nodes and notes show before any typing", async () => {
    await openApi();
    expect(evaluateResources).toHaveBeenCalledTimes(1);
    expect(vi.mocked(evaluateResources).mock.calls[0][1]).toEqual({ kind: "adjust", containers: [] });
    expect(resourceEditor.evaluation).toEqual(evaluation());
    expect(resourceEditor.evaluating).toBe(false);
  });

  it("sets factsError when the facts cannot be read, and retry reads them again", async () => {
    vi.mocked(resourceFacts).mockRejectedValueOnce(new Error("pods is forbidden"));
    await openApi();
    expect(resourceEditor.factsError).toBe("pods is forbidden");
    expect(resourceEditor.facts).toBeNull();
    expect(resourceEditor.loading).toBe(false);
    expect(resourceEditor.target).toEqual({ namespace: "default", name: "api" });

    await resourceEditor.retry();
    await settle();
    expect(resourceFacts).toHaveBeenCalledTimes(2);
    expect(resourceEditor.factsError).toBeNull();
    expect(resourceEditor.facts?.workload.name).toBe("api");
  });

  it("drops the facts of an editor that was closed meanwhile", async () => {
    const late = deferred<ResourceFacts>();
    vi.mocked(resourceFacts).mockReturnValueOnce(late.promise);
    const pending = resourceEditor.open(DEPLOYMENT);
    resourceEditor.close();
    late.resolve(facts());
    await pending;
    await settle();
    expect(resourceEditor.target).toBeNull();
    expect(resourceEditor.facts).toBeNull();
  });
});

describe("typing", () => {
  it("sends one check, EVALUATE_DEBOUNCE_MS after the last of several quick changes", async () => {
    await openApi();
    vi.mocked(evaluateResources).mockClear();
    resourceEditor.setField("api", "memory.limit", "6");
    resourceEditor.setField("api", "memory.limit", "64");
    resourceEditor.setField("api", "memory.limit", "640Mi");
    expect(resourceEditor.drafts.api["memory.limit"]).toBe("640Mi");
    expect(resourceEditor.evaluating).toBe(true);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS - 1);
    expect(evaluateResources).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(evaluateResources).toHaveBeenCalledTimes(1);
    const [sentFacts, proposal] = vi.mocked(evaluateResources).mock.calls[0];
    expect(sentFacts.workload.name).toBe("api");
    expect(proposal.containers).toEqual([
      {
        name: "api",
        resources: { cpu: { request: "250m", limit: "500m" }, memory: { request: "256Mi", limit: "640Mi" } },
      },
    ]);
    await settle();
    expect(resourceEditor.evaluating).toBe(false);
  });

  it("never lets an older answer replace a newer one", async () => {
    await openApi();
    const first = deferred<ResourceEvaluation>();
    const second = deferred<ResourceEvaluation>();
    vi.mocked(evaluateResources).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await type("api", "memory.limit", "1Gi");
    await type("api", "memory.limit", "2Gi");

    // The older answer arrives while the newer is still out: ignored, still evaluating.
    first.resolve(evaluation([finding({ message: "for 1Gi" })]));
    await settle();
    expect(resourceEditor.evaluation?.findings[0].message).not.toBe("for 1Gi");
    expect(resourceEditor.evaluating).toBe(true);
    expect(resourceEditor.canReview).toBe(false);

    second.resolve(evaluation([finding({ message: "for 2Gi" })]));
    await settle();
    expect(resourceEditor.evaluation?.findings[0].message).toBe("for 2Gi");
    expect(resourceEditor.evaluating).toBe(false);
  });

  it("ignores an older answer that arrives after the newer one", async () => {
    await openApi();
    const first = deferred<ResourceEvaluation>();
    vi.mocked(evaluateResources)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(evaluation([finding({ message: "for 2Gi" })]));
    await type("api", "memory.limit", "1Gi");
    await type("api", "memory.limit", "2Gi");
    first.resolve(evaluation([finding({ message: "for 1Gi" })]));
    await settle();
    expect(resourceEditor.evaluation?.findings[0].message).toBe("for 2Gi");
  });

  it("writes a quick step from the cluster's amount, and nothing for a field the cluster has no value for", async () => {
    await openApi();
    resourceEditor.quickStep("api", "memory.limit", 1.5);
    expect(resourceEditor.drafts.api["memory.limit"]).toBe("768Mi");
    // From the cluster's value, not from what is typed.
    resourceEditor.quickStep("api", "memory.limit", 2);
    expect(resourceEditor.drafts.api["memory.limit"]).toBe("1Gi");
    resourceEditor.quickStep("envoy", "memory.limit", 2);
    expect(resourceEditor.drafts.envoy["memory.limit"]).toBe("");
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(vi.mocked(evaluateResources).mock.lastCall?.[1].containers.map((c) => c.name)).toEqual(["api"]);
  });

  it("reset puts a container back to the cluster's values and checks again", async () => {
    await openApi();
    await type("api", "memory.limit", "1Gi");
    resourceEditor.setField("api", "cpu.limit", "1");
    resourceEditor.reset("api");
    expect(resourceEditor.drafts.api).toEqual({
      "cpu.request": "250m",
      "cpu.limit": "500m",
      "memory.request": "256Mi",
      "memory.limit": "512Mi",
    });
    expect(resourceEditor.changed).toBe(false);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(vi.mocked(evaluateResources).mock.lastCall?.[1].containers).toEqual([]);
  });
});

describe("canReview", () => {
  it("is false while nothing changed", async () => {
    await openApi();
    expect(resourceEditor.changed).toBe(false);
    expect(resourceEditor.canReview).toBe(false);
  });

  it("is false while the check of the latest text has not answered", async () => {
    await openApi();
    resourceEditor.setField("api", "memory.limit", "1Gi");
    expect(resourceEditor.changed).toBe(true);
    expect(resourceEditor.canReview).toBe(false);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(resourceEditor.canReview).toBe(true);
  });

  it("is false when the check finds no change: the same amounts in another text", async () => {
    await openApi();
    vi.mocked(evaluateResources).mockResolvedValueOnce(evaluation());
    await type("api", "cpu.limit", "0.5");
    expect(resourceEditor.changed).toBe(true);
    expect(resourceEditor.evaluating).toBe(false);
    expect(resourceEditor.sameAmounts).toBe(true);
    expect(resourceEditor.canReview).toBe(false);
    await type("api", "cpu.limit", "750m");
    expect(resourceEditor.sameAmounts).toBe(false);
    expect(resourceEditor.canReview).toBe(true);
  });

  it("is false with a blocked finding", async () => {
    await openApi();
    vi.mocked(evaluateResources).mockResolvedValueOnce(
      evaluation([
        finding({
          code: "b3",
          level: "blocked",
          message: "The limit is under the request.",
          container: "api",
          resource: "memory",
          field: "limit",
        }),
      ]),
    );
    await type("api", "memory.limit", "128Mi");
    expect(resourceEditor.changed).toBe(true);
    expect(resourceEditor.evaluating).toBe(false);
    expect(resourceEditor.canReview).toBe(false);
    await resourceEditor.review();
    expect(resourceEditor.step).toBe("edit");
    expect(applyResources).not.toHaveBeenCalled();
  });
});

describe("review", () => {
  it("moves to step 2 and runs the dry run of the exact proposal with facts.seen", async () => {
    await openApi();
    await type("api", "memory.limit", "768Mi");
    const dry = deferred<ResourceEvaluation>();
    vi.mocked(applyResources).mockReturnValueOnce(dry.promise);
    const pending = resourceEditor.review();
    expect(resourceEditor.step).toBe("review");
    expect(resourceEditor.dryRun).toBe("running");
    const answer = evaluation([finding({ code: "w2", level: "warning", message: "from the dry run" })]);
    dry.resolve(answer);
    await pending;
    expect(applyResources).toHaveBeenCalledWith(
      KC,
      "default",
      "api",
      {
        kind: "adjust",
        containers: [
          {
            name: "api",
            resources: { cpu: { request: "250m", limit: "500m" }, memory: { request: "256Mi", limit: "768Mi" } },
          },
        ],
      },
      facts().seen,
      true,
      "prod",
    );
    expect(resourceEditor.dryRun).toBe("ok");
    expect(resourceEditor.evaluation).toEqual(answer);
  });

  it("keeps the refusal of the dry run, and apply then sends nothing", async () => {
    await openApi();
    await type("api", "memory.limit", "768Mi");
    vi.mocked(applyResources).mockRejectedValueOnce(new Error("You are not allowed to change this deployment."));
    await resourceEditor.review();
    expect(resourceEditor.step).toBe("review");
    expect(resourceEditor.dryRun).toBe("failed");
    expect(resourceEditor.dryRunError).toBe("You are not allowed to change this deployment.");
    expect(await resourceEditor.apply()).toBe(false);
    expect(applyCalls(false)).toHaveLength(0);
  });

  it("does not take typing while on step 2", async () => {
    await openApi();
    await type("api", "memory.limit", "768Mi");
    await resourceEditor.review();
    resourceEditor.setField("api", "memory.limit", "2Gi");
    expect(resourceEditor.drafts.api["memory.limit"]).toBe("768Mi");
  });

  it("back returns to the fields with their text, and a late dry run answer is dropped", async () => {
    await openApi();
    await type("api", "memory.limit", "768Mi");
    const dry = deferred<ResourceEvaluation>();
    vi.mocked(applyResources).mockReturnValueOnce(dry.promise);
    const pending = resourceEditor.review();
    resourceEditor.back();
    expect(resourceEditor.step).toBe("edit");
    expect(resourceEditor.dryRun).toBe("idle");
    expect(resourceEditor.drafts.api["memory.limit"]).toBe("768Mi");
    dry.resolve(evaluation([finding({ message: "late" })]));
    await pending;
    expect(resourceEditor.dryRun).toBe("idle");
    expect(resourceEditor.evaluation?.findings[0].message).not.toBe("late");
  });
});

describe("apply", () => {
  async function reviewed(): Promise<void> {
    await openApi();
    await type("api", "memory.limit", "768Mi");
    await resourceEditor.review();
  }

  it("is refused before the dry run answered", async () => {
    await openApi();
    await type("api", "memory.limit", "768Mi");
    vi.mocked(applyResources).mockReturnValueOnce(deferred<ResourceEvaluation>().promise);
    void resourceEditor.review();
    expect(await resourceEditor.apply()).toBe(false);
    expect(applyCalls(false)).toHaveLength(0);
  });

  it("sends the real apply once, even when asked twice, and shows it as applying", async () => {
    await reviewed();
    const real = deferred<ResourceEvaluation>();
    vi.mocked(applyResources).mockReturnValueOnce(real.promise);
    const first = resourceEditor.apply();
    const second = resourceEditor.apply();
    expect(resourceEditor.applying).toBe(true);
    expect(resourceEditor.isApplying("default", "api")).toBe(true);
    expect(resourceEditor.isApplying("default", "web")).toBe(false);
    expect(await second).toBe(false);
    real.resolve(evaluation());
    expect(await first).toBe(true);
    expect(applyCalls(false)).toHaveLength(1);
    expect(applyCalls(false)[0][3]).toEqual(applyCalls(true)[0][3]);
    expect(applyCalls(false)[0][4]).toEqual(facts().seen);
    expect(resourceEditor.isApplying("default", "api")).toBe(false);
  });

  it("does not close while the apply runs", async () => {
    await reviewed();
    const real = deferred<ResourceEvaluation>();
    vi.mocked(applyResources).mockReturnValueOnce(real.promise);
    const pending = resourceEditor.apply();
    resourceEditor.close();
    expect(resourceEditor.target).toEqual({ namespace: "default", name: "api" });
    resourceEditor.back();
    expect(resourceEditor.step).toBe("review");
    real.resolve(evaluation());
    await pending;
  });

  it("on success closes, toasts and reloads the lists", async () => {
    await reviewed();
    vi.mocked(listDeployments).mockClear();
    expect(await resourceEditor.apply()).toBe(true);
    expect(resourceEditor.target).toBeNull();
    expect(resourceEditor.applying).toBe(false);
    expect(toasts.items.at(-1)).toMatchObject({
      message: "Resources of api updated, rollout started",
      tone: "ok",
    });
    await settle();
    expect(listDeployments).toHaveBeenCalled();
  });

  it("a failure after the user switched cluster says so in a toast, as the editor goes", async () => {
    await reviewed();
    const real = deferred<ResourceEvaluation>();
    vi.mocked(applyResources).mockReturnValueOnce(real.promise);
    const pending = resourceEditor.apply();
    app.activeCluster = "staging";
    flushSync();
    real.reject(new Error("The deployment is changing too fast to update. Try again."));
    expect(await pending).toBe(false);
    flushSync();
    expect(resourceEditor.target).toBeNull();
    expect(toasts.items.at(-1)).toMatchObject({
      message: "Could not update the resources of api: The deployment is changing too fast to update. Try again.",
      tone: "err",
    });
  });

  it("a failure with the editor still in view stays inline, without a toast", async () => {
    await reviewed();
    vi.mocked(applyResources).mockRejectedValueOnce(new Error("conflict"));
    await resourceEditor.apply();
    flushSync();
    expect(resourceEditor.applyError).toBe("conflict");
    expect(toasts.items).toHaveLength(0);
  });

  it("on failure stays on step 2 with the message", async () => {
    await reviewed();
    vi.mocked(applyResources).mockRejectedValueOnce(
      new Error("The deployment is changing too fast to update. Try again."),
    );
    expect(await resourceEditor.apply()).toBe(false);
    expect(resourceEditor.target).toEqual({ namespace: "default", name: "api" });
    expect(resourceEditor.step).toBe("review");
    expect(resourceEditor.applying).toBe(false);
    expect(resourceEditor.applyError).toBe("The deployment is changing too fast to update. Try again.");
  });
});

describe("restore", () => {
  it("opens on step 2 and runs the dry run of RESTORE_PROPOSAL", async () => {
    await openApi("restore");
    expect(resourceEditor.mode).toBe("restore");
    expect(resourceEditor.step).toBe("review");
    expect(applyResources).toHaveBeenCalledWith(KC, "default", "api", RESTORE_PROPOSAL, facts().seen, true, "prod");
    expect(resourceEditor.dryRun).toBe("ok");
    expect(resourceEditor.evaluation).not.toBeNull();
  });

  it("has its own check while the dry run runs", async () => {
    vi.mocked(applyResources).mockReturnValueOnce(deferred<ResourceEvaluation>().promise);
    await openApi("restore");
    expect(evaluateResources).toHaveBeenCalledWith(expect.anything(), RESTORE_PROPOSAL);
    expect(resourceEditor.dryRun).toBe("running");
    expect(resourceEditor.evaluation).toEqual(evaluation());
  });

  it("toasts the restore and has no step 1 to go back to", async () => {
    await openApi("restore");
    resourceEditor.back();
    expect(resourceEditor.step).toBe("review");
    expect(await resourceEditor.apply()).toBe(true);
    expect(applyCalls(false)[0][3]).toEqual(RESTORE_PROPOSAL);
    expect(toasts.items.at(-1)?.message).toBe("Resources of api restored, rollout started");
  });
});

describe("keepValues", () => {
  it("removes the mark, toasts and reloads", async () => {
    vi.mocked(listDeployments).mockClear();
    expect(await resourceEditor.keepValues(DEPLOYMENT)).toBe(true);
    expect(clearResourcesOverride).toHaveBeenCalledWith(KC, "default", "api", "prod");
    expect(toasts.items.at(-1)).toMatchObject({ message: "Override mark removed from api", tone: "ok" });
    await settle();
    expect(listDeployments).toHaveBeenCalled();
  });

  it("toasts the failure", async () => {
    vi.mocked(clearResourcesOverride).mockRejectedValueOnce(new Error("forbidden"));
    expect(await resourceEditor.keepValues(DEPLOYMENT)).toBe(false);
    expect(toasts.items.at(-1)).toMatchObject({ message: "Could not remove the mark: forbidden", tone: "err" });
  });
});

describe("the deployment leaves the list", () => {
  it("closes the editor with a toast", async () => {
    await resources.load();
    await openApi();
    flushSync();
    expect(resourceEditor.target).not.toBeNull();

    vi.mocked(listDeployments).mockResolvedValue([]);
    await resources.load();
    flushSync();
    expect(resourceEditor.target).toBeNull();
    expect(toasts.items.at(-1)).toMatchObject({ message: "Deployment api is gone" });
  });

  it("stays open while an apply runs, and closes once it is over", async () => {
    await resources.load();
    await openApi();
    await type("api", "memory.limit", "768Mi");
    await resourceEditor.review();
    const real = deferred<ResourceEvaluation>();
    vi.mocked(applyResources).mockReturnValueOnce(real.promise);
    const pending = resourceEditor.apply();

    vi.mocked(listDeployments).mockResolvedValue([]);
    await resources.load();
    flushSync();
    expect(resourceEditor.target).not.toBeNull();

    real.reject(new Error("deployments.apps \"api\" not found"));
    await pending;
    flushSync();
    expect(resourceEditor.target).toBeNull();
    expect(toasts.items.at(-1)?.message).toBe("Deployment api is gone");
  });

  it("is not judged on a list that failed to load", async () => {
    await resources.load();
    await openApi();
    // An empty list that only says the load failed.
    resources.clear();
    vi.mocked(listDeployments).mockRejectedValue(new Error("deployments is forbidden"));
    await resources.load();
    expect(resources.deployments).toEqual([]);
    flushSync();
    expect(resourceEditor.target).not.toBeNull();
  });

  it("closes when the view is no longer the Deployments list", async () => {
    await openApi();
    flushSync();
    app.navigate("pods");
    flushSync();
    expect(resourceEditor.target).toBeNull();
    app.navigate("deployments");
    flushSync();
    expect(resourceEditor.target).toBeNull();
    expect(toasts.items).toHaveLength(0);
  });

  it("stays open on another view while an apply runs, and closes once it is over", async () => {
    await openApi();
    await type("api", "memory.limit", "768Mi");
    await resourceEditor.review();
    const real = deferred<ResourceEvaluation>();
    vi.mocked(applyResources).mockReturnValueOnce(real.promise);
    const pending = resourceEditor.apply();
    app.navigate("pods");
    flushSync();
    expect(resourceEditor.target).not.toBeNull();
    real.resolve(evaluation());
    await pending;
    flushSync();
    expect(resourceEditor.target).toBeNull();
  });

  it("closes without a toast when the active cluster changes", async () => {
    await resources.load();
    await openApi();
    app.activeCluster = "staging";
    flushSync();
    expect(resourceEditor.target).toBeNull();
    expect(toasts.items).toHaveLength(0);
  });
});
