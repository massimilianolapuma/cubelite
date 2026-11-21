import { describe, it, expect } from "vitest";
import { errorMessage, isReadOnlyError } from "./errors";

const refusal = {
  kind: "read_only",
  context: "p",
  message: "p is read-only. Make it writable from the cluster menu.",
};

describe("errorMessage", () => {
  it("reads an Error and a string as before", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("The cluster settings are not loaded yet.")).toBe(
      "The cluster settings are not loaded yet.",
    );
  });

  it("reads the message of the backend's refusal, not its JSON (#662)", () => {
    expect(errorMessage(refusal)).toBe("p is read-only. Make it writable from the cluster menu.");
    expect(errorMessage({ kind: "no_context", message: "No cluster was named for this change." })).toBe(
      "No cluster was named for this change.",
    );
  });

  it("an object whose message is not text is still printed whole", () => {
    expect(errorMessage({ message: 5 })).toBe('{"message":5}');
  });
});

describe("isReadOnlyError (#662)", () => {
  it("is true for the read-only refusal only", () => {
    expect(isReadOnlyError(refusal)).toBe(true);
    expect(isReadOnlyError("text")).toBe(false);
    expect(isReadOnlyError({ kind: "no_context" })).toBe(false);
    expect(isReadOnlyError({ kind: "no_context", message: "No cluster was named for this change." })).toBe(false);
    expect(isReadOnlyError({ kind: "read_only", message: "x" })).toBe(false);
    expect(isReadOnlyError(null)).toBe(false);
    expect(isReadOnlyError(undefined)).toBe(false);
  });
});
