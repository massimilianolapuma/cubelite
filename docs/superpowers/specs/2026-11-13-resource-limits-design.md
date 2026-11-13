# Adjust a workload's requests and limits, with a capacity check — design (#650)

Status: for approval · 2026-11-13 · desktop and core · issue #650

## 1. Intent

A service that was just deployed does not hold: its pods are OOMKilled, or throttled on CPU. The
real fix comes from git, but that takes time, and until then the service needs more room. Today
the user leaves CubeLite for `kubectl set resources`, picks a number, and learns afterwards whether
the nodes could take it.

CubeLite lets the user raise (or lower) the CPU and memory requests and limits of a workload from
its detail panel, as a **temporary intervention on the live cluster**. The value is not arbitrary:
before anything is applied the app works out whether the nodes and the namespace can hold it, and
says so with numbers. What cannot work is refused. What is risky is shown, and the user decides.
Because the intervention is temporary, the app keeps it visible on the workload until the fix
arrives or the user restores the original values.

## 2. Goals, non-goals, anti-goals

- Goal: see each container's requests and limits next to what it uses now, in the Deployment and
  Pod panels.
- Goal: change them for a Deployment in a few seconds, with the capacity check visible while typing.
- Goal: refuse values that cannot work; for risky ones, show the numbers and let the user decide.
- Goal: say before the confirmation what will happen to a manual change (rollout, Helm, Argo CD,
  Flux, autoscalers).
- Goal: an override made from the app stays visible, and one action restores the original values.
- Non-goal, first version: StatefulSets, DaemonSets, Jobs, CronJobs. StatefulSets were in the first
  idea, but they have no detail panel today; they follow once they have one.
- Non-goal: resizing a running pod without a restart (the `resize` subresource, stable since
  Kubernetes 1.35). The change goes to the pod template and a rollout follows.
- Non-goal: suspending or changing Argo CD or Flux synchronisation from the app. The app warns.
- Non-goal: removing a request or a limit, and any other field of the pod template (env, image,
  probes); init containers; ephemeral storage, GPUs and other extended resources.
- Non-goal: simulating the scheduler (taints, node selectors, affinity, topology spread). The check
  is an estimate from capacity, and says so.
- Non-goal: recommending a value (no right-sizing advice).
- Anti-goal: a change applied with a check silently skipped. A check that could not run is shown
  as "not checked", with the reason, and counts as a warning.
- Anti-goal: an override that nobody remembers. It must be visible wherever the workload is.
- Anti-goal: the check and the write disagreeing. The same rules run when the user types and when
  the change is applied.

## 3. What the user sees

### 3.1 Resources section (read-only)

A new **Resources** section in the Deployment panel, after Replicas, and the same rows inside each
container card of the Pod panel.

```
Resources                                  [ Adjust ]
┌──────────────────────────────────────────────────┐
│ api                                              │
│ CPU     250m · 500m      ▓▓▓▓▓░░░░░  260m  52%   │
│ Memory  256Mi · 512Mi    ▓▓▓▓▓▓▓▓▓░  498Mi 97% ■ │
├──────────────────────────────────────────────────┤
│ envoy                                            │
│ CPU     100m · –         –  38m                  │
│ Memory  64Mi · 128Mi     ▓▓▓░░░░░░░  41Mi  32%   │
└──────────────────────────────────────────────────┘
```

- Per container, one row per resource: request, limit (`request · limit`, an en dash when not
  set), then usage now against the limit as a meter (`ui/MeterBar`) with the value and the percent.
- In the Deployment panel usage is the **highest** of the workload's pods (the pod closest to its
  limit is the one about to fail). In the Pod panel it is that pod's.
- The meter is `ui/MeterBar` as it is, with its thresholds (high from 60%, critical from 75%,
  each a glyph and a weight as well as a colour). No limit: no meter, usage as a number.
- No metrics-server: the usage part reads "Usage unavailable" once for the section, not per row.
- **Adjust** (tonal button, in the section header) opens the editor. In the Pod panel there is no
  editor: under the containers a text button "Adjust on deployment `api`" opens the Deployment
  panel's editor when the pod belongs to a Deployment (ReplicaSet owner, then the Deployment that
  owns it); pods with another owner or none get no button.

