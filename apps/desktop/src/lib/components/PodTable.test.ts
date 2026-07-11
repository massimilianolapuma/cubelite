import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import PodTable from "./PodTable.svelte";
import type { PodInfo } from "$lib/tauri";

function pod(overrides: Partial<PodInfo> = {}): PodInfo {
  return {
    name: "api-0",
    namespace: "default",
    phase: "Running",
    ready: true,
    restarts: 0,
    ...overrides,
  };
}

describe("PodTable", () => {
  it("renders the spec'd column headers", () => {
    render(PodTable, { props: { pods: [] } });
    for (const h of ["Name", "Status", "Ready", "Age", "CPU", "Memory", "Restarts"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
  });

  it("shows the empty state when there are no pods", () => {
    render(PodTable, { props: { pods: [] } });
    expect(screen.getByText("No pods found.")).toBeInTheDocument();
  });

  it("renders pod name as plain text inside a clickable row (never a link)", () => {
    render(PodTable, { props: { pods: [pod()] } });
    const name = screen.getByText("api-0");
    expect(name.closest("a")).toBeNull();
    expect(name.closest("button")).not.toBeNull();
  });

  it("calls onRowClick with the pod", async () => {
    const onRowClick = vi.fn();
    render(PodTable, { props: { pods: [pod()], onRowClick } });
    await fireEvent.click(screen.getByText("api-0"));
    expect(onRowClick).toHaveBeenCalledWith(pod());
  });

  it("labels running-but-not-ready pods as NotReady", () => {
    render(PodTable, { props: { pods: [pod({ ready: false })] } });
    expect(screen.getByText("NotReady")).toBeInTheDocument();
  });

  it("styles restarts > 3 with the err color", () => {
    render(PodTable, { props: { pods: [pod({ restarts: 5 })] } });
    const cell = screen.getByText("5");
    expect(cell.getAttribute("style")).toContain("--color-status-err");
  });

  it("marks the selected row", () => {
    const p = pod();
    render(PodTable, { props: { pods: [p], selected: p } });
    const row = screen.getByText("api-0").closest("button");
    expect(row?.getAttribute("style")).toContain("--alpha-selection-bg");
  });
});
