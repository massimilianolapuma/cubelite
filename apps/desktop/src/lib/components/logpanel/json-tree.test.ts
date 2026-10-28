import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import JsonTree from "./JsonTree.svelte";

const obj = {
  a: "str",
  n: 2,
  ok: true,
  z: null,
  nest: { deep: { deeper: { deepest: 1 } } },
  list: [7, 8, 9],
};
const raw = JSON.stringify(obj);

afterEach(() => vi.restoreAllMocks());

describe("JsonTree", () => {
  it("renders scalars with their type token", () => {
    render(JsonTree, { props: { value: obj, raw } });
    expect(screen.getByText('"str"')).toHaveAttribute("data-json", "string");
    expect(screen.getByText("2")).toHaveAttribute("data-json", "number");
    expect(screen.getByText("true")).toHaveAttribute("data-json", "boolean");
    expect(screen.getByText("null")).toHaveAttribute("data-json", "null");
  });
  it("caps default expansion at depth 2 for deep objects", () => {
    render(JsonTree, { props: { value: obj, raw } });
    expect(screen.getByText("deep")).toBeInTheDocument();
    expect(screen.getByText("{1 keys}")).toBeInTheDocument();
    expect(screen.queryByText("deepest")).toBeNull();
  });
  it("expands a collapsed node on click", async () => {
    render(JsonTree, { props: { value: obj, raw } });
    const toggle = screen.getAllByRole("button", { expanded: false })[0];
    await fireEvent.click(toggle);
    expect(screen.getByText("deeper")).toBeInTheDocument();
    expect(screen.queryByText("deepest")).toBeNull();
  });
  it("shows [N items] for collapsed arrays", () => {
    render(JsonTree, { props: { value: { l: { m: [1, 2] } }, raw: "{}" } });
    expect(screen.getByText("[2 items]")).toBeInTheDocument();
  });
  it("Copy JSON writes the pretty text and Copy raw writes the raw line", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(JsonTree, { props: { value: { a: 1 }, raw: '{"a":1}' } });
    await fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    expect(writeText).toHaveBeenLastCalledWith('{\n  "a": 1\n}');
    await fireEvent.click(screen.getByRole("button", { name: "Copy raw" }));
    expect(writeText).toHaveBeenLastCalledWith('{"a":1}');
  });
  it("copy buttons swallow clipboard errors", async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    render(JsonTree, { props: { value: { a: 1 }, raw: "{}" } });
    await expect(
      fireEvent.click(screen.getByRole("button", { name: "Copy JSON" })),
    ).resolves.not.toThrow();
  });
  it("does not render copy buttons on nested instances", () => {
    render(JsonTree, { props: { value: { a: 1 }, raw: "{}", depth: 1 } });
    expect(screen.queryByRole("button", { name: "Copy JSON" })).toBeNull();
  });
});
