import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  clusterSettings: vi.fn(),
  setClusterEnvironment: vi.fn(),
  setEnvironmentVariants: vi.fn(),
  makeClusterWritable: vi.fn(),
  makeClusterReadOnly: vi.fn(),
  setClusterAccessPreferences: vi.fn(),
}));

import UnlockDialog from "./UnlockDialog.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { clusterSettings } from "#lib/stores/cluster-settings.svelte.ts";
import { makeClusterWritable, type ContextEnvironment, type UnlockFor } from "#lib/tauri.ts";

/** The element whose whole text is `text`, read across the spans that keep "read-only" on one line. */
const wholeText = (text: string) => (_: string, el: Element | null) =>
  el?.textContent === text && !Array.from(el.children).some((c) => c.textContent === text);

const prod: ContextEnvironment = {
  name: "aks-prod-01-emm",
  environment: "production",
  source: "detected",
  detected: "production",
  access: "read_only",
  writable_until: null,
};
const lab: ContextEnvironment = { ...prod, name: "dol-lab-aks", environment: null, detected: null };

const ACTIONS = "Actions in CubeLite will change this cluster: apply, delete, restart, scale, resources, shell.";

function pending(name: string, duration: UnlockFor): void {
  clusterSettings.pendingUnlock = { name, duration };
}

const dialog = () => screen.queryByRole("dialog");

beforeEach(() => {
  vi.clearAllMocks();
  clusterSettings.reset();
  clusterSettings.byName = { [prod.name]: prod, [lab.name]: lab };
});

afterEach(() => {
  clusterSettings.pendingUnlock = null;
});

