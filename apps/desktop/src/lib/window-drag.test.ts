import { describe, it, expect } from "vitest";
import { isDragSurface } from "./window-drag";

function build(html: string, selector: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  const el = root.querySelector(selector);
  if (!el) throw new Error(`selector ${selector} not found`);
  return el;
}

describe("isDragSurface", () => {
  it("accepts plain header surfaces", () => {
    expect(isDragSurface(build("<header><div id='x'></div></header>", "#x"))).toBe(true);
  });

  it("rejects interactive elements and their descendants", () => {
    expect(isDragSurface(build("<button id='x'>go</button>", "#x"))).toBe(false);
    expect(isDragSurface(build("<button><span id='x'>go</span></button>", "#x"))).toBe(false);
    expect(isDragSurface(build("<input id='x' />", "#x"))).toBe(false);
    expect(isDragSurface(build("<a href='#' id='x'>l</a>", "#x"))).toBe(false);
  });

  it("rejects opted-out regions via data-no-drag", () => {
    expect(
      isDragSurface(build("<div data-no-drag><span id='x'></span></div>", "#x")),
    ).toBe(false);
  });

  it("rejects null targets", () => {
    expect(isDragSurface(null)).toBe(false);
  });
});
