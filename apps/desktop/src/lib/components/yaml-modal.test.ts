import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

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

beforeEach(() => {
  vi.clearAllMocks();
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
});
