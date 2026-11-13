# Resource limits, delivery 3: the editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can change the requests and limits of a Deployment from its panel, see the check while typing, review and apply (or restore) the change, and see the override wherever the workload shows.

**Architecture:** The core does all the reasoning (delivery 2); the desktop only shows it. A pure module (`resource-editor.ts`) turns facts, drafts and an evaluation into what the screen needs (proposal, quick steps, sentences, node rows). A store (`resourceEditor.svelte.ts`) holds one open editor: facts, drafts, the last evaluation (debounced), the step, the dry run and the apply. The modal and the banner are thin components over the store. The e2e mock answers the four commands from fixtures.

**Tech Stack:** Svelte 5 runes, TypeScript, Tailwind v4 with the Tonal tokens, Vitest with Testing Library, Playwright against `vite preview` with the Tauri mock; one small Rust addition in `crates/cubelite-core`.

**Spec:** `docs/superpowers/specs/2026-11-13-resource-limits-design.md` (§3, §5, §6.2, §6.3, §7.2, §8, §9). Issue #657, parent #650.

## Global Constraints

- The check is the core's: the desktop never decides whether a value is allowed, never parses a quantity to judge it, never computes a finding. It sends what was typed and shows what comes back.
- The app never changes a field the user did not touch: a container goes in the proposal with its four values, untouched ones as the cluster wrote them.
- Level to look, everywhere: `blocked` is `err` (square), `warning` and `not_checked` are attention (triangle for a warning, dashed ring and the words "Not checked" for the other), a note is a quiet circle. Never colour alone: a glyph and a word or a weight.
- Tonal tokens, type roles and `ui/` components only (`design/README.md`): `Modal`, `Button` (`text`, `tonal`, `primary`; never `danger-solid`), `FIELD_BASE`, `MeterBar`, `StatusGlyph`, `StatusBadge`, `PANEL_CARD`, `PANEL_SECTION`. No new colour role, no raw hex, no `text-[Npx]`. An empty value is `EMPTY`. No em dash in anything a user reads.
- Copy is the spec's, verbatim where the spec gives a sentence.
- Primary button of step 2: "Apply" with no warning or not-checked finding, "Apply anyway" with at least one; for a restore "Restore" / "Restore anyway". No checkbox, no typed name.
- One apply per deployment at a time; the button shows it (`pending`); a toast on the outcome.
- More contrast, forced colours and reduced motion are honoured (`tests/e2e/a11y-tonal.spec.ts` gains the new parts). The modal works at 800 × 600: the body scrolls, the footer stays.
- Never touch `~/.kube`, never run `kubectl`, never start the real app.

## Calls made in this plan

1. Quick steps are `Button` (`tonal`, `inline`), not `Chip`: `Chip` is a toggle (`aria-pressed`), a quick step is an action.
2. A quick step acts on the field of that container that had focus last (clicking the step takes the focus away), or on the memory limit when none had. It is disabled when the cluster has no value for that field.
3. Rounding of a quick step: up to the next 10m for CPU; for memory up to the next 16Mi when the result is under 1Gi, to the next 128Mi from 1Gi. Written as `{n}m` and `{n}Mi` (`{n}Gi` when it is a whole number of Gi).
4. "At a time" in the rollout sentence is `max(1, max_surge + max_unavailable)`.
5. The pod to deployment link: `PodInfo` gains `deployment`, the name of the Deployment whose ReplicaSet controls the pod (the rule `facts.rs` already uses for own pods).
6. The "Override" badge sits after the name through a new optional `nameSuffix` snippet of `ui/ResourceList.svelte`.
7. The node rows show one measure for all nodes, chosen by the worst finding: W3 "memory, if the pods use their limit"; W2 "memory limits"; the CPU note "CPU limits"; W0, W1, W1r "memory requests" (or "CPU requests" when the finding is about CPU); otherwise "memory limits".

## Review Focus

