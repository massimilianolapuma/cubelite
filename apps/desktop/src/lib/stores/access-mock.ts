/**
 * Test helper: give a context an access in the cluster settings store, as the
 * backend would answer it (#662). A timed unlock ends `minutes` after the app
 * clock's `now`; move `clock.now` past it to end it.
 */

import type { ContextEnvironment } from "#lib/tauri.ts";
import { clusterSettings } from "./cluster-settings.svelte";
import { clock } from "./clock.svelte";

export function setAccess(name: string, access: "read_only" | "writable" | "timed", minutes = 5): ContextEnvironment {
  const entry: ContextEnvironment = {
    name,
    environment: null,
    source: "detected",
    detected: null,
    access: access === "read_only" ? "read_only" : "writable",
    writable_until: access === "timed" ? clock.now + minutes * 60_000 : null,
  };
  clusterSettings.byName = { ...clusterSettings.byName, [name]: entry };
  return entry;
}
