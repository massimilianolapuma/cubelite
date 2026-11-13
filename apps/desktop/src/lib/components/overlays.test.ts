import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import { tick } from "svelte";

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
  kubeconfigSources: vi.fn(async () => ({ spec: "", sources: [], origin: "default" })),
  watchKubeconfig: vi.fn(async () => "kw1"),
  unwatchKubeconfig: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("mode-watcher", () => ({
  setMode: vi.fn(),
}));

import { setMode } from "mode-watcher";
import { open } from "@tauri-apps/plugin-dialog";
import Toaster from "./ui/Toaster.svelte";
import DeletePodDialog from "./DeletePodDialog.svelte";
import PreferencesModal from "./PreferencesModal.svelte";
import OnboardingModal from "./OnboardingModal.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { clusters } from "#lib/stores/clusters.svelte.ts";
import { settings } from "#lib/stores/settings.svelte.ts";
import { toasts } from "#lib/stores/toasts.svelte.ts";
import { updater } from "#lib/stores/updater.svelte.ts";
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
  settings.kubeconfigPaths.value = [];
  app.kubeconfigOrigin = "env";
  settings.onboardingSeen.value = false;
  settings.skipTls.value = false;
  settings.refreshInterval.value = 30;
  settings.theme.value = "dark";
  clusters.contexts = [
    { name: "prod", cluster_server: "https://prod:6443", namespace: "default", is_active: true },
    { name: "staging", cluster_server: "https://staging:6443", namespace: "default", is_active: false },
  ];
  clusters.identityColors = { prod: "blue", staging: "magenta" };
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
  it("names the pod, its namespace and the cluster, and disables confirm by default", () => {
    app.activeCluster = "prod";
    render(DeletePodDialog, { props: { pod, onCancel: vi.fn(), onConfirm: vi.fn() } });
    const dialog = screen.getByRole("dialog", { name: "Delete Pod" });
    const facts = within(dialog).getByRole("list", { name: "Pod to delete" });
    expect(within(facts).getByText("Pod").nextElementSibling).toHaveTextContent("api-0");
    expect(within(facts).getByText("Namespace").nextElementSibling).toHaveTextContent("default");
    expect(within(facts).getByText("Cluster").nextElementSibling).toHaveTextContent("prod");
    expect(screen.getByRole("button", { name: "Delete Pod" })).toBeDisabled();
  });

  it("confirms with the destructive solid button, the only one of its kind", () => {
    // The colour pairing (`on-error-solid` on `error-solid`) is read on the rendered page (overlays-tonal.spec.ts).
    render(DeletePodDialog, { props: { pod, onCancel: vi.fn(), onConfirm: vi.fn() } });
    const confirm = screen.getByRole("button", { name: "Delete Pod" });
    expect(confirm).toHaveAttribute("data-variant", "danger-solid");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("data-variant", "text");
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

  it("keeps a plain title: only a dialog that asks for it gets a focusable one", () => {
    render(DeletePodDialog, { props: { pod, onCancel: vi.fn(), onConfirm: vi.fn() } });
    expect(screen.getByRole("heading", { name: "Delete Pod" })).not.toHaveAttribute("tabindex");
  });
});

