import { describe, it, expect, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import PodTable from "./PodTable.svelte";
import NavigationPreferences from "./NavigationPreferences.svelte";
import Sidebar from "./shell/Sidebar.svelte";
import { navigation } from "#lib/stores/navigation.svelte.ts";
import { lists } from "#lib/stores/lists.svelte.ts";
import { app } from "#lib/stores/app.svelte.ts";
import type { PodInfo } from "#lib/tauri.ts";

function pod(name: string, overrides: Partial<PodInfo> = {}): PodInfo {
  return {
    name,
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

const rowNames = () =>
  screen.getAllByRole("button").map((b) => b.textContent ?? "").filter((t) => t.startsWith("pod-")).map((t) => t.split(/\s/)[0]);

beforeEach(() => {
  navigation.reset();
  lists.defaultSort = { field: "api", dir: "asc" };
  lists.resetSession();
});

describe("list sort (#496)", () => {
  const pods = [
    pod("pod-10", { restarts: 1 }),
    pod("pod-2", { phase: "Failed", restarts: 7 }),
    pod("pod-1", { restarts: 3 }),
  ];

  it("keeps API order by default", () => {
    render(PodTable, { props: { pods } });
    expect(rowNames()).toEqual(["pod-10", "pod-2", "pod-1"]);
  });

  it("applies the Preferences default", () => {
    lists.defaultSort = { field: "name", dir: "asc" };
    render(PodTable, { props: { pods } });
    expect(rowNames()).toEqual(["pod-1", "pod-2", "pod-10"]);
  });

  it("header clicks sort, flip and return to the default", async () => {
    render(PodTable, { props: { pods } });
    const restarts = screen.getByRole("button", { name: /^Sort by Restarts/ });
    await fireEvent.click(restarts);
    expect(rowNames()).toEqual(["pod-2", "pod-1", "pod-10"]);
    expect(restarts).toHaveAttribute("data-sort", "descending");
    await fireEvent.click(restarts);
    expect(rowNames()).toEqual(["pod-10", "pod-1", "pod-2"]);
    await fireEvent.click(restarts);
    expect(rowNames()).toEqual(["pod-10", "pod-2", "pod-1"]);
    expect(restarts).toHaveAttribute("data-sort", "none");
  });

  it("status puts problems first and the override clears on cluster switch", async () => {
    render(PodTable, { props: { pods } });
    await fireEvent.click(screen.getByRole("button", { name: /^Sort by Status/ }));
    expect(rowNames()[0]).toBe("pod-2");
    app.resetForClusterSwitch();
    expect(lists.specFor("pods")).toEqual({ field: "api", dir: "asc" });
  });
});

describe("navigation preferences (#496)", () => {
  it("hiding a type removes it from the sidebar, empty sections disappear", async () => {
    render(NavigationPreferences);
    render(Sidebar);
    await fireEvent.click(screen.getByRole("button", { name: "Hide Services" }));
    await fireEvent.click(screen.getByRole("button", { name: "Hide Ingresses" }));
    const aside = document.querySelector("aside")!;
    expect(within(aside).queryByText("Services")).toBeNull();
    expect(within(aside).queryByText("Network")).toBeNull();
    expect(screen.getByRole("button", { name: "Show Services" })).toHaveAttribute("aria-pressed", "true");
  });

  it("moves items within a section and sections among themselves", async () => {
    render(NavigationPreferences);
    render(Sidebar);
    await fireEvent.click(screen.getByRole("button", { name: "Move Deployments up" }));
    await fireEvent.click(screen.getByRole("button", { name: "Move Observe section up" }));
    const aside = document.querySelector("aside")!;
    const labels = [...aside.querySelectorAll("button")].map((b) => b.textContent?.trim().split(/\s+/)[0]);
    expect(labels.indexOf("Deployments")).toBeLessThan(labels.indexOf("Pods"));
    expect(labels.indexOf("Events")).toBeLessThan(labels.indexOf("ConfigMaps"));
  });

  it("Overview cannot be moved or hidden; first items cannot move up", () => {
    render(NavigationPreferences);
    expect(screen.queryByRole("button", { name: "Hide Overview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move Cluster section down" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move Nodes up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Workloads section up" })).toBeDisabled();
  });

  it("Reset to default restores order and visibility", async () => {
    navigation.setHidden("pods", true);
    render(NavigationPreferences);
    await fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(navigation.isHidden("pods")).toBe(false);
    expect(window.localStorage.getItem("cubelite.navigation")).toBeNull();
  });

  it("the default sort selector persists", async () => {
    render(NavigationPreferences);
    await fireEvent.change(screen.getByLabelText("Default sort field"), { target: { value: "age" } });
    expect(lists.defaultSort).toEqual({ field: "age", dir: "asc" });
    await fireEvent.click(screen.getByRole("radio", { name: "Descending" }));
    expect(JSON.parse(window.localStorage.getItem("cubelite.lists.sort")!)).toEqual({ field: "age", dir: "desc" });
  });
});
