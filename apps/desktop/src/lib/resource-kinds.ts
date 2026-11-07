/**
 * Registry of the resource types shown through the generic list (spec
 * 2026-11-07 §4, the ★ types): what the sidebar calls them and where the
 * API serves them. `version` is the default; discovery picks the version
 * the cluster actually prefers. Imported by `app.svelte.ts`: no store
 * imports here.
 */
import type { View } from "#lib/stores/app.svelte.ts";

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
) as unknown as Record<GenericView, GenericKind>;

export function isGenericView(v: unknown): v is GenericView {
  return typeof v === "string" && (GENERIC_VIEWS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Custom kinds (resource-kinds §5.3): any kind discovery reports outside the
// built-in Kubernetes groups, as the view id `crd:<group>/<plural>`.
// ---------------------------------------------------------------------------

export type CustomView = `crd:${string}`;

/** API groups of Kubernetes itself; anything else served is a custom kind. */
export const BUILTIN_GROUPS: ReadonlySet<string> = new Set([
  "",
  "apps",
  "batch",
  "autoscaling",
  "policy",
  "networking.k8s.io",
  "rbac.authorization.k8s.io",
  "storage.k8s.io",
  "scheduling.k8s.io",
  "discovery.k8s.io",
  "coordination.k8s.io",
  "node.k8s.io",
  "events.k8s.io",
  "admissionregistration.k8s.io",
  "apiextensions.k8s.io",
  "apiregistration.k8s.io",
  "authentication.k8s.io",
  "authorization.k8s.io",
  "certificates.k8s.io",
  "flowcontrol.apiserver.k8s.io",
  "internal.apiserver.k8s.io",
  "resource.k8s.io",
  "storagemigration.k8s.io",
  "metrics.k8s.io",
]);

// Group: a DNS subdomain. Plural: a DNS-1035 label, so hyphens are allowed
// (Multus: `network-attachment-definitions.k8s.cni.cncf.io`).
const CUSTOM_ID = /^crd:([a-z0-9](?:[-a-z0-9.]*[a-z0-9])?)\/([a-z](?:[-a-z0-9]*[a-z0-9])?)$/;

export function customView(group: string, plural: string): CustomView {
  return `crd:${group}/${plural}`;
}

export function parseCustomView(v: string): { group: string; plural: string } | null {
  const m = CUSTOM_ID.exec(v);
  return m ? { group: m[1], plural: m[2] } : null;
}

export function isCustomView(v: unknown): v is CustomView {
  return typeof v === "string" && CUSTOM_ID.test(v);
}

/** Views listed through the API server's Table: the ★ kinds and custom kinds. */
export type KindView = GenericView | CustomView;

export function isKindView(v: unknown): v is KindView {
  return isGenericView(v) || isCustomView(v);
}

export function isCustomKind(k: { group: string }): boolean {
  return !BUILTIN_GROUPS.has(k.group);
}

/** kubectl short names and singular/plural words of the hand-written views. */
const BUILTIN_KEYWORDS: Partial<Record<View, readonly string[]>> = {
  overview: ["overview", "dashboard"],
  nodes: ["no", "node", "nodes"],
  pods: ["po", "pod", "pods"],
  deployments: ["deploy", "deployment", "deployments"],
  statefulsets: ["sts", "statefulset", "statefulsets"],
  jobs: ["job", "jobs"],
  cronjobs: ["cj", "cronjob", "cronjobs"],
  helm: ["helm", "release", "releases", "chart"],
  services: ["svc", "service", "services"],
  ingresses: ["ing", "ingress", "ingresses"],
  configmaps: ["cm", "configmap", "configmaps"],
  secrets: ["secret", "secrets"],
  pvcs: ["pvc", "persistentvolumeclaim", "persistentvolumeclaims"],
  events: ["ev", "event", "events"],
  logs: ["log", "logs", "tail"],
};

/** Aliases people type that kubectl has no short name for (spec §6: `crb`). */
const ALIASES: Partial<Record<GenericView, readonly string[]>> = {
  rolebindings: ["rb"],
  clusterroles: ["cr"],
  clusterrolebindings: ["crb"],
};

/** Words the ⌘K palette matches a type by: label, kind, plural, short names (and group for custom kinds). */
export function searchKeywords(
  view: View,
  label: string,
  custom?: { kind: string; plural: string; shortNames: readonly string[] },
): string[] {
  const words = [label];
  const id = isCustomView(view) ? parseCustomView(view) : null;
  if (id) {
    words.push(custom?.kind ?? "", custom?.plural ?? id.plural, ...(custom?.shortNames ?? []), id.group);
  } else if (isGenericView(view)) {
    const k = GENERIC_KINDS[view];
    words.push(k.kind, k.plural, ...k.shortNames, ...(ALIASES[view] ?? []));
  } else {
    words.push(...(BUILTIN_KEYWORDS[view] ?? []));
  }
  return [...new Set(words.filter((w) => w !== "").map((w) => w.toLowerCase()))];
}
