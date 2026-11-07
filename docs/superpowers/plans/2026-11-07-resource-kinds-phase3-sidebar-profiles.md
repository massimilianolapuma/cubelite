# Resource kinds — phase 3: sidebar C, profiles and pins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace today's ~35-row sidebar with variant C (profile menu, Go to resource, Pinned list, All resources as an exclusive accordion) and ship profiles: four built-ins plus user profiles, pins edited from list headers and Preferences.

**Architecture:** A pure model (`profiles.ts`) owns profiles, pins and every rule (caps, names, built-ins, repair of stored data). A persisted store (`profiles.svelte.ts`) wraps it, next to the existing `navigation` store (#496 order/hidden, unchanged). The sidebar becomes three components (`ProfileMenu`, `NavRow`, `AllResources`) driven by `navigation.sections` and `profiles.active`. Preferences gains a Profiles block inside Navigation.

**Tech Stack:** Svelte 5 runes, bits-ui 2 (`DropdownMenu`, `ContextMenu`), Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-sidebar-resources-profiles-design.md` (§3, §7, §8, §9 phase 3). Mockup: canvas https://claude.ai/artifact/MMYQd8WeLe28GLhmf8hJuH, variant C (`Pinned`).

## Global Constraints

- Sidebar width 216 px (today 198 px).
- Built-in profiles, ids and pins in order (spec §7): `oncall` "On-call" (overview, nodes, pods, deployments, jobs, events, logs); `developer` "Developer" (pods, deployments, services, ingresses, configmaps, secrets, logs); `security` "Security" (serviceaccounts, roles, rolebindings, clusterroles, secrets, networkpolicies); `all` "All" (overview, pods, deployments, services, events). Default active profile, for new and existing installs: `oncall`.
- A profile is a name and an ordered pin list, at most **9** pins. The 10th pin is refused with the toast **"A profile holds up to 9 pins"** (tone `err`).
- Profile names: trimmed, 1–24 characters, unique case-insensitively. At most **12** profiles in all. Built-ins cannot be renamed or deleted; they offer "Reset to default pins". Deleting the active profile switches to `oncall`.
- Profiles and the active profile are global (all clusters), persisted with the navigation preferences (`persisted("profiles", …)`).
- Switching profile changes only the pinned list. Hiding stays the #496 Preferences setting: hidden types disappear from All resources, cannot be pinned, and a pinned hidden type is not shown in Pinned (it stays in the profile).
- All resources: exclusive accordion (opening a section closes the open one), open section remembered for the session only, not persisted. Section order from #496 Preferences.
- Keyboard: Tab follows visual order; on section rows ↑/↓ move between section rows, Enter/Space toggle, → opens, ← closes (`aria-expanded`). Profile shortcuts: **⌥⌘1…⌥⌘9** (Ctrl+Alt+1…9 elsewhere) — ⌘1…⌘5 already switch clusters; see Ruling 1 below.
- A collapsed section shows a red dot when a type inside has the red attention badge (only Pods today).
- The sidebar never scrolls at 800 px window height with the default profile and the largest section (Workloads) open.
- Pin toggle in each list's title bar: `aria-pressed`, label "Pin to <profile>" / "Unpin from <profile>". Unpin also from the Pinned row's context menu ("Unpin").
- Preferences › Navigation › Profiles: create (name; start empty or as a copy of the active profile), rename and delete user profiles, reorder all profiles (order = menu order and shortcut order), reorder and remove the pins of a profile with the #496 up/down buttons, "Reset to default pins" on built-ins.
- Commits: Conventional Commits, no Claude attribution. Branch `feat/580-sidebar-profiles` from `main`. Gates before each commit: `pnpm --filter desktop lint`, `pnpm --filter desktop test`, `pnpm --filter desktop exec svelte-check --threshold error`; before the PR also `pnpm --filter desktop test:e2e`. Pipe gates with `set -o pipefail`.
- CHANGELOG under `## [Unreleased]`; after this phase a release is allowed again (spec §9), but not part of this plan.

**Ruling 1 (confirmed by the user):** spec §3 gives ⌘1…⌘9 to profiles, but ⌘1…⌘5 switch clusters today (`keyboard.ts`, multi-cluster is a core commitment). The plan keeps ⌘1…⌘5 for clusters and uses ⌥⌘1…⌥⌘9 for profiles, matched on `event.code` (`Digit1`…`Digit9`) because ⌥ changes `event.key` on macOS.

## Review Focus

1. **Stored profile data from an older or hand-edited build** (unknown views, duplicate pins, >9 pins, a missing built-in, an `active` id that no longer exists, names over 24 chars): the app loads with repaired profiles, never crashes or shows an empty menu (Task 1 test `normalize repairs every broken field`).
2. **A pinned type that the user later hides in Preferences, then unhides**: it vanishes from Pinned while hidden and comes back in place afterwards (Task 3 test `a hidden pinned type leaves Pinned and comes back`).
3. **Window 800 px tall, On-call active, Workloads open**: the sidebar has no scrollbar (Task 5 e2e `the sidebar does not scroll at 800 px`).
4. **Deleting the active user profile, or the profile behind ⌥⌘N**: active falls back to On-call and the shortcut maps to the new order (Task 1 test `deleting the active profile activates On-call`, Task 2 test `the profile shortcut follows the menu order`).
5. **Navigating to a type that is neither pinned nor in the open section** (palette, attention badge, Overview links): its section opens so the active row is visible (Task 3 test `the active view's section opens when you navigate to it`).

---

### Task 1: The profile model

**Files:**
- Create: `apps/desktop/src/lib/profiles.ts`, `apps/desktop/src/lib/profiles.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MAX_PINS = 9; export const MAX_PROFILES = 12; export const NAME_MAX = 24;
  export const PIN_LIMIT_MESSAGE = "A profile holds up to 9 pins";
  export type BuiltInId = "oncall" | "developer" | "security" | "all";
  export interface Profile { id: string; name: string; builtIn: boolean; pins: View[] }
  export interface ProfilesPrefs { profiles: Profile[]; active: string }
  export const DEFAULT_PROFILES: ProfilesPrefs;               // the four built-ins, active "oncall"
  export type Result = { ok: true; prefs: ProfilesPrefs } | { ok: false; error: string };
  export function normalizeProfiles(raw: unknown): ProfilesPrefs;
  export function activeProfile(prefs: ProfilesPrefs): Profile;
  export function setActive(prefs: ProfilesPrefs, id: string): ProfilesPrefs;      // unknown id → unchanged
  export function pin(prefs: ProfilesPrefs, view: View, hidden: readonly View[]): Result; // to the active profile
  export function unpin(prefs: ProfilesPrefs, view: View, profileId?: string): ProfilesPrefs;
  export function movePin(prefs: ProfilesPrefs, profileId: string, view: View, delta: -1 | 1): ProfilesPrefs;
  export function validateName(prefs: ProfilesPrefs, name: string, exceptId?: string): string | null;
  export function createProfile(prefs: ProfilesPrefs, name: string, from: "empty" | "active", id: string): Result; // becomes active
  export function renameProfile(prefs: ProfilesPrefs, id: string, name: string): Result;
  export function deleteProfile(prefs: ProfilesPrefs, id: string): ProfilesPrefs;
  export function moveProfile(prefs: ProfilesPrefs, id: string, delta: -1 | 1): ProfilesPrefs;
  export function resetPins(prefs: ProfilesPrefs, id: BuiltInId): ProfilesPrefs;
  ```
  Error copy: pin limit `PIN_LIMIT_MESSAGE`; hidden `"Hidden in Preferences: show it first to pin it"`; name length `"Use 1 to 24 characters"`; duplicate `"A profile with this name already exists"`; profile cap `"Up to 12 profiles"`; built-in rename `"Built-in profiles keep their name"`.

`normalizeProfiles`: keeps stored order; drops entries without a string id, unknown views (`isView`), duplicate pins, pins past 9, user profiles with invalid or duplicate names, profiles past 12; re-adds missing built-ins at the end with default pins; built-ins always get their own name and `builtIn: true`; `active` must name a kept profile, else `oncall`. `pin` on an already pinned view returns `ok` unchanged.

- [ ] **Step 1: Write the failing tests** — one `describe` per function, including:
```ts
it("ships the built-ins of spec §7 with On-call active", () => {
  expect(DEFAULT_PROFILES.active).toBe("oncall");
  expect(DEFAULT_PROFILES.profiles.map((p) => [p.id, p.name])).toEqual([["oncall", "On-call"], ["developer", "Developer"], ["security", "Security"], ["all", "All"]]);
  expect(activeProfile(DEFAULT_PROFILES).pins).toEqual(["overview", "nodes", "pods", "deployments", "jobs", "events", "logs"]);
});
it("normalize repairs every broken field", () => {
  const prefs = normalizeProfiles({ active: "gone", profiles: [
    { id: "oncall", name: "Hacked", builtIn: false, pins: ["pods", "pods", "nope", "events"] },
    { id: "u1", name: "x".repeat(30), builtIn: false, pins: [] },
    { id: "u2", name: " Mine ", builtIn: false, pins: ["pods","deployments","services","ingresses","configmaps","secrets","events","logs","nodes","jobs"] },
  ]});
  expect(prefs.active).toBe("oncall");
  expect(prefs.profiles[0]).toEqual({ id: "oncall", name: "On-call", builtIn: true, pins: ["pods", "events"] });
  expect(prefs.profiles.find((p) => p.id === "u1")).toBeUndefined();
  expect(prefs.profiles.find((p) => p.id === "u2")).toMatchObject({ name: "Mine" });
  expect(prefs.profiles.find((p) => p.id === "u2")!.pins).toHaveLength(9);
  expect(prefs.profiles.map((p) => p.id)).toEqual(["oncall", "u2", "developer", "security", "all"]);
  expect(normalizeProfiles("junk")).toEqual(DEFAULT_PROFILES);
});
it("refuses the 10th pin and hidden types", () => { /* 9 pins → pin("secrets") → { ok: false, error: PIN_LIMIT_MESSAGE }; pin("services", ["services"]) → hidden error */ });
it("validates names", () => { /* "" and 25 chars → "Use 1 to 24 characters"; "on-CALL" → duplicate; renaming u1 to its own name → null */ });
it("creates empty or as a copy of the active profile, and caps at 12", () => { /* copy → pins equal active's, new profile active; 13th → "Up to 12 profiles" */ });
it("deleting the active profile activates On-call", () => { /* create u1 (active) → delete u1 → active "oncall"; deleteProfile(prefs, "security") → unchanged */ });
it("built-ins keep their name and reset their pins", () => { /* renameProfile("developer") → error; unpin pods from developer then resetPins → default pins */ });
it("moves pins and profiles", () => { /* movePin up/down, moveProfile, edges unchanged */ });
```
- [ ] **Step 2: Run** `pnpm --filter desktop exec vitest run src/lib/profiles.test.ts` — Expected: FAIL, module missing.
- [ ] **Step 3: Implement `profiles.ts`** (pure; imports only `View`/`isView` from `app.svelte.ts` types — use `import type` for `View` and import `isView` from `#lib/stores/app.svelte.ts`, which has no store side effects beyond `lists`).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): profile model with built-ins, pins and validation`.

---

### Task 2: Profiles store, pin toggle, shortcuts

**Files:**
- Create: `apps/desktop/src/lib/stores/profiles.svelte.ts`, `apps/desktop/src/lib/stores/profiles.svelte.test.ts`
- Create: `apps/desktop/src/lib/components/ui/PinToggle.svelte`
- Modify: `apps/desktop/src/lib/components/ui/ListTitle.svelte` (render `PinToggle` before the children); `OverviewView.svelte:80`, `EventsView.svelte:15`, `LogsView.svelte:158`, `NodesView.svelte:23` (render `PinToggle` next to their `<h1>`)
- Modify: `apps/desktop/src/lib/keyboard.ts` (+ `keyboard.test.ts`), `apps/desktop/src/routes/+page.svelte:96` (dispatch)
- Test: `apps/desktop/src/lib/components/ui/pin-toggle.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  class ProfilesStore {
    get prefs(): ProfilesPrefs; get active(): Profile; get list(): Profile[];
    isPinned(view: View): boolean;              // in the active profile
    togglePin(view: View): void;                // pin or unpin in the active profile; a refused pin pushes the toast with the Result error (tone "err")
    activate(id: string): void; activateIndex(index: number): void; // index into list
    create(name: string, from: "empty" | "active"): string | null;  // error or null; id = `user-${crypto.randomUUID()}`
    rename(id: string, name: string): string | null;
    remove(id: string): void; move(id: string, delta: -1 | 1): void;
    unpin(view: View, profileId?: string): void; movePin(profileId: string, view: View, delta: -1 | 1): void;
    resetPins(id: BuiltInId): void;
  }
  export const profiles: ProfilesStore;
  // keyboard.ts
  ShortcutAction |= { type: "switch-profile"; index: number };  // mod+alt+Digit1…9 via event.code
  KeyLike gains `code?: string`
  ```
  `PinToggle` (no props): reads `app.view`; renders nothing for `dashboard`; a 28 px icon button (lucide `Pin` / `PinOff`, 14 px, like the group toggle in `ListTitle`), `aria-pressed={profiles.isPinned(app.view)}`, `aria-label` "Pin to {profile}" / "Unpin from {profile}"; disabled with `title="Hidden in Preferences"` when `navigation.isHidden(app.view)`.

- [ ] **Step 1: Write the failing tests**
  - store: `persists to cubelite.profiles and repairs on load`, `togglePin pins and unpins in the active profile`, `the 10th pin pushes the toast` (spy `toasts.push` → called with `"A profile holds up to 9 pins", "err"`), `create returns the validation error`, `the profile shortcut follows the menu order` (move profile, `activateIndex(0)` activates the moved one).
  - keyboard: `matchShortcut({ key: "¡", code: "Digit1", metaKey: true, altKey: true, ctrlKey: false }, true)` → `{ type: "switch-profile", index: 0 }`; ⌘1 without ⌥ still → `switch-cluster`; `Digit0` → null.
  - pin toggle: `pressed when the view is pinned`, `click pins to the active profile`, `disabled for hidden types`, `absent on the dashboard`.
- [ ] **Step 2: Run** `pnpm --filter desktop exec vitest run src/lib/stores/profiles.svelte.test.ts src/lib/keyboard.test.ts src/lib/components/ui/pin-toggle.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** store, `PinToggle`, the header placements, the shortcut and its dispatch (`activateIndex`; out-of-range index → nothing).
- [ ] **Step 4: Run** the same command, then the full gates — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): profiles store, pin toggle in list headers, ⌥⌘1–9 profile shortcuts`.

---

### Task 3: Sidebar C

**Files:**
- Create: `apps/desktop/src/lib/components/shell/NavRow.svelte` (today's row: dot, label, neutral count, attention badge, greying, active background — moved out of `Sidebar.svelte` with `countFor`, unchanged behaviour), `ProfileMenu.svelte`, `AllResources.svelte`, `apps/desktop/src/lib/stores/sidebar.svelte.ts`
- Modify: `apps/desktop/src/lib/components/shell/Sidebar.svelte` (layout), `PreferencesModal.svelte` + `app.svelte.ts` (`PreferencesSection` gains `"navigation"`, bound on the Navigation block)
- Test: `apps/desktop/src/lib/components/shell/sidebar-c.test.ts`; update `shell.test.ts`, `components/resource-order.test.ts`

**Interfaces:**
- Consumes: `profiles` (Task 2), `navigation.sections`, `resources`, `dynamic`, `app`.
- Produces: `sidebar.openSection: SectionId | null` ($state, session); `sidebar.toggle(id)`, `sidebar.open(id)`, `sidebar.close()`; an `$effect` in `Sidebar.svelte` opens the section of `app.view` when that view is not shown in Pinned.

Layout top to bottom (spec §3, mockup C): `ProfileMenu` (bits-ui `DropdownMenu`; trigger "Profile: {name} ▾"; a radio item per profile with its shortcut hint ⌥⌘N for the first nine; separator; "Manage profiles…" → `app.openPreferences("navigation")`) · "Go to resource" button with `Kbd` ⌘K → `app.paletteOpen = true` · section label "Pinned · {name}" and one `NavRow` per visible pin, each wrapped in a bits-ui `ContextMenu` with "Unpin" · empty state when no pins: caption "Pin any resource from its list header." · divider · label "All resources" · `AllResources`: one header button per visible section (dot, label, number of visible types, chevron, `aria-expanded`, `aria-controls`), the open section's types as compact `NavRow`s (row padding 4 px instead of 6 px); collapsed section with `resources.issuePods.length > 0` and pods visible in it → red dot (`--color-status-err`) with sr-only text "pods need attention".

- [ ] **Step 1: Write the failing tests** (`sidebar-c.test.ts`)
```ts
it("shows the active profile's pins and the section rows", () => { /* default: Pinned · On-call with 7 rows; 7 section buttons, all aria-expanded=false except the one holding app.view if unpinned */ });
it("switching profile changes only the pinned list", async () => { /* open menu, pick Security → Pinned · Security rows = Service Accounts…Network Policies; section buttons unchanged */ });
it("opening a section closes the other", async () => { /* click Workloads then Network → Workloads aria-expanded=false, Network true, Network's 5 types shown */ });
it("arrow keys move between sections, → opens, ← closes, Enter toggles", async () => {});
it("a collapsed section shows the red dot for pods needing attention", () => {});
it("a hidden pinned type leaves Pinned and comes back", () => { /* navigation.setHidden("jobs", true) → no Jobs in Pinned; false → back between Deployments and Events */ });
it("the active view's section opens when you navigate to it", async () => { /* app.navigate("daemonsets") → Workloads expanded, DaemonSets row has the active background */ });
it("Unpin from the context menu removes the pin", async () => {});
it("Manage profiles… opens Preferences on Navigation", async () => {});
it("greys a pinned kind the cluster does not serve", async () => { /* discovery without serviceaccounts, Security active → its pinned row title "Not available on this cluster" */ });
```
Update `shell.test.ts` "renders every section and item" to the C layout (section buttons + On-call pins) and move its count/attention tests onto pinned rows; update `resource-order.test.ts` sidebar assertions to open the section first.
- [ ] **Step 2: Run** `pnpm --filter desktop exec vitest run src/lib/components/shell src/lib/components/resource-order.test.ts` — Expected: FAIL on the new file.
- [ ] **Step 3: Implement** `NavRow` (extract first, keep existing shell tests green), `sidebar.svelte.ts`, `ProfileMenu`, `AllResources`, the new `Sidebar` (216 px, no `overflow-y-auto` needed; keep it as a fallback for tiny windows), the `"navigation"` Preferences section.
- [ ] **Step 4: Run** the full gates — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): sidebar C — profile menu, pinned resources, one open section`.

