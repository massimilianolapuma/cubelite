import { beforeEach, describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import PodTable from "./PodTable.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { layout } from "#lib/stores/layout.svelte.ts";
import { lists } from "#lib/stores/lists.svelte.ts";
import { mutations } from "#lib/stores/mutations.svelte.ts";
import type { PodInfo } from "#lib/tauri.ts";

function pod(overrides: Partial<PodInfo> = {}): PodInfo {
  return {
    name: "api-0",
    namespace: "default",
    phase: "Running",
    ready: true,
    restarts: 0,
    ready_containers: 1,
    total_containers: 1,
    node: null,
    pod_ip: null,
    qos_class: null,
    containers: [],
    labels: {},
    creation_timestamp: null,
    ...overrides,
  };
}

const rowOf = (name: string) => screen.getByText(name).closest<HTMLElement>('[role="button"]')!;

beforeEach(() => {
  lists.resetSession();
  lists.groupByNamespace = false;
  app.namespace = null;
  layout.contentWidth = 0;
});

describe("PodTable", () => {
  it("renders the spec'd column headers", () => {
    render(PodTable, { props: { pods: [pod()] } });
    for (const h of ["Name", "Status", "Ready", "Age", "CPU", "Memory", "Restarts"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
  });

  it("shows the empty state when there are no pods", () => {
    render(PodTable, { props: { pods: [] } });
    expect(screen.getByRole("heading", { name: "No pods in any namespace" })).toBeInTheDocument();
  });

  it("shows placeholder rows, not the empty state, while the first load is in flight (#606)", () => {
    render(PodTable, { props: { pods: [], loaded: false } });
    expect(screen.getByRole("status", { name: "Loading pods" })).toBeInTheDocument();
    expect(screen.queryByText(/^No pods/)).not.toBeInTheDocument();
  });

  it("shows a failed load with its message and retries (#606)", async () => {
    const onRetry = vi.fn();
    render(PodTable, { props: { pods: [], error: "connection reset", onRetry } });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load pods");
    expect(screen.getByRole("alert")).toHaveTextContent("connection reset");
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders pod name as plain text inside a clickable row (never a link)", () => {
    render(PodTable, { props: { pods: [pod()] } });
    const name = screen.getByText("api-0");
    expect(name.closest("a")).toBeNull();
    expect(rowOf("api-0")).toHaveAttribute("tabindex", "0");
  });

  it("gives a long name its full text as a tooltip", () => {
    render(PodTable, { props: { pods: [pod()] } });
    expect(screen.getByText("api-0")).toHaveAttribute("title", "api-0");
  });

  it("calls onRowClick with the pod", async () => {
    const onRowClick = vi.fn();
    render(PodTable, { props: { pods: [pod()], onRowClick } });
    await fireEvent.click(screen.getByText("api-0"));
    expect(onRowClick).toHaveBeenCalledWith(pod());
  });

  it("labels running-but-not-ready pods as NotReady, as an attention pill", () => {
    render(PodTable, { props: { pods: [pod({ ready: false })] } });
    const badge = screen.getByText("NotReady").closest("[data-state]")!;
    expect(badge).toHaveAttribute("data-state", "warn");
    expect(badge.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "warn");
  });

  it("tells each status by its own shape, not by colour", () => {
    render(PodTable, {
      props: {
        pods: [
          pod({ name: "a" }),
          pod({ name: "b", phase: "CrashLoopBackOff", ready: false }),
          pod({ name: "c", phase: "Succeeded", ready: false }),
          pod({ name: "d", phase: null, ready: false }),
        ],
      },
    });
    const glyph = (name: string) => rowOf(name).querySelector("[data-state] svg[data-glyph]")?.getAttribute("data-glyph");
    expect([glyph("a"), glyph("b"), glyph("c"), glyph("d")]).toEqual(["ok", "err", "done", "unknown"]);
  });

  it("marks restarts above 3 by weight, not by colour", () => {
    render(PodTable, { props: { pods: [pod({ restarts: 5 }), pod({ name: "calm", restarts: 2 })] } });
    const restarts = (name: string) => rowOf(name).querySelector("[data-attention]")!;
    expect(restarts("api-0")).toHaveTextContent("5");
    expect(restarts("api-0")).toHaveAttribute("data-attention", "true");
    expect(restarts("api-0").getAttribute("style") ?? "").not.toContain("color");
    expect(restarts("calm")).toHaveAttribute("data-attention", "false");
  });

  it("marks the selected row", () => {
    const p = pod();
    render(PodTable, { props: { pods: [p, pod({ name: "other" })], selected: p } });
    expect(rowOf("api-0")).toHaveAttribute("data-selected", "true");
    expect(rowOf("api-0")).toHaveAttribute("aria-current", "true");
    expect(rowOf("other")).toHaveAttribute("data-selected", "false");
    expect(rowOf("other")).not.toHaveAttribute("aria-current");
  });

  it("has no 'logs' chip on the selected row (Tonal §3 #10)", () => {
    const p = pod();
    render(PodTable, { props: { pods: [p], selected: p } });
    expect(screen.queryByText("logs")).toBeNull();
  });

  it("Enter on an already-selected row calls onLogs instead of onRowClick", async () => {
    const p = pod();
    const onRowClick = vi.fn();
    const onLogs = vi.fn();
    render(PodTable, { props: { pods: [p], selected: p, onRowClick, onLogs } });
    await fireEvent.keyDown(rowOf("api-0"), { key: "Enter" });
    expect(onLogs).toHaveBeenCalledWith(p);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("Enter on an unselected row calls onRowClick, not onLogs", async () => {
    const p = pod();
    const onRowClick = vi.fn();
    const onLogs = vi.fn();
    render(PodTable, { props: { pods: [p], selected: null, onRowClick, onLogs } });
    await fireEvent.keyDown(rowOf("api-0"), { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledWith(p);
    expect(onLogs).not.toHaveBeenCalled();
  });

  it("Space selects the row, like a button", async () => {
    const onRowClick = vi.fn();
    render(PodTable, { props: { pods: [pod()], onRowClick } });
    await fireEvent.keyDown(rowOf("api-0"), { key: " " });
    expect(onRowClick).toHaveBeenCalledWith(pod());
  });

  it("shows an inline spinner while the pod is being terminated", () => {
    mutations.pendingPodDeletes = { "default/api-0": true };
    try {
      render(PodTable, { props: { pods: [pod()] } });
      expect(screen.getByText("Terminating…")).toBeInTheDocument();
      expect(screen.queryByText("Running", { selector: "[data-state] *" })).toBeNull();
    } finally {
      mutations.pendingPodDeletes = {};
    }
  });
});

describe("PodTable status chips (Tonal §3 #7)", () => {
  const pods = [
    pod({ name: "ok-1" }),
    pod({ name: "ok-2" }),
    pod({ name: "crash", phase: "CrashLoopBackOff", ready: false }),
    pod({ name: "wait", phase: "Pending", ready: false }),
    pod({ name: "job", phase: "Succeeded", ready: false }),
  ];
  const chip = (name: RegExp) =>
    within(screen.getByRole("group", { name: "Filter by status" })).getByRole("button", { name });
  const names = () => screen.getAllByRole("button").filter((b) => b.hasAttribute("data-selected")).map((b) => b.querySelector("[title]")?.textContent);

  it("shows one chip per state present, worst first, with counts", () => {
    render(PodTable, { props: { pods } });
    const group = screen.getByRole("group", { name: "Filter by status" });
    expect([...group.querySelectorAll("button")].map((b) => b.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Failing 1",
      "Pending 1",
      "Running 2",
      "Completed 1",
    ]);
  });

  it("hides a chip whose state has no pod", () => {
    render(PodTable, { props: { pods: [pod()] } });
    const group = screen.getByRole("group", { name: "Filter by status" });
    expect(within(group).queryByRole("button", { name: /Failing/ })).toBeNull();
    expect(chip(/Running/)).toBeInTheDocument();
  });

  it("pressing chips keeps the pods of any pressed one", async () => {
    render(PodTable, { props: { pods } });
    await fireEvent.click(chip(/Failing/));
    expect(names()).toEqual(["crash"]);
    await fireEvent.click(chip(/Pending/));
    expect(names()).toEqual(["crash", "wait"]);
    expect(screen.getByTestId("list-count")).toHaveTextContent("2 of 5");
    await fireEvent.click(chip(/Failing/));
    await fireEvent.click(chip(/Pending/));
    expect(names()).toHaveLength(5);
  });

  it("a pressed chip with nothing left to show offers Clear filter, which releases it", async () => {
    lists.setStatus("pods", ["err"]);
    const onClearFilter = vi.fn();
    render(PodTable, { props: { pods: [pod()], onClearFilter } });
    expect(screen.getByRole("heading", { name: "No pods with the selected status" })).toBeInTheDocument();
    expect(chip(/Failing/)).toHaveAttribute("aria-pressed", "true");
    await fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(lists.pressed("pods")).toEqual([]);
    expect(onClearFilter).toHaveBeenCalledOnce();
    expect(screen.getByText("api-0")).toBeInTheDocument();
  });
});

describe("PodTable beside a docked detail panel (Tonal §3 #2)", () => {
  const headers = () => [...document.querySelectorAll(".list-head > *")].map((el) => el.textContent?.replace(/[▲▼].*/, "").trim());

  it("shows every column while nothing is selected, however wide the window", () => {
    layout.contentWidth = 1200;
    render(PodTable, { props: { pods: [pod()] } });
    expect(headers()).toEqual(["Name", "Namespace", "Status", "Ready", "Age", "CPU", "Memory", "Restarts"]);
  });

  it("keeps five identifying columns once the panel is docked", () => {
    layout.contentWidth = 1200;
    const p = pod();
    render(PodTable, { props: { pods: [p], selected: p } });
    expect(headers()).toEqual(["Name", "Namespace", "Status", "Ready", "Restarts"]);
  });

  it("drops the namespace column for Age when one namespace is selected", () => {
    layout.contentWidth = 1200;
    app.namespace = "default";
    const p = pod();
    render(PodTable, { props: { pods: [p], selected: p } });
    expect(headers()).toEqual(["Name", "Status", "Ready", "Age", "Restarts"]);
  });

  it("keeps every column when the panel overlays the list", () => {
    layout.contentWidth = 964;
    const p = pod();
    render(PodTable, { props: { pods: [p], selected: p } });
    expect(headers()).toHaveLength(8);
  });
});
