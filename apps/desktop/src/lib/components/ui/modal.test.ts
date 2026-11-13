import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { createRawSnippet } from "svelte";
import { render, screen } from "@testing-library/svelte";
import Modal from "./Modal.svelte";

const text = (value: string) => createRawSnippet(() => ({ render: () => `<p>${value}</p>` }));

/** The scrolling body: the element that holds the children. */
const body = () => screen.getByText("the body").parentElement!;

describe("Modal", () => {
  it("by default has no region between the body and the footer, and its body is no keyboard stop", () => {
    render(Modal, { props: { title: "Plain", onClose: vi.fn(), children: text("the body"), footer: text("the footer") } });
    expect(document.querySelector("[data-modal-pinned]")).toBeNull();
    expect(body()).not.toHaveAttribute("tabindex");
    expect(body()).not.toHaveAttribute("role");
    expect(body()).not.toHaveAttribute("aria-label");
    expect(screen.queryByRole("region")).toBeNull();
    // The footer follows the body directly.
    expect(body().nextElementSibling?.tagName).toBe("FOOTER");
  });

  it("holds what must stay in view between the scrolling body and the footer, outside the body's scroll", () => {
    render(Modal, {
      props: {
        title: "Pinned",
        onClose: vi.fn(),
        children: text("the body"),
        pinned: text("the check"),
        footer: text("the footer"),
      },
    });
    const pinned = document.querySelector<HTMLElement>("[data-modal-pinned]")!;
    expect(pinned).toHaveTextContent("the check");
    expect(body()).not.toContainElement(pinned);
    expect(body().nextElementSibling).toBe(pinned);
    expect(pinned.nextElementSibling?.tagName).toBe("FOOTER");
    // It does not grow without end: past its cap it scrolls on its own.
    expect(pinned.className).toMatch(/\bmax-h-/);
    expect(pinned).toHaveClass("overflow-y-auto");
    // Without a label it is no region and no keyboard stop.
    expect(pinned).not.toHaveAttribute("role");
    expect(pinned).not.toHaveAttribute("tabindex");
  });

  it("makes the scrolling body a labelled keyboard stop on request", () => {
    render(Modal, {
      props: { title: "Long", onClose: vi.fn(), children: text("the body"), scrollLabel: "Containers and nodes" },
    });
    const region = screen.getByRole("region", { name: "Containers and nodes" });
    expect(region).toBe(body());
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("names the pinned region on request", () => {
    render(Modal, {
      props: { title: "Named", onClose: vi.fn(), children: text("the body"), pinned: text("the check"), pinnedLabel: "Check" },
    });
    expect(screen.getByRole("region", { name: "Check" })).toHaveTextContent("the check");
  });
});
