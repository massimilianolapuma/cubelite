import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import StatusBadge from "./StatusBadge.svelte";
import StatusPill from "./StatusPill.svelte";
import Button from "./Button.svelte";
import Chip from "./Chip.svelte";
import Switch from "./Switch.svelte";
import SegmentedControl from "./SegmentedControl.svelte";
import StatCard from "./StatCard.svelte";
import Toaster from "./Toaster.svelte";
import { toasts } from "#lib/stores/toasts.svelte.ts";

const text = (value: string) => createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));
const glyphOf = (el: Element) => el.querySelector("svg[data-glyph]")?.getAttribute("data-glyph") ?? null;

describe("StatusBadge", () => {
  it("pairs every state with its own shape and the word", () => {
    for (const state of ["ok", "warn", "err", "done", "unknown"] as const) {
      const { unmount } = render(StatusBadge, { props: { state, label: `is ${state}` } });
      const badge = screen.getByText(`is ${state}`).closest("[data-state]")!;
      expect(badge).toHaveAttribute("data-state", state);
      expect(glyphOf(badge)).toBe(state);
      unmount();
    }
  });

  it("fills only attention and failure; healthy stays plain text", () => {
    const fill = (state: "ok" | "warn" | "err" | "done") => {
      const { unmount } = render(StatusBadge, { props: { state, label: "x" } });
      const value = screen.getByText("x").closest("[data-state]")!.getAttribute("data-fill");
      unmount();
      return value;
    };
    expect(fill("ok")).toBe("none");
    expect(fill("done")).toBe("none");
    expect(fill("warn")).toBe("warning");
    expect(fill("err")).toBe("error");
  });

  it("gives failure a squarer outline than attention, so the two differ in shape", () => {
    render(StatusBadge, { props: { state: "err", label: "Failed" } });
    render(StatusBadge, { props: { state: "warn", label: "Pending" } });
    // 6 px corners on a 22 px badge read as a rectangle; 10 px would still look like a pill.
    expect(screen.getByText("Failed").closest("[data-state]")).toHaveClass("rounded-xs");
    expect(screen.getByText("Pending").closest("[data-state]")).toHaveClass("rounded-full");
  });
});

describe("StatusPill (v2 API on the new badge)", () => {
  it("has an unknown tone: a dashed ring, lighter than a healthy badge, never a filled chip", () => {
    render(StatusPill, { props: { label: "Unknown", tone: "unknown" } });
    const badge = screen.getByText("Unknown").closest("[data-state]")!;
    expect(glyphOf(badge)).toBe("unknown");
    expect(badge).toHaveAttribute("data-fill", "none");
  });

  it("maps tones to states and leaves neutral without a glyph", () => {
    render(StatusPill, { props: { label: "deployed", tone: "ok" } });
    render(StatusPill, { props: { label: "failed", tone: "err" } });
    render(StatusPill, { props: { label: "Normal", tone: "neutral" } });
    expect(glyphOf(screen.getByText("deployed").closest("[data-state]")!)).toBe("ok");
    expect(glyphOf(screen.getByText("failed").closest("[data-state]")!)).toBe("err");
    expect(screen.getByText("Normal").closest("[data-state]")).toBeNull();
    expect(screen.getByText("Normal").parentElement!.querySelector("svg")).toBeNull();
  });
});

