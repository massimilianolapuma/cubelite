import { describe, it, expect, afterEach } from "vitest";
import { focusOrigin } from "./focus-origin";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("focusOrigin", () => {
  it("is null when nothing has the focus", () => {
    expect(focusOrigin()).toBeNull();
  });

  it("is the focused element outside a menu", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const b = document.getElementById("b")!;
    b.focus();
    expect(focusOrigin()).toBe(b);
  });

  it("is the button that opened the menu, through a submenu", () => {
    document.body.innerHTML = `
      <button id="chip" aria-controls="root">chip</button>
      <div role="menu" id="root">
        <div role="menuitem" id="sub" tabindex="-1" aria-controls="inner">Make writable for</div>
      </div>
      <div role="menu" id="inner"><div role="menuitem" id="five" tabindex="-1">5 minutes</div></div>`;
    document.getElementById("five")!.focus();
    expect(focusOrigin()).toBe(document.getElementById("chip"));
  });

  it("is the item itself when its menu names no trigger", () => {
    document.body.innerHTML = `<div role="menu" id="m"><div role="menuitem" id="i" tabindex="-1">x</div></div>`;
    const item = document.getElementById("i")!;
    item.focus();
    expect(focusOrigin()).toBe(item);
  });
});