describe("UnlockDialog (#662, spec §5.3)", () => {
  it("is closed while no unlock waits", () => {
    render(UnlockDialog);
    expect(dialog()).toBeNull();
  });

  it("asks for a timed unlock with the label, the duration and what it means", async () => {
    render(UnlockDialog);
    pending("aks-prod-01-emm", 15);
    await tick();
    expect(dialog()).toHaveAccessibleName("Make aks-prod-01-emm writable?");
    expect(screen.getByRole("heading", { name: "Make aks-prod-01-emm writable?" })).toBeInTheDocument();
    expect(screen.getByText("Production · for 15 minutes")).toBeInTheDocument();
    expect(screen.getByText(ACTIONS)).toBeInTheDocument();
    expect(screen.getByText(wholeText("It goes back to read-only after 15 minutes or when CubeLite quits."))).toBeInTheDocument();
    // "read-" never ends a line.
    expect(
      screen.getByText(wholeText("It goes back to read-only after 15 minutes or when CubeLite quits.")).querySelector(".whitespace-nowrap"),
    ).toHaveTextContent(/^read-only$/);
    expect(screen.getByRole("checkbox", { name: "Don't ask again" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    // The action is allowed and chosen: tonal, not danger.
    expect(screen.getByRole("button", { name: "Make writable" })).toHaveAttribute("data-variant", "tonal");
  });

  it("names an hour, and leaves the label out when there is none", async () => {
    render(UnlockDialog);
    pending("dol-lab-aks", 60);
    await tick();
    // It starts the line: a capital, as "Always" has.
    expect(screen.getByText("For 1 hour")).toBeInTheDocument();
    expect(screen.getByText(wholeText("It goes back to read-only after 1 hour or when CubeLite quits."))).toBeInTheDocument();
  });

  it("starts a summary without a label with a capital", async () => {
    render(UnlockDialog);
    pending("dol-lab-aks", 5);
    await tick();
    expect(screen.getByText("For 5 minutes")).toBeInTheDocument();
    clusterSettings.pendingUnlock = null;
    await tick();
    pending("dol-lab-aks", "always");
    await tick();
    expect(screen.getByText("Always")).toBeInTheDocument();
  });

  it("says Always stays until made read-only", async () => {
    render(UnlockDialog);
    pending("aks-prod-01-emm", "always");
    await tick();
    expect(screen.getByText("Production · always")).toBeInTheDocument();
    expect(screen.getByText(wholeText("It stays writable until you make it read-only."))).toBeInTheDocument();
    expect(screen.queryByText(/goes back to/)).toBeNull();
  });

  it("starts with the focus on Cancel", async () => {
    render(UnlockDialog);
    pending("aks-prod-01-emm", 5);
    await tick();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });

  it("Esc cancels, and nothing is sent", async () => {
    render(UnlockDialog);
    pending("aks-prod-01-emm", 5);
    await tick();
    expect(app.closeTopOverlay()).toBe(true);
    await tick();
    expect(clusterSettings.pendingUnlock).toBeNull();
    expect(dialog()).toBeNull();
    expect(makeClusterWritable).not.toHaveBeenCalled();
  });

  it("Cancel and the close button cancel", async () => {
    render(UnlockDialog);
    pending("aks-prod-01-emm", 5);
    await tick();
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(clusterSettings.pendingUnlock).toBeNull();
    pending("aks-prod-01-emm", 5);
    await tick();
    await fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(clusterSettings.pendingUnlock).toBeNull();
    expect(makeClusterWritable).not.toHaveBeenCalled();
  });

  it("Make writable confirms; Don't ask again passes true", async () => {
    const confirm = vi.spyOn(clusterSettings, "confirmPendingUnlock").mockResolvedValue();
    render(UnlockDialog);
    pending("aks-prod-01-emm", 15);
    await tick();
    await fireEvent.click(screen.getByRole("button", { name: "Make writable" }));
    expect(confirm).toHaveBeenLastCalledWith(false);

    pending("aks-prod-01-emm", 15);
    await tick();
    await fireEvent.click(screen.getByRole("checkbox", { name: "Don't ask again" }));
    await fireEvent.click(screen.getByRole("button", { name: "Make writable" }));
    expect(confirm).toHaveBeenLastCalledWith(true);
    confirm.mockRestore();
  });

  it("the checkbox starts unchecked each time the dialog opens", async () => {
    render(UnlockDialog);
    pending("aks-prod-01-emm", 15);
    await tick();
    await fireEvent.click(screen.getByRole("checkbox", { name: "Don't ask again" }));
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    pending("aks-prod-01-emm", 5);
    await tick();
    expect(screen.getByRole("checkbox", { name: "Don't ask again" })).not.toBeChecked();
  });
});

describe("UnlockDialog focus on close (#662)", () => {
  let opener: HTMLButtonElement;
  let chip: HTMLButtonElement;

  beforeEach(() => {
    // The top bar's cluster chip, the fallback when the opener is gone.
    chip = document.createElement("button");
    chip.setAttribute("data-cluster-chip", "");
    chip.textContent = "aks-prod-01-emm";
    document.body.append(chip);
    opener = document.createElement("button");
    opener.textContent = "Make writable for";
    document.body.append(opener);
    opener.focus();
  });

  afterEach(() => {
    chip.remove();
    opener.remove();
  });

  async function open(): Promise<void> {
    pending("aks-prod-01-emm", 5);
    await tick();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  }

  it("Esc gives the focus back to what opened it", async () => {
    render(UnlockDialog);
    await open();
    app.closeTopOverlay();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("Cancel gives the focus back to what opened it", async () => {
    render(UnlockDialog);
    await open();
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("Make writable gives the focus back to what opened it", async () => {
    vi.mocked(makeClusterWritable).mockResolvedValue({
      contexts: [{ ...prod, access: "writable", writable_until: Date.now() + 300_000 }],
      variants: clusterSettings.variants,
      recovered: false,
      confirm_unlock: true,
      read_only_from_start: ["production"],
    });
    render(UnlockDialog);
    await open();
    await fireEvent.click(screen.getByRole("button", { name: "Make writable" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("falls back to the cluster chip when the opener is gone (a menu that closed)", async () => {
    render(UnlockDialog);
    await open();
    opener.remove();
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(chip).toHaveFocus());
  });
});
