import { describe, it, expect, beforeEach } from "vitest";
import { app, isView, VIEWS } from "./app.svelte";
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
  app.view = "dashboard";
  app.namespace = null;
  app.selectedPod = null;
  app.selectedDeployment = null;
  app.podFilter = "";
  app.deploymentFilter = "";
  app.paletteOpen = false;
  app.preferencesOpen = false;
  app.onboardingOpen = false;
});

describe("navigate", () => {
  it("changes view and clears drawer selections", () => {
    app.selectedPod = pod;
    app.navigate("pods");
    expect(app.view).toBe("pods");
    expect(app.selectedPod).toBeNull();
  });
});

describe("resetForClusterSwitch", () => {
  it("resets namespace, selections and filters", () => {
    app.view = "pods";
    app.namespace = "kube-system";
    app.selectedPod = pod;
    app.podFilter = "api";
    app.resetForClusterSwitch();
    expect(app.namespace).toBeNull();
    expect(app.selectedPod).toBeNull();
    expect(app.podFilter).toBe("");
    expect(app.view).toBe("pods");
  });

  it("leaves the dashboard for the overview when switching from it", () => {
    app.view = "dashboard";
    app.resetForClusterSwitch();
    expect(app.view).toBe("overview");
  });
});

describe("closeTopOverlay", () => {
  it("closes the palette before drawers", () => {
    app.paletteOpen = true;
    app.selectedPod = pod;
    expect(app.closeTopOverlay()).toBe(true);
    expect(app.paletteOpen).toBe(false);
    expect(app.selectedPod).not.toBeNull();
  });

  it("closes drawers when no modal overlays are open", () => {
    app.selectedPod = pod;
    expect(app.closeTopOverlay()).toBe(true);
    expect(app.selectedPod).toBeNull();
  });

  it("returns false when nothing is open", () => {
    expect(app.closeTopOverlay()).toBe(false);
  });
});

describe("isView", () => {
  it("accepts every declared view and rejects unknowns", () => {
    for (const v of VIEWS) expect(isView(v)).toBe(true);
    expect(isView("settings")).toBe(false);
  });
});
