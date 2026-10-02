import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  listEvents: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("mode-watcher", () => ({
  setMode: vi.fn(),
}));

import { setMode } from "mode-watcher";
import Toaster from "./ui/Toaster.svelte";
import DeletePodDialog from "./DeletePodDialog.svelte";
import PreferencesModal from "./PreferencesModal.svelte";
import OnboardingModal from "./OnboardingModal.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { clusters } from "#lib/stores/clusters.svelte.ts";
import { settings } from "#lib/stores/settings.svelte.ts";
import { toasts } from "#lib/stores/toasts.svelte.ts";
import { installLocalStorageMock } from "#lib/stores/storage-mock.ts";
import type { PodInfo } from "#lib/tauri.ts";

const pod: PodInfo = {
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
};

beforeEach(() => {
  installLocalStorageMock();
  toasts.items = [];
  app.preferencesOpen = false;
  app.onboardingOpen = false;
  app.kubeconfigPath = "/home/u/.kube/config";
  app.kubeconfigSources = [];
  settings.onboardingSeen.value = false;
  settings.skipTls.value = false;
  settings.refreshInterval.value = 30;
  settings.theme.value = "dark";
  clusters.contexts = [
    { name: "prod", cluster_server: "https://prod:6443", namespace: "default", is_active: true },
    { name: "staging", cluster_server: "https://staging:6443", namespace: "default", is_active: false },
  ];
  clusters.identityColors = { prod: "blue", staging: "amber" };
});

describe("Toaster", () => {
  it("renders queued toasts and dismisses on click", async () => {
    toasts.items = [{ id: 1, message: "Pod restarted", tone: "ok" }];
    render(Toaster);
    expect(screen.getByText("Pod restarted")).toBeInTheDocument();
    await fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(toasts.items).toHaveLength(0);
  });
});

describe("DeletePodDialog", () => {
  it("repeats pod name and namespace in mono and disables confirm by default", () => {
    render(DeletePodDialog, { props: { pod, onCancel: vi.fn(), onConfirm: vi.fn() } });
    expect(screen.getByText("api-0")).toBeInTheDocument();
    expect(screen.getByText("default")).toBeInTheDocument();
    expect(screen.getByText("Delete Pod", { selector: "button" })).toBeDisabled();
  });

  it("registers with the overlay stack so Esc closes it before the drawer", () => {
    const onCancel = vi.fn();
    app.selectedPod = pod;
    const { unmount } = render(DeletePodDialog, { props: { pod, onCancel, onConfirm: vi.fn() } });
    expect(app.closeTopOverlay()).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(app.selectedPod).not.toBeNull();
    unmount();
    // Once unmounted the dialog no longer intercepts Esc.
    expect(app.closeTopOverlay()).toBe(true);
    expect(app.selectedPod).toBeNull();
  });

  it("cancels via the Cancel button", async () => {
    const onCancel = vi.fn();
    render(DeletePodDialog, { props: { pod, onCancel, onConfirm: vi.fn() } });
    await fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("PreferencesModal", () => {
  it("offers all three appearance modes and applies the choice", async () => {
    app.preferencesOpen = true;
    render(PreferencesModal);
    expect(screen.getByText("Dark")).not.toBeDisabled();
    await fireEvent.click(screen.getByText("Light"));
    expect(settings.theme.value).toBe("light");
    expect(setMode).toHaveBeenCalledWith("light");
    await fireEvent.click(screen.getByText("System"));
    expect(settings.theme.value).toBe("system");
    expect(setMode).toHaveBeenCalledWith("system");
  });

  it("persists the auto-refresh choice", async () => {
    app.preferencesOpen = true;
    render(PreferencesModal);
    await fireEvent.click(screen.getByText("1m"));
    expect(settings.refreshInterval.value).toBe(60);
  });

  it("toggles skip TLS", async () => {
    app.preferencesOpen = true;
    render(PreferencesModal);
    await fireEvent.click(screen.getByRole("switch", { name: "Skip TLS verification" }));
    expect(settings.skipTls.value).toBe(true);
  });

  it("persists density and applies it to the document", async () => {
    render(PreferencesModal);
    await fireEvent.click(screen.getByRole("radio", { name: "Compact" }));
    expect(settings.density.value).toBe("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    await fireEvent.click(screen.getByRole("radio", { name: "Default" }));
  });

  it("switches the accent color", async () => {
    render(PreferencesModal);
    await fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
    expect(settings.accent.value).toBe("violet");
    expect(document.documentElement.style.getPropertyValue("--cl-color-accent")).toContain("violet");
    await fireEvent.click(screen.getByRole("radio", { name: "Blue" }));
    expect(document.documentElement.style.getPropertyValue("--cl-color-accent")).toBe("");
  });

  it("overrides a cluster's identity color", async () => {
    render(PreferencesModal);
    const group = screen.getByRole("radiogroup", { name: "Color for staging" });
    await fireEvent.click(within(group).getByRole("radio", { name: "pink" }));
    expect(clusters.identityFor("staging")).toBe("pink");
    expect(settings.identityColors.value.staging).toBe("pink");
  });

  it("falls back to the single kubeconfig path before sources load", () => {
    render(PreferencesModal);
    const list = screen.getByRole("list", { name: "Kubeconfig files" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("/home/u/.kube/config")).toBeInTheDocument();
    expect(within(list).getByText(/2 contexts/)).toBeInTheDocument();
  });

  it("lists every kubeconfig file with counts, merged and missing notes", () => {
    app.kubeconfigSources = [
      { path: "/home/u/.kube/config", exists: true, contexts: 2, shadowed: [] },
      { path: "/home/u/.kube/gone.yaml", exists: false, contexts: 0, shadowed: [] },
      { path: "/home/u/.kube/team.yaml", exists: true, contexts: 1, shadowed: ["prod"] },
    ];
    render(PreferencesModal);
    const rows = within(screen.getByRole("list", { name: "Kubeconfig files" })).getAllByRole(
      "listitem",
    );
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText(/2 contexts/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/not found/)).toBeInTheDocument();
    expect(within(rows[2]).getByText(/1 context\b/)).toBeInTheDocument();
    const merged = within(rows[2]).getByText(/1 merged/);
    expect(merged).toHaveAttribute("title", expect.stringContaining("prod"));
    expect(screen.getByText(/first file wins/)).toBeInTheDocument();
  });

  it("re-triggers onboarding", async () => {
    app.preferencesOpen = true;
    render(PreferencesModal);
    await fireEvent.click(screen.getByText("Show first-launch onboarding again"));
    expect(app.onboardingOpen).toBe(true);
    expect(app.preferencesOpen).toBe(false);
  });
});

describe("OnboardingModal", () => {
  it("walks the three steps and finishes with the seen flag", async () => {
    app.onboardingOpen = true;
    render(OnboardingModal);
    expect(screen.getByText("Welcome to CubeLite")).toBeInTheDocument();
    expect(screen.getByText("2 contexts found")).toBeInTheDocument();
    await fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Your clusters")).toBeInTheDocument();
    await fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Keyboard first")).toBeInTheDocument();
    await fireEvent.click(screen.getByText("Start using CubeLite"));
    expect(settings.onboardingSeen.value).toBe(true);
    expect(app.onboardingOpen).toBe(false);
  });

  it("skip marks onboarding as seen", async () => {
    app.onboardingOpen = true;
    render(OnboardingModal);
    await fireEvent.click(screen.getByText("Skip"));
    expect(settings.onboardingSeen.value).toBe(true);
    expect(app.onboardingOpen).toBe(false);
  });
});
