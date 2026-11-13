import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";

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
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import ResourceEditor from "./ResourceEditor.svelte";
import {
  applyResources,
  evaluateResources,
  resourceFacts,
  type ContainerResourcesInfo,
  type DeploymentInfo,
  type Finding,
  type ManagerInfo,
  type NodeProjection,
  type ResourceEvaluation,
  type ResourceFacts,
} from "#lib/tauri.ts";
import { EVALUATE_DEBOUNCE_MS, resourceEditor } from "#lib/stores/resourceEditor.svelte.ts";
import { app } from "#lib/stores/app.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { toasts } from "#lib/stores/toasts.svelte.ts";
import { EMPTY } from "#lib/empty.ts";

const Mi = 1024 * 1024;
const q = (text: string, amount: number | null) => ({ text, amount });

const DEPLOYMENT: DeploymentInfo = {
  name: "api",
  namespace: "default",
  replicas: 2,
  ready_replicas: 2,
  images: [],
  selector: {},
  strategy: "RollingUpdate",
  conditions: [],
  creation_timestamp: null,
};

/** cpu 250m / 500m, memory 256Mi / 512Mi. */
const WORKER: ContainerResourcesInfo = {
  cpu: { request: q("250m", 250), limit: q("500m", 500) },
  memory: { request: q("256Mi", 256 * Mi), limit: q("512Mi", 512 * Mi) },
};
/** A native sidecar with a CPU request and a memory limit only. */
const ENVOY: ContainerResourcesInfo = {
  cpu: { request: q("100m", 100), limit: null },
  memory: { request: null, limit: q("128Mi", 128 * Mi) },
};