### 3.2 Editor (modal, two steps)

`ui/Modal`, about 640 px wide. Title "Adjust resources · api". Step 1 edits, step 2 confirms.

**Step 1, Edit**

```
Adjust resources · api                                   ✕
default · prod-aks · 3 replicas · managed by Argo CD

Container  api
            Request      Limit        Now (highest pod)
CPU         [ 250m  ]    [ 500m  ]    412m
Memory      [ 256Mi ]    [ 768Mi ]▲   498Mi      was 512Mi
            +25%  +50%  ×2            ↺ reset

Container  envoy                                    (unchanged)
  …

Nodes these pods run on                 memory, if the pods use their limit
aks-pool-1   3 pods here   ▓▓▓▓▓▓▓▓░░ 81% → ▓▓▓▓▓▓▓▓▓░ 93%
aks-pool-2   –             ▓▓▓▓▓░░░░░ 52%

▲ Memory limits on aks-pool-1 add up to 118% of what the node has (was 104%).
● Fits: 3 of 3 replicas have room by their requests.
– Not checked: namespace quota (not allowed to read ResourceQuota).

                                      [ Cancel ]  [ Review ]
```

- Header line: namespace, cluster, replica count, and who manages the workload (§5).
- One block per container (regular containers and native sidecars). Four fields per container.
  A field accepts a Kubernetes quantity (`500m`, `1`, `1.5`; `512Mi`, `1Gi`, `1G`). The app sends
  what was typed; the cluster stores quantities in its own canonical form (`1024Mi` comes back as
  `1Gi`), so every comparison of quantities in this feature is numeric, never textual.
- A request that is not set shows what Kubernetes will use instead, as a hint in the empty field:
  "= limit" when the container has a limit (an unset request defaults to the limit), or the
  LimitRange default when the namespace has one. The check always works on these **effective**
  values (§4).
- Quick steps act on the field that has focus, or on the memory limit when none has: `+25%`,
  `+50%`, `×2`, computed from the value on the cluster and rounded to a readable quantity (10m for
  CPU; 16Mi under 1Gi, 128Mi above). "reset" puts a container back to the cluster's values.
- A changed field shows the previous value beside it ("was 512Mi") and the changed mark (weight and
  a glyph, as the pending replica count does today).
- The app never changes a field the user did not touch. Raising a limit leaves a request that is
  set where it is; when the request is not set, its effective value follows the limit, and the
  hint and the findings say so. Lowering a limit under its request is an error on the field
  (§4.1); the app does not move the request for the user.
- **Nodes**: one row per node that hosts this workload's pods now, then the other schedulable
  nodes collapsed under "N other nodes" (open on demand). For each node a before → after bar for
  the measure the worst finding is about (memory if there is none). The bars carry numbers.
- **Findings** (§4): a list under the nodes, worst first, each with a glyph and a sentence with
  the numbers. It updates as the user types (debounced, about 300 ms; the last answer wins).
- **Review** is disabled while nothing changed or while there is a blocking finding; the blocking
  finding says why, next to the field it is about and in the list.

**Step 2, Review**

```
Review · api                                             ✕

api      Memory limit    512Mi → 768Mi
(nothing else changes)

What happens
• The deployment rolls out: 3 pods are replaced (RollingUpdate, 1 at a time).
• Argo CD manages this workload. If self-heal is on, it will undo this change at its next sync.
• CubeLite marks the deployment as overridden, so the change stays visible and can be restored.

Warnings (1)
▲ Memory limits on aks-pool-1 add up to 118% of what the node has (was 104%). Under memory
  pressure the node evicts pods.

                              [ Back ]  [ Apply anyway ]
```

- A table of what changes (container, field, before → after), and only that.
- "What happens": the rollout in the workload's own terms (strategy, how many pods; "all pods stop
  first" for `Recreate`), the manager sentence (§5), the override sentence (§6).
- Warnings again in full, "not checked" items included.
- Opening this step runs a **server-side dry run** of the exact patch. A rejection (admission
  webhook, validation, 403 "you are not allowed to change this deployment", 409) shows inline as an
  error and the primary button stays disabled.
