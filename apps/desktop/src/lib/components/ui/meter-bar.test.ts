import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";
import MeterBar from "./MeterBar.svelte";

function at(percent: number | null) {
  const { container, unmount } = render(MeterBar, { props: { label: "CPU", percent } });
  const root = container.querySelector("[data-level]")!;
  const out = {
    level: root.getAttribute("data-level"),
    glyph: root.querySelector("svg[data-glyph]")?.getAttribute("data-glyph") ?? null,
    fill: [...screen.getByTestId("meter-fill").classList].filter((c) => c.startsWith("bg-")),
    value: screen.getByTestId("meter-value"),
  };
  const bold = out.value.classList.contains("font-bold");
  const text = out.value.textContent?.trim();
  unmount();
  return { ...out, bold, text };
}

describe("MeterBar thresholds (parity v2 §4, Tonal §7)", () => {
  it("is primary below 60%, warning from 60%, error from 75%", () => {
    expect(at(59).level).toBe("normal");
    expect(at(59).fill).toEqual(["bg-primary"]);
    expect(at(60).level).toBe("high");
    expect(at(74.4).fill).toEqual(["bg-warning"]);
    expect(at(75).level).toBe("critical");
    expect(at(75).fill).toEqual(["bg-error"]);
  });

  it("decides the level on the value it shows, so the shape and the number agree", () => {
    // 74.6 reads "75%": it must not carry the 60–74 triangle.
    expect(at(74.6)).toMatchObject({ text: "75%", level: "critical", glyph: "err" });
    expect(at(59.6)).toMatchObject({ text: "60%", level: "high", glyph: "warn" });
  });

  it("marks a threshold with a shape and a bold value, not with colour alone", () => {
    expect(at(59)).toMatchObject({ glyph: null, bold: false });
    expect(at(60)).toMatchObject({ glyph: "warn", bold: true });
    expect(at(75)).toMatchObject({ glyph: "err", bold: true });
  });

  it("with no data shows an empty track and an en dash, never 0%", () => {
    const none = at(null);
    expect(none.level).toBe("none");
    expect(none.text).toBe("–");
    expect(none.glyph).toBeNull();
    expect(none.fill).toEqual([]);
  });

  it("renders the absolute sub-label when given", () => {
    render(MeterBar, { props: { label: "MEM", percent: 25, detail: "2.0 / 8.0 GiB" } });
    expect(screen.getByText("2.0 / 8.0 GiB")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  it("leaves the label column out when it has no label, so a row with a name of its own keeps its room", () => {
    const { container } = render(MeterBar, { props: { percent: 40 } });
    expect(container.querySelector(".type-label")).toBeNull();
    expect(screen.getByText("40%")).toBeInTheDocument();
  });
});
