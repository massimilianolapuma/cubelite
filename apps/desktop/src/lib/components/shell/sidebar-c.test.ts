import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", () => ({
  discoverResourceKinds: vi.fn(async () => []),
  listResourceTable: vi.fn(async () => ({ columns: [], rows: [] })),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { discoverResourceKinds } from "#lib/tauri.ts";
import Sidebar from "./Sidebar.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { navigation } from "#lib/stores/navigation.svelte.ts";
import { profiles } from "#lib/stores/profiles.svelte.ts";
import { sidebar } from "#lib/stores/sidebar.svelte.ts";
import { dynamic } from "#lib/stores/dynamic.svelte.ts";
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

const pinned = () => within(screen.getByRole("list", { name: /^Pinned/ }));
const pinnedLabels = () => pinned().getAllByRole("listitem").map((li) => li.textContent?.replace(/\d+/g, "").trim());
// Section toggles read "<label> [pods need attention] <count>".
const section = (label: string) =>
  screen.getByRole("button", { name: new RegExp(`^${label}( pods need attention)? \\d+$`) });

let n = 0;

beforeEach(() => {
  window.localStorage.clear();
  profiles.reset();
  navigation.reset();
  sidebar.close();
  app.view = "overview";
  app.namespace = null;
  app.kubeconfigPath = "/k";
  app.activeCluster = `sidebar-c-${++n}`;
  app.preferencesOpen = false;
  app.paletteOpen = false;
  resources.pods = [];
  resources.events = [];
  resources.deployments = [];
  dynamic.clear();
});

