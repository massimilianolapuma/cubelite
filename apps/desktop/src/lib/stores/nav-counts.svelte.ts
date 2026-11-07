/**
 * The count a sidebar row (and the ⌘K palette) shows for a type (#574):
 * a neutral total plus, for pods and events, a separate attention badge.
 * Null while the kind is not loaded for the current cluster + namespace.
 */
import { app, type View } from "./app.svelte";
import { dynamic } from "./dynamic.svelte";
import { isExtraKind, resources } from "./resources.svelte";
import { isKindView } from "#lib/resource-kinds.ts";

export interface Attention {
  value: number;
  /** Tooltip and accessible name, e.g. "3 pods need attention". */
  label: string;
  tone: "err" | "warn";
  /** Opens the list filtered to these items. */
  open: () => void;
}

export interface Count {
  value: number;
  /**
   * Items needing attention: a separate badge next to the neutral total
   * (#574), so 24 failing pods out of 187 do not turn all 187 red.
   */
  attention: Attention | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One right-aligned count per row; null when the kind is not loaded. */
export function countFor(v: View): Count | null {
  switch (v) {
    case "pods": {
      const issues = resources.issuePods.length;
      return {
        value: resources.pods.length,
        attention:
          issues > 0
            ? {
                value: issues,
                label: `${plural(issues, "pod needs", "pods need")} attention`,
                tone: "err",
                open: () => {
                  app.navigate("pods");
                  app.podIssuesOnly = true;
                }
              }
            : null
      };
    }
    case "deployments":
      return { value: resources.deployments.length, attention: null };
    case "events": {
      const warnings = resources.warningEvents.length;
      return {
        value: resources.events.length,
        attention:
          warnings > 0
            ? {
                value: warnings,
                label: plural(warnings, "warning", "warnings"),
                tone: "warn",
                open: () => {
                  app.navigate("events");
                  app.eventWarningsOnly = true;
                }
              }
            : null
      };
    }
    default: {
      if (isKindView(v)) {
        const value = dynamic.count(v);
        return value === null ? null : { value, attention: null };
      }
      if (!isExtraKind(v)) return null;
      const value = resources.kindCount(v);
      return value === null ? null : { value, attention: null };
    }
  }
}
