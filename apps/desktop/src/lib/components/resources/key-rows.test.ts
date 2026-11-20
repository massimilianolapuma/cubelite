import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, within } from "@testing-library/svelte";
import KeyRows, { type KeyRowInfo, type KeyRowState } from "./KeyRows.svelte";

// The key rows of #661, with the `masked` prop of #668: a Secret's value is
// hidden behind dots until revealed; a ConfigMap's is only not read yet.
const KEYS: KeyRowInfo[] = [
  { key: "LOG_LEVEL", size: 4, binary: false },
  { key: "application.yaml", size: 2150, binary: false },
  { key: "big.json", size: 70_000, binary: false },
  { key: "logo.png", size: 14_336, binary: true },
  { key: "unused", size: 0, binary: false },
];

function draw(states: Record<string, KeyRowState> = {}, masked?: boolean) {
  const props = {
    keys: KEYS,
    label: "Keys of app-config",
    stateOf: (key: string) => states[key] ?? ({ kind: "hidden" } as const),
    onToggle: vi.fn(),
    onCopy: vi.fn(),
    ...(masked === undefined ? {} : { masked }),
  };
  const view = render(KeyRows, { props });
  const block = view.getByRole("group", { name: "Keys of app-config" });
  const row = (key: string) => block.querySelector(`[data-key-row="${key}"]`) as HTMLElement;
  const names = (key: string) => within(row(key)).queryAllByRole("button").map((b) => b.getAttribute("aria-label"));
  return { block, row, names };
}

describe("KeyRows with masked={false} (#668)", () => {
  it("leaves the value area of a key not shown empty: no dots, no hidden", () => {
    const { block, row } = draw({}, false);
    expect(block).not.toHaveTextContent("••••••••");
    expect(within(block).queryByText("hidden")).toBeNull();
    const area = row("LOG_LEVEL").querySelector("[data-key-value]") as HTMLElement;
    expect(area).toBeEmptyDOMElement();
    expect(row("LOG_LEVEL")).toHaveTextContent("4 B");
  });

  it("reads Show, then Reading… while the request runs, then Hide, with the key in each name", () => {
    let { row, names } = draw({}, false);
    expect(names("application.yaml")).toEqual(["Show application.yaml", "Copy application.yaml"]);
    expect(within(row("application.yaml")).getByRole("button", { name: "Show application.yaml" })).toHaveTextContent(
      "Show",
    );
    cleanup();

    ({ row } = draw({ "application.yaml": { kind: "reading" } }, false));
    const reading = within(row("application.yaml")).getByRole("button", { name: "Reading application.yaml" });
    expect(reading).toHaveTextContent("Reading…");
    cleanup();

    ({ row, names } = draw({ "application.yaml": { kind: "shown", value: "server:\n  port: 8080\n" } }, false));
    expect(names("application.yaml")).toEqual(["Hide application.yaml", "Copy application.yaml"]);
    expect(within(row("application.yaml")).getByRole("button", { name: "Hide application.yaml" })).toHaveTextContent(
      "Hide",
    );
    const shown = row("application.yaml").querySelector("[data-key-shown]") as HTMLElement;
    expect(shown.textContent).toBe("server:\n  port: 8080\n");
  });

  it("binary: the area reads binary, Copy base64 only; empty: no action; too large: Copy only", () => {
    const { row, names } = draw({}, false);
    expect(row("logo.png")).toHaveTextContent("binary");
    expect(names("logo.png")).toEqual(["Copy logo.png as base64"]);
    expect(within(row("logo.png")).getByRole("button")).toHaveTextContent("Copy base64");
    expect(row("unused")).toHaveTextContent("empty");
    expect(names("unused")).toEqual([]);
    expect(row("big.json")).toHaveTextContent("too large to show");
    expect(names("big.json")).toEqual(["Copy big.json"]);
  });

  it("shows an error in the row, with its glyph", () => {
    const { row } = draw({ LOG_LEVEL: { kind: "error", message: "Not allowed to read this ConfigMap (403)" } }, false);
    expect(row("LOG_LEVEL")).toHaveTextContent("Not allowed to read this ConfigMap (403)");
    expect(row("LOG_LEVEL").querySelector('[data-glyph="err"]')).not.toBeNull();
    expect(within(row("LOG_LEVEL")).getByRole("button", { name: "Show LOG_LEVEL" })).toBeInTheDocument();
  });
});

describe("KeyRows by default, as a Secret's (#661)", () => {
  it("masks a key not shown and reads Reveal / Hide", () => {
    let { row, names } = draw();
    expect(within(row("LOG_LEVEL")).getByText("••••••••")).toHaveAttribute("aria-hidden", "true");
    expect(within(row("LOG_LEVEL")).getByText("hidden")).toHaveClass("sr-only");
    expect(names("LOG_LEVEL")).toEqual(["Reveal LOG_LEVEL", "Copy LOG_LEVEL"]);
    expect(within(row("LOG_LEVEL")).getByRole("button", { name: "Reveal LOG_LEVEL" })).toHaveTextContent("Reveal");
    cleanup();

    ({ row, names } = draw({ LOG_LEVEL: { kind: "shown", value: "info" } }));
    expect(names("LOG_LEVEL")).toEqual(["Hide LOG_LEVEL", "Copy LOG_LEVEL"]);
    expect(row("LOG_LEVEL")).not.toHaveTextContent("••••••••");
  });

  it("with masked={true} it is the same", () => {
    const { row, names } = draw({}, true);
    expect(within(row("LOG_LEVEL")).getByText("••••••••")).toBeInTheDocument();
    expect(names("LOG_LEVEL")).toEqual(["Reveal LOG_LEVEL", "Copy LOG_LEVEL"]);
  });
});
