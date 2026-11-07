/**
 * Columns of the generic list (resource-kinds design §5.1): the API
 * server's Table columns, with CubeLite's own Name, Namespace and Age cells.
 */
import { formatAge } from "#lib/age.ts";
import type { TableColumn } from "#lib/tauri.ts";

export type ColumnPlan =
  | { kind: "name" }
  | { kind: "namespace" }
  | { kind: "age"; label: string }
  | { kind: "cell"; index: number; label: string; date: boolean };

/**
 * The server's name column (format `name`, else the column called `Name`)
 * becomes CubeLite's name cell, followed by Namespace when `showNamespace`;
 * a date column called `Age` (else `Created At`, as RBAC kinds print it)
 * becomes the Age cell, keeping its label. Everything else keeps
 * its server position. No Age column is added when the server has none
 * (kubectl shows none either).
 */
export function planColumns(columns: readonly TableColumn[], showNamespace: boolean): ColumnPlan[] {
  let nameIndex = columns.findIndex((c) => c.format === "name");
  if (nameIndex < 0) nameIndex = columns.findIndex((c) => c.name === "Name");
  const name: ColumnPlan[] = showNamespace ? [{ kind: "name" }, { kind: "namespace" }] : [{ kind: "name" }];
  const plan: ColumnPlan[] = nameIndex < 0 ? [...name] : [];
  // RBAC kinds print `Created At` instead of `Age`: same cell, their label.
  const isDate = (c: TableColumn, label: string) => c.name === label && c.column_type === "date";
  let ageIndex = columns.findIndex((c) => isDate(c, "Age"));
  if (ageIndex < 0) ageIndex = columns.findIndex((c) => isDate(c, "Created At"));
  columns.forEach((c, index) => {
    if (index === nameIndex) plan.push(...name);
    else if (index === ageIndex) plan.push({ kind: "age", label: c.name });
    else plan.push({ kind: "cell", index, label: c.name, date: c.column_type === "date" });
  });
  return plan;
}

/** One Table cell as text; `date` cells as an age. */
export function cellText(value: unknown, date: boolean, now?: Date): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return date ? formatAge(value, now) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => cellText(v, date, now)).join(", ");
  return JSON.stringify(value);
}

const WIDTH: Record<ColumnPlan["kind"], string> = {
  name: "minmax(0,3fr)",
  namespace: "minmax(0,1fr)",
  cell: "minmax(0,1fr)",
  age: "0.55fr",
};

export function gridTemplate(plan: readonly ColumnPlan[]): string {
  return `grid-template-columns: ${plan.map((c) => WIDTH[c.kind]).join(" ")};`;
}
