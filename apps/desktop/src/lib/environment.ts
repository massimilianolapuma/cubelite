/**
 * A cluster's environment label (#662): the four values, their names and the
 * default words detection reads (spec §3.2). Detection itself runs in the
 * backend; the app only shows and sets what the backend holds.
 */

import type { Environment, EnvironmentVariants } from "#lib/tauri.ts";

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
