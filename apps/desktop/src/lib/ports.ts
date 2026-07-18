/**
 * Port-forward input parsing, mirroring the macOS PortForwardInput rules
 * plus an auto-assign option.
 */

/** Trimmed integer in 1-65535, else null. */
export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= 65535 ? value : null;
}

/**
 * Resolves the local-port field: empty mirrors `remote`, "auto"/"0"
 * request OS assignment (0), anything else must be a valid port.
 */
export function resolveLocalPort(text: string, remote: number): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return remote;
  if (trimmed === "0" || trimmed.toLowerCase() === "auto") return 0;
  return parsePort(trimmed);
}
