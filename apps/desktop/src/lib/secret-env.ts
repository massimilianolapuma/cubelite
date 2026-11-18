/**
 * A Secret as a `.env` file, as the confirmation draws it (#661, spec §3.3):
 * what will be written and what is left out, from what the list already holds
 * (key names and the binary mark). No value is read to draw it. The backend
 * applies the same rule to the values it reads, and what it answers is what
 * the toast reports (a value with a NUL is only known there).
 */
import type { EnvLeftOutReason, SecretKeyInfo } from "#lib/tauri.ts";

/** A key left out of the file, with the reason. */
export type EnvLeftOut = { key: string; reason: EnvLeftOutReason };

/** What a `.env` of a Secret would hold, in key order. */
export type EnvPlan = { written: string[]; leftOut: EnvLeftOut[] };

/** Whether `key` can be a shell variable's name, as the backend's rule. */
export function isEnvName(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** The keys a `.env` would hold and those it would leave out (a binary value first, then a bad name). */
export function envPlan(keys: readonly SecretKeyInfo[]): EnvPlan {
  const plan: EnvPlan = { written: [], leftOut: [] };
  for (const { key, binary } of keys) {
    if (binary) plan.leftOut.push({ key, reason: "binary" });
    else if (!isEnvName(key)) plan.leftOut.push({ key, reason: "not_a_name" });
    else plan.written.push(key);
  }
  return plan;
}

const REASONS: Record<EnvLeftOutReason, string> = {
  binary: "binary",
  not_a_name: "not a variable name",
  nul: "holds a NUL character",
};

/** `ca.crt (binary)`. */
export function leftOutText({ key, reason }: EnvLeftOut): string {
  return `${key} (${REASONS[reason]})`;
}

/** `n value` or `n values`. */
export function values(n: number): string {
  return `${n} ${n === 1 ? "value" : "values"}`;
}

/** The toast after the file is written: the count, the Secret and the path, never a value. */
export function savedText(name: string, written: number, path: string): string {
  return `${values(written)} of ${name} saved to ${path}`;
}