- Primary button: **Apply** with no warnings, **Apply anyway** with at least one. No checkbox, no
  typing the name: reading this step is the confirmation.
- On success the modal closes, a toast says "Resources of api updated, rollout started", and the
  panel shows the override banner (§6). On failure the error stays inline in step 2.

### 3.3 Where else it shows

- Deployment panel: the override banner (§6.2) above the Resources section.
- Deployments list: a row with an active override carries a text badge "Override" after the name.
- Pod panel: container rows as in §3.1; no banner.

## 4. The check

One evaluation, the same when typing and when applying. It takes the facts read from the cluster
(§7.1) and the proposed values, and returns findings. Each finding has a level and a sentence.

The check works on **effective** values: a request that is not set takes the container's limit,
and a LimitRange default fills what is still unset. The per-pod figures are computed as Kubernetes
computes them (regular containers, init containers and native sidecars by the scheduler's formula,
plus the pod overhead of a RuntimeClass); the builder takes the formula from the Kubernetes
documentation, not from this sentence. A container with no effective limit makes the pod's limit
"none" for that resource.

### 4.1 Blocked (cannot be applied)

Only what the cluster itself would refuse, at once or when it creates the pods.

| # | Condition | Why |
|---|---|---|
| B1 | A value is not a valid quantity or is negative | The API rejects it |
| B2 | A limit of zero | The API accepts it and the container cannot run; here it can only be a mistake |
| B3 | A limit under its request | The API rejects it |
| B4 | A LimitRange of the namespace is violated (container min, max, max limit/request ratio; pod max) | The Deployment would accept the change and its pods would then fail to be created, silently |
| B5 | With all replicas on the new values, a ResourceQuota of the namespace is exceeded (`requests.cpu`, `requests.memory`, `limits.cpu`, `limits.memory`, and the bare `cpu` / `memory` forms) | Same silent failure |

A B4 or B5 condition that already held before the change, and that the change does not move
further past its bound, is not blocked: it is shown as a warning, with "It was already so before
this change." Blocking it would refuse a change that helps (a request lowered in a namespace whose
quota was already exceeded). A value that is missing where a rule needs one stays blocked.

In an edit, emptying a field that has a value on the cluster is blocked too: only Restore removes
a value. A quota with scopes is not evaluated; it is reported as not checked (§4.3).

### 4.2 Warnings (shown with numbers, the user decides)

| # | Condition | Sentence says |
|---|---|---|
| W0 | The pod's request, or a limit the change sets, is above the allocatable of every node the cluster has now (cordoned ones included) | For a request: "No node in this cluster can hold 24Gi (largest: 16Gi). The pods stay Pending unless a larger node is added." For a limit alone the pods are not Pending: "No node in this cluster has 24Gi (largest: 16Gi): the container can never use this limit." Always first in the list |
| W1 | By requests, fewer replicas fit than the deployment wants: per schedulable node, room = allocatable − requests of the pods there (this workload's own pods left out); replicas that fit = sum over nodes of how many pods fit in both CPU and memory | "Only 2 of 3 replicas have room by their requests; the rest stay Pending unless nodes are added." |
| W1r | The end state fits (W1 is clear) but the rollout does not: with the strategy's resolved surge and unavailable counts, a new pod has to start while the old ones still hold their room, and no schedulable node has that room | "The rollout may stall: no node has room for a new pod while the old ones still run." |
| W2 | On a node that hosts this workload's pods, memory limits after the change add up to more than its allocatable | the node, the percent before and after |
| W3 | On such a node, memory used now − what these pods use now + their new limits is above allocatable | "If these pods use their full limit, aks-pool-1 runs out of memory (81% → 104%)." |
| W4 | A new memory limit is under what a pod of the workload uses now | "The container would be OOMKilled as soon as it starts using what it uses now (498Mi)." |
| W5 | A new CPU limit is under current usage | throttling, with the numbers |
| W6 | During the rollout the quota would be exceeded while old and new pods coexist (surge), though the end state fits | "The rollout may stall until old pods are gone." |
| W7 | A HorizontalPodAutoscaler targets the deployment on CPU or memory utilisation, and a request of that resource changes | utilisation is a share of the request, so the replica count may move |
| W8 | A VerticalPodAutoscaler targets the deployment with an update mode other than `Off` | it will rewrite the values |
| W9 | Any "not checked" item (§4.3) | what was not checked and why |

Notes (shown, never ask for anything): CPU limits adding up to more than a node's CPU (CPU is
shared, it slows down, it does not kill); the pod's QoS class changing (for example Guaranteed to
Burstable); a successful W1 ("3 of 3 replicas have room").