describe("Sidebar C", () => {
  it("shows the active profile's pins and the section rows", () => {
    render(Sidebar);
    expect(screen.getByRole("list", { name: "Pinned · On-call" })).toBeInTheDocument();
    expect(pinnedLabels()).toEqual(["Overview", "Nodes", "Pods", "Deployments", "Jobs", "Events", "Logs"]);
    for (const label of ["Cluster", "Workloads", "Network", "Storage", "Config", "Access Control", "Observe"]) {
      expect(section(label)).toHaveAttribute("aria-expanded", "false");
    }
    expect(screen.getByRole("button", { name: /Profile: On-call/ })).toBeInTheDocument();
  });

  it("switching profile changes only the pinned list", async () => {
    render(Sidebar);
    profiles.activate("security");
    await vi.waitFor(() => expect(screen.getByRole("list", { name: "Pinned · Security" })).toBeInTheDocument());
    expect(pinnedLabels()).toEqual(["Service Accounts", "Roles", "Role Bindings", "Cluster Roles", "Secrets", "Network Policies"]);
    expect(section("Workloads")).toHaveAttribute("aria-expanded", "false");
  });

  it("opening a section closes the other", async () => {
    render(Sidebar);
    await fireEvent.click(section("Workloads"));
    expect(section("Workloads")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("DaemonSets")).toBeInTheDocument();
    await fireEvent.click(section("Network"));
    expect(section("Workloads")).toHaveAttribute("aria-expanded", "false");
    expect(section("Network")).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("DaemonSets")).toBeNull();
    for (const label of ["Services", "Ingresses", "Ingress Classes", "EndpointSlices", "Network Policies"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("shows how many types each section holds", () => {
    render(Sidebar);
    expect(section("Network")).toHaveTextContent("5");
    expect(section("Storage")).toHaveTextContent("3");
  });

  it("arrow keys move between sections, → opens, ← closes, Enter toggles", async () => {
    render(Sidebar);
    const workloads = section("Workloads");
    workloads.focus();
    await fireEvent.keyDown(workloads, { key: "ArrowDown" });
    expect(document.activeElement).toBe(section("Network"));
    await fireEvent.keyDown(section("Network"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(workloads);
    await fireEvent.keyDown(workloads, { key: "ArrowRight" });
    expect(workloads).toHaveAttribute("aria-expanded", "true");
    await fireEvent.keyDown(workloads, { key: "ArrowLeft" });
    expect(workloads).toHaveAttribute("aria-expanded", "false");
    await fireEvent.click(workloads); // Enter/Space on a native button fire click
    expect(workloads).toHaveAttribute("aria-expanded", "true");
  });

  it("a collapsed section shows the red dot for pods needing attention", async () => {
    resources.pods = [pod({ ready: false, phase: "Pending" })];
    render(Sidebar);
    expect(within(section("Workloads")).getByText("pods need attention")).toBeInTheDocument();
    expect(section("Workloads").querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "err");
    await fireEvent.click(section("Workloads"));
    expect(within(section("Workloads")).queryByText("pods need attention")).toBeNull();
  });

  it("a hidden pinned type leaves Pinned and comes back", async () => {
    render(Sidebar);
    navigation.setHidden("jobs", true);
    await vi.waitFor(() => expect(pinnedLabels()).not.toContain("Jobs"));
    navigation.setHidden("jobs", false);
    await vi.waitFor(() => expect(pinnedLabels()).toEqual(["Overview", "Nodes", "Pods", "Deployments", "Jobs", "Events", "Logs"]));
  });

  it("the active view's section opens when you navigate to it", async () => {
    render(Sidebar);
    app.navigate("daemonsets");
    await vi.waitFor(() => expect(section("Workloads")).toHaveAttribute("aria-expanded", "true"));
    const row = screen.getByText("DaemonSets").closest("button")!;
    expect(row).toHaveAttribute("aria-current", "page");
  });

  it("does not open a section for a pinned view", async () => {
    render(Sidebar);
    app.navigate("pods");
    await Promise.resolve();
    expect(section("Workloads")).toHaveAttribute("aria-expanded", "false");
    expect(pinned().getByText("Pods").closest("button")).toHaveAttribute("aria-current", "page");
  });

  it("a section you closed stays closed when pins change", async () => {
    render(Sidebar);
    app.navigate("daemonsets");
    await vi.waitFor(() => expect(section("Workloads")).toHaveAttribute("aria-expanded", "true"));
    await fireEvent.click(section("Workloads"));
    expect(section("Workloads")).toHaveAttribute("aria-expanded", "false");
    profiles.togglePin("services");
    await vi.waitFor(() => expect(pinnedLabels()).toContain("Services"));
    expect(section("Workloads")).toHaveAttribute("aria-expanded", "false");
  });

  it("a section you closed stays closed when the profile switches", async () => {
    render(Sidebar);
    app.navigate("daemonsets");
    await vi.waitFor(() => expect(section("Workloads")).toHaveAttribute("aria-expanded", "true"));
    await fireEvent.click(section("Workloads"));
    profiles.activate("security");
    await vi.waitFor(() => expect(screen.getByRole("list", { name: "Pinned · Security" })).toBeInTheDocument());
    expect(section("Workloads")).toHaveAttribute("aria-expanded", "false");
  });

  it("a section you closed stays closed when discovery finishes", async () => {
    render(Sidebar);
    app.navigate("daemonsets");
    await vi.waitFor(() => expect(section("Workloads")).toHaveAttribute("aria-expanded", "true"));
    await fireEvent.click(section("Workloads"));
    vi.mocked(discoverResourceKinds).mockResolvedValueOnce([
      { group: "cert-manager.io", version: "v1", kind: "Certificate", plural: "certificates", namespaced: true, short_names: [] },
    ]);
    await dynamic.discover(app.activeCluster!);
    await vi.waitFor(() => expect(dynamic.customKindCount).toBe(1));
    await Promise.resolve();
    expect(section("Workloads")).toHaveAttribute("aria-expanded", "false");
  });

  it("unpinning the active view opens its section", async () => {
    render(Sidebar);
    app.navigate("pods");
    await Promise.resolve();
    expect(section("Workloads")).toHaveAttribute("aria-expanded", "false");
    profiles.unpin("pods");
    await vi.waitFor(() => expect(section("Workloads")).toHaveAttribute("aria-expanded", "true"));
  });

  it("Unpin from the context menu removes the pin", async () => {
    render(Sidebar);
    await fireEvent.contextMenu(pinned().getByText("Jobs"));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin" }));
    expect(profiles.isPinned("jobs")).toBe(false);
    await vi.waitFor(() => expect(pinnedLabels()).not.toContain("Jobs"));
  });

  it("after Unpin from the context menu focus moves to the next pinned row", async () => {
    render(Sidebar);
    await fireEvent.contextMenu(pinned().getByText("Jobs"));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin" }));
    await vi.waitFor(() => expect(pinned().getByText("Events").closest("button")).toHaveFocus());
  });

  it("a long profile name stays on one line in the Pinned header", async () => {
    expect(profiles.create("Platform team on-call", "active")).toBeNull();
    render(Sidebar);
    const header = screen.getByText("Pinned · Platform team on-call");
    expect(header).toHaveClass("truncate");
    expect(header).toHaveAttribute("title", "Platform team on-call");
  });

  it("says how to pin when the profile has no pins", async () => {
    expect(profiles.create("Empty", "empty")).toBeNull();
    render(Sidebar);
    expect(screen.getByText("Pin any resource from its list header.")).toBeInTheDocument();
  });

  async function openMenu() {
    const trigger = screen.getByRole("button", { name: /Profile: / });
    await fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    await fireEvent.keyDown(trigger, { key: "Enter" });
    return screen.findByRole("menu");
  }

  it("picks a profile from the menu, with its shortcut hint", async () => {
    render(Sidebar);
    const menu = await openMenu();
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent?.replace(/\s+/g, " ").trim().split(" ")[0])).toEqual(["On-call", "Developer", "Security", "All"]);
    expect(items[0]).toHaveAttribute("aria-checked", "true");
    await fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Developer/ }));
    expect(profiles.active.id).toBe("developer");
  });

  it("Manage profiles… opens Preferences on Navigation", async () => {
    render(Sidebar);
    const menu = await openMenu();
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "Manage profiles…" }));
    expect(app.preferencesOpen).toBe(true);
    expect(app.preferencesSection).toBe("navigation");
  });

  it("Go to resource opens the palette", async () => {
    render(Sidebar);
    await fireEvent.click(screen.getByRole("button", { name: /Go to resource/ }));
    expect(app.paletteOpen).toBe(true);
  });

  it("greys a pinned kind the cluster does not serve", async () => {
    vi.mocked(discoverResourceKinds).mockResolvedValueOnce([]);
    await dynamic.discover(app.activeCluster as string);
    profiles.activate("security");
    render(Sidebar);
    expect(pinned().getByText("Service Accounts").closest("button")).toHaveAttribute("title", "Not available on this cluster");
    expect(pinned().getByText("Secrets").closest("button")).not.toHaveAttribute("title");
  });

  it("a greyed row says it is unavailable to screen readers too", async () => {
    vi.mocked(discoverResourceKinds).mockResolvedValueOnce([]);
    await dynamic.discover(app.activeCluster as string);
    profiles.activate("security");
    render(Sidebar);
    expect(pinned().getByRole("button", { name: /^Service Accounts\W+not available on this cluster$/ })).toBeInTheDocument();
  });
});