1. The user types faster than the check answers: an older answer must never replace a newer one, and Review must not open on findings that belong to an earlier text (Task 3).
2. The facts cannot be read (403 on pods, the deployment gone): the modal says why, offers "Try again", and no field is editable (Tasks 3 and 5).
3. The deployment changes or disappears while the editor is open: a refused dry run says so inline and offers nothing to apply; a deployment that leaves the list closes the editor with a toast (Tasks 3 and 6).
4. A second click on Apply, or Esc, while the apply runs: one request only; the modal does not close under a running apply (Task 3).
5. Long names and many containers or nodes: a 60-character container name, 8 containers, 50 nodes; nothing overflows the modal at 800 × 600 and the footer stays reachable (Task 8).

## File map

| File | Responsibility |
|---|---|
| `crates/cubelite-core/src/resources.rs`, `watcher.rs` | `PodInfo.deployment` |
| `apps/desktop/src/lib/resource-editor.ts` (+ `.test.ts`) | Pure: drafts to proposal, quick steps, sentences, node rows, finding looks |
| `apps/desktop/src/lib/stores/resourceEditor.svelte.ts` (+ `.test.ts`) | The open editor: facts, drafts, evaluation, steps, dry run, apply, keep |
| `apps/desktop/src/lib/components/deployments/ResourceEditor.svelte` | The modal: header line, the two steps, footer |
| `…/deployments/ResourceEditorFields.svelte` | One container's four fields, quick steps, reset |
| `…/deployments/ResourceFindings.svelte` | The findings list |
| `…/deployments/ResourceNodes.svelte` | Node rows before and after, the disclosure |
| `…/deployments/OverrideBanner.svelte` | The banner with Restore and Keep these values |
| `…/deployments/DeploymentDrawer.svelte`, `DeploymentTable.svelte`, `pods/PodDrawer.svelte`, `ui/ResourceList.svelte`, `views/DeploymentsView.svelte` | Adjust, banner, badge, "Adjust on deployment", the editor's mount |
| `apps/desktop/tests/e2e/tauri-mock.ts`, `resource-editor.spec.ts`, `a11y-tonal.spec.ts` | Mock answers and the e2e walk |

---

### Task 1: The pod's deployment

**Files:** `crates/cubelite-core/src/resources.rs`, `crates/cubelite-core/src/watcher.rs`, `apps/desktop/src/lib/tauri.ts`

**Interfaces (produces):** `PodInfo` gains `#[serde(default)] pub deployment: Option<String>`; TypeScript `deployment?: string | null`.

Rule: the pod's controller owner reference is a ReplicaSet and the pod has a `pod-template-hash` label and the ReplicaSet's name is `{deployment}-{hash}`: `deployment` is that prefix. Anything else is `None`. If `limits/facts.rs` has this rule as a private function, move it where both can use it; one rule, one place.

- [ ] **Step 1: Failing tests** in `watcher.rs`: `pod_info_names_the_deployment_its_replicaset_belongs_to` (`api-6d4cf56db6` with hash `6d4cf56db6` gives `Some("api")`), `a_pod_of_a_statefulset_a_job_or_no_owner_has_no_deployment`, `a_replicaset_name_that_does_not_end_with_the_hash_gives_none`.
- [ ] **Step 2:** `cargo test -p cubelite-core watcher::` fails.
- [ ] **Step 3:** Implement; add the TypeScript field.
- [ ] **Step 4:** `scripts/gates.sh --rust --no-e2e` exits 0.
- [ ] **Step 5:** Commit `feat(core): name the deployment a pod belongs to`

---

### Task 2: The pure half

**Files:** Create `apps/desktop/src/lib/resource-editor.ts`, `resource-editor.test.ts`

**Interfaces (produces):**

