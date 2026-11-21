import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("#lib/tauri.ts", () => ({
  getResourceYaml: vi.fn(),
  applyResourceYaml: vi.fn(),
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  listEvents: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import YamlModal from "./YamlModal.svelte";
import { applyResourceYaml, getResourceYaml } from "#lib/tauri.ts";
import { app } from "#lib/stores/app.svelte.ts";
import { clock } from "#lib/stores/clock.svelte.ts";
import { clusterSettings } from "#lib/stores/cluster-settings.svelte.ts";
import { setAccess } from "#lib/stores/access-mock.ts";

beforeEach(() => {
  vi.clearAllMocks();
  clusterSettings.reset();
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
});

describe("YamlModal", () => {
  it("fetches and renders the resource YAML", async () => {
    vi.mocked(getResourceYaml).mockResolvedValue("kind: Pod\nmetadata:\n  name: api-0\n");
    render(YamlModal, {
      props: { resourceType: "pod", namespace: "default", name: "api-0", onClose: vi.fn() },
    });
    expect(getResourceYaml).toHaveBeenCalledWith(
      "/home/u/.kube/config",
      "pod",
      "default",
      "api-0",
      "prod",
    );
    expect(await screen.findByText(/kind: Pod/)).toBeInTheDocument();
    expect(screen.getByText("api-0.yaml")).toBeInTheDocument();
    expect(screen.getByText("Copy")).toBeInTheDocument();
  });

  it("shows the fetch error", async () => {
    vi.mocked(getResourceYaml).mockRejectedValue(new Error("not found"));
    render(YamlModal, {
      props: { resourceType: "pod", namespace: "default", name: "gone", onClose: vi.fn() },
    });
    expect(await screen.findByText("not found")).toBeInTheDocument();
  });

  describe("edit & apply (#487)", () => {
    const YAML = "kind: Pod\nmetadata:\n  name: api-0\n";

    async function openEditor(onClose = vi.fn()) {
      vi.mocked(getResourceYaml).mockResolvedValue(YAML);
      render(YamlModal, {
        props: { resourceType: "pod", namespace: "default", name: "api-0", onClose },
      });
      await screen.findByText(/kind: Pod/);
      await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      return screen.getByRole("textbox", { name: "Manifest YAML" }) as HTMLTextAreaElement;
    }

    it("Edit opens the editor on the fetched YAML and Cancel leaves it", async () => {
      const editor = await openEditor();
      expect(editor.value).toBe(YAML);
      expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();

      await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("textbox", { name: "Manifest YAML" })).not.toBeInTheDocument();
      expect(screen.getByText(/kind: Pod/)).toBeInTheDocument();
      expect(applyResourceYaml).not.toHaveBeenCalled();
    });

    it("Apply sends the draft and closes on success", async () => {
      vi.mocked(applyResourceYaml).mockResolvedValue(undefined);
      const onClose = vi.fn();
      const editor = await openEditor(onClose);
      await fireEvent.input(editor, { target: { value: YAML + "  labels: {a: b}\n" } });
      await fireEvent.click(screen.getByRole("button", { name: "Apply" }));

      expect(applyResourceYaml).toHaveBeenCalledWith(
        "/home/u/.kube/config",
        "pod",
        "default",
        "api-0",
        YAML + "  labels: {a: b}\n",
        "prod",
      );
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it("an apply error shows inline and keeps the draft", async () => {
      vi.mocked(applyResourceYaml).mockRejectedValue(
        "The resource changed since you opened it. Reload and edit again.",
      );
      const onClose = vi.fn();
      const editor = await openEditor(onClose);
      await fireEvent.input(editor, { target: { value: "kind: Pod\n" } });
      await fireEvent.click(screen.getByRole("button", { name: "Apply" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The resource changed since you opened it. Reload and edit again.",
      );
      expect(
        (screen.getByRole("textbox", { name: "Manifest YAML" }) as HTMLTextAreaElement).value,
      ).toBe("kind: Pod\n");
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Tab indents with two spaces", async () => {
      const editor = await openEditor();
      editor.setSelectionRange(0, 0);
      await fireEvent.keyDown(editor, { key: "Tab" });
      expect(editor.value).toBe("  " + YAML);
    });
  });

  describe("on a read-only cluster (#662)", () => {
    const YAML = "kind: Pod\nmetadata:\n  name: api-0\n";

    function expectBlocked(button: HTMLElement) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled();
      expect(button).toHaveAccessibleDescription("prod is read-only");
      expect(button).toHaveAttribute("title", "prod is read-only");
    }

    it("shows the YAML and Copy, and Edit says why it is off and opens no editor", async () => {
      setAccess("prod", "read_only");
      vi.mocked(getResourceYaml).mockResolvedValue(YAML);
      render(YamlModal, { props: { resourceType: "pod", namespace: "default", name: "api-0", onClose: vi.fn() } });
      await screen.findByText(/kind: Pod/);
      expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Copy" })).not.toHaveAttribute("aria-disabled");
      const edit = screen.getByRole("button", { name: "Edit" });
      expectBlocked(edit);
      await fireEvent.click(edit);
      expect(screen.queryByRole("textbox", { name: "Manifest YAML" })).toBeNull();
    });

    it("keeps the draft when the unlock ends while editing; Apply says why and sends nothing", async () => {
      const entry = setAccess("prod", "timed", 5);
      vi.mocked(getResourceYaml).mockResolvedValue(YAML);
      render(YamlModal, { props: { resourceType: "pod", namespace: "default", name: "api-0", onClose: vi.fn() } });
      await screen.findByText(/kind: Pod/);
      await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const editor = screen.getByRole("textbox", { name: "Manifest YAML" }) as HTMLTextAreaElement;
      await fireEvent.input(editor, { target: { value: YAML + "  labels: {a: b}\n" } });

      clock.now = (entry.writable_until ?? 0) + 1;
      await tick();

      expect((screen.getByRole("textbox", { name: "Manifest YAML" }) as HTMLTextAreaElement).value).toBe(
        YAML + "  labels: {a: b}\n",
      );
      const apply = screen.getByRole("button", { name: "Apply" });
      expectBlocked(apply);
      await fireEvent.click(apply);
      expect(applyResourceYaml).not.toHaveBeenCalled();
      // Leaving the editor still works.
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    });
  });
  describe("bound to the cluster it was opened on (#685)", () => {
    const YAML = "kind: Pod\nmetadata:\n  name: api-0\n";

    it("a switch reads nothing from the new cluster, and Apply goes to the cluster it was opened on", async () => {
      vi.mocked(getResourceYaml).mockResolvedValue(YAML);
      vi.mocked(applyResourceYaml).mockResolvedValue(undefined);
      render(YamlModal, { props: { resourceType: "pod", namespace: "default", name: "api-0", onClose: vi.fn() } });
      await screen.findByText(/kind: Pod/);
      await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const editor = screen.getByRole("textbox", { name: "Manifest YAML" }) as HTMLTextAreaElement;
      await fireEvent.input(editor, { target: { value: YAML + "  labels: {a: b}\n" } });

      app.activeCluster = "staging";
      app.kubeconfigPath = "/other/kubeconfig";
      await tick();

      expect(getResourceYaml).toHaveBeenCalledTimes(1);
      await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      expect(applyResourceYaml).toHaveBeenCalledWith(
        "/home/u/.kube/config",
        "pod",
        "default",
        "api-0",
        YAML + "  labels: {a: b}\n",
        "prod",
      );
    });

    it("follows the lock of the cluster it was opened on, not of the active one", async () => {
      setAccess("staging", "read_only");
      vi.mocked(getResourceYaml).mockResolvedValue(YAML);
      render(YamlModal, { props: { resourceType: "pod", namespace: "default", name: "api-0", onClose: vi.fn() } });
      await screen.findByText(/kind: Pod/);
      app.activeCluster = "staging";
      await tick();
      expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-disabled");
    });
  });
});
