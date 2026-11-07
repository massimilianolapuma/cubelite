/**
 * Registry of the resource types shown through the generic list (spec
 * 2026-11-07 §4, the ★ types): what the sidebar calls them and where the
 * API serves them. `version` is the default; discovery picks the version
 * the cluster actually prefers. Imported by `app.svelte.ts`: no store
 * imports here.
 */

export const GENERIC_VIEWS = [
  "namespaces",
  "daemonsets",
  "replicasets",
  "hpas",
  "ingressclasses",
  "endpointslices",
  "networkpolicies",
  "pvs",
  "storageclasses",
  "resourcequotas",
  "limitranges",
  "pdbs",
  "priorityclasses",
  "serviceaccounts",
  "roles",
  "rolebindings",
  "clusterroles",
  "clusterrolebindings",
] as const;

export type GenericView = (typeof GENERIC_VIEWS)[number];

export interface GenericKind {
  /** Sidebar and list title. */
  label: string;
  /** Row noun, singular and plural, e.g. ["daemon set", "daemon sets"]. */
  nouns: readonly [string, string];
  /** API group; `""` for the core group. */
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  shortNames: readonly string[];
}

const RBAC = "rbac.authorization.k8s.io";

// id, label, singular noun, group, version, kind, plural, namespaced, short names
const TABLE: [GenericView, string, string, string, string, string, string, boolean, string[]][] = [
  ["namespaces", "Namespaces", "namespace", "", "v1", "Namespace", "namespaces", false, ["ns"]],
  ["daemonsets", "DaemonSets", "daemon set", "apps", "v1", "DaemonSet", "daemonsets", true, ["ds"]],
  ["replicasets", "ReplicaSets", "replica set", "apps", "v1", "ReplicaSet", "replicasets", true, ["rs"]],
  ["hpas", "Autoscalers", "autoscaler", "autoscaling", "v2", "HorizontalPodAutoscaler", "horizontalpodautoscalers", true, ["hpa"]],
  ["ingressclasses", "Ingress Classes", "ingress class", "networking.k8s.io", "v1", "IngressClass", "ingressclasses", false, []],
  ["endpointslices", "EndpointSlices", "endpoint slice", "discovery.k8s.io", "v1", "EndpointSlice", "endpointslices", true, []],
  ["networkpolicies", "Network Policies", "network policy", "networking.k8s.io", "v1", "NetworkPolicy", "networkpolicies", true, ["netpol"]],
  ["pvs", "Persistent Volumes", "persistent volume", "", "v1", "PersistentVolume", "persistentvolumes", false, ["pv"]],
  ["storageclasses", "Storage Classes", "storage class", "storage.k8s.io", "v1", "StorageClass", "storageclasses", false, ["sc"]],
  ["resourcequotas", "Resource Quotas", "resource quota", "", "v1", "ResourceQuota", "resourcequotas", true, ["quota"]],
  ["limitranges", "Limit Ranges", "limit range", "", "v1", "LimitRange", "limitranges", true, ["limits"]],
  ["pdbs", "Disruption Budgets", "disruption budget", "policy", "v1", "PodDisruptionBudget", "poddisruptionbudgets", true, ["pdb"]],
  ["priorityclasses", "Priority Classes", "priority class", "scheduling.k8s.io", "v1", "PriorityClass", "priorityclasses", false, ["pc"]],
  ["serviceaccounts", "Service Accounts", "service account", "", "v1", "ServiceAccount", "serviceaccounts", true, ["sa"]],
  ["roles", "Roles", "role", RBAC, "v1", "Role", "roles", true, []],
  ["rolebindings", "Role Bindings", "role binding", RBAC, "v1", "RoleBinding", "rolebindings", true, []],
  ["clusterroles", "Cluster Roles", "cluster role", RBAC, "v1", "ClusterRole", "clusterroles", false, []],
  ["clusterrolebindings", "Cluster Role Bindings", "cluster role binding", RBAC, "v1", "ClusterRoleBinding", "clusterrolebindings", false, []],
];

/** English plural of the row nouns above ("policy" → "policies", "class" → "classes"). */
function pluralNoun(noun: string): string {
  if (noun.endsWith("y")) return `${noun.slice(0, -1)}ies`;
  if (noun.endsWith("s")) return `${noun}es`;
  return `${noun}s`;
}

export const GENERIC_KINDS = Object.fromEntries(
  TABLE.map(([view, label, noun, group, version, kind, plural, namespaced, shortNames]) => [
    view,
    { label, nouns: [noun, pluralNoun(noun)], group, version, kind, plural, namespaced, shortNames },
  ]),
) as Record<GenericView, GenericKind>;

export function isGenericView(v: unknown): v is GenericView {
  return typeof v === "string" && (GENERIC_VIEWS as readonly string[]).includes(v);
}