describe("PreferencesModal", () => {
  it("shows a toast when the file picker fails", async () => {
    vi.mocked(open).mockRejectedValue(new Error("denied"));
    app.preferencesOpen = true;
    render(PreferencesModal);
    await fireEvent.click(screen.getByRole("button", { name: "Add file…" }));
    await vi.waitFor(() =>
      expect(toasts.items.at(-1)?.message).toBe("Could not open the file picker: denied"),
    );
    expect(settings.kubeconfigPaths.value).toEqual([]);
  });

  it("shows a toast when the reload after a list change fails", async () => {
    app.kubeconfigOrigin = "custom";
    app.kubeconfigSources = [
      { path: "/home/u/.kube/config", exists: true, contexts: 1, shadowed: [] },
    ];
    const reload = vi.spyOn(clusters, "reloadKubeconfig").mockRejectedValue(new Error("boom"));
    app.preferencesOpen = true;
    render(PreferencesModal);
    await fireEvent.click(screen.getByRole("button", { name: "Remove /home/u/.kube/config" }));
    await vi.waitFor(() =>
      expect(toasts.items.at(-1)?.message).toBe("Failed to update kubeconfig list: boom"),
    );
    expect(settings.kubeconfigPaths.value).toEqual([]);
    reload.mockRestore();
  });

  it("restores the previous list when the reload reports failure", async () => {
    app.kubeconfigOrigin = "default";
    app.kubeconfigSources = [
      { path: "/home/u/.kube/config", exists: true, contexts: 1, shadowed: [] },
      { path: "/home/u/.kube/team.yaml", exists: true, contexts: 1, shadowed: [] },
    ];
    const reload = vi.spyOn(clusters, "reloadKubeconfig").mockResolvedValue(false);
    app.preferencesOpen = true;
    render(PreferencesModal);
    await fireEvent.click(screen.getByRole("button", { name: "Remove /home/u/.kube/team.yaml" }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith("preferences"));
    await vi.waitFor(() => expect(settings.kubeconfigPaths.value).toEqual([]));
    reload.mockRestore();
  });

  it("hides Remove on a single non-custom file", () => {
    app.kubeconfigOrigin = "env";
    app.kubeconfigSources = [
      { path: "/home/u/.kube/config", exists: true, contexts: 1, shadowed: [] },
    ];
    app.preferencesOpen = true;
    render(PreferencesModal);
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  it("hides Remove when no sources are known", () => {
    app.kubeconfigSources = [];
    app.preferencesOpen = true;
    render(PreferencesModal);
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  it("shows where the kubeconfig list comes from", () => {
    app.kubeconfigOrigin = "env";
    app.preferencesOpen = true;
    render(PreferencesModal);
    expect(screen.getByText("From KUBECONFIG")).toBeInTheDocument();
  });

  it("Add file… seeds the custom list with the resolved files, then appends the picked ones", async () => {
    app.kubeconfigSources = [
      { path: "/home/u/.kube/config", exists: true, contexts: 1, shadowed: [] },
    ];
    vi.mocked(open).mockResolvedValue(["/home/u/team.yaml"]);
    const reload = vi.spyOn(clusters, "reloadKubeconfig").mockResolvedValue(true);
    app.preferencesOpen = true;
    render(PreferencesModal);
    await fireEvent.click(screen.getByRole("button", { name: "Add file…" }));
    await vi.waitFor(() =>
      expect(settings.kubeconfigPaths.value).toEqual(["/home/u/.kube/config", "/home/u/team.yaml"]),
    );
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ multiple: true, directory: false }));
    expect(reload).toHaveBeenCalledWith("preferences");
    reload.mockRestore();
  });

  it("Remove pins the list as custom and drops the file; Use defaults clears it", async () => {
    app.kubeconfigSources = [
      { path: "/home/u/.kube/config", exists: true, contexts: 1, shadowed: [] },
      { path: "/home/u/.kube/team.yaml", exists: true, contexts: 1, shadowed: [] },
    ];
    const reload = vi.spyOn(clusters, "reloadKubeconfig").mockResolvedValue(true);
    app.preferencesOpen = true;
    render(PreferencesModal);
    await fireEvent.click(screen.getByRole("button", { name: "Remove /home/u/.kube/team.yaml" }));
    await vi.waitFor(() => expect(settings.kubeconfigPaths.value).toEqual(["/home/u/.kube/config"]));
    app.kubeconfigOrigin = "custom";
    await fireEvent.click(await screen.findByRole("button", { name: "Use defaults" }));
    expect(settings.kubeconfigPaths.value).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(2);
    reload.mockRestore();
  });

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

  it("toggles integration hints and opens on a requested integration (#526)", async () => {
    settings.integrationHints.value = true;
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    // Content loading above the section resizes the page: the scroll follows.
    let resized: (() => void) | null = null;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    app.openPreferences("prometheus");
    const { unmount } = render(PreferencesModal);
    expect(app.preferencesOpen).toBe(true);
    expect(app.preferencesSection).toBeNull();
    await tick();
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.querySelector('[data-testid="prometheus-prefs"]')).not.toBeNull();
    resized!();
    expect(scrolled).toHaveLength(2);
    expect(scrolled[1]).toBe(scrolled[0]);
    unmount();
    expect(disconnect).toHaveBeenCalled();
    vi.unstubAllGlobals();
    render(PreferencesModal);
    await fireEvent.click(screen.getByRole("switch", { name: "Show integration hints in panels" }));
    expect(settings.integrationHints.value).toBe(false);
    await fireEvent.click(screen.getByRole("switch", { name: "Show integration hints in panels" }));
    expect(settings.integrationHints.value).toBe(true);
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it("lands on the section asked for: Integrations as a whole, Prometheus on its own form", async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      app.openPreferences("integrations");
      let view = render(PreferencesModal);
      await tick();
      expect(scrolled).toEqual([screen.getByRole("region", { name: "Integrations" })]);
      view.unmount();

      scrolled.length = 0;
      app.openPreferences("prometheus");
      view = render(PreferencesModal);
      await tick();
      // The Prometheus form, not the Integrations section it sits in (which starts with Elasticsearch).
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0].firstElementChild).toBe(screen.getByTestId("prometheus-prefs"));
      expect(scrolled[0].contains(screen.getByTestId("elastic-prefs"))).toBe(false);
      view.unmount();
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("opens on the kubeconfig files when asked (All Clusters' Open Preferences)", async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    app.openPreferences("kubeconfig");
    const { unmount } = render(PreferencesModal);
    expect(app.preferencesOpen).toBe(true);
    expect(app.preferencesSection).toBeNull();
    await tick();
    expect(scrolled).toHaveLength(1);
    expect(within(scrolled[0] as HTMLElement).getByRole("list", { name: "Kubeconfig files" })).toBeInTheDocument();
    unmount();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it("persists density and applies it to the document", async () => {
    render(PreferencesModal);
    await fireEvent.click(screen.getByRole("radio", { name: "Compact" }));
    expect(settings.density.value).toBe("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    await fireEvent.click(screen.getByRole("radio", { name: "Default" }));
  });

  it("has no accent setting: the accent is the active cluster's tint", () => {
    render(PreferencesModal);
    expect(screen.queryByRole("radiogroup", { name: "Accent color" })).toBeNull();
    expect(screen.queryByText("Accent")).toBeNull();
  });

  it("groups Theme, Density and Cluster colours under Appearance", () => {
    render(PreferencesModal);
    const appearance = screen.getByRole("region", { name: "Appearance" });
    expect(within(appearance).getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    expect(within(appearance).getByRole("radiogroup", { name: "Density" })).toBeInTheDocument();
    expect(within(appearance).getByRole("radiogroup", { name: "Color for staging" })).toBeInTheDocument();
  });

  it("paints each swatch in its own tint and marks the chosen one by more than its colour", async () => {
    render(PreferencesModal);
    const group = screen.getByRole("radiogroup", { name: "Color for staging" });
    for (const radio of within(group).getAllByRole("radio")) {
      expect(radio).toHaveAttribute("data-tint");
      expect(radio.getAttribute("style")).toContain(`--cl-hue-${radio.getAttribute("aria-label")}`);
    }
    const marked = () =>
      within(group)
        .getAllByRole("radio")
        .filter((r) => r.querySelector("[data-swatch-mark]"))
        .map((r) => r.getAttribute("aria-label"));
    expect(marked()).toEqual(["magenta"]);
    await fireEvent.click(within(group).getByRole("radio", { name: "teal" }));
    expect(marked()).toEqual(["teal"]);
  });

  it("marks merged and redefined files with the attention shape, not only a colour", () => {
    app.kubeconfigSources = [
      { path: "/home/u/.kube/config", exists: true, contexts: 2, shadowed: [] },
      { path: "/home/u/.kube/team.yaml", exists: true, contexts: 1, shadowed: ["prod"] },
      {
        path: "/home/u/.kube/dolomiti",
        exists: true,
        contexts: 1,
        shadowed: [],
        redefined_clusters: ["aks-prod-01"],
        redefined_users: [],
      },
    ];
    render(PreferencesModal);
    const rows = within(screen.getByRole("list", { name: "Kubeconfig files" })).getAllByRole("listitem");
    const triangle = (row: HTMLElement, note: RegExp) =>
      within(row).getByText(note).closest("[data-note]")?.querySelector("[data-glyph]");
    expect(rows[0].querySelector("[data-glyph]")).toBeNull();
    expect(triangle(rows[1], /1 merged/)).toHaveAttribute("data-glyph", "warn");
    expect(triangle(rows[2], /1 redefined/)).toHaveAttribute("data-glyph", "warn");
  });

  it("overrides a cluster's identity color", async () => {
    render(PreferencesModal);
    const group = screen.getByRole("radiogroup", { name: "Color for staging" });
    expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual([
      "blue",
      "magenta",
      "teal",
      "violet",
      "indigo",
    ]);
    await fireEvent.click(within(group).getByRole("radio", { name: "magenta" }));
    expect(clusters.identityFor("staging")).toBe("magenta");
    expect(settings.identityColors.value.staging).toBe("magenta");
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
    expect(within(rows[2]).queryByText(/redefined/)).not.toBeInTheDocument();
    expect(screen.getByText(/first file wins/)).toBeInTheDocument();
  });

  it("notes clusters and users an earlier file defines differently", () => {
    app.kubeconfigSources = [
      { path: "/home/u/.kube/config", exists: true, contexts: 0, shadowed: [] },
      {
        path: "/home/u/.kube/dolomiti",
        exists: true,
        contexts: 1,
        shadowed: [],
        redefined_clusters: ["aks-prod-01-emm"],
        redefined_users: ["clusterUser_emm"],
      },
    ];
    render(PreferencesModal);
    const rows = within(screen.getByRole("list", { name: "Kubeconfig files" })).getAllByRole(
      "listitem",
    );
    expect(within(rows[0]).queryByText(/redefined/)).not.toBeInTheDocument();
    const note = within(rows[1]).getByText(/2 redefined/);
    expect(note).toHaveAttribute(
      "title",
      expect.stringContaining(
        "Also defined differently in an earlier file: cluster aks-prod-01-emm, user clusterUser_emm",
      ),
    );
    expect(note).toHaveAttribute("title", expect.stringContaining("this file's definition"));
  });

  it("re-triggers onboarding", async () => {
    app.preferencesOpen = true;
    render(PreferencesModal);
    await fireEvent.click(screen.getByText("Show first-launch onboarding again"));
    expect(app.onboardingOpen).toBe(true);
    expect(app.preferencesOpen).toBe(false);
  });
});

describe("PreferencesModal updates", () => {
  it("keeps 'Install update' on its button while downloading and says so beside it", () => {
    updater.status = "downloading";
    updater.version = "0.11.0";
    try {
      render(PreferencesModal);
      const region = screen.getByRole("region", { name: "Updates" });
      // Pending swaps the icon for a spinner; the name and the label stay (§7, §9.3).
      const install = within(region).getByRole("button", { name: "Install update" });
      expect(install).toHaveAttribute("aria-busy", "true");
      // The overlay spinner of an icon-less button would hide the label (opacity 0).
      expect(within(install).getByText("Install update")).not.toHaveClass("opacity-0");
      expect(within(region).getByText("Downloading update 0.11.0…")).toBeInTheDocument();
    } finally {
      updater.status = "idle";
      updater.version = null;
    }
  });
});

describe("OnboardingModal", () => {
  it("lists each cluster in its own tint", async () => {
    app.onboardingOpen = true;
    render(OnboardingModal);
    await fireEvent.click(screen.getByText("Continue"));
    const avatars = screen.getAllByTestId("identity-avatar");
    expect(avatars.map((a) => a.getAttribute("style"))).toEqual([
      expect.stringContaining("--cl-hue-blue"),
      expect.stringContaining("--cl-hue-magenta"),
    ]);
    // On the overlay the resting disc is the tonal container: a surface tone would vanish.
    expect(avatars.map((a) => a.dataset.surface)).toEqual(["container", "container"]);
  });

  it("keeps a cut cluster name whole in its title (§9.2)", async () => {
    app.onboardingOpen = true;
    render(OnboardingModal);
    await fireEvent.click(screen.getByText("Continue"));
    const list = screen.getByRole("list", { name: "Clusters" });
    expect(within(list).getByText("prod")).toHaveAttribute("title", "prod");
    expect(within(list).getByText("staging")).toHaveAttribute("title", "staging");
  });

  it("walks the three steps and finishes with the seen flag", async () => {
    app.onboardingOpen = true;
    render(OnboardingModal);
    expect(screen.getByText("Welcome to CubeLite")).toBeInTheDocument();
    expect(screen.getByText("2 contexts found")).toBeInTheDocument();
    // Progress is a sentence, not only the dots (Tonal §8.6, §9.3).
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    await fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Your clusters")).toBeInTheDocument();
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    await fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Keyboard first")).toBeInTheDocument();
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
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
