/**
 * Words that must not break across lines (#662). A line may end after a
 * hyphen, so "read-only" could read "read-" / "only". The parts marked `keep`
 * are drawn with `white-space: nowrap`: the characters stay the same, so a
 * screen reader reads the word as written.
 */

const KEEP = /(read-only)/i;

export function keepTogether(text: string): { text: string; keep: boolean }[] {
  return text
    .split(KEEP)
    .map((part, i) => ({ text: part, keep: i % 2 === 1 }))
    .filter((part) => part.text !== "");
}
