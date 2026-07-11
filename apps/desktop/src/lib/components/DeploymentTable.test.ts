import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import DeploymentTable from "./DeploymentTable.svelte";
import type { DeploymentInfo } from "$lib/tauri";

function dep(overrides: Partial<DeploymentInfo> = {}): DeploymentInfo {
  return {
    name: "api",
    namespace: "default",
    replicas: 3,
    ready_replicas: 3,
    ...overrides,
  };
}

describe("DeploymentTable", () => {
  it("renders the spec'd column headers", () => {
    render(DeploymentTable, { props: { deployments: [] } });
    for (const h of ["Name", "Ready", "Status", "Age", "Replicas · Actions"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
  });

  it("shows the empty state when there are no deployments", () => {
    render(DeploymentTable, { props: { deployments: [] } });
    expect(screen.getByText("No deployments found.")).toBeInTheDocument();
  });

  it("derives Available when all replicas are ready", () => {
    render(DeploymentTable, { props: { deployments: [dep()] } });
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByText("3/3")).toBeInTheDocument();
  });

  it("derives Progressing when replicas are missing", () => {
    render(DeploymentTable, { props: { deployments: [dep({ ready_replicas: 1 })] } });
    expect(screen.getByText("Progressing")).toBeInTheDocument();
  });

  it("renders the stepper and Restart disabled with a reason", () => {
    render(DeploymentTable, { props: { deployments: [dep()] } });
    const restart = screen.getByText("Restart").closest("button");
    expect(restart).toBeDisabled();
    expect(restart).toHaveAttribute("title", "Requires backend support");
  });

  it("calls onRowClick with the deployment", async () => {
    const onRowClick = vi.fn();
    render(DeploymentTable, { props: { deployments: [dep()], onRowClick } });
    await fireEvent.click(screen.getByText("api"));
    expect(onRowClick).toHaveBeenCalledWith(dep());
  });
});
