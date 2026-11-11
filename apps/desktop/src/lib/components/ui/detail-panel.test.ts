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

  it("marks a missing value as such, not only by its colour", () => {
    render(FactRows, { props: { facts: [["Node", null]] } });
    expect(screen.getByRole("definition")).toHaveAttribute("data-missing", "true");
  });
});
