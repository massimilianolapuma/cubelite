# Resource kinds — phase 4: Go to resource in the palette — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ⌘K palette reaches every resource type of the sidebar, matched by label, plural, kind and short name, shows each one's section, count and "Hidden in Preferences", opens it on ↵ and opens and pins it on ⌘↵.

**Architecture:** Search keywords for every navigation view live next to the kind registry (`resource-kinds.ts`). The sidebar's count logic moves out of `NavRow.svelte` into a shared function, so the palette shows the same numbers. `CommandPalette.svelte` gains a "Go to resource" group built from `navigation.arranged`, and a capture-phase key handler for ⌘↵.

**Tech Stack:** Svelte 5, bits-ui 2 `Command` (`keywords` on items, `bind:value` on the root for the highlighted item), Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-sidebar-resources-profiles-design.md` §6 (and §2 anti-goal: the palette always reaches every type).

## Global Constraints

- Every type shown in Preferences › Navigation (`navigation.arranged`, hidden ones included) is a result; the palette is the guaranteed way to every type, whatever the profile and Preferences say (spec §6). Custom kinds join in phase 5.
- Matching: label, plural, kind, short names (`deploy`, `svc`, `pvc`, `hpa`, `netpol`, `sa`, `crb`…), via bits-ui `Command.Item` `keywords`.
- Each result shows its section label, its count when loaded (same rule as the sidebar), and "Hidden in Preferences" when hidden (spec §6 "hidden in <profile>" has no meaning in sidebar C, where a profile only pins and never hides; see Ruling 1).
- ↵ opens the type; ⌘↵ (Ctrl+↵ off macOS) opens it and pins it to the active profile. A refused pin (9-pin cap, hidden type) shows the existing toast and still opens the type.
- Group order: Switch cluster, Actions, Go to resource (the long list last, so the short groups stay visible with an empty query). The duplicate actions "Go to Overview", "Go to Pods", "Go to Deployments" are removed: the resource group covers them (Ruling 2).
- Footer hint: "↵ open · ⌘↵ open and pin to <profile>" (Ctrl+↵ off macOS).
- Commits: Conventional Commits, no Claude attribution. Branch `feat/583-palette-resources`. Gates before each commit (with `set -o pipefail`): `pnpm --filter desktop lint`, `pnpm --filter desktop test`, `pnpm --filter desktop exec svelte-check --threshold error`; before the PR `pnpm --filter desktop test:e2e`. CHANGELOG under `## [Unreleased]`.

**Ruling 1 (confirmed by the user):** results never say "hidden in <profile>": in sidebar C every non-hidden type is in All resources whatever the profile. Pinned types show "Pinned" instead, which tells what ⌘↵ would add.
**Ruling 2 (confirmed by the user):** drop "Go to Overview / Pods / Deployments" from Actions (typing "pods" finds the resource row); keep "All Clusters dashboard", "Tail logs", "Preferences" and the integration actions.

## Review Focus

1. **A short name shared or close to several types** (`cr` → Cluster Roles, ConfigMaps?; `ing` → Ingresses and Ingress Classes): the exact short name ranks its own type first (Task 2 test `a short name ranks its own type first`).
2. **⌘↵ on a type that cannot be pinned** (10th pin, hidden type): the toast shows, the type still opens, the palette closes (Task 2 test `⌘↵ on a full profile still opens the type`).
3. **⌘↵ while a cluster or action row is highlighted**: behaves like ↵ for that row, never pins anything (Task 2 test `⌘↵ on a non-resource row just selects it`).
4. **A cluster context named like a type** (e.g. a context called "Nodes"): both rows show and each selects its own thing (Task 2 test `a context named like a type keeps both rows`).
5. **Hidden types**: still listed and openable, tagged "Hidden in Preferences" (Task 2 test `hidden types stay reachable`).

---

### Task 1: Keywords and shared counts

**Files:**
- Modify: `apps/desktop/src/lib/resource-kinds.ts`, `apps/desktop/src/lib/resource-kinds.test.ts`
- Create: `apps/desktop/src/lib/stores/nav-counts.svelte.ts` (move `countFor` and its `Count`/`Attention` types out of `NavRow.svelte`), `apps/desktop/src/lib/stores/nav-counts.svelte.test.ts`
- Modify: `apps/desktop/src/lib/components/shell/NavRow.svelte` (import `countFor`)

**Interfaces:**
- Produces:
  ```ts
  // resource-kinds.ts
  export function searchKeywords(view: View, label: string): string[]; // label, plural/kind words and short names, lower-case, no duplicates
  // nav-counts.svelte.ts
  export interface Attention { value: number; label: string; tone: "err" | "warn"; open: () => void }
  export interface Count { value: number; attention: Attention | null }
  export function countFor(view: View): Count | null;
  ```
  `resource-kinds.ts` must keep importing no store: take `View` as a type import only.

