// What a sighted user sees of a key row (#661, #668): jsdom has no layout.
import type { Locator } from "@playwright/test";

/**
 * How many elements of `row` show `text` whole to a sighted user: their own
 * text is it, they are visible and wider than a pixel, and no ancestor up to
 * the row clips them.
 */
export async function wholeShown(row: Locator, text: string): Promise<number> {
  return row.evaluate((root, wanted) => {
    let count = 0;
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join("")
        .trim();
      if (own !== wanted || getComputedStyle(el).visibility !== "visible") continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 2 || box.height <= 2) continue;
      let clipped = false;
      for (let a = el.parentElement; a && !clipped; a = a === root ? null : a.parentElement) {
        if (getComputedStyle(a).overflowX === "visible") continue;
        const r = a.getBoundingClientRect();
        clipped = box.left < r.left - 0.5 || box.right > r.right + 0.5 || box.width < 2 || r.width < 2;
      }
      if (!clipped) count += 1;
    }
    return count;
  }, text);
}
