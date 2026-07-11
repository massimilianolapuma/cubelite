import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("$lib/tauri", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

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
  it("disables Light and System and keeps Dark active", () => {
    app.preferencesOpen = true;
    render(PreferencesModal);
    expect(screen.getByText("Light")).toBeDisabled();
    expect(screen.getByText("System")).toBeDisabled();
    expect(screen.getByText("Dark")).not.toBeDisabled();
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