function facts(manager: ManagerInfo = { kind: "none", release: null }): ResourceFacts {
  return {
    workload: {
      namespace: "default",
      name: "api",
      resource_version: "812",
      generation: 4,
      replicas: 2,
      rollout: { recreate: false, max_surge: 1, max_unavailable: 0 },
      containers: [{ name: "worker", image: null, sidecar: false, resources: WORKER }],
      init_containers: [{ name: "envoy", image: null, sidecar: true, resources: ENVOY }],
      overhead: { cpu_millis: 0, memory_bytes: 0 },
      manager,
      override_annotation: null,
    },
    seen: { generation: 4, resources: { worker: WORKER, envoy: ENVOY }, override_annotation: null },
    pods: [
      {
        name: "api-0",
        node: "node-1",
        figures: {
          request: { cpu_millis: 350, memory_bytes: 256 * Mi },
          cpu_limit: null,
          memory_limit: 640 * Mi,
          set_limits: { cpu_millis: 500, memory_bytes: 640 * Mi },
        },
        usage: [{ name: "worker", cpu_millis: 260, memory_bytes: 498 * Mi }],
      },
      {
        name: "api-1",
        node: "node-1",
        figures: {
          request: { cpu_millis: 350, memory_bytes: 256 * Mi },
          cpu_limit: null,
          memory_limit: 640 * Mi,
          set_limits: { cpu_millis: 500, memory_bytes: 640 * Mi },
        },
        usage: [{ name: "worker", cpu_millis: 412, memory_bytes: 300 * Mi }],
      },
    ],
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

const same = (n: number) => ({ before: n, after: n });
function node(name: string, ownPods: number, memoryLimits: { before: number; after: number }): NodeProjection {
  return {
    name,
    schedulable: true,
    own_pods: ownPods,
    cpu_requests: same(40),
    memory_requests: same(50),
    cpu_limits: same(60),
    memory_limits: memoryLimits,
    memory_if_full: null,
  };
}

const NODES = [node("node-1", 2, { before: 81, after: 93 }), node("node-2", 0, same(52)), node("node-3", 0, same(30))];

function evaluation(findings: Finding[] = [finding()], nodes: NodeProjection[] = NODES): ResourceEvaluation {
  return { findings, changes: [], nodes };
}

const BLOCKED = finding({
  code: "b3",
  level: "blocked",
  message: "The limit (128Mi) is under the request (256Mi).",
  container: "worker",
  resource: "memory",
  field: "limit",
});

const MEMORY_LIMIT_CHANGE = {
  container: "worker",
  sidecar: false,
  resource: "memory" as const,
  field: "limit" as const,
  before: "512Mi",
  after: "768Mi",
};
const WARNING = finding({
  code: "w2",
  level: "warning",
  message: "Memory limits on node-1 add up to 103% of what the node has (was 91%). Under memory pressure the node evicts pods.",
  resource: "memory",
  node: "node-1",
});
const NOT_CHECKED = finding({
  code: "w9",
  level: "not_checked",
  message: "Not checked: namespace quota (not allowed to read ResourceQuota).",
});

/** What the dry run answers: the memory limit of worker raised, with these findings. */
function reviewed(findings: Finding[] = [finding()]): ResourceEvaluation {
  return { findings, changes: [MEMORY_LIMIT_CHANGE], nodes: NODES };
}

/** Lets every settled promise run its continuation. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

/** Open the editor on api, render it and wait for the facts and the first check. */
async function openEditor(): Promise<void> {
  render(ResourceEditor);
  await resourceEditor.open(DEPLOYMENT);
  await settle();
}

/** Type into a field and let the debounced check answer. */
async function typeInto(label: string, text: string): Promise<void> {
  await fireEvent.input(screen.getByLabelText(label), { target: { value: text } });
  await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
  await settle();
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const card = (container: string) => screen.getByRole("group", { name: container });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resourceEditor.close();
  resources.clear();
  toasts.items = [];
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod-aks";
  app.namespace = "default";
  vi.mocked(resourceFacts).mockImplementation(async () => facts());
  vi.mocked(evaluateResources).mockImplementation(async () => evaluation());
  vi.mocked(applyResources).mockImplementation(async () => reviewed());
});

afterEach(() => {
  resourceEditor.close();
  vi.useRealTimers();
});

describe("ResourceEditor, step 1 (Edit)", () => {
  it("is titled after the deployment and says where it is, without a manager when none was recognised", async () => {
    await openEditor();
    expect(screen.getByRole("dialog", { name: "Adjust resources · api" })).toBeInTheDocument();
    expect(screen.getByTestId("editor-context")).toHaveTextContent(/^default · prod-aks · 2 replicas$/);
  });

  it("names the manager in the header line", async () => {
    vi.mocked(resourceFacts).mockImplementation(async () => facts({ kind: "argo_cd", release: null }));
    await openEditor();
    expect(screen.getByTestId("editor-context")).toHaveTextContent(
      /^default · prod-aks · 2 replicas · managed by Argo CD$/,
    );
  });

  it("says it is reading the cluster until the facts arrive", async () => {
    vi.mocked(resourceFacts).mockImplementation(() => new Promise(() => {}));
    render(ResourceEditor);
    void resourceEditor.open(DEPLOYMENT);
    await settle();
    expect(screen.getByText("Reading the cluster…")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows why the facts could not be read, offers Try again and no field", async () => {
    vi.mocked(resourceFacts).mockRejectedValueOnce(new Error("pods is forbidden: User cannot list resource pods"));
    await openEditor();
    expect(screen.getByRole("alert")).toHaveTextContent("pods is forbidden: User cannot list resource pods");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();

    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(resourceFacts).toHaveBeenCalledTimes(2);
    expect(field("worker memory limit")).toHaveValue("512Mi");
  });

  it("shows one block per container, the sidecar marked, with the cluster's values in the four fields", async () => {
    await openEditor();
    expect(field("worker CPU request")).toHaveValue("250m");
    expect(field("worker CPU limit")).toHaveValue("500m");
    expect(field("worker memory request")).toHaveValue("256Mi");
    expect(field("worker memory limit")).toHaveValue("512Mi");
    expect(field("envoy CPU limit")).toHaveValue("");
    expect(within(card("envoy")).getByText("sidecar")).toBeInTheDocument();
    // An unset request says what Kubernetes uses instead.
    expect(field("envoy memory request")).toHaveAttribute("placeholder", "= limit");
    // An unset limit is an empty value.
    expect(field("envoy CPU limit")).toHaveAttribute("placeholder", EMPTY);
  });

  it("shows usage now, the highest of the pods, and an empty value without a sample", async () => {
    await openEditor();
    const worker = card("worker");
    expect(within(worker).getByTestId("now-cpu")).toHaveTextContent("412m");
    expect(within(worker).getByTestId("now-memory")).toHaveTextContent("498Mi");
    const envoy = card("envoy");
    expect(within(envoy).getByTestId("now-cpu")).toHaveTextContent(EMPTY);
    expect(within(envoy).getByTestId("now-memory")).toHaveTextContent(EMPTY);
  });

  it("sends what is typed to the store", async () => {
    await openEditor();
    const setField = vi.spyOn(resourceEditor, "setField");
    await typeInto("worker memory limit", "768Mi");
    expect(setField).toHaveBeenCalledWith("worker", "memory.limit", "768Mi");
    expect(resourceEditor.drafts.worker["memory.limit"]).toBe("768Mi");
    setField.mockRestore();
  });

  it("marks a changed field with a weight, a glyph and the value it had", async () => {
    await openEditor();
    expect(within(card("worker")).getByText("(unchanged)")).toBeVisible();
    await typeInto("worker memory limit", "768Mi");
    const input = field("worker memory limit");
    expect(input).toHaveClass("font-semibold");
    expect(input.closest("[data-field]")).toHaveAttribute("data-changed", "true");
    expect(input.closest("[data-field]")!.querySelector('[data-glyph="warn"]')).not.toBeNull();
    expect(within(card("worker")).getByText("was 512Mi")).toBeInTheDocument();
    expect(field("worker memory request")).not.toHaveClass("font-semibold");
    // "(unchanged)" keeps its room, so the name does not move; it is no longer shown.
    expect(within(card("worker")).getByText("(unchanged)")).toHaveClass("invisible");
    expect(within(card("envoy")).getByText("(unchanged)")).not.toHaveClass("invisible");
  });

  it("says was and an empty value for a field the cluster had not set", async () => {
    await openEditor();
    await typeInto("envoy CPU limit", "200m");
    expect(within(card("envoy")).getByText(`was ${EMPTY}`)).toBeInTheDocument();
  });

  it("marks a blocked field invalid, with its message under it and in the list, and Review disabled", async () => {
    vi.mocked(evaluateResources).mockImplementation(async (_facts, proposal) =>
      proposal.containers.length > 0 ? evaluation([BLOCKED]) : evaluation(),
    );
    await openEditor();
    await typeInto("worker memory limit", "128Mi");
    const input = field("worker memory limit");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const message = document.getElementById(describedBy!);
    expect(message).toHaveTextContent("The limit (128Mi) is under the request (256Mi).");
    expect(message!.querySelector('[data-glyph="err"]')).not.toBeNull();
    expect(card("worker")).toContainElement(message);
    // The field's own mark is the error's square, not the changed triangle.
    expect(input.closest("[data-field]")!.querySelector('[data-glyph="err"]')).not.toBeNull();
    const list = screen.getByRole("list", { name: "Findings" });
    expect(within(list).getByText("The limit (128Mi) is under the request (256Mi).")).toHaveClass("font-semibold");
    expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
    // The other fields are not invalid.
    expect(field("worker memory request")).not.toHaveAttribute("aria-invalid");
  });

  it("enables Review once a change is checked and nothing blocks it", async () => {
    await openEditor();
    const review = screen.getByRole("button", { name: "Review" });
    expect(review).toBeDisabled();
    await fireEvent.input(field("worker memory limit"), { target: { value: "768Mi" } });
    // While the check runs, Review waits for it.
    expect(review).toBeDisabled();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    await settle();
    expect(review).toBeEnabled();
  });

  it("keeps the last findings, quieter, while the check runs", async () => {
    await openEditor();
    const list = screen.getByRole("list", { name: "Findings" });
    expect(list).toHaveAttribute("aria-live", "polite");
    expect(list).not.toHaveClass("text-text-muted");
    await fireEvent.input(field("worker memory limit"), { target: { value: "768Mi" } });
    expect(screen.getByRole("list", { name: "Findings" })).toHaveClass("text-text-muted");
    expect(within(list).getByText(/^Fits:/)).toBeInTheDocument();
  });

  it("shows a check that could not run where the findings would be", async () => {
    vi.mocked(evaluateResources).mockRejectedValue(new Error("the check failed: bad facts"));
    await openEditor();
    expect(screen.getByRole("alert")).toHaveTextContent("the check failed: bad facts");
    expect(screen.queryByRole("list", { name: "Findings" })).toBeNull();
  });

  it("a quick step raises the memory limit when no field had focus", async () => {
    await openEditor();
    const worker = card("worker");
    expect(within(worker).getByText("on memory limit")).toBeInTheDocument();
    await fireEvent.click(within(worker).getByRole("button", { name: "Raise memory limit of worker by 50%" }));
    expect(field("worker memory limit")).toHaveValue("768Mi");
  });

  it("a quick step raises the field of that container that had focus last", async () => {
    await openEditor();
    const worker = card("worker");
    await fireEvent.focus(field("worker CPU request"));
    expect(within(worker).getByText("on CPU request")).toBeInTheDocument();
    await fireEvent.click(within(worker).getByRole("button", { name: "Raise CPU request of worker by 25%" }));
    expect(field("worker CPU request")).toHaveValue("320m");
    await fireEvent.click(within(worker).getByRole("button", { name: "Double CPU request of worker" }));
    expect(field("worker CPU request")).toHaveValue("500m");
    expect(field("worker memory limit")).toHaveValue("512Mi");
  });

  it("a quick step is disabled for a field the cluster has no value for", async () => {
    await openEditor();
    const envoy = card("envoy");
    await fireEvent.focus(field("envoy CPU limit"));
    for (const name of [
      "Raise CPU limit of envoy by 25%",
      "Raise CPU limit of envoy by 50%",
      "Double CPU limit of envoy",
    ]) {
      expect(within(envoy).getByRole("button", { name })).toBeDisabled();
    }
    await fireEvent.focus(field("envoy memory limit"));
    expect(within(envoy).getByRole("button", { name: "Raise memory limit of envoy by 25%" })).toBeEnabled();
  });

  it("reset puts a container back to the cluster's values", async () => {
    await openEditor();
    const worker = card("worker");
    const reset = within(worker).getByRole("button", { name: "Reset worker to the cluster's values" });
    expect(reset).toBeDisabled();
    await typeInto("worker memory limit", "768Mi");
    await typeInto("worker CPU limit", "1");
    expect(reset).toBeEnabled();
    await fireEvent.click(reset);
    expect(field("worker memory limit")).toHaveValue("512Mi");
    expect(field("worker CPU limit")).toHaveValue("500m");
  });

  it("shows the nodes hosting the pods before and after, the caption, the others behind a disclosure and the estimate", async () => {
    await openEditor();
    const nodes = screen.getByRole("region", { name: "Nodes these pods run on" });
    expect(within(nodes).getByText("memory limits")).toBeInTheDocument();
    const hosting = within(nodes).getByTestId("node-node-1");
    expect(within(hosting).getByText("2 pods here")).toBeInTheDocument();
    const meters = hosting.querySelectorAll("[data-level]");
    expect(meters).toHaveLength(2);
    expect(within(hosting).getByText("81%")).toBeInTheDocument();
    expect(within(hosting).getByText("93%")).toBeInTheDocument();

    const toggle = within(nodes).getByRole("button", { name: "2 other nodes" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(nodes).queryByTestId("node-node-2")).toBeNull();
    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const other = within(nodes).getByTestId("node-node-2");
    expect(within(other).getByText(EMPTY)).toBeInTheDocument();
    // No change on that node: one bar, no arrow.
    expect(other.querySelectorAll("[data-level]")).toHaveLength(1);
    expect(within(nodes).getByText("Estimate from capacity. Node selectors, taints and affinity are not considered.")).toBeInTheDocument();
  });

  it("shows no node section when the check projects no node", async () => {
    vi.mocked(evaluateResources).mockImplementation(async () => evaluation([finding()], []));
    await openEditor();
    expect(screen.queryByRole("region", { name: "Nodes these pods run on" })).toBeNull();
    expect(screen.queryByText(/Estimate from capacity/)).toBeNull();
  });

  it("Cancel closes the editor", async () => {
    await openEditor();
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(resourceEditor.target).toBeNull();
  });

  it("moves focus to its title when it opens, and back to what opened it when it closes", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    await openEditor();
    const heading = screen.getByRole("heading", { name: "Adjust resources · api" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveFocus();
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

/** Open the editor, change worker's memory limit to 768Mi and go to Review. */
async function toReview(): Promise<void> {
  await openEditor();
  await typeInto("worker memory limit", "768Mi");
  await fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await settle();
}

const dryRuns = (dryRun: boolean) => vi.mocked(applyResources).mock.calls.filter((call) => call[5] === dryRun);

describe("ResourceEditor, step 2 (Review)", () => {
  it("is titled Review, lists only what changes and says nothing else does", async () => {
    await toReview();
    expect(screen.getByRole("dialog", { name: "Review · api" })).toBeInTheDocument();
    const changes = screen.getByRole("list", { name: "Changes" });
    const rows = within(changes).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(/^worker\s*Memory limit\s*512Mi → 768Mi$/);
    expect(screen.getByText("(nothing else changes)")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("writes an unset value as an empty one", async () => {
    vi.mocked(applyResources).mockImplementation(async () => ({
      findings: [finding()],
      changes: [{ ...MEMORY_LIMIT_CHANGE, container: "envoy", sidecar: true, resource: "cpu", before: null, after: "200m" }],
      nodes: [],
    }));
    await toReview();
    expect(within(screen.getByRole("list", { name: "Changes" })).getByRole("listitem")).toHaveTextContent(
      `envoy CPU limit ${EMPTY} → 200m`,
    );
  });

  it("says what happens: the rollout, the manager and the override mark", async () => {
    vi.mocked(resourceFacts).mockImplementation(async () => facts({ kind: "argo_cd", release: null }));
    await toReview();
    const happens = screen.getByRole("list", { name: "What happens" });
    // Each item: a bullet (decorative, hidden from assistive technology) and the sentence.
    expect(within(happens).getAllByRole("listitem").map((li) => li.lastElementChild?.textContent?.trim())).toEqual([
      "The deployment rolls out: 2 pods are replaced (RollingUpdate, 1 at a time).",
      "Argo CD manages this workload. If self-heal is on, it will undo this change at its next sync.",
      "CubeLite marks the deployment as overridden, so the change stays visible and can be restored.",
    ]);
  });

  it("runs the dry run of the exact change and says so while it runs", async () => {
    let answer!: (e: ResourceEvaluation) => void;
    vi.mocked(applyResources).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await openEditor();
    await typeInto("worker memory limit", "768Mi");
    await fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("status")).toHaveTextContent("Checking with the cluster…");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(dryRuns(true)).toHaveLength(1);
    expect(dryRuns(true)[0][3]).toEqual({
      kind: "adjust",
      containers: [{ name: "worker", resources: { cpu: { request: "250m", limit: "500m" }, memory: { request: "256Mi", limit: "768Mi" } } }],
    });
    answer(reviewed());
    await settle();
    expect(screen.queryByText("Checking with the cluster…")).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("offers Apply when nothing needs a decision", async () => {
    await toReview();
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: /^Warnings/ })).toBeNull();
    // The notes still show, without a count.
    expect(within(screen.getByRole("list", { name: "Notes" })).getByText(/^Fits:/)).toBeInTheDocument();
  });

  it("offers Apply anyway with a warning, shown again in full under its count", async () => {
    vi.mocked(applyResources).mockImplementation(async () => reviewed([WARNING, finding()]));
    await toReview();
    expect(screen.getByRole("button", { name: "Apply anyway" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Warnings (1)" })).toBeInTheDocument();
    const warnings = screen.getByRole("list", { name: "Warnings" });
    expect(within(warnings).getByText(WARNING.message)).toBeInTheDocument();
    expect(within(warnings).queryByText(/^Fits:/)).toBeNull();
  });

  it("offers Apply anyway for a lone not-checked finding, counted as a warning", async () => {
    vi.mocked(applyResources).mockImplementation(async () => reviewed([NOT_CHECKED]));
    await toReview();
    expect(screen.getByRole("button", { name: "Apply anyway" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Warnings (1)" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Warnings" })).getByText(NOT_CHECKED.message)).toBeInTheDocument();
  });

  it("shows a refused dry run inline, and offers nothing to apply", async () => {
    vi.mocked(applyResources).mockRejectedValueOnce(new Error("You are not allowed to change this deployment."));
    await toReview();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("You are not allowed to change this deployment.");
    expect(alert.querySelector('[data-glyph="err"]')).not.toBeNull();
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    await fireEvent.click(apply);
    await settle();
    expect(dryRuns(false)).toHaveLength(0);
  });

  it("applies once, closes, and says the rollout started", async () => {
    await toReview();
    const apply = screen.getByRole("button", { name: "Apply" });
    await fireEvent.click(apply);
    await fireEvent.click(apply);
    await settle();
    expect(dryRuns(false)).toHaveLength(1);
    expect(resourceEditor.target).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toasts.items.map((t) => t.message)).toContain("Resources of api updated, rollout started");
  });

  it("shows the apply as pending while it runs, and Esc does not close it", async () => {
    let done!: (e: ResourceEvaluation) => void;
    await toReview();
    vi.mocked(applyResources).mockImplementationOnce(() => new Promise((resolve) => (done = resolve)));
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("button", { name: "Apply" })).toHaveAttribute("aria-busy", "true");
    expect(app.closeTopOverlay()).toBe(true);
    await settle();
    expect(screen.getByRole("dialog", { name: "Review · api" })).toBeInTheDocument();
    done(reviewed());
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a failed apply inline, still on Review", async () => {
    await toReview();
    vi.mocked(applyResources).mockRejectedValueOnce(
      new Error("The deployment's resources changed since you opened this. Reopen and try again."),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await settle();
    expect(screen.getByRole("dialog", { name: "Review · api" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The deployment's resources changed since you opened this. Reopen and try again.",
    );
  });

  it("Back returns to the fields with what was typed", async () => {
    await toReview();
    await fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await settle();
    expect(screen.getByRole("dialog", { name: "Adjust resources · api" })).toBeInTheDocument();
    expect(field("worker memory limit")).toHaveValue("768Mi");
    expect(within(card("worker")).getByText("was 512Mi")).toBeInTheDocument();
  });

  it("moves focus to the step's heading on Review and on Back", async () => {
    await openEditor();
    await typeInto("worker memory limit", "768Mi");
    // A click or a key press leaves focus on the button: it is the step that moves it.
    const review = screen.getByRole("button", { name: "Review" });
    review.focus();
    await fireEvent.click(review);
    await settle();
    expect(screen.getByRole("heading", { name: "Review · api" })).toHaveFocus();
    const back = screen.getByRole("button", { name: "Back" });
    back.focus();
    await fireEvent.click(back);
    await settle();
    expect(screen.getByRole("heading", { name: "Adjust resources · api" })).toHaveFocus();
  });

  it("a restore opens on Review: Restore, Cancel instead of Back, and the mark is removed", async () => {
    vi.mocked(applyResources).mockImplementation(async () => ({
      findings: [finding()],
      changes: [{ ...MEMORY_LIMIT_CHANGE, before: "768Mi", after: "512Mi" }],
      nodes: [],
    }));
    render(ResourceEditor);
    await resourceEditor.open(DEPLOYMENT, "restore");
    await settle();
    expect(screen.getByRole("dialog", { name: "Restore · api" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Restore · api" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Changes" })).getByRole("listitem")).toHaveTextContent(
      "worker Memory limit 768Mi → 512Mi",
    );
    expect(within(screen.getByRole("list", { name: "What happens" })).getByText("The override mark is removed.")).toBeInTheDocument();
    const restore = screen.getByRole("button", { name: "Restore" });
    expect(restore).toBeEnabled();
    await fireEvent.click(restore);
    await settle();
    expect(dryRuns(false)[0][3]).toEqual({ kind: "restore", containers: [] });
    expect(toasts.items.map((t) => t.message)).toContain("Resources of api restored, rollout started");
  });

  it("a restore with a warning offers Restore anyway", async () => {
    vi.mocked(applyResources).mockImplementation(async () => ({
      findings: [WARNING],
      changes: [{ ...MEMORY_LIMIT_CHANGE, before: "768Mi", after: "512Mi" }],
      nodes: [],
    }));
    render(ResourceEditor);
    await resourceEditor.open(DEPLOYMENT, "restore");
    await settle();
    expect(screen.getByRole("button", { name: "Restore anyway" })).toBeEnabled();
  });
});
