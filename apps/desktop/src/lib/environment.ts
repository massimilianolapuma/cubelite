/**
 * A cluster's environment label (#662): the four values, their names and the
 * default words detection reads (spec §3.2). Detection itself runs in the
 * backend; the app only shows and sets what the backend holds.
 */

import type { ContextEnvironment, Environment, EnvironmentSetting, EnvironmentVariants } from "#lib/tauri.ts";

/** Every environment, in the order the app shows them. */
export const ENVIRONMENTS: readonly Environment[] = ["development", "test", "staging", "production"];

export const ENVIRONMENT_LABEL: Record<Environment, string> = {
  development: "Development",
  test: "Test",
  staging: "Staging",
  production: "Production",
};

/** What the app shows for no label. */
export const NOT_SET = "Not set";

export function environmentLabel(environment: Environment | null): string {
  return environment ? ENVIRONMENT_LABEL[environment] : NOT_SET;
}

/** The default variants, as the backend's `Variants::default()`. */
export function defaultVariants(): EnvironmentVariants {
  return {
    development: ["dev", "develop", "development", "svil", "sviluppo"],
    test: ["test", "tst", "qa"],
    staging: ["stg", "stage", "staging", "coll", "collaudo", "uat", "preprod"],
    production: ["prod", "prd", "production", "produzione"],
  };
}

/**
 * One choice of the Environment menu and select: back to detection, one of
 * the four values, or "none" (not set, by hand).
 */
export type EnvironmentChoice = "detected" | Environment | "none";

/** The choice that is checked for a context; unknown to the backend reads as detected. */
export function choiceOf(entry: ContextEnvironment | undefined): EnvironmentChoice {
  if (!entry || entry.source === "detected") return "detected";
  return entry.environment ?? "none";
}

/** The setting the backend stores for a choice. */
export function settingOf(choice: EnvironmentChoice): EnvironmentSetting {
  if (choice === "detected") return { source: "detected" };
  return { source: "manual", value: choice === "none" ? null : choice };
}

/** The choices in menu order, with their text; `detected` is the label detection reads. */
export function environmentChoices(detected: Environment | null): { value: EnvironmentChoice; label: string }[] {
  return [
    { value: "detected", label: `Detect from name (${environmentLabel(detected)})` },
    ...ENVIRONMENTS.map((e) => ({ value: e, label: ENVIRONMENT_LABEL[e] })),
    { value: "none", label: NOT_SET },
  ];
}
