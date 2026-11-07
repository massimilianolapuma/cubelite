import type { View } from "#lib/stores/app.svelte.ts";
import { GENERIC_KINDS, isGenericView } from "#lib/resource-kinds.ts";

/** Navigation sections of the sidebar (#496, spec §3 and §6b-A; resource-kinds §4). */
export type SectionId = "cluster" | "workloads" | "network" | "storage" | "config" | "access" | "observe";

export type NavItem = { view: View; label: string };
export type NavSection = { id: SectionId; label: string; dot: string; items: NavItem[] };

/** Label of a hand-written view, or of a ★ kind from the registry. */
type Item = View | [View, string];

// Dot colours: workloads blue, network violet, storage teal, config amber,
// access pink, observe teal (resource-kinds mockup). One row per section:
// id, label, dot colour, items in default order.
const SECTION_TABLE: [SectionId, string, string, Item[]][] = [
  ["cluster", "Cluster", "var(--color-accent)", [["overview", "Overview"], ["nodes", "Nodes"], "namespaces"]],
  ["workloads", "Workloads", "var(--color-cluster-blue)", [["pods", "Pods"], ["deployments", "Deployments"], ["statefulsets", "StatefulSets"], "daemonsets", "replicasets", ["jobs", "Jobs"], ["cronjobs", "CronJobs"], "hpas", ["helm", "Helm Releases"]]],
  ["network", "Network", "var(--color-cluster-violet)", [["services", "Services"], ["ingresses", "Ingresses"], "ingressclasses", "endpointslices", "networkpolicies"]],
  ["storage", "Storage", "var(--color-cluster-teal)", [["pvcs", "PVCs"], "pvs", "storageclasses"]],
  ["config", "Config", "var(--color-status-warn)", [["configmaps", "ConfigMaps"], ["secrets", "Secrets"], "resourcequotas", "limitranges", "pdbs", "priorityclasses"]],
  ["access", "Access Control", "var(--color-cluster-pink)", ["serviceaccounts", "roles", "rolebindings", "clusterroles", "clusterrolebindings"]],
  ["observe", "Observe", "var(--color-cluster-teal)", [["events", "Events"], ["logs", "Logs"]]],
];

function navItem(item: Item): NavItem {
  if (Array.isArray(item)) return { view: item[0], label: item[1] };
  if (!isGenericView(item)) throw new Error(`no label for view ${item}`);
  return { view: item, label: GENERIC_KINDS[item].label };
}

export const DEFAULT_SECTIONS: readonly NavSection[] = SECTION_TABLE.map(([id, label, dot, items]) => ({
  id,
  label,
  dot,
  items: items.map(navItem),
}));

/** Overview is the landing page: first, never hidden or moved. */
export const PINNED_VIEW: View = "overview";
/** The section holding the pinned view stays first. */
export const PINNED_SECTION: SectionId = "cluster";

export type NavPrefs = { sections: SectionId[]; order: View[]; hidden: View[] };

const ALL_ITEMS = DEFAULT_SECTIONS.flatMap((s) => s.items.map((i) => i.view));

export const DEFAULT_NAV: NavPrefs = {
  sections: DEFAULT_SECTIONS.map((s) => s.id),
  order: [...ALL_ITEMS],
  hidden: [],
};

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Inserts the ids missing from `stored` after their default predecessor
 * (or first when they have none), dropping unknown and duplicate ids.
 */
function merge<T extends string>(stored: string[], defaults: readonly T[]): T[] {
  const known = new Set<string>(defaults);
  const out: T[] = [];
  for (const id of stored) if (known.has(id) && !out.includes(id as T)) out.push(id as T);
  defaults.forEach((id, i) => {
    if (out.includes(id)) return;
    const before = i === 0 ? -1 : out.indexOf(defaults[i - 1]);
    out.splice(before + 1, 0, id);
  });
  return out;
}

/** Repairs stored preferences: unknown ids dropped, new ids at their default place, pins enforced. */
export function normalize(raw: unknown): NavPrefs {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const sections = merge(strings(obj.sections), DEFAULT_NAV.sections).filter((s) => s !== PINNED_SECTION);
  const order: View[] = [];
  for (const section of DEFAULT_SECTIONS) {
    const own = section.items.map((i) => i.view);
    const items = merge(
      strings(obj.order).filter((v) => (own as string[]).includes(v)),
      own,
    ).filter((v) => v !== PINNED_VIEW);
    if (section.items.some((i) => i.view === PINNED_VIEW)) items.unshift(PINNED_VIEW);
    order.push(...items);
  }
  const hidden = strings(obj.hidden).filter(
    (v, i, all): v is View => (ALL_ITEMS as string[]).includes(v) && v !== PINNED_VIEW && all.indexOf(v) === i,
  );
  // At least one type besides Overview stays visible.
  if (ALL_ITEMS.filter((v) => v !== PINNED_VIEW && !hidden.includes(v)).length === 0) hidden.pop();
  return { sections: [PINNED_SECTION, ...sections], order, hidden };
}

/** Sections in the user's order, items in the user's order, every item (hidden ones included). */
export function arrange(prefs: NavPrefs): NavSection[] {
  return prefs.sections.map((id) => {
    const section = DEFAULT_SECTIONS.find((s) => s.id === id)!;
    const items = prefs.order
      .map((view) => section.items.find((i) => i.view === view))
      .filter((i): i is NavItem => i !== undefined);
    return { ...section, items };
  });
}

/** The sidebar: visible items only; sections left empty are dropped. */
export function visibleSections(prefs: NavPrefs): NavSection[] {
  return arrange(prefs)
    .map((s) => ({ ...s, items: s.items.filter((i) => !prefs.hidden.includes(i.view)) }))
    .filter((s) => s.items.length > 0);
}

function swap<T>(list: T[], i: number, j: number): T[] {
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Moves a section up (-1) or down (+1); the pinned section never moves and stays first. */
export function moveSection(prefs: NavPrefs, id: SectionId, delta: -1 | 1): NavPrefs {
  const i = prefs.sections.indexOf(id);
  const j = i + delta;
  if (id === PINNED_SECTION || i < 0 || j < 1 || j >= prefs.sections.length) return prefs;
  return { ...prefs, sections: swap(prefs.sections, i, j) };
}

/** Moves an item up or down within its section; Overview stays first in its section. */
export function moveItem(prefs: NavPrefs, view: View, delta: -1 | 1): NavPrefs {
  if (view === PINNED_VIEW) return prefs;
  const section = DEFAULT_SECTIONS.find((s) => s.items.some((i) => i.view === view));
  if (!section) return prefs;
  const siblings = prefs.order.filter((v) => section.items.some((i) => i.view === v));
  const k = siblings.indexOf(view);
  const target = siblings[k + delta];
  if (target === undefined || target === PINNED_VIEW) return prefs;
  return { ...prefs, order: swap(prefs.order, prefs.order.indexOf(view), prefs.order.indexOf(target)) };
}

/** Whether `view` may be hidden now (not Overview, not the last visible type). */
export function canHide(prefs: NavPrefs, view: View): boolean {
  if (view === PINNED_VIEW || prefs.hidden.includes(view)) return false;
  return ALL_ITEMS.some((v) => v !== PINNED_VIEW && v !== view && !prefs.hidden.includes(v));
}

export function setHidden(prefs: NavPrefs, view: View, hidden: boolean): NavPrefs {
  if (hidden) return canHide(prefs, view) ? { ...prefs, hidden: [...prefs.hidden, view] } : prefs;
  return { ...prefs, hidden: prefs.hidden.filter((v) => v !== view) };
}