```ts
export type FieldKey = `${"cpu" | "memory"}.${"request" | "limit"}`;
/** What is typed, per container: "" is a field left empty. */
export type Drafts = Record<string, Record<FieldKey, string>>;
export interface EditableContainer { name: string; sidecar: boolean; resources: ContainerResourcesInfo }

/** The template's regular containers, then its native sidecars. */
export function editableContainers(facts: ResourceFacts): EditableContainer[];
/** Each field as the cluster wrote it ("" when not set). */
export function initialDrafts(facts: ResourceFacts): Drafts;
/** An adjust proposal listing only the containers whose draft differs from the cluster's text. */
export function buildProposal(facts: ResourceFacts, drafts: Drafts): ResourceProposal;
export const RESTORE_PROPOSAL: ResourceProposal;        // { kind: "restore", containers: [] }
/** The text a quick step writes, or null when the cluster has no readable value for the field. */
export function quickStep(resource: ResourceName, clusterAmount: number | null, factor: 1.25 | 1.5 | 2): string | null;
/** Placeholder of an empty request field: "= limit" when the draft has a limit, else the LimitRange default, else "". */
export function requestHint(facts: ResourceFacts, drafts: Drafts, container: string, resource: ResourceName): string;
export function changeLabel(change: ResourceChange): string;       // "Memory limit", "CPU request"
export function rolloutSentence(workload: WorkloadFacts): string;
export function managerSentence(manager: ManagerInfo): string;    // the six sentences of spec §5
export function managerLabel(manager: ManagerInfo): string | null; // "managed by Argo CD" … null for none
export type FindingLook = { glyph: GlyphState; lead: string | null; strong: boolean };
export function findingLook(finding: Finding): FindingLook;
export function needsConfirmation(evaluation: ResourceEvaluation): boolean;   // any warning or not_checked
export function isBlocked(evaluation: ResourceEvaluation): boolean;
export function fieldFinding(evaluation: ResourceEvaluation | null, container: string, key: FieldKey): Finding | null; // blocked, on that field
export interface NodeRows { caption: string; hosting: NodeRow[]; others: NodeRow[] }
export interface NodeRow { name: string; ownPods: number; schedulable: boolean; before: number; after: number | null }
export function nodeRows(evaluation: ResourceEvaluation): NodeRows | null;   // null when the projection is empty
/** The fields an override changed: original and applied differ as texts. */
export function overrideChanges(override: OverrideInfo): { container: string; label: string; before: string | null; after: string | null }[];
```

Rules:

- `quickStep`: calls 2 and 3 above. `quickStep("memory", 512Mi, 1.25)` is `"640Mi"`; `("cpu", 250, 1.25)` is `"320m"`; `("memory", 1Gi, 2)` is `"2Gi"`; `("memory", 900Mi, 1.25)` is `"1152Mi"` (1125Mi is above 1Gi: next 128Mi).
- `rolloutSentence`: `recreate`: "The deployment rolls out: all {replicas} pods stop first, then new ones start (Recreate)."; rolling: "The deployment rolls out: {replicas} pods are replaced (RollingUpdate, {n} at a time)." (call 4); `replicas` 0: "The deployment has no replicas: no pod is replaced now."; one replica reads "1 pod is replaced" / "the pod stops first".
- `managerLabel`: "managed by Argo CD", "managed by Flux", "managed by Flux (Helm release)", "managed by Helm release `{release}`", "possibly managed", null.
- `findingLook`: blocked `{ glyph: "err", lead: null, strong: true }`; warning `{ "warn", null, true }`; not_checked `{ "unknown", null, false }` (its message already starts with "Not checked:"); note_fits `{ "ok", null, false }`; other notes `{ "done", null, false }`.
- `nodeRows`: call 7 for the caption and the measure; `hosting` are the nodes with own pods, `others` the rest, both in the evaluation's order; `after` is null when it equals `before`. A measure a node does not have (`memory_if_full` null) falls back to that node's memory limits.