Keywords for the hand-written views (kubectl short names plus singular/plural): overview → ["overview", "dashboard"]; nodes → ["no", "node", "nodes"]; pods → ["po", "pod", "pods"]; deployments → ["deploy", "deployment", "deployments"]; statefulsets → ["sts", "statefulset", "statefulsets"]; jobs → ["job", "jobs"]; cronjobs → ["cj", "cronjob", "cronjobs"]; helm → ["helm", "release", "releases", "chart"]; services → ["svc", "service", "services"]; ingresses → ["ing", "ingress", "ingresses"]; configmaps → ["cm", "configmap", "configmaps"]; secrets → ["secret", "secrets"]; pvcs → ["pvc", "persistentvolumeclaim", "persistentvolumeclaims"]; events → ["ev", "event", "events"]; logs → ["log", "logs", "tail"]. ★ kinds: `kind` and `plural` lower-cased, `shortNames`, plus the aliases rb (rolebindings), cr (clusterroles), crb (clusterrolebindings), quota already there.

- [ ] **Step 1: Write the failing tests**: `every navigation view has keywords that include its label`, `finds the short names of spec §6` (deploy→deployments, svc→services, pvc→pvcs, hpa→hpas, netpol→networkpolicies, sa→serviceaccounts, crb→clusterrolebindings), `countFor matches the sidebar rules` (pods total + attention, a ★ kind's count only once loaded for the namespace, null for logs).
- [ ] **Step 2: Run** `pnpm --filter desktop exec vitest run src/lib/resource-kinds.test.ts src/lib/stores/nav-counts.svelte.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; NavRow keeps its behaviour (existing shell tests stay green).
- [ ] **Step 4: Run** the full gates — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): search keywords for every type; sidebar counts shared`.

---

### Task 2: The palette's resource group

**Files:**
- Modify: `apps/desktop/src/lib/components/CommandPalette.svelte`, `CommandPalette.test.ts`
- Modify: `apps/desktop/src/lib/stores/profiles.svelte.ts` (`pin(view): void` — pins, toasts a refusal, never unpins)
- Create: `apps/desktop/tests/e2e/palette.spec.ts`; Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `searchKeywords`, `countFor` (Task 1); `navigation.arranged`, `navigation.isHidden`, `profiles.isPinned`, `profiles.pin`, `profiles.active.name`.

Each resource row: section dot, label, section label (caption), count (`nav-count` style) when `countFor` is not null, then "Hidden in Preferences" or "Pinned" (caption). Item `value` = `resource:<view>` is not used: bits-ui filters on `value`, so `value` = the label and `keywords` = `searchKeywords(view, label)`; the root's `bind:value` maps the highlighted label back to its view through a `Map<string, View>` built from the group. ⌘↵: an `onkeydowncapture` on `Command.Root` — when Enter with the platform modifier and the highlighted value is a resource, `preventDefault` + `stopPropagation`, `profiles.pin(view)`, `app.navigate(view)`, close; otherwise let bits-ui handle it as ↵.

- [ ] **Step 1: Write the failing tests** (CommandPalette.test.ts, new `describe("Go to resource (resource-kinds §6)")`):
  - `lists every type with its section, after Actions` — group heading "Go to resource" after "Actions"; rows for Overview…Logs incl. "Cluster Role Bindings"; "Network Policies" row shows "Network".
  - `finds a type by short name` — type `netpol` → "Network Policies" visible, "Pods" not.
  - `a short name ranks its own type first` — type `ing` → first resource row "Ingresses".
  - `shows the count once loaded and tags pinned and hidden types` — pods 2 → "2"; "Pods" row "Pinned"; hide Services → its row "Hidden in Preferences".
  - `↵ opens the type` — click "Persistent Volumes" → `app.view === "pvs"`, palette closed.
  - `⌘↵ opens and pins to the active profile` — highlight "Secrets" (type `secrets`), keydown Enter with meta → view secrets, `profiles.isPinned("secrets")`.
  - `⌘↵ on a full profile still opens the type` — 9 pins → toast "A profile holds up to 9 pins", view opened.
  - `⌘↵ on a non-resource row just selects it` — type `staging` → meta+Enter → cluster switch requested, no pin change.
  - `a context named like a type keeps both rows` — context "Nodes" → two rows named Nodes, one per group.
  - `hidden types stay reachable` — hide Network Policies, type `netpol` → row present, ↵ opens it.
  - Update `navigates and closes when selecting an action` to use "Tail logs" (the Go to actions are gone).
- [ ] **Step 2: Run** `pnpm --filter desktop exec vitest run src/lib/components/CommandPalette.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the group, the footer hint, `profiles.pin`, the removal of the Go to actions, placeholder "Search clusters, resources, actions…".
- [ ] **Step 4: e2e** `palette.spec.ts`: ⌘K (Control+K off mac) → type `hpa` → ↵ opens Autoscalers; ⌘K → `sa` → ⌘↵ → Pinned · On-call contains Service Accounts. Run the full gates including e2e — Expected: PASS.
- [ ] **Step 5: CHANGELOG** (`- **Go to any resource from ⌘K** (#583): …`) and **Commit** `feat(desktop): go to any resource type from the palette, ⌘↵ to pin it`.
