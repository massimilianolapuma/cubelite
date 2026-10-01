import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";
import MeterBar from "./MeterBar.svelte";

function fillAt(percent: number | null): string {
  const { unmount } = render(MeterBar, { props: { label: "CPU", percent } });
  const background = screen.getByTestId("meter-fill").style.background;
  unmount();
  return background;
}

describe("MeterBar thresholds (parity v2 §4)", () => {
  it("uses accent below 60%, warn from 60%, err from 75%", () => {
    expect(fillAt(59)).toBe("var(--color-accent)");
    expect(fillAt(60)).toBe("var(--color-status-warn)");
    expect(fillAt(74.9)).toBe("var(--color-status-warn)");
    expect(fillAt(75)).toBe("var(--color-status-err)");
    expect(fillAt(null)).toBe("transparent");
  });

  it("renders the absolute sub-label when given", () => {
    render(MeterBar, { props: { label: "MEM", percent: 25, detail: "2.0 / 8.0 GiB" } });
    expect(screen.getByText("2.0 / 8.0 GiB")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
  });
});