- [ ] **Step 1: Failing tests** (`resource-editor.test.ts`), one `describe` per function: the quick-step table above plus `null` for a null amount; `buildProposal` lists only changed containers with all four values and leaves untouched fields as the cluster's text; an emptied field is sent as `null`; `requestHint` for the three cases; the six manager sentences verbatim from spec §5; the rollout sentences; `findingLook` per level; `needsConfirmation` true for a lone `not_checked`; `fieldFinding` ignores warnings; `nodeRows` caption and measure per worst finding, hosting first, null for an empty projection; `overrideChanges` lists only fields that differ.
- [ ] **Step 2:** `pnpm --filter desktop test -- resource-editor` fails (module missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `scripts/gates.sh --no-e2e` exits 0.
- [ ] **Step 5:** Commit `feat(desktop): what the resources editor shows, worked out from the core's answers`

---

### Task 3: The store

**Files:** Create `apps/desktop/src/lib/stores/resourceEditor.svelte.ts`, `resourceEditor.svelte.test.ts`

**Interfaces:**
- Consumes: Task 2; `resourceFacts`, `evaluateResources`, `applyResources`, `clearResourcesOverride` from `#lib/tauri.ts`; `app`, `resources`, `toasts`, `errorMessage` as `mutations.svelte.ts` uses them.
- Produces:

```ts
export const EVALUATE_DEBOUNCE_MS = 300;
export type EditorMode = "adjust" | "restore";
export type EditorStep = "edit" | "review";
class ResourceEditorStore {
  target: { namespace: string; name: string } | null;      // null: closed
  mode: EditorMode; step: EditorStep;
  facts: ResourceFacts | null; factsError: string | null; loading: boolean;
  drafts: Drafts;
  evaluation: ResourceEvaluation | null;                    // of the current drafts, or of the dry run
  evaluating: boolean;                                      // drafts newer than `evaluation`
  dryRun: "idle" | "running" | "ok" | "failed"; dryRunError: string | null;
  applying: boolean; applyError: string | null;
  open(deployment: DeploymentInfo, mode?: EditorMode): Promise<void>;   // restore opens on review
  close(): void;                                            // ignored while applying
  retry(): Promise<void>;                                   // read the facts again
  setField(container: string, key: FieldKey, text: string): void;
  step(container: string, key: FieldKey, factor: 1.25 | 1.5 | 2): void;
  reset(container: string): void;
  readonly changed: boolean; readonly canReview: boolean;   // changed, evaluated, not blocked
  review(): Promise<void>;                                  // to step 2, runs the dry run
  back(): void;
  apply(): Promise<boolean>;
  keepValues(deployment: DeploymentInfo): Promise<boolean>; // clear_resources_override
  isApplying(namespace: string, name: string): boolean;
}
export const resourceEditor: ResourceEditorStore;
```

Behaviour:

- `open` reads the facts with the active kubeconfig and cluster; `setField` schedules one `evaluateResources(facts, buildProposal(...))` after `EVALUATE_DEBOUNCE_MS`; each call carries a sequence number and an answer older than the latest request is dropped. `canReview` is false while `evaluating`.
- `review` sets the step, then `applyResources(..., proposal, facts.seen, true)`: on success `dryRun = "ok"` and the returned evaluation replaces `evaluation`; on failure `dryRun = "failed"` and `dryRunError` is the message. `apply` is refused unless `dryRun === "ok"`.
- `apply`: `applyResources(..., false)`. Success: close, toast "Resources of {name} updated, rollout started" (restore: "Resources of {name} restored, rollout started"), `resources.load()`. Failure: `applyError`, the modal stays on step 2.
- `keepValues`: `clearResourcesOverride`, toast "Override mark removed from {name}", `resources.load()`; failure toast "Could not remove the mark: {message}".
- While `target` is set and the deployment is no longer in `resources.deployments` (after a load that succeeded), the editor closes with the toast "Deployment {name} is gone" unless an apply is running.

- [ ] **Step 1: Failing tests** with the Tauri wrappers mocked and fake timers: facts loaded on open; a facts failure sets `factsError` and `retry` reads again; three quick `setField` calls give one `evaluateResources` call after 300 ms; an answer that resolves after a newer request is ignored; `canReview` false when unchanged, while evaluating, and with a blocked finding; `review` sends `dryRun: true` with `facts.seen` and keeps the returned evaluation; a rejected dry run sets `dryRunError` and `apply` then sends nothing; `apply` sends `dryRun: false` once even when called twice; `close` during an apply does nothing; success closes, toasts and reloads; failure keeps step 2 with `applyError`; restore opens on review with `RESTORE_PROPOSAL`; `keepValues` success and failure; the deployment leaving the list closes the editor.
- [ ] **Step 2:** `pnpm --filter desktop test -- resourceEditor` fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `scripts/gates.sh --no-e2e` exits 0.
- [ ] **Step 5:** Commit `feat(desktop): the state of the resources editor`

---

### Task 4: The mock answers the four commands

**Files:** `apps/desktop/tests/e2e/tauri-mock.ts`

**Interfaces (produces):** new `FIXTURES` keys, each overridable through `tauriMockScript(overrides)`:

- `resourceFacts`: the facts of the fixture deployment `default/api` (its two containers `worker` and `envoy` with the texts the deployment fixture has, 2 replicas, rolling update 1 / 0, two nodes one of them hosting, usage known, no LimitRange / quota / HPA / VPA); `null` makes `resource_facts` fail with "pods is forbidden: User cannot list resource pods".
- `resourceFindings`: `Record<string, Finding[]>` keyed `"{container}/{resource}.{field}={text}"`; the default table has one blocked entry, one warning entry and one not-checked entry, with the spec's sentences.
- `dryRunError`: `string | null`; when set, `apply_resources` with `dryRun` fails with it.
- `applyError`: `string | null`, the same for the real apply.
- Test hooks on `window`: the arguments of the last `apply_resources` and `clear_resources_override` calls, as the mock already does for `apply_resource_yaml`.

`evaluate_resources`: `changes` = the fields of the proposal whose text differs from the facts' text; findings = those of every matching key, else one `note_fits`; `nodes` = the fixture's projection, with `after` moved when a memory limit changes. `apply_resources` (not a dry run, no error): the deployment fixture takes the new texts and gains `resources_override`; a restore puts the originals back and removes it; `clear_resources_override` removes it. So a later `list_deployments` shows the outcome.

- [ ] **Step 1:** Add the fixtures and handlers.
- [ ] **Step 2:** `scripts/gates.sh` (full) exits 0 with the e2e count unchanged.
- [ ] **Step 3:** Commit `test(desktop): the Tauri mock answers the resources commands`

---

### Task 5: The editor, step 1 (Edit)

**Files:** Create `ResourceEditor.svelte`, `ResourceEditorFields.svelte`, `ResourceFindings.svelte`, `ResourceNodes.svelte` under `apps/desktop/src/lib/components/deployments/`; test `resource-editor-modal.test.ts` beside them. Modify `views/DeploymentsView.svelte` (mounts `<ResourceEditor />` once, when `resourceEditor.target` is set).

Layout, spec §3.2 step 1, top to bottom inside `Modal` (`width={640}`, title "Adjust resources · {name}"):

- Header line (`type-body-sm text-text-muted`): namespace · cluster · "{n} replicas" · `managerLabel` (left out when null).
- While loading: "Reading the cluster…". On `factsError`: the message and a `Button` "Try again"; no fields.
- Per editable container, a `PANEL_CARD` block: the name (with "sidecar" as the panel does), "(unchanged)" in `text-text-muted` when no field of it changed; a grid with column heads "Request", "Limit", "Now (highest pod)" and rows CPU, Memory. Each field is an `<input>` with `FIELD_BASE`, `aria-label` "{container} CPU request", placeholder `requestHint`, `aria-invalid` and `aria-describedby` when `fieldFinding` gives a blocked finding (its message under the row, `err` glyph). A changed field carries `font-semibold`, the `warn` glyph and "was {cluster text or EMPTY}" beside it. "Now" is the highest usage of that container over `facts.pods`, through `formatCpu` / `formatBytes`, `EMPTY` without a sample.
- Under the grid: `+25%`, `+50%`, `×2` (`Button` `tonal` `inline`, `aria-label` "Raise {field label} of {container} by 25%") and "reset" (`Button` `text` `inline`), per call 2.
- `ResourceNodes`: heading "Nodes these pods run on" with the caption at the end of the line; one row per hosting node: name, "{n} pods here", `MeterBar` before, an arrow, `MeterBar` after (only when `after` is not null), both with their percent; the others under a `<button aria-expanded>` "{n} other nodes"; under the list "Estimate from capacity. Node selectors, taints and affinity are not considered." Nothing at all when `nodeRows` is null.
- `ResourceFindings`: a list (`role="list"`), one row per finding in the evaluation's order: `StatusGlyph` by `findingLook`, the message (`font-semibold` when `strong`). `aria-live="polite"` on the list. While `evaluating`, the list keeps the last findings at reduced emphasis (`text-text-muted`), not a spinner that moves the layout.
- Footer: `Button` `text` "Cancel", `Button` `primary` "Review" (`disabled` unless `canReview`).

- [ ] **Step 1: Failing component tests** (Testing Library, store calls mocked as in Task 3): the header line with and without a manager; the fields carry the cluster's values; typing calls `setField`; a blocked finding marks its field invalid, shows its message under the field and in the list, and Review is disabled; a changed field shows "was 512Mi"; the quick step writes into the last focused field and into the memory limit when none had focus, and is disabled for an unset field; reset; the node rows, the disclosure and the estimate sentence; the facts error with "Try again" and no fields; "Usage" `EMPTY` without a sample.
- [ ] **Step 2:** the tests fail (components missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `scripts/gates.sh --no-e2e` exits 0.
- [ ] **Step 5:** Commit `feat(desktop): edit a deployment's requests and limits with the check in view`

---

### Task 6: The editor, step 2 (Review) and the apply

**Files:** Modify `ResourceEditor.svelte` (step 2), `resource-editor-modal.test.ts`

Layout, spec §3.2 step 2 (title "Review · {name}"; for a restore "Restore · {name}"):

- The changes: one row per `evaluation.changes` entry: container, `changeLabel`, "{before or EMPTY} → {after or EMPTY}"; then "(nothing else changes)".
- "What happens" (`PANEL_SECTION`), a list: `rolloutSentence`; `managerSentence`; adjust: "CubeLite marks the deployment as overridden, so the change stays visible and can be restored."; restore: "The override mark is removed."
- "Warnings ({n})" with `ResourceFindings` over the warnings and not-checked findings, each in full; left out when there are none. Notes below, without a count.
- Dry run: while it runs "Checking with the cluster…" (`role="status"`); failed: the error inline (`err` glyph, `role="alert"`) and the primary button disabled; an apply failure shows the same way.
- Footer: `Button` `text` "Back" (adjust only; a restore has "Cancel"), primary `Apply` / `Apply anyway` / `Restore` / `Restore anyway`, `pending` while applying, `disabled` unless the dry run is ok.
- Focus: entering a step moves focus to that step's heading (`tabindex="-1"`); closing returns focus to the element that opened the editor.

- [ ] **Step 1: Failing component tests**: the table lists only the changes; the three "What happens" sentences for a rolling update managed by Argo CD; "Apply" without warnings and "Apply anyway" with a warning and with a lone not-checked; the dry-run error inline with the primary disabled; the apply error inline, still on step 2; Back returns to the fields with their text; a restore shows "Restore", no Back, and "The override mark is removed."; focus is on the step heading after Review and after Back.
- [ ] **Step 2:** the tests fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `scripts/gates.sh --no-e2e` exits 0.
- [ ] **Step 5:** Commit `feat(desktop): review and apply a change of requests and limits`

---

### Task 7: Where it shows: Adjust, the banner, the badge, the pod panel

**Files:** Create `OverrideBanner.svelte`; modify `DeploymentDrawer.svelte`, `DeploymentTable.svelte`, `ui/ResourceList.svelte` (`nameSuffix?: Snippet<[T]>`, rendered after the name inside the sticky name cell, never shrinking the name to nothing), `pods/PodDrawer.svelte`; tests in `panels.test.ts`, `views.test.ts` (or the files those components' tests live in).

- Deployment panel, Resources section: the section title row gains `Button` `tonal` `inline` "Adjust" at its end (`resourceEditor.open(deployment)`); `pending` while an apply of this deployment runs.
- `OverrideBanner` above the Resources section when `deployment.resources_override` is set: a `PANEL_CARD` with the `warn` glyph, "Resources overridden from CubeLite · {date}" (day, short month, hour and minute in the user's locale, from `at`), one line per `overrideChanges` entry ("{container}  {label}  {before} → {after}"), and two buttons: `text` "Keep these values" and `tonal` "Restore". "Keep these values" asks once in place: the buttons are replaced by "Remove the override mark? The values stay as they are." with `text` "Cancel" and `tonal` "Remove mark" (`keepValues`). "Restore" calls `resourceEditor.open(deployment, "restore")`.
- Deployments list: `nameSuffix` renders `StatusBadge state="warn" label="Override"` for a row with `resources_override`.
- Pod panel, under the containers: when `pod.deployment` is set and that deployment is in `resources.deployments` (same namespace): `Button` `text` "Adjust on deployment {name}": closes the pod panel, `app.navigate('deployments')`, selects that deployment and opens its editor. No button otherwise.

- [ ] **Step 1: Failing tests**: Adjust opens the editor for that deployment; the banner shows the date and the changed fields and is absent without an override; "Keep these values" asks first, Cancel restores the two buttons, "Remove mark" calls `keepValues`; Restore opens the editor in restore mode; the list row has the badge only with an override; the pod panel's button appears only for a pod of a known deployment and opens that deployment's editor.
- [ ] **Step 2:** the tests fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `scripts/gates.sh --no-e2e` exits 0.
- [ ] **Step 5:** Commit `feat(desktop): the override banner, the list badge and the way into the resources editor`

---

### Task 8: End to end, accessibility, changelog

**Files:** Create `apps/desktop/tests/e2e/resource-editor.spec.ts`; modify `tests/e2e/a11y-tonal.spec.ts`, `CHANGELOG.md`

- [ ] **Step 1: E2E** (each a test; the first is the happy path of spec §9):
  - open the deployment panel, Adjust, raise the worker's memory limit with `+50%`, Review, Apply: the toast, the banner in the panel, the "Override" badge in the list, and the mock's last `apply_resources` call has `dryRun: false` and the proposal;
  - a blocking value: the field invalid, the finding in the list, Review disabled;
  - a warning: "Apply anyway"; a not-checked finding alone: "Apply anyway";
  - `dryRunError` "You are not allowed to change this deployment.": inline, primary disabled, no real apply sent;
  - Restore from the banner: step 2 with "Restore", then the banner is gone; "Keep these values": the mark goes, the values stay;
  - the facts refused: the message and "Try again";
  - keyboard only: Tab to Adjust, Enter, through every field and quick step, the node disclosure with Enter, Review, focus on the step heading, Back, Esc closes and focus is on Adjust;
  - the viewport at 800 × 600 with 8 containers (one with a 60-character name) and 50 nodes: no horizontal overflow of the modal, the footer buttons are in the viewport and clickable;
  - the pod panel's "Adjust on deployment api" opens the editor.
- [ ] **Step 2: Accessibility** in `a11y-tonal.spec.ts`: the editor (both steps) and the banner in more contrast (cards keep their edge), forced colours (the changed mark, the invalid field, the finding glyphs and both node bars are visible; buttons have an edge) and reduced motion (nothing moves between loading and loaded).
- [ ] **Step 3: Look at it.** Screenshots of step 1 (with a warning and a blocked finding), step 2, the banner, the confirm of "Keep these values", the list badge and the pod panel button, in the light and the dark theme and in compact density, into the scratch directory the brief names. Fix what looks wrong before committing.
- [ ] **Step 4:** `CHANGELOG.md`, under Unreleased / Added: "Adjust a deployment's CPU and memory requests and limits from its panel, with a capacity check before anything is applied, a server-side dry run, and an override mark that can be restored (#650)."
- [ ] **Step 5:** `scripts/gates.sh --rust` (full) exits 0.
- [ ] **Step 6:** Commit `test(desktop): the resources editor end to end, with its accessibility settings`
