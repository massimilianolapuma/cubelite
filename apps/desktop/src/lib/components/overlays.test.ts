import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("$lib/tauri", () => ({
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
import { app } from "$lib/stores/app.svelte";
import { clusters } from "$lib/stores/clusters.svelte";
import { settings } from "$lib/stores/settings.svelte";
import { toasts } from "$lib/stores/toasts.svelte";
import { installLocalStorageMock } from "$lib/stores/storage-mock";
import type { PodInfo } from "$lib/tauri";

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