describe("Button", () => {
  it("is a real button that reports its variant and runs its handler", async () => {
    const onclick = vi.fn();
    render(Button, { props: { variant: "primary", onclick, children: text("Open logs") } });
    const button = screen.getByRole("button", { name: "Open logs" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("data-variant", "primary");
    await fireEvent.click(button);
    expect(onclick).toHaveBeenCalledOnce();
  });

  it("while pending keeps its label and its focus, shows a spinner and ignores clicks", async () => {
    const onclick = vi.fn();
    render(Button, { props: { pending: true, onclick, children: text("Restart") } });
    const button = screen.getByRole("button", { name: "Restart" });
    expect(button).toHaveAttribute("aria-busy", "true");
    // Busy, not natively disabled: a disabled button would drop keyboard focus.
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    button.focus();
    expect(button).toHaveFocus();
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    await fireEvent.click(button);
    expect(onclick).not.toHaveBeenCalled();
  });

  it("an icon-only button takes its name from the label prop", () => {
    render(Button, { props: { iconOnly: true, label: "Close details", children: text("") } });
    expect(screen.getByRole("button", { name: "Close details" })).toHaveAttribute("data-icon-only", "true");
  });

  it("keeps a caller's aria-label, with or without iconOnly", () => {
    render(Button, { props: { iconOnly: true, "aria-label": "Close", children: text("") } });
    render(Button, { props: { "aria-label": "Retry now", children: text("Retry") } });
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry now" })).toBeInTheDocument();
  });

  it("a disabled button can still show why in its tooltip", () => {
    render(Button, { props: { disabled: true, title: "Requires backend support", children: text("Delete") } });
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button).toHaveAttribute("title", "Requires backend support");
    expect(button.className).not.toContain("pointer-events-none");
  });

  it("is disabled without being busy", () => {
    render(Button, { props: { disabled: true, children: text("Scale") } });
    const button = screen.getByRole("button", { name: "Scale" });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("aria-busy");
  });
});

describe("Chip", () => {
  it("is a toggle with its count and, for a status, its shape", async () => {
    const onToggle = vi.fn();
    render(Chip, { props: { label: "Failing", count: 2, state: "err", pressed: false, onToggle } });
    const chip = screen.getByRole("button", { name: /Failing/ });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(chip).toHaveTextContent("2");
    expect(glyphOf(chip)).toBe("err");
    await fireEvent.click(chip);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("when pressed takes its state's fill, or the primary one without a state", () => {
    render(Chip, { props: { label: "Failing", state: "err", pressed: true, onToggle: () => {} } });
    render(Chip, { props: { label: "Mine", pressed: true, onToggle: () => {} } });
    render(Chip, { props: { label: "Off", pressed: false, onToggle: () => {} } });
    expect(screen.getByRole("button", { name: /Failing/ })).toHaveAttribute("data-fill", "error");
    expect(screen.getByRole("button", { name: "Mine" })).toHaveAttribute("data-fill", "primary");
    expect(screen.getByRole("button", { name: "Off" })).toHaveAttribute("data-fill", "none");
  });
});

describe("Switch", () => {
  it("says on or off and flips", async () => {
    const onChange = vi.fn();
    render(Switch, { props: { checked: false, label: "Skip TLS", onChange } });
    const toggle = screen.getByRole("switch", { name: "Skip TLS" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("on is the primary colour, not the healthy green: on is a setting, not a state", () => {
    render(Switch, { props: { checked: true, label: "Hints", onChange: () => {} } });
    const toggle = screen.getByRole("switch", { name: "Hints" });
    expect(toggle).toHaveClass("bg-primary");
    expect(toggle.getAttribute("style") ?? "").not.toContain("status-ok");
  });
});

describe("SegmentedControl", () => {
  const segments = [
    { value: "a", label: "Raw" },
    { value: "b", label: "JSON" },
    { value: "c", label: "ECS", disabled: true },
  ];

  it("marks the selected segment and reports a change", async () => {
    const onChange = vi.fn();
    render(SegmentedControl, { props: { segments, value: "a", onChange, label: "View" } });
    expect(screen.getByRole("radio", { name: "Raw" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Raw" })).toHaveAttribute("data-selected", "true");
    await fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.getByRole("radio", { name: "ECS" })).toBeDisabled();
  });
});

describe("StatCard", () => {
  it("a warning value fills the tile and carries the triangle", () => {
    render(StatCard, { props: { label: "Warnings", value: 3, tone: "warn" } });
    const tile = screen.getByText("Warnings").closest("[data-tone]")!;
    expect(tile).toHaveAttribute("data-tone", "warn");
    expect(glyphOf(tile)).toBe("warn");
  });

  it("a plain or healthy value is not filled and has no glyph", () => {
    render(StatCard, { props: { label: "Nodes", value: 5 } });
    render(StatCard, { props: { label: "Online", value: 2, tone: "ok" } });
    for (const label of ["Nodes", "Online"]) {
      const tile = screen.getByText(label).closest("[data-tone]")!;
      expect(tile).toHaveAttribute("data-tone", "none");
      expect(glyphOf(tile)).toBeNull();
    }
  });

  it("as a button keeps its accessible name", () => {
    render(StatCard, { props: { label: "Pods", value: 7, target: "Pods", onclick: () => {} } });
    expect(screen.getByRole("button", { name: "Pods: 7. Open Pods" })).toBeInTheDocument();
  });
});

describe("Toaster", () => {
  it("shows a toast's outcome as a shape beside its message", () => {
    toasts.items = [];
    toasts.push("Pod deleted", "ok");
    toasts.push("Could not delete", "err");
    render(Toaster);
    expect(glyphOf(screen.getByText("Pod deleted").closest("[data-tone]")!)).toBe("ok");
    expect(glyphOf(screen.getByText("Could not delete").closest("[data-tone]")!)).toBe("err");
    toasts.items = [];
  });
});

describe("icon toggles", () => {
  it("a pressed toggle is filled with the primary colour: a fill a step away would not show", async () => {
    const { iconToggle } = await import("#lib/ui-classes.ts");
    expect(iconToggle(true)).toContain("bg-primary ");
    expect(iconToggle(true)).toContain("text-on-primary ");
    expect(iconToggle(false)).not.toContain("bg-primary");
  });
});
