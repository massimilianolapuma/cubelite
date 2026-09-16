import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTypeStyle } from "./type-style.ts";

test("parses weight, size and family", () => {
  assert.deepEqual(parseTypeStyle("500 13px sans"), {
    size: 13,
    weight: 500,
    family: "sans",
    uppercase: false,
    tracking: 0,
  });
});

test("parses fractional sizes and mono family", () => {
  assert.deepEqual(parseTypeStyle("400 11.5px mono"), {
    size: 11.5,
    weight: 400,
    family: "mono",
    uppercase: false,
    tracking: 0,
  });
});

test("parses uppercase and letter-spacing flags", () => {
  assert.deepEqual(parseTypeStyle("600 10px sans · uppercase · ls .07em"), {
    size: 10,
    weight: 600,
    family: "sans",
    uppercase: true,
    tracking: 0.07,
  });
});

test("rejects unknown flags", () => {
  assert.throws(() => parseTypeStyle("600 10px sans · italic"), /Unknown typography flag/);
});

test("rejects malformed core", () => {
  assert.throws(() => parseTypeStyle("bold 10px sans"), /Bad typography token/);
});
