/**
 * One-shot session handoff payload for the pop-out log window (#298):
 * everything the receiving JS context needs to recreate the session —
 * identity, stream settings, ring contents, and the kube connection the
 * pop-out (which never runs full app boot) must adopt.
 */
import type { KeyedLogLine } from "./logs.svelte";
import type { LogSession } from "./logSession.svelte";
import { app } from "./app.svelte";

export type SessionTransfer = {
  key: string;
  namespace: string;
  pod: string;
  container: string | null;
  previous: boolean;
  tailLines: number;
  following: boolean;
  lines: KeyedLogLine[];
  kubeconfigPath: string;
  activeCluster: string | null;
};

export function serializeSession(session: LogSession): SessionTransfer {
  return {
    key: session.key,
    namespace: session.namespace,
    pod: session.pod,
    container: session.container,
    previous: session.previous,
    tailLines: session.tailLines,
    following: session.following,
    lines: [...session.ring.lines],
    kubeconfigPath: app.kubeconfigPath,
    activeCluster: app.activeCluster,
  };
}

/** Runtime guard for event payloads crossing the window boundary. */
export function isSessionTransfer(v: unknown): v is SessionTransfer {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.key === "string" &&
    typeof t.namespace === "string" &&
    typeof t.pod === "string" &&
    (t.container === null || typeof t.container === "string") &&
    typeof t.previous === "boolean" &&
    typeof t.tailLines === "number" &&
    typeof t.following === "boolean" &&
    Array.isArray(t.lines) &&
    typeof t.kubeconfigPath === "string" &&
    (t.activeCluster === null || typeof t.activeCluster === "string")
  );
}
