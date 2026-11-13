import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/svelte";
import StatusGlyph from "./StatusGlyph.svelte";

const shape = (state: "ok" | "warn" | "err" | "done" | "unknown") => {
  const { container } = render(StatusGlyph, { props: { state } });
  const svg = container.querySelector("svg")!;
  return { svg, tag: svg.firstElementChild!.tagName.toLowerCase(), el: svg.firstElementChild! };
};

describe("StatusGlyph", () => {
  it("draws a different outline for each state, so colour is never the only signal", () => {
    expect(shape("ok").tag).toBe("circle");
    expect(shape("warn").tag).toBe("path"); // triangle
    expect(shape("err").tag).toBe("rect"); // square
  });

  it("tells finished and unknown apart from healthy by an open ring", () => {
    expect(shape("ok").el).not.toHaveAttribute("stroke");
    expect(shape("done").el).toHaveAttribute("fill", "none");
    expect(shape("unknown").el).toHaveAttribute("stroke-dasharray");
    expect(shape("done").el).not.toHaveAttribute("stroke-dasharray");
  });

  it("is decorative and inherits the text colour (survives forced colours)", () => {
    const { svg } = shape("err");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("fill", "currentColor");
    expect(svg).toHaveAttribute("data-glyph", "err");
  });
});
