import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY } from "./empty";
import { formatAge } from "./age";

// Tonal §6: an empty or unknown value is an en dash; a sentence never uses an
// em dash as punctuation (a full stop, a colon or a comma instead).

const SRC = resolve(__dirname, "..");

/** Each Svelte and TypeScript source, tests excluded, with its comments taken out. */
function sources(): { file: string; text: string }[] {
  return readdirSync(SRC, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(svelte|ts)$/.test(e.name) && !/\.test\.ts$/.test(e.name))
    .map((e) => {
      const file = `${e.parentPath}/${e.name}`;
      const text = readFileSync(file, "utf8")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        // A line comment, but not the `//` of a URL inside a string.
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      return { file: file.slice(SRC.length + 1), text };
    });
}

describe("user-visible copy", () => {
  it("has no em dash outside comments", () => {
    const found = sources().flatMap(({ file, text }) =>
      text
        .split("\n")
        .filter((line) => line.includes("—"))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(found).toEqual([]);
  });

  it("writes an empty value as the shared en dash", () => {
    expect(EMPTY).toBe("–");
    expect(formatAge(null)).toBe(EMPTY);
    expect(formatAge("not-a-date")).toBe(EMPTY);
  });

  it("names the en dash once, through EMPTY", () => {
    const literal = /(['"`])–\1|>–</;
    const found = sources()
      .filter(({ file, text }) => file !== "lib/empty.ts" && literal.test(text))
      .map(({ file }) => file);
    expect(found).toEqual([]);
  });
});