---

### Task 4: Profiles in Preferences

**Files:**
- Create: `apps/desktop/src/lib/components/ProfilesPreferences.svelte`, `apps/desktop/src/lib/components/profiles-preferences.test.ts`
- Modify: `apps/desktop/src/lib/components/NavigationPreferences.svelte` (render `ProfilesPreferences` at the top of the Navigation block)

**Interfaces:**
- Consumes: `profiles` store (Task 2).

Content: heading "Profiles"; one row per profile in menu order — name (inline text input when renaming), "Built-in" caption for built-ins, Move up/down (`aria-label="Move {name} up"`), Rename and Delete for user profiles, "Reset to default pins" for built-ins; selecting a row (button `aria-pressed`) shows that profile's pins below with Move up/down and Remove (`aria-label="Unpin {label} from {name}"`), labels from `navigation.arranged`; "New profile" form: name input (`aria-label="Profile name"`), segmented choice "Start empty" / "Copy {active}", Create button; validation errors shown under the input (`role="alert"`) from the store's return value. Delete asks no confirmation (pins are cheap to rebuild; read-only-by-default concerns cluster actions) — Ruling 2, confirmed by the user.

- [ ] **Step 1: Write the failing tests**: `lists every profile in menu order`, `creates a copy of the active profile and activates it`, `shows the name error`, `renames and deletes a user profile but not a built-in`, `reorders profiles`, `reorders and removes pins`, `resets a built-in's pins`.
- [ ] **Step 2: Run** `pnpm --filter desktop exec vitest run src/lib/components/profiles-preferences.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full gates — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): manage profiles and their pins in Preferences`.

