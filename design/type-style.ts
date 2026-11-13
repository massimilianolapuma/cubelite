/**
 * design/type-style.ts
 *
 * Parses the compact typography token syntax used in design/tokens.json:
 *
 *   "<weight> <size>px <sans|mono|display>[ · ls <em>em]"
 *
 * Used by the CSS builder in build-css.ts. There is no uppercase flag: labels
 * are sentence case (Tonal §4.3).
 */

export type TypeFamily = "sans" | "mono" | "display";
export type TypeWeight = 400 | 500 | 600 | 700;

export interface TypeStyleSpec {
  size: number;
  weight: TypeWeight;
  family: TypeFamily;
  /** Letter spacing as a fraction of the font size (em). 0 when unset. */
  tracking: number;
}

const CORE = /^([4-7]00)\s+([\d.]+)px\s+(sans|mono|display)$/;
const LS = /^ls\s+(-?[\d.]+)em$/;

export function parseTypeStyle(value: string): TypeStyleSpec {
  const [core = "", ...flags] = value.split("·").map((s) => s.trim());
  const m = CORE.exec(core);
  if (!m) throw new Error(`Bad typography token: ${value}`);
  let tracking = 0;
  for (const flag of flags) {
    const ls = LS.exec(flag);
    if (ls) tracking = Number.parseFloat(ls[1]);
    else throw new Error(`Unknown typography flag "${flag}" in: ${value}`);
  }
  return {
    size: Number.parseFloat(m[2]),
    weight: Number(m[1]) as TypeWeight,
    family: m[3] as TypeFamily,
    tracking,
  };
}
