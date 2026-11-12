import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY } from "./empty";
import { formatAge } from "./age";

// Tonal §6: an empty or unknown value is an en dash; a sentence never uses an
// em dash as punctuation (a full stop, a colon or a comma instead).

const SRC = resolve(__dirname, "..");

/** `s` with every character but its line breaks taken out. */
const keepBreaks = (s: string) => s.replace(/[^\n]/g, "");

/**
 * A file's text with its comments taken out (line breaks kept). In a Svelte
 * file only the script is code: its markup has HTML comments only (a `//` in
 * running text is text), its style block comments only.
 */
function stripComments(text: string, file: string): string {
  if (!file.endsWith(".svelte")) return stripScriptComments(text);
  return text.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)|(<style\b[^>]*>)([\s\S]*?)(<\/style>)|<!--[\s\S]*?-->/g,
    (all, open, script, close, styleOpen, style, styleClose) =>
      open !== undefined
        ? open + stripScriptComments(script) + close
        : styleOpen !== undefined
          ? styleOpen + style.replace(/\/\*[\s\S]*?\*\//g, keepBreaks) + styleClose
          : keepBreaks(all),
  );
}

/** Words after which a `/` starts a regular expression, not a division. */
const BEFORE_REGEX = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "else", "do", "yield", "await", "instanceof"]);

/**
 * TypeScript with its `//` and block comments taken out. A small lexer: strings,
 * template literals (with `${}` holes, nested) and regular expressions are kept
 * whole, so a `//` inside one is not taken for a comment.
 */
function stripScriptComments(src: string): string {
  let out = "";
  let i = 0;
  let depth = 0;
  /** Brace depth at which each open `${` hole closes, innermost last. */
  const holes: number[] = [];
  /** Last significant character and, when it ends a word, that word (a space keeps both). */
  let last = "";
  let word = "";

  /** From inside a template literal to its closing backtick or its next hole. */
  const template = () => {
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        out += c;
        i++;
        last = "`";
        return;
      } else if (c === "$" && src[i + 1] === "{") {
        out += "${";
        i += 2;
        holes.push(depth);
        depth++;
        last = "{";
        return;
      } else {
        out += c;
        i++;
      }
    }
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close < 0 ? src.length : close + 2;
      out += keepBreaks(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      last = c;
      word = "";
      continue;
    }
    if (c === "`") {
      out += c;
      i++;
      template();
      word = "";
      continue;
    }
    if (c === "}" && holes.length > 0 && holes[holes.length - 1] === depth - 1) {
      holes.pop();
      depth--;
      out += c;
      i++;
      template();
      word = "";
      continue;
    }
    const regex =
      c === "/" && (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last) || BEFORE_REGEX.has(word));
    if (regex) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/.test(src[j])) j++;
      out += src.slice(i, j);
      i = j;
      last = ")";
      word = "";
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    out += c;
    i++;
    if (/[\w$]/.test(c)) {
      // A word runs on while its characters follow each other.
      word = /[\w$]/.test(src[i - 2] ?? "") ? word + c : c;
      last = c;
    } else if (/\S/.test(c)) {
      last = c;
      word = "";
    }
  }
  return out;
}

/** Each Svelte and TypeScript source, tests excluded, with its comments taken out. */
function sources(): { file: string; text: string }[] {
  return readdirSync(SRC, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(svelte|ts)$/.test(e.name) && !/\.test\.ts$/.test(e.name))
    .map((e) => {
      const file = `${e.parentPath}/${e.name}`;
      const text = stripComments(readFileSync(file, "utf8"), file);
      return { file: file.slice(SRC.length + 1), text };
    });
}

const DASH = "—";

describe("the comment stripper", () => {
  it("drops line and block comments in a script", () => {
    const code = [`const a = 1; // aside ${DASH} here`, `/* block ${DASH}`, `   still */ const b = 2;`].join("\n");
    expect(stripComments(code, "x.ts")).not.toContain(DASH);
    expect(stripComments(code, "x.ts")).toContain("const b = 2;");
  });

  it("keeps a // inside a string or a template literal, and what follows it", () => {
    for (const code of [
      `const a = "see // ${DASH} here";`,
      `const a = 'see // ${DASH} here';`,
      "const a = `see // " + DASH + " here`;",
      "const a = `${x // y\n} ok // " + DASH + "`;",
      `const url = "https://example.com/a ${DASH} b";`,
      `const a = "quote \\" // ${DASH}";`,
      `const r = /"/g; const s = "// ${DASH}";`,
      `function f() { return /'[/]/.test(x) ? "// ${DASH}" : y / 2; }`,
    ]) {
      expect(stripComments(code, "x.ts"), code).toContain(DASH);
    }
  });

  it("keeps markup text with a // in a Svelte file, and strips its comments", () => {
    const svelte = [
      "<script>",
      `  const a = "x"; // aside ${DASH}`,
      `  const b = 'y // ${DASH} kept';`,
      "</script>",
      `<!-- note ${DASH} -->`,
      `<p>Docs at https://example.com ${DASH} kept</p>`,
      `<style>/* ${DASH} */ p { color: red; }</style>`,
    ].join("\n");
    const out = stripComments(svelte, "X.svelte");
    expect(out.match(new RegExp(DASH, "g"))).toHaveLength(2);
    expect(out).toContain(`y // ${DASH} kept`);
    expect(out).toContain(`https://example.com ${DASH} kept`);
  });
});

describe("user-visible copy", () => {
  it("has no em dash outside comments", () => {
    const found = sources().flatMap(({ file, text }) =>
      text
        .split("\n")
        .filter((line) => line.includes(DASH))
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