W2, W3 and the CPU note are reported only when the change makes the figure worse: an overcommit
that was there before and does not grow is not held against this change. Sums of limits on a node
count the limits that are set (as `kubectl describe node` does); a container with no memory limit
adds a "not checked" line that names it. A value typed for memory with the suffix `m` (`512m` is
0.512 bytes) gets a warning of its own that suggests `512Mi`.

W2 and W3 assume the new pods come back to the nodes the old ones are on, in the same numbers. It
is the likeliest placement and the only one that can be worked out without simulating the
scheduler. The editor says under the node list: "Estimate from capacity. Node selectors, taints and
affinity are not considered."

A schedulable node is one that is Ready and not cordoned.

W0 and W1 are warnings and not blocks because the app cannot see what a cluster autoscaler could
add (a larger node pool scaled to zero, for instance). Confirmed by the user (§11).

### 4.3 Not checked

Each check names the facts it needs. When a fact is missing the check does not run and reports
itself as not checked, with the reason in the user's terms:

- nodes or pods of other namespaces cannot be listed (403) → W0, W1, W1r, W2, W3
- metrics-server is not installed or does not answer → W3, W4, W5, and usage in §3.1
- LimitRange, ResourceQuota, HPA cannot be read (403) → B4, B5/W6, W7
- the VPA API is not installed → nothing to report (no VPA can exist)
- a ResourceQuota has scopes → that quota is not evaluated
- the hosting node has no usage sample → W3 for that node

Node allocatable must not depend on metrics-server (today `cluster_capacity` fails as a whole
without it).

## 5. Who manages the workload

Read from the deployment's labels and annotations, in this order; first match wins.

| Manager | Recognised by | Sentence in "What happens" |
|---|---|---|
| Argo CD | annotation `argocd.argoproj.io/tracking-id`, or label `argocd.argoproj.io/instance` | "Argo CD manages this workload. If self-heal is on, it will undo this change at its next sync." |
| Flux, Kustomization | label `kustomize.toolkit.fluxcd.io/name` | "Flux manages this workload. It will undo this change at its next reconciliation." |
| Flux, HelmRelease | label `helm.toolkit.fluxcd.io/name` | "Flux manages this workload through a Helm release. The change stays until the next upgrade of the release, or sooner if drift detection is on." |
| Helm | annotation `meta.helm.sh/release-name` | "Helm release `orders` manages this workload. The change stays until an upgrade of the release sets these values." |
| Possibly managed | label `app.kubernetes.io/instance` or `app.kubernetes.io/managed-by` and none of the above | "This workload carries labels that GitOps tools use, but no tool was recognised. If one applies it (Argo CD with label tracking, for example), the change will be undone." |
| none found | | "Nothing that manages this workload was recognised. The change stays until something applies it again." |

The Helm label alone is not proof of a Helm release: a chart rendered by Argo CD carries
`app.kubernetes.io/managed-by: Helm` and no release annotation, and Argo CD's label tracking leaves
only `app.kubernetes.io/instance`. Those cases fall in "possibly managed", which errs towards
warning. The builder verifies the label and annotation keys against the current Argo CD and Flux
documentation before relying on them. The app does not read Application, Kustomization or
HelmRelease objects in this version, so it cannot say whether self-heal or drift detection is on.

## 6. The override mark

### 6.1 What is written

The change and the mark go in **one patch** to the Deployment:

- the containers' `resources`, as a strategic merge patch keyed by container name (never a JSON
  merge patch of the `containers` array, which would replace the other containers);
