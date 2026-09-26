/**
 * design/type-style.ts
 *
 * Parses the compact typography token syntax used in design/tokens.json:
 *
 *   "<weight> <size>px <sans|mono>[ · uppercase][ · ls <em>em]"
 *
 * Shared by the CSS and Swift emitters in export-tokens.ts.
 */

export type TypeFamily = "sans" | "mono";
export type TypeWeight = 400 | 500 | 600 | 700;

export interface TypeStyleSpec {
  size: number;
  weight: TypeWeight;
  family: TypeFamily;
  uppercase: boolean;
  /** Letter spacing as a fraction of the font size (em). 0 when unset. */
  tracking: number;
}

const CORE = /^([4-7]00)\s+([\d.]+)px\s+(sans|mono)$/;
const LS = /^ls\s+([\d.]+)em$/;

export function parseTypeStyle(value: string): TypeStyleSpec {
  const [core = "", ...flags] = value.split("·").map((s) => s.trim());
  const m = CORE.exec(core);
  if (!m) throw new Error(`Bad typography token: ${value}`);
  let uppercase = false;
  let tracking = 0;
  for (const flag of flags) {
    const ls = LS.exec(flag);
    if (flag === "uppercase") uppercase = true;
    else if (ls) tracking = Number.parseFloat(ls[1]);
    else throw new Error(`Unknown typography flag "${flag}" in: ${value}`);
  }
  return {
    size: Number.parseFloat(m[2]),
    weight: Number(m[1]) as TypeWeight,
    family: m[3] as TypeFamily,
    uppercase,
    tracking,
  };
}
