import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import ReadOnlyNotice from "./ReadOnlyNotice.svelte";
import { clusterSettings } from "#lib/stores/cluster-settings.svelte.ts";
import { setAccess } from "#lib/stores/access-mock.ts";

beforeEach(() => {
  clusterSettings.reset();
});

describe("ReadOnlyNotice (#662, spec §5.4)", () => {
  it("says a read-only cluster is read-only, with a lock, once", () => {
    setAccess("aks-prod-01-emm", "read_only");
    render(ReadOnlyNotice, { props: { name: "aks-prod-01-emm" } });
    const notice = screen.getByTestId("read-only-notice");
    expect(notice).toHaveTextContent("aks-prod-01-emm is read-only");
    expect(notice.querySelector("svg")?.getAttribute("class")).toContain("lucide-lock");
    // The word stays on one line: "read-" never ends a line.
    expect(notice.querySelector(".whitespace-nowrap")).toHaveTextContent("read-only");
  });

  it("shows nothing on a writable cluster, nor one writable for a while", () => {
    setAccess("minikube", "writable");
    setAccess("aks-test", "timed", 5);
    render(ReadOnlyNotice, { props: { name: "minikube" } });
    render(ReadOnlyNotice, { props: { name: "aks-test" } });
    render(ReadOnlyNotice, { props: { name: "never-seen" } });
    expect(screen.queryByTestId("read-only-notice")).toBeNull();
  });

  it("Make writable offers the four durations; one asks the store for that unlock", async () => {
    setAccess("aks-prod-01-emm", "read_only");
    const request = vi.spyOn(clusterSettings, "requestUnlock").mockResolvedValue();
    render(ReadOnlyNotice, { props: { name: "aks-prod-01-emm" } });
    await fireEvent.click(screen.getByRole("button", { name: "Make writable" }));
    await screen.findByRole("menuitem", { name: "15 minutes" });
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual([
      "5 minutes",
      "15 minutes",
      "1 hour",
      "Always",
    ]);
    await fireEvent.click(screen.getByRole("menuitem", { name: "15 minutes" }));
    expect(request).toHaveBeenCalledWith("aks-prod-01-emm", 15);
    request.mockRestore();
  });
});