- `metadata.resourceVersion` as read by the apply itself, a moment before the patch, so a write
  that lands in between answers 409 and the apply is retried once from the read. It is **not** the
  version the editor saw: a deployment's resource version moves at every status write, and the
  pods of a failing service rewrite the status every few seconds;
- the annotation `cubelite.app/resources-override` on the **Deployment's metadata** (not the pod
  template: it must not cause a rollout of its own), holding JSON:

```json
{ "v": 1, "at": "2026-11-13T11:20:00Z",
  "containers": { "api": {
    "original": { "cpu": { "request": "250m", "limit": "500m" }, "memory": { "request": "256Mi", "limit": "512Mi" } },
    "applied":  { "cpu": { "request": "250m", "limit": "500m" }, "memory": { "request": "256Mi", "limit": "768Mi" } } } } }
```

Only containers that were changed are listed. A value that was not set is `null`. A second change
while a mark is active keeps the first `original` and replaces `applied` and `at`. Field manager
`cubelite`. The patch is sent first with `dryRun=All` (§3.2), then for real.

**A change underneath the editor.** The editor remembers the deployment's `metadata.generation`
(it moves only when the spec changes) and the override annotation as they were when it opened, and
sends both with the proposal. The apply, dry run included, reads the deployment again and refuses
when the pod template's resources or the annotation differ from what the editor showed: "The
deployment's resources changed since you opened this. Reopen and try again." A generation that
moved for another reason (a scale, an image update) does not refuse: the facts are read again and
the check runs on them.

### 6.2 What is shown

A mark is **active** while, for every container it lists, the values on the cluster equal
`applied` (compared as numbers). Then the panel shows, above Resources:

```
▲ Resources overridden from CubeLite · 13 Nov, 12:20
  api   Memory limit  512Mi → 768Mi
                          [ Keep these values ]  [ Restore ]
```

When the values on the cluster no longer equal `applied` (the fix arrived from git with other
values, or someone changed them elsewhere) the mark is **stale**: nothing is shown, no badge, no
banner. The app does not write to remove it on a read; the next change from the app replaces it.

**Keep these values.** The likely ending is that the value that held is the one committed to git.
The cluster then still equals `applied`, nothing removes a foreign annotation, and the mark would
stay for good with Restore as its only action, which would undo the real fix. "Keep these values"
(text button) removes the annotation and nothing else: a metadata patch, no rollout, no check. It
asks once in place ("Remove the override mark? The values stay as they are.") and then the banner
and the badge go.

### 6.3 Restore

**Restore** opens the editor's step 2 directly, with the `original` values as the proposal: same
check, same dry run, same "What happens", primary button "Restore" (or "Restore anyway"). It
removes the annotation in the same patch. Restoring to a value that was not set is the one case in
which the app removes a request or a limit.

## 7. How it is built (the parts decided here)

### 7.1 Core (`crates/cubelite-core`)

- `ContainerInfo` (pods) gains the container's requests and limits; `DeploymentInfo` gains its
  containers with requests and limits, the manager (§5) and the parsed, active override (§6.2), so
  panels and the list need no extra call. Labels and annotations are not shipped whole.
- A function that reads the **facts** for one deployment: its containers, replicas, strategy,
  resource version; its pods with node and per-container usage; every schedulable node with
  allocatable, the summed requests and limits of the pods on it, and usage; the namespace's
  LimitRanges and ResourceQuotas; HPAs and VPAs that target it. Each part is optional and carries
  why it is missing (§4.3). One call when the editor opens; it is not kept fresh while the editor
  is open (the resource version catches a change underneath).
- A **pure** function `evaluate(facts, proposal) -> findings` (§4): no I/O, table-tested.
- A function that applies a proposal: reads the facts again, evaluates, refuses on any blocking
  finding even if the caller sent it, then sends the patch (§6.1); a `dry_run` flag runs the same
  path with `dryRun=All`.
- Quantity parsing is completed for what a cluster can return (`Pi`, `Ei`, `P`, `E`, exponents,
  milli-units of memory) and gains a comparison that does not lose precision between `1G` and
  `1Gi`. No `unwrap` or `expect`.

### 7.2 Tauri and desktop

