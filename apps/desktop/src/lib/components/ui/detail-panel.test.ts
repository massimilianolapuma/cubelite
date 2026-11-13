import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import Drawer from "./Drawer.svelte";
import FactRows from "./FactRows.svelte";
import StatusHero from "./StatusHero.svelte";
import { layout } from "#lib/stores/layout.svelte.ts";

const html = (value: string) => createRawSnippet(() => ({ render: () => value }));

function panel(extra: Record<string, unknown> = {}) {
  return render(Drawer, {
    props: { kind: "Pod", title: "api-0", onClose: vi.fn(), children: html("<p>body</p>"), ...extra },
  });
}

let host: HTMLElement | null = null;
beforeEach(() => (layout.contentWidth = 0));
afterEach(() => {
  host?.remove();
  host = null;
});

describe("Drawer (detail panel)", () => {
  it("is a dialog named after the resource, with the kind above the name", () => {
    panel();
    const dialog = screen.getByRole("dialog", { name: "api-0" });
    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(screen.getByRole("heading", { level: 2, name: "api-0" })).toBeInTheDocument();
    expect(screen.getByText("Pod")).toBeInTheDocument();
  });

  it("overlays the list when the content column is narrower than 1000 px", () => {
    layout.contentWidth = 964;
    panel();
    expect(screen.getByRole("dialog")).toHaveAttribute("data-mode", "overlay");
  });

  it("docks beside the list from 1000 px, and follows the width while open", async () => {
    layout.contentWidth = 1044;
    panel();
    expect(screen.getByRole("dialog")).toHaveAttribute("data-mode", "docked");
    layout.contentWidth = 900;
    await vi.waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("data-mode", "overlay"));
  });

  it("renders into the app's panel host", () => {
    host = document.createElement("div");
    host.setAttribute("data-drawer-host", "");
    document.body.appendChild(host);
    panel();
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("moves focus to its heading and gives it back when it is rendered into the host too", async () => {
    host = document.createElement("div");
    host.setAttribute("data-drawer-host", "");
    const row = document.createElement("button");
    document.body.append(host, row);
    row.focus();
    const view = panel();
    await vi.waitFor(() => expect(host!.querySelector("h2")).toHaveFocus());
    view.unmount();
    expect(row).toHaveFocus();
    row.remove();
  });

  it("moves focus to its heading when it opens", async () => {
    panel();
    await vi.waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "api-0" })).toHaveFocus());
  });

  it("returns focus to where it was when it closes", async () => {
    const row = document.createElement("button");
    row.textContent = "row";
    document.body.appendChild(row);
    row.focus();
    const view = panel();
    await vi.waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveFocus());
    view.unmount();
    expect(row).toHaveFocus();
    row.remove();
  });

  it("does not pull focus back when the user has moved on to something else", async () => {
    const row = document.createElement("button");
    const elsewhere = document.createElement("input");
    document.body.append(row, elsewhere);
    row.focus();
    const view = panel();
    await vi.waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveFocus());
    elsewhere.focus();
    view.unmount();
    expect(elsewhere).toHaveFocus();
    row.remove();
    elsewhere.remove();
  });

  it("closes from its Close button", async () => {
    const onClose = vi.fn();
    panel({ onClose });
    await fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Enter on the heading runs the panel's primary action, so Enter twice on a row still reaches it", async () => {
    const onPrimary = vi.fn();
    panel({ onPrimary, children: html('<button type="button">other</button>') });
    await fireEvent.keyDown(screen.getByRole("heading", { level: 2 }), { key: "Enter" });
    expect(onPrimary).toHaveBeenCalledOnce();
    await fireEvent.keyDown(screen.getByRole("button", { name: "other" }), { key: "Enter" });
    expect(onPrimary).toHaveBeenCalledOnce();
  });

  it("a held Enter that opened the panel does not also run the primary action", async () => {
    const onPrimary = vi.fn();
    panel({ onPrimary });
    await fireEvent.keyDown(screen.getByRole("heading", { level: 2 }), { key: "Enter", repeat: true });
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it("Enter on the heading does nothing while a modal is open above the panel", async () => {
    const onPrimary = vi.fn();
    panel({ onPrimary });
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    await fireEvent.keyDown(screen.getByRole("heading", { level: 2 }), { key: "Enter" });
    modal.remove();
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it("starts at the top again when it shows another object", async () => {
    const view = panel();
    const body = document.querySelector<HTMLElement>("[data-panel-body]")!;
    body.scrollTop = 160;
    await view.rerender({ title: "worker-0" });
    await vi.waitFor(() => expect(body.scrollTop).toBe(0));
  });

  it("gives focus back to the row of the object it shows now, not the one it opened for", async () => {
    const main = document.createElement("main");
    main.innerHTML =
      '<div role="button" tabindex="0" id="first" aria-current="true"></div><div role="button" tabindex="0" id="second"></div>';
    document.body.appendChild(main);
    const [first, second] = [main.querySelector<HTMLElement>("#first")!, main.querySelector<HTMLElement>("#second")!];
    first.focus();
    const view = panel();
    await vi.waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveFocus());
    // The user clicks another row: the panel now shows it.
    first.removeAttribute("aria-current");
    second.setAttribute("aria-current", "true");
    await view.rerender({ title: "worker-0" });
    screen.getByRole("heading", { level: 2 }).focus();
    view.unmount();
    expect(second).toHaveFocus();
    main.remove();
  });

  it("gives focus to the list when the row it came from is gone", async () => {
    const main = document.createElement("main");
    main.innerHTML = '<div class="list-row" role="button" tabindex="0" id="gone"></div><div class="list-row" role="button" tabindex="0" id="left"></div>';
    document.body.appendChild(main);
    main.querySelector<HTMLElement>("#gone")!.focus();
    const view = panel();
    await vi.waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveFocus());
    main.querySelector("#gone")!.remove();
    view.unmount();
    expect(main.querySelector("#left")).toHaveFocus();
    main.remove();
  });

  it("pins its footer under the scrolling body", () => {
    panel({ footer: html('<button type="button">Open logs</button>') });
    const footer = screen.getByRole("button", { name: "Open logs" }).closest("footer")!;
    expect(footer.previousElementSibling).toHaveAttribute("data-panel-body");
  });
});

