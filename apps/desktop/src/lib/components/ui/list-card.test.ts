import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import ListCard from "./ListCard.svelte";
import type { ListState } from "#lib/list-state.ts";
import { app } from "#lib/stores/app.svelte.ts";
import { lists } from "#lib/stores/lists.svelte.ts";

const html = (value: string) => createRawSnippet(() => ({ render: () => value }));

function card(state: ListState, extra: Record<string, unknown> = {}) {
  return render(ListCard, {
    props: {
      title: "Pods",
      list: "pods",
      nouns: ["pod", "pods"] as const,
      columns: ["2fr", "1fr"],
      state,
      shown: 3,
      total: 3,
      head: html("<span>Name</span>"),
      children: html('<div data-testid="row">api-1</div>'),
      ...extra,
    },
  });
}

beforeEach(() => {
  lists.resetSession();
  lists.groupByNamespace = false;
  app.namespace = null;
  app.view = "pods";
});

describe("ListCard", () => {
  it("shows the title, the count, the column header and the rows when ready", () => {
    card({ kind: "ready" });
    expect(screen.getByRole("heading", { level: 1, name: "Pods" })).toBeInTheDocument();
    expect(screen.getByTestId("list-count")).toHaveTextContent("3");
    expect(screen.getByTestId("list-count")).toHaveAccessibleName("3 pods");
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByTestId("row")).toBeInTheDocument();
  });

  it("hands the column tracks to the rows as one variable", () => {
    card({ kind: "ready" });
    expect(screen.getByTestId("list-scroller").getAttribute("style")).toContain("--list-cols: 2fr 1fr");
  });

  it("counts shown of total while a filter hides rows", () => {
    card({ kind: "ready" }, { shown: 2, total: 5 });
    expect(screen.getByTestId("list-count")).toHaveTextContent("2 of 5");
    expect(screen.getByTestId("list-count")).toHaveAccessibleName("2 of 5 pods");
  });

  it("says one pod, not one pods", () => {
    card({ kind: "ready" }, { shown: 1, total: 1 });
    expect(screen.getByTestId("list-count")).toHaveAccessibleName("1 pod");
  });

  it("shows placeholder rows while loading: no rows, no count, no empty message", () => {
    card({ kind: "loading" }, { shown: 0, total: 0 });
    const status = screen.getByRole("status", { name: "Loading pods" });
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status.querySelectorAll("[data-placeholder]")).toHaveLength(6);
    expect(screen.queryByTestId("row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("list-count")).not.toBeInTheDocument();
    expect(screen.queryByText(/^No pods/)).not.toBeInTheDocument();
  });

  it("shows the empty state as a heading and one line", () => {
    card({ kind: "empty", title: "No pods in payments", hint: "Look elsewhere." }, { shown: 0, total: 0 });
    expect(screen.getByRole("heading", { level: 2, name: "No pods in payments" })).toBeInTheDocument();
    expect(screen.getByText("Look elsewhere.")).toBeInTheDocument();
    expect(screen.queryByTestId("row")).not.toBeInTheDocument();
  });

  it("offers Clear filter when the filter matches nothing", async () => {
    const onClear = vi.fn();
    card({ kind: "filtered", title: 'No pods match "abc"' }, { shown: 0, total: 3, onClear });
    expect(screen.getByRole("heading", { level: 2, name: 'No pods match "abc"' })).toBeInTheDocument();
    expect(screen.getByTestId("list-count")).toHaveTextContent("0 of 3");
    await fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("shows a failed load as an alert with the server's message and Retry", async () => {
    const onRetry = vi.fn();
    card({ kind: "error", title: "Could not load pods", message: "connection reset" }, { onRetry });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not load pods");
    expect(alert).toHaveTextContent("connection reset");
    expect(alert.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "err");
    await fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("row")).not.toBeInTheDocument();
  });

  it("marks Retry busy while the retry is in flight", () => {
    card({ kind: "error", title: "Could not load pods", message: "x" }, { onRetry: vi.fn(), busy: true });
    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute("aria-busy", "true");
  });

  it("says a list is forbidden with the unknown shape, and offers no retry", () => {
    card({ kind: "forbidden", title: "You are not allowed to list pods in payments." }, { onRetry: vi.fn() });
    const block = screen.getByText("You are not allowed to list pods in payments.").closest("[data-list-state]")!;
    expect(block).toHaveAttribute("data-list-state", "forbidden");
    expect(block.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "unknown");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("says a kind is not available on this cluster with the unknown shape", () => {
    card({ kind: "unavailable" });
    const block = screen.getByText("Not available on this cluster").closest("[data-list-state]")!;
    expect(block.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "unknown");
  });

  it("renders the status chips as a named group and presses them for this list", async () => {
    card(
      { kind: "ready" },
      {
        chips: [
          { key: "err", label: "Failing", state: "err", count: 1, pressed: false },
          { key: "ok", label: "Running", state: "ok", count: 2, pressed: false },
        ],
      },
    );
    const group = screen.getByRole("group", { name: "Filter by status" });
    const failing = within(group).getByRole("button", { name: /Failing/ });
    expect(failing).toHaveAttribute("aria-pressed", "false");
    expect(failing).toHaveTextContent("1");
    await fireEvent.click(failing);
    expect(lists.pressed("pods")).toEqual(["err"]);
  });

  it("has no chip group when there are no chips", () => {
    card({ kind: "ready" });
    expect(screen.queryByRole("group", { name: "Filter by status" })).not.toBeInTheDocument();
  });

  it("offers Group by namespace only for a namespaced list showing all namespaces", () => {
    const first = card({ kind: "ready" });
    expect(screen.getByRole("button", { name: "Group by namespace" })).toBeInTheDocument();
    first.unmount();

    const scoped = card({ kind: "ready" }, { groupable: false });
    expect(screen.queryByRole("button", { name: "Group by namespace" })).not.toBeInTheDocument();
    scoped.unmount();

    app.namespace = "payments";
    card({ kind: "ready" });
    expect(screen.queryByRole("button", { name: "Group by namespace" })).not.toBeInTheDocument();
  });
});