- Four commands: read facts, evaluate (facts are held by the frontend and sent back with the
  proposal, so typing costs no cluster call), apply (with `dry_run`), and remove the override mark
  ("Keep these values").
- Errors: the API's `status.message` reaches the user without the `kubernetes client error:`
  prefix, as YAML apply does today; a 403 from RBAC gets the sentence in §3.2 (a 403 from an
  admission webhook, as Gatekeeper answers, keeps the webhook's own message), a change underneath the
  editor the one in §6.1, and a 409 that survives the one retry reads "The deployment is changing
  too fast to update. Try again."
- The editor is a new component under `components/deployments/`, the section and the banner are
  parts of the Deployment panel. Tokens, type roles and components are the Tonal ones
  (`design/README.md`): `Modal`, `Button` (text, tonal, primary; `danger-solid` is not used, this
  is not a deletion), `FIELD`, `Chip` for the quick steps, `MeterBar`, `StatusGlyph`, `StatusBadge`
  for "Override". No new colour role.
- Pending state follows `stores/mutations.svelte.ts`: one apply per deployment at a time, the
  button shows it, a toast on the outcome.

## 8. Scenario matrix

| Scenario | Expected |
|---|---|
| One container, limit raised, everything fits | no warnings, "Apply" |
| Several containers, one changed | review lists only that one; mark lists only that one |
| Container with no limit or no request | en dash; a value can be set; cannot be cleared |
| Sidecar (native or plain) | editable like any container; counted in the pod's figures |
| 0 replicas, or no pod running yet | no usage, W2 to W5 not applicable (said as such, not as a warning); B and W1 still run with the wanted replicas |
| Pods all crashing (no usage sample) | usage "unavailable" for those containers; W4 and W5 not checked |
| Single node cluster | node section has one row |
| 50 nodes | hosting nodes listed, the rest collapsed with a count |
| No metrics-server | §4.3; editor still usable |
| Namespace-scoped user (cannot list nodes) | node checks "not checked"; namespace rules still checked |
| Read-only user | dry run answers 403; inline error; nothing applied |
| LimitRange max exceeded | B4 on the field and in the list; Review disabled |
| Quota fits at the end, not during surge | W6 |
| Argo CD / Flux / Helm / none | the sentence of §5 |
| HPA on CPU, CPU request changed | W7 |
| Resources or the mark changed while the editor is open | refused at the dry run or at apply with the sentence of §6.1 |
| Status churn, a scale or an image update while the editor is open | not refused; facts read again, check runs again |
| Request not set, limit raised | hint "= limit"; findings use the effective request |
| Value above every node, cluster with an autoscaler | W0, "Apply anyway" possible |
| Small deployment, tight cluster, surge of 1 | W1r |
| Git lands the same values the override applied | mark still active; "Keep these values" removes it |
| Deployment deleted while the editor is open | the editor closes with a toast, as the panel does |
| Second override on top of an active one | `original` kept; banner shows original → current |
| Fix arrives from git | mark stale, banner and badge gone |
| Restore | values back, annotation removed, rollout |
| Both themes, compact density, more contrast, forced colours, reduced motion | as the Tonal rules require; state never by colour alone |
| Keyboard only | every field, step and the node disclosure reachable; focus moves to the step's heading on Review and Back; Esc closes; focus returns to Adjust |
| Window 800 × 600 | the modal body scrolls; the footer stays reachable |

## 9. Tests

- Core: table tests for `evaluate` (one per row of §4.1 and §4.2, and each "not checked" path);
  quantity parsing and comparison; the patch body (strategic merge by name, resource version,
  annotation, dry run flag) against a mocked API, as the scale and restart tests do; the mark's
  active / stale rule; manager detection for each row of §5.
- Desktop unit: the section in both panels; the editor's two steps, quick steps, changed marks,
  disabled Review on a blocking finding, "Apply anyway" with a warning; the banner and Restore; the
  list badge.
- E2E (Tauri mock): the happy path end to end; a blocking finding; a warning; the 403 dry run;
  the modal at 800 × 600; keyboard walk; forced colours and more contrast for the new parts.

## 10. Delivery

Three issues under #650, one PR each to `main`, each usable on its own:

1. **Read-only**: requests and limits in the core payloads, the Resources section in both panels.
2. **Core of the change**: facts, `evaluate`, apply with dry run, the mark, manager detection, the
   Tauri commands. No UI.
3. **Editor**: the modal, the banner, Restore, the list badge.

## 11. Calls made in this spec, for review

Decided with the user: the change goes to the workload and rolls out; the check is against what
the nodes can hold; impossible values are blocked, risky ones warn and the user decides; the
intervention is temporary and stays visible; deployments arrive through Helm or Argo CD / Flux.
A value above every node of the cluster is a warning (W0), not a block: the app cannot see a
cluster autoscaler's larger node pools, and the user decides (answered 2026-11-13).

Calls made here, not yet confirmed:

1. Deployments only in this version (StatefulSets have no panel).
2. Warn, never suspend, for Argo CD and Flux; no reading of their objects.
3. A check that cannot run is a warning ("not checked"), not a block.
4. (Settled, see above: W0 is a warning.)
5. Memory overcommit warns; CPU overcommit is only a note.
6. W2 and W3 assume the pods come back to the same nodes.
7. Usage comes from metrics-server only; Prometheus is not used as a second source.
8. Confirmation is the review step with "Apply anyway"; no checkbox, no typed name.
9. Quick steps `+25%`, `+50%`, `×2`.
10. Values can be raised or lowered, set where missing, never cleared (except by Restore).
11. A stale mark is ignored and left in place until the next change from the app.
12. The "Override" badge in the Deployments list.
13. The annotation key `cubelite.app/resources-override` (from the bundle identifier
    `com.cubelite.app`).
14. "Keep these values" on the banner, to close an override whose values became the real ones.
15. The Resources section uses `MeterBar` with its existing thresholds (60% and 75%).
16. A rollout-time room check (W1r) beside the end-state one.

Calls made while building the editor (delivery 3, #657), the first five shown to the user on
2026-11-13, the rest from the review of that delivery:

25. Quick steps are buttons, not `Chip` (a chip is a toggle). The field they raise is an explicit
    choice per container (CPU request, CPU limit, memory request, memory limit; memory limit by
    default) that also follows the field that takes focus, so the keyboard reaches every field.
26. A quick step rounds up: to 10m for CPU; to 16Mi under 1Gi and to 128Mi from 1Gi for memory.
27. The pod to deployment link is a field of the pod payload (`deployment`), by the ReplicaSet rule.
28. The node rows show one measure for all nodes, chosen by the worst finding about the nodes.
29. "At a time" in the rollout sentence is the surge plus the unavailable count, at least 1 and at
    most the replicas.
30. The findings of step 1, and the dry run's status and refusal in step 2, sit in a region above
    the footer that does not scroll with the body: the check stays in view at any window size.
31. The same amount typed in another unit is not a change: Review stays off and the editor says
    "Nothing changes: these are the same amounts as on the cluster."
32. Once the dry run passes, step 2 says "The cluster accepts this change."
33. The editor closes when the view or the cluster is no longer its own.

Calls made while building the core (delivery 2, #655), accepted by the user on 2026-11-13 except
the last two, which came from the review of that delivery:

17. A fourth command removes the override mark.
18. W0 has a sentence of its own for a limit alone.
19. W2, W3 and the CPU note only when the change makes the figure worse.
20. A quota with scopes is not evaluated.
21. A warning for memory typed with the suffix `m`.
22. Emptying a field in an edit is blocked.
23. A B4 or B5 violation that was already there and is not made worse is a warning, not a block.
24. A pod counts as the deployment's own only when one of its ReplicaSets controls it; a pod of
    another workload with the same labels counts with the others on its node.

## 12. Left to the builder

- The exact shape of the facts and findings types, and the command names.
- How the pod → deployment owner link is resolved (owner references are not in the payloads today).
- Rounding of the quick steps beyond the rule in §3.2, and the debounce value.
- Whether the Resources section's usage reuses `resources.podMetrics` or needs per-container
  usage from metrics-server (it is summed per pod today); per-container is what §3.1 shows.
- Layout details of the modal under 640 px of content width.