describe("StatusHero", () => {
  const hero = (state: string, extra: Record<string, unknown> = {}) =>
    render(StatusHero, { props: { state: state as never, label: `is ${state}`, ...extra } });

  it("fills attention and failure, each with its shape, the state as a headline and the reason under it", () => {
    for (const [state, fill] of [
      ["warn", "warning"],
      ["err", "error"],
    ]) {
      const view = hero(state, { reason: "0 of 1 containers ready" });
      const block = screen.getByText(`is ${state}`).closest("[data-hero]")!;
      expect(block).toHaveAttribute("data-hero", fill);
      expect(block.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", state);
      expect(screen.getByText("0 of 1 containers ready")).toBeInTheDocument();
      view.unmount();
    }
  });

  it("keeps healthy, finished and unknown as a plain line with their shape", () => {
    for (const state of ["ok", "done", "unknown"]) {
      const view = hero(state);
      const block = screen.getByText(`is ${state}`).closest("[data-hero]")!;
      expect(block).toHaveAttribute("data-hero", "none");
      expect(block.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", state);
      view.unmount();
    }
  });
});

describe("FactRows", () => {
  it("lists facts as label and value pairs", () => {
    render(FactRows, { props: { facts: [["Namespace", "payments"], ["Node", null]] } });
    const terms = screen.getAllByRole("term").map((el) => el.textContent);
    expect(terms).toEqual(["Namespace", "Node"]);
    expect(screen.getAllByRole("definition").map((el) => el.textContent?.trim())).toEqual(["payments", "–"]);
  });

  it("shows two facts with the same label: a kind may have a column called like one of ours", () => {
    render(FactRows, { props: { facts: [["Namespace", "payments"], ["Namespace", "from-the-server"], ["Status", "a"], ["Status", "b"]] } });
    expect(screen.getAllByRole("term").map((el) => el.textContent)).toEqual(["Namespace", "Namespace", "Status", "Status"]);
    expect(screen.getByText("from-the-server")).toBeInTheDocument();
  });

  it("marks a missing value as such, not only by its colour", () => {
    render(FactRows, { props: { facts: [["Node", null]] } });
    expect(screen.getByRole("definition")).toHaveAttribute("data-missing", "true");
  });
});
