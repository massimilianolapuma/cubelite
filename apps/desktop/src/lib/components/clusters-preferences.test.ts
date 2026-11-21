import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  clusterSettings: vi.fn(),
  setClusterEnvironment: vi.fn(),
  setEnvironmentVariants: vi.fn(),
}));

import ClustersPreferences from "./ClustersPreferences.svelte";
import { clusters } from "#lib/stores/clusters.svelte.ts";
import { clusterSettings } from "#lib/stores/cluster-settings.svelte.ts";
import { defaultVariants } from "#lib/environment.ts";
import {
  clusterSettings as fetchClusterSettings,
  setClusterEnvironment,
  setEnvironmentVariants,
  type ClusterSettings,
  type ContextEnvironment,
  type ContextInfo,
  type EnvironmentVariants,
} from "#lib/tauri.ts";

const context = (name: string): ContextInfo => ({
  name,
  cluster_server: `https://${name}:6443`,
  namespace: "default",
  is_active: false,
});

const ro = { access: "read_only", writable_until: null } as const;
const rw = { access: "writable", writable_until: null } as const;
const entries: ContextEnvironment[] = [
  { name: "aks-prod-01-emm", environment: "production", source: "detected", detected: "production", ...ro },
  { name: "minikube", environment: "development", source: "manual", detected: null, ...rw },
  { name: "dol-lab-aks", environment: null, source: "detected", detected: null, ...rw },
];
const PREFS = { confirm_unlock: true, read_only_from_start: ["production"] } satisfies Partial<ClusterSettings>;

const table = () => screen.getByRole("table", { name: "Cluster environments" });
const rowNames = () =>
  within(table())
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0].textContent?.trim());
const selectOf = (name: string) => screen.getByRole("combobox", { name: `Environment of ${name}` }) as HTMLSelectElement;
const field = (label: string) => screen.getByRole("textbox", { name: label }) as HTMLInputElement;

async function openNames(): Promise<void> {
  await fireEvent.click(screen.getByRole("button", { name: "Environment names" }));
}