---

### Task 5: End to end, CHANGELOG

**Files:**
- Create: `apps/desktop/tests/e2e/profiles.spec.ts`
- Modify: `apps/desktop/tests/e2e/app.spec.ts`, `resource-kinds.spec.ts`, other specs that click sidebar rows no longer visible by default (open the section first)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the failing e2e tests**
```ts
test("the sidebar does not scroll at 800 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  await page.getByRole("button", { name: "Workloads", exact: true }).click();
  const aside = page.locator("aside").first();
  expect(await aside.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
});
test("switch profile from the menu and with ⌥⌘2, pin from a list header, survives reload", async ({ page }) => { /* menu → Developer; ⌥⌘3 → Security (page.keyboard.press("Meta+Alt+Digit3")); open Network → Network Policies already pinned; open Config → Resource Quotas → header "Pin to Security" → Pinned shows it; reload → still Security with Resource Quotas */ });
test("a 10th pin is refused with a toast", async ({ page }) => {});
test("create, rename and delete a profile in Preferences", async ({ page }) => {});
```
- [ ] **Step 2: Run** `pnpm --filter desktop test:e2e` — Expected: the new tests fail only where their feature is missing (if Tasks 1–4 are done they may pass at once; then confirm each fails by breaking its assertion once and restoring it).
- [ ] **Step 3: Fix the older specs** that relied on every row being visible, and add the CHANGELOG entry: `- **Sidebar with profiles and pinned resources** (#580): …` (profile menu with four built-ins and your own profiles, ⌥⌘1–9, Go to resource, pins from list headers, one section open at a time so the sidebar does not scroll).
- [ ] **Step 4: Run** every gate — Expected: PASS (one warm rerun allowed for the two known cold-start tests in `app.spec.ts`).
- [ ] **Step 5: Commit** `test(desktop): profiles and sidebar C end to end; changelog`.
