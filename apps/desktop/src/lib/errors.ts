/** The backend's refusal of a write to a read-only cluster (#662). */
export interface ReadOnlyError {
  kind: "read_only";
  context: string;
  message: string;
}

/** An object carrying a text `message`, as the backend's refusals do. */
function hasMessage(e: unknown): e is { message: string } {
  return typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string";
}

/** Human-readable message from an unknown thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (hasMessage(e)) return e.message;
  try {
    return JSON.stringify(e) ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

/** The write was refused because its cluster is read-only; matched on `kind`, never the text. */
export function isReadOnlyError(e: unknown): e is ReadOnlyError {
  if (!hasMessage(e)) return false;
  const { kind, context } = e as { kind?: unknown; context?: unknown };
  return kind === "read_only" && typeof context === "string";
}