/** The backend saving what it is sent, normalised as validate_variants does. */
function saving(): void {
  vi.mocked(setEnvironmentVariants).mockImplementation(async (v: EnvironmentVariants) => {
    const out = {} as EnvironmentVariants;
    for (const [env, words] of Object.entries(v) as [keyof EnvironmentVariants, string[]][]) {
      out[env] = words.map((w) => w.trim().toLowerCase()).filter((w) => w !== "");
    }
    return out;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clusterSettings.reset();
  clusters.contexts = ["aks-prod-01-emm", "minikube", "dol-lab-aks"].map(context);
  clusterSettings.byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  vi.mocked(fetchClusterSettings).mockImplementation(async (names: string[]) => ({
    contexts: entries.filter((e) => names.includes(e.name)),
    variants: clusterSettings.variants,
    recovered: false,
    ...PREFS,
  }));
});

describe("ClustersPreferences (#662)", () => {
  it("has one row per context, in rail order", () => {
    render(ClustersPreferences);
    expect(within(table()).getAllByRole("columnheader").map((h) => h.textContent?.trim())).toEqual([
      "Context",
      "Environment",
    ]);
    expect(rowNames()).toEqual(["aks-prod-01-emm", "minikube", "dol-lab-aks"]);
  });

  it("offers the choices of the menu, the detected one named after what it reads", () => {
    render(ClustersPreferences);
    const options = (name: string) => Array.from(selectOf(name).options).map((o) => o.textContent?.trim());
    expect(options("aks-prod-01-emm")).toEqual([
      "Production (detected)",
      "Development",
      "Test",
      "Staging",
      "Production",
      "Not set",
    ]);
    expect(options("dol-lab-aks")[0]).toBe("Not set (detected)");
    expect(selectOf("aks-prod-01-emm").value).toBe("detected");
    expect(selectOf("minikube").value).toBe("development");
    expect(selectOf("dol-lab-aks").value).toBe("detected");
  });

  it("sets the environment through the store", async () => {
    vi.mocked(setClusterEnvironment).mockResolvedValue({
      contexts: [{ ...entries[0], environment: "test", source: "manual" }],
      variants: defaultVariants(),
      recovered: false,
      ...PREFS,
    });
    render(ClustersPreferences);
    await fireEvent.change(selectOf("aks-prod-01-emm"), { target: { value: "test" } });
    expect(setClusterEnvironment).toHaveBeenCalledWith("aks-prod-01-emm", { source: "manual", value: "test" });
    await waitFor(() => expect(selectOf("aks-prod-01-emm").value).toBe("test"));

    await fireEvent.change(selectOf("minikube"), { target: { value: "none" } });
    expect(setClusterEnvironment).toHaveBeenLastCalledWith("minikube", { source: "manual", value: null });
    await fireEvent.change(selectOf("minikube"), { target: { value: "detected" } });
    expect(setClusterEnvironment).toHaveBeenLastCalledWith("minikube", { source: "detected" });
  });

  it("a choice the backend did not save goes back to the stored one", async () => {
    vi.mocked(setClusterEnvironment).mockRejectedValue("disk full");
    render(ClustersPreferences);
    await fireEvent.change(selectOf("minikube"), { target: { value: "test" } });
    expect(setClusterEnvironment).toHaveBeenCalled();
    await waitFor(() => expect(selectOf("minikube").value).toBe("development"));
  });

  it("drops the row of a context that left the kubeconfig (Review Focus 5)", async () => {
    render(ClustersPreferences);
    expect(rowNames()).toContain("aks-prod-01-emm");
    clusters.contexts = ["minikube", "dol-lab-aks"].map(context);
    await waitFor(() => expect(rowNames()).toEqual(["minikube", "dol-lab-aks"]));
    expect(screen.queryByRole("combobox", { name: "Environment of aks-prod-01-emm" })).not.toBeInTheDocument();
  });

  it("keeps the environment names collapsed until asked", async () => {
    render(ClustersPreferences);
    const toggle = screen.getByRole("button", { name: "Environment names" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("textbox", { name: "Production" })).not.toBeInTheDocument();
    await openNames();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(field("Development").value).toBe("dev, develop, development, svil, sviluppo");
    expect(field("Production").value).toBe("prod, prd, production, produzione");
  });

  it("saves a field on blur", async () => {
    saving();
    render(ClustersPreferences);
    await openNames();
    await fireEvent.input(field("Production"), { target: { value: "prod, prd, Live " } });
    expect(setEnvironmentVariants).not.toHaveBeenCalled();
    await fireEvent.blur(field("Production"));
    await waitFor(() => expect(setEnvironmentVariants).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setEnvironmentVariants).mock.calls[0][0]).toEqual({
      ...defaultVariants(),
      production: ["prod", "prd", "live"],
    });
    await waitFor(() => expect(field("Production").value).toBe("prod, prd, live"));
  });

  it("refuses a word already in another environment, naming it, and keeps the text (Review Focus 4)", async () => {
    saving();
    render(ClustersPreferences);
    await openNames();
    await fireEvent.input(field("Production"), { target: { value: "prod, stg" } });
    await fireEvent.blur(field("Production"));
    const error = await screen.findByText('"stg" is already in Staging');
    expect(field("Production")).toHaveAttribute("aria-describedby", error.id);
    expect(field("Production")).toHaveAttribute("aria-invalid", "true");
    expect(field("Production").value).toBe("prod, stg");
    expect(setEnvironmentVariants).not.toHaveBeenCalled();
    expect(clusterSettings.variants).toEqual(defaultVariants());
  });

  it("a change from elsewhere follows in the other fields, not in a refused one", async () => {
    saving();
    render(ClustersPreferences);
    await openNames();
    await fireEvent.input(field("Production"), { target: { value: "prod, stg" } });
    await fireEvent.blur(field("Production"));
    await screen.findByText('"stg" is already in Staging');
    clusterSettings.variants = { ...defaultVariants(), test: ["test", "check"] };
    await waitFor(() => expect(field("Test").value).toBe("test, check"));
    expect(field("Production").value).toBe("prod, stg");
  });

  it("names the other environment whichever comes first", async () => {
    saving();
    render(ClustersPreferences);
    await openNames();
    await fireEvent.input(field("Test"), { target: { value: "test, PROD" } });
    await fireEvent.blur(field("Test"));
    expect(await screen.findByText('"prod" is already in Production')).toBeInTheDocument();
  });

  it("drops a word that is not letters and digits, with a line under the field", async () => {
    saving();
    render(ClustersPreferences);
    await openNames();
    await fireEvent.input(field("Staging"), { target: { value: "stg, pre-prod, uat,, " } });
    await fireEvent.blur(field("Staging"));
    await waitFor(() => expect(setEnvironmentVariants).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setEnvironmentVariants).mock.calls[0][0].staging).toEqual(["stg", "uat"]);
    const note = await screen.findByText(/Left out "pre-prod"/);
    expect(field("Staging")).toHaveAttribute("aria-describedby", note.id);
    expect(field("Staging").value).toBe("stg, uat");
  });

  it("shows the backend's refusal under the field", async () => {
    vi.mocked(setEnvironmentVariants).mockRejectedValue("disk full");
    render(ClustersPreferences);
    await openNames();
    await fireEvent.input(field("Test"), { target: { value: "test, qa, check" } });
    await fireEvent.blur(field("Test"));
    expect(await screen.findByText("disk full")).toBeInTheDocument();
    expect(field("Test").value).toBe("test, qa, check");
  });

  it("keeps the typed text while the save is pending and after the backend refuses it", async () => {
    let refuse!: (reason: unknown) => void;
    vi.mocked(setEnvironmentVariants).mockReturnValue(new Promise((_, reject) => (refuse = reject)));
    render(ClustersPreferences);
    await openNames();
    await fireEvent.focus(field("Test"));
    await fireEvent.input(field("Test"), { target: { value: "test, qa, check" } });
    await fireEvent.blur(field("Test"));
    await tick();
    expect(field("Test").value).toBe("test, qa, check");
    refuse("disk full");
    expect(await screen.findByText("disk full")).toBeInTheDocument();
    expect(field("Test").value).toBe("test, qa, check");
  });

  it("does not save a field that did not change", async () => {
    saving();
    render(ClustersPreferences);
    await openNames();
    await fireEvent.blur(field("Test"));
    expect(setEnvironmentVariants).not.toHaveBeenCalled();
  });

  it("resets the names to the defaults", async () => {
    saving();
    clusterSettings.variants = { ...defaultVariants(), production: ["live"] };
    render(ClustersPreferences);
    await openNames();
    expect(field("Production").value).toBe("live");
    await fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() => expect(setEnvironmentVariants).toHaveBeenCalledWith(defaultVariants()));
    await waitFor(() => expect(field("Production").value).toBe("prod, prd, production, produzione"));
  });
});
