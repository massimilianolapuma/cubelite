# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Namespace column in the desktop resource lists** (#546): Pods,
  Deployments, StatefulSets, Jobs, CronJobs, Services, Ingresses, ConfigMaps,
  Secrets and PVCs show each row's namespace next to its name, and the header
  sorts by namespace then name — as the native app and the Helm Releases list
  already did. With "All namespaces" selected, rows from different namespaces
  are no longer told apart only through the filter field.

### Fixed

- **A context uses the cluster and user of its own kubeconfig file**
  (core, desktop and macOS, #543): when several kubeconfig files are merged
  (`~/.kube`, the Preferences list or `KUBECONFIG`), clusters and users were
  settled first-wins by name across the whole merge, so a stale cluster or
  user left in an earlier file (for example `~/.kube/config` after a cluster
  was recreated) redirected a context defined in a later file to the old API
  server and credentials. A context now resolves its `cluster` and `user`
  against the file that defines it; only names that file does not define fall
  back to the first file that does, so cross-file references keep working.
  Contexts and `current-context` are still first-wins. On macOS, a token
  stored in the Keychain from the earlier file's stale user is replaced with
  the context file's token for the same server; a token you entered yourself
  is kept, and "Reset stored credentials" still clears it. Preferences notes,
  per file, the clusters and users an earlier file defines differently
  ("N redefined" on the desktop, a caption on macOS).

## [0.7.0] - 2026-11-05

### Added

- **Node and cluster charts and active alerts from Prometheus** (desktop and
  macOS, #530): the Overview's Capacity card gets a cluster CPU and memory
  history (1h · 6h · 24h · 7d) against allocatable, next to the
  metrics-server meters, and an Alerts card lists the firing alerts
  (severity, name, the pod or node they are about with a link to it,
  summary, firing since, Open in Grafana on the alert's expression), with a
  "N firing" badge by the Overview title. Nodes open a detail (drawer on the
  desktop) with a Metrics section: CPU, memory, pods running, network rx/tx
  and filesystem. Each chart uses node-exporter where it scrapes the node,
  else cAdvisor (`node="<n>"`, or `instance="<n>"` on Azure Monitor), and
  says which; a chart no exporter has says "not available". node-exporter's
  `instance` (an IP:port) is matched to the node by `node_uname_info`'s
  host name, else by the node's `internal_ip` from `kube_node_info`. Alerts
  come from `/api/v1/alerts` (annotations, activeAt), else the `ALERTS`
  series; Open in Grafana fetches the alert's rule expression on click
  (rules cached 5 minutes per connection). Informational alerts (severity
  `none`: Watchdog) are listed last, muted, and not counted. A reference
  line (allocatable, capacity, size) always comes from its usage's
  exporter. Everything uses the
  context's Prometheus endpoint and cluster label, loads on the Overview's
  refresh at most every 30 s, and shows the "Set up Prometheus" hint without
  an endpoint. Core: `prometheus::nodes` and `prometheus::alerts`; Tauri:
  `prometheus_cluster_usage`, `prometheus_node_metrics`, `prometheus_alerts`.
- **Integration endpoints shared across contexts** (desktop and macOS,
  #528): Settings → Integrations has a "This context" / "All contexts
  (default)" switch for Elasticsearch and Prometheus. One external
  endpoint (an Azure Monitor workspace, an Elastic Cloud deployment) can
  serve every kube context without one of its own; a context can
  override it or turn it off. Each context keeps its own Prometheus
  `cluster` label, picked from the values Test connection finds
  (preselecting the one matching the context name), or its own
  Elasticsearch cluster filter (`orchestrator.cluster.name` with ECS).
  The default's credentials are saved once in the keychain and only sent
  to its URL; in-cluster services cannot be defaults. Settings saved by
  older versions load unchanged.
- **Elasticsearch history for workloads and the Logs view** (desktop and
  macOS, #529): the Logs view gets a Workload picker (deployments,
  StatefulSets, DaemonSets, Jobs; the deployment details' Logs button opens
  it on that deployment) that narrows the live stream to the workload's
  pods, and Live · History for its filter: one workload's pods, or the
  selected namespace. History matches the pods with the same name regexp as
  the Prometheus charts (deployment `name-<hash>-<suffix>`, StatefulSet
  `name-<n>`, DaemonSet `name-<suffix>`, Job `name-<suffix>` or, Indexed,
  `name-<index>-<suffix>` with an index of at most 7 digits so a CronJob's
  pods never match), so `api` never matches `api-gateway`; a Job also
  matches its `job-name` label (ECS). With the Fluent Bit preset every exact
  filter tries the field and its `.keyword` subfield (dynamic mapping or a
  keyword template). Every history line shows its pod. A label selector or
  every namespace at once keeps History disabled, with the reason as its
  tooltip; leaving the view releases the search's point in time. Open in
  Kibana uses the same filter (Lucene). The core's `HistoryQuery` takes an
  optional `workload` (backwards-compatible) and history lines carry their
  pod.
- **Detect Elasticsearch and Prometheus on connect, enable them in one
  click** (desktop and macOS, #527): after a context connects, CubeLite
  lists its services once (across namespaces, classified by the existing
  Elasticsearch/Kibana and Prometheus/Grafana detectors) and, for each
  integration that is not configured yet, shows a slim banner above the
  content naming the services it would use, e.g. "Elasticsearch found
  (logging/quickstart-es-http) and Prometheus (monitoring/prometheus-operated)
  — Enable · Review · ✕". Enable tests and saves the in-cluster endpoints
  with the defaults (the ECK elastic user, the default index pattern with
  ECS fields, the Kibana and Grafana next to them); a failed test saves
  nothing and the banner says why, and a Prometheus without cAdvisor series
  is saved with a warning. Enable is offered only when the service is the
  only candidate, selects its instance, and is controlled by an ECK
  `Elasticsearch` or a `Prometheus` resource verified through the
  Kubernetes API (it exists with the referenced uid); labels and names only
  rank candidates, so a look-alike Service cannot be enabled in one click.
  kube-prometheus-stack's `prometheus-operated` is not controlled by its
  Prometheus, so it gets Review. Otherwise Review opens
  Preferences pre-filled with the best guess and every candidate, not
  saved. ✕, or turning the
  integration off in Preferences, hides the banner for that context until
  Preferences → Integrations brings it back.
  Nothing reaches Elasticsearch or Prometheus and no secret is read before
  the click; a user who may not list services across namespaces gets no
  banner. The banner follows "Show integration hints in panels".
- **Discoverable history, metrics, Kibana and Grafana** (desktop and macOS,
  #526): without Elasticsearch the log panel still shows Live · History,
  with History disabled ("Connect Elasticsearch in Settings → Integrations
  to see older logs") and a Set up link; without Prometheus the pod and
  deployment details show a compact Metrics placeholder with Set up
  Prometheus and Hide. Both follow a new "Show integration hints in panels"
  setting (Settings → Integrations, on by default). The pod and deployment
  details add "Logs in Kibana" (Discover on the pod, or on a deployment's
  pods by name prefix) and "Metrics in Grafana" (Explore on the workload's
  CPU) when the context's Kibana or Grafana can be opened, and the command
  palette adds Open Kibana, Open Grafana and Integrations settings.
- **Open an in-cluster Grafana** (desktop and macOS, #525): Detect in the
  Prometheus preferences now lists Grafana services too (kube-prometheus-stack's
  `monitoring/<release>-grafana`) and can pick one; without a Grafana URL,
  Open in Grafana port-forwards to it (one forward per context and service,
  reused while its pod is ready, closed when the context's Prometheus is
  disconnected or its settings are saved) and opens Explore on 127.0.0.1.
  Kibana and Grafana share the forward code on both apps.
- **Open an in-cluster Kibana on macOS** (#519): Detect in Settings →
  Integrations → Elasticsearch can pick the cluster's Kibana service;
  without a Kibana URL, Open in Kibana forwards to it (one loopback forward
  per context, reused while its pod is ready, closed on disconnect) and
  opens Discover on 127.0.0.1.
- **Open an in-cluster Kibana** (desktop, #505): Detect in Preferences →
  Elasticsearch can pick the cluster's Kibana service; without a Kibana URL,
  Open in Kibana port-forwards to it (one forward per context, reused while
  its pod is ready, closed when the endpoint changes) and opens Discover on
  127.0.0.1.
- **Metrics history from Prometheus on macOS** (#512, closes #484): Settings
  → Integrations gets a Prometheus pane next to Elasticsearch (in-cluster
  with Detect, or external with basic, bearer or the Azure CLI; cluster
  label, Grafana URL and datasource, Test connection); pod and deployment
  details show a Metrics section (CPU and memory with requests and limits,
  restarts, network over 1 h – 7 d, per container or total, hover values,
  Open in Grafana), and the Pods and Deployments lists last-hour sparklines.
- **Prometheus service on macOS** (#511, part of #484): the native app can
  detect Prometheus servers, test a connection, chart a pod's or
  deployment's history and load list sparklines — in-cluster through the
  API server (a port-forward when the proxy is not allowed), or external
  with basic, bearer or an Azure CLI token for Azure Monitor — with
  credentials in the keychain bound to their endpoint. The UI comes in #512.
- **Metrics history from Prometheus** (desktop, #510, part of #484): with a
  Prometheus endpoint set for the cluster (Preferences → Prometheus: detect
  in-cluster servers or enter an external URL — basic, bearer or Azure CLI
  for Azure Monitor — with an optional cluster label and Grafana URL), pod
  and deployment drawers get a Metrics section (CPU and memory with
  requests and limits, restarts, network over 1 h – 7 d, per container or
  total, hover values, Open in Grafana) and the Pods and Deployments lists
  show last-hour sparklines.
- **Prometheus client** (core + desktop backend, #509, part of #484): the
  core builds the PromQL of a pod's or deployment's CPU, memory, restarts
  and network history, queries an in-cluster Prometheus through the API
  server (a port-forward when the proxy is not allowed) or an external
  endpoint (basic, bearer, or Azure Monitor with an Azure CLI token), and
  builds Grafana Explore links. Credentials are kept in the OS keychain,
  bound to their endpoint. The UI comes in #510. Integration plumbing is
  now shared with Elasticsearch, and redirects are no longer followed.
- **Log history from Elasticsearch on macOS** (#503, closes #483): Settings →
  Integrations sets a cluster's Elasticsearch endpoint (detect in-cluster
  services or enter an external URL, credentials in the keychain, Test
  connection); the log panel then gets a Live · History switch with time
  range, query, load older and Raw · JSON · ECS rendering of the stored
  documents, and "Open in Kibana" in the overflow menu.
- **Elasticsearch service on macOS** (#502, part of #483): the native app
  can detect Elasticsearch/Kibana services, test a connection and search a
  pod's log history (in-cluster through a loopback port-forward with ECK's
  CA pinned to the service name, or an external HTTPS endpoint), with
  credentials in the keychain bound to their endpoint. The UI comes in #503.
- **Log history from Elasticsearch** (desktop, #501, part of #483): with an
  Elasticsearch endpoint set for the cluster (Preferences → Elasticsearch:
  detect in-cluster services or enter an external URL, credentials kept in
  the OS keychain, Test connection), the log panel gets a Live · History
  switch: a pod's past logs with time range, query, Load older and the
  Raw · JSON · ECS modes rendering the stored documents; "Open in Kibana"
  opens Discover filtered on the pod.
- **Elasticsearch client** (core + desktop backend, #500, part of #483): the
  core can search a pod's log history in Elasticsearch (in-cluster through
  a port-forward with the ECK CA trusted, or an external endpoint), map hits
  to log lines, read version/health and detect Elasticsearch/Kibana services;
  the desktop app gets the Tauri commands and stores credentials in the OS
  keychain. The UI comes in #501.
- **Resource order and list sort** (macOS, #497): a Navigation tab in
  Preferences reorders the resource types within their groups, reorders the
  groups and hides types (Overview stays first), with the same rules as the
  desktop app; a default list sort (API order, Name, Namespace, Age, Status —
  problems first — or Restarts) applies to every resource table, and the
  native column headers sort a list for the session.
- **Resource order and list sort** (desktop, #496): Preferences → Navigation
  reorders the sidebar types within their sections, reorders the sections
  and hides types (Overview stays first; hidden types stay in the command
  palette). A default list sort (API order, Name, Namespace, Age, Status —
  problems first — or Restarts) applies to every resource table, and
  clicking a column header sorts that list for the session.
- **ECS log view** (macOS, #493): the `{}` JSON toggle in the log panel and
  the aggregated Logs view becomes a Raw · JSON · ECS segmented control
  (an enabled JSON toggle carries over). ECS mode shows every line as its
  Elastic Common Schema document, with the same rules as the desktop app:
  aliases renamed, Kubernetes metadata added, a `service.name` chip, a sorted
  field table with Copy ECS, and NDJSON export. Log lines now keep the full
  kubelet timestamp for `@timestamp`.
- **ECS log view** (desktop, #492): the log toolbar's `{}` toggle becomes a
  Raw · JSON · ECS mode control (log panel, pop-out and aggregated Logs view;
  an enabled JSON toggle carries over). ECS mode shows every line as the
  Elastic Common Schema document it would be in Kibana: common aliases
  (`msg`, `level`, `trace_id`, `service`…) renamed, Kubernetes metadata
  added, `service.name` chip on the row, a sorted field table on expand with
  Copy ECS, and NDJSON export.
- **Pod shell** (desktop, #488): a Shell button in the pod drawer opens a
  line-based `/bin/sh` session (no TTY) in the pod's first container, like
  the native app; stdout, stderr and exit status stream into a scrollback.
- **Edit & apply manifests** (desktop, #487): the YAML modal gets an Edit
  mode; Apply replaces the resource (`kubectl replace` semantics, like the
  native app), with conflicts and validation errors shown inline.

- **JSON view for structured logs** (desktop, #454): a `{}` toggle in the log
  toolbar (off by default, remembered) renders JSON log lines as
  `LEVEL  message  key=value …`, taking the level from the line itself, and a
  click expands the line into a formatted tree with Copy JSON / Copy raw.
  Plain-text lines, search, export and the pop-out window are unchanged.
- **JSON view in the aggregated Logs view** (desktop, #461): the same `{}`
  toggle and expandable tree as the log panel, with its own remembered
  preference; rows now share the log panel's row component and show the
  full pod name on hover.

- **Overview stat cards open their view** (desktop, #463): Nodes, Pods
  running, Deploys healthy and Warnings are now buttons with an arrow that
  jump to Nodes, Pods, Deployments and Events.
- **Kubeconfigs without `kind` are accepted** (desktop + macOS, #481): like
  kubectl, a file with no `kind` loads when it has at least one cluster,
  context or user; a `kind` other than `Config` is still rejected.
- **JSON view for structured logs** (macOS, #477): native parity of the
  desktop JSON view in the log panel (`{}` toggle, remembered) and in the
  aggregated Logs view (own toggle; rows now share the panel's row and show
  the full pod name). Key order and large integers are kept exact.
- **Overview stat cards open their view** (macOS, #464): same as the desktop;
  the four tiles are buttons that raise on hover and select Nodes, Pods,
  Deployments and Events.

### Fixed

- **Client-certificate clusters: intermittent TLS failure on the first
  call** (macOS, #521): every new connection re-imported the client
  identity under one key tag shared by all clusters, deleting the private
  key another session had paired — its TLS handshake then failed with
  "Certificate validation failed", or a concurrent import with OSStatus
  -25299. A stored identity that can sign is now reused, each cluster's key
  has its own tag (a rotated certificate replaces only that cluster's key,
  so keys never pile up, and Reset stored credentials removes them), and
  imports are serialised across the process. The TLS error now names the
  URLError code and the stream error.

- **Exact Elasticsearch history paging** (desktop and macOS, #531): Load
  older could repeat or skip lines whose timestamps were equal across shards.
  A history search now opens a point in time (`keep_alive` 5m) and pages on it
  with `_shard_doc` as tiebreaker; the opaque cursor carries the PIT id (the
  latest one Elasticsearch returns). An expired PIT resumes on a new one at the
  boundary millisecond, and the panel drops the lines repeated there by
  `_index` + `_id`. The PIT is closed, best effort, after the last page or
  when the search is replaced or its log tab closed. Servers without PIT,
  users without the privilege (400/403/404/405 on open) and Elasticsearch
  7.10–7.11 (no `_shard_doc`) keep plain `search_after`, remembered per
  connection; any other failure to open a PIT (a full PIT table, a 5xx) pages
  without one for that request only.
- **Desktop skipped kubectl-written kubeconfigs in ~/.kube** (#479): discovery
  read only the first 512 bytes, where kubectl's sorted keys rarely put
  `kind: Config`; it now parses the whole file (16 MiB cap), like macOS (#473).

- **JSON view rounded large integers** (desktop, #455): ids and nanosecond
  timestamps beyond 2^53 are now kept exact in the row tail, the tree and
  Copy JSON (engines without `JSON.parse` source access keep the old
  rounding).

- **Log pop-out showed 404 in dev** (desktop, #459): the detached log window
  opened `index.html?logWindow=…`, which the SvelteKit dev server does not
  route; it now opens `/?logWindow=…`, valid in dev and in the static build.

- **`~/.kube` discovery missed kubectl-written files** (macOS, #473): the
  native app only read the first 512 bytes of each file, and kubectl writes
  `kind: Config` after the inline certificates, so most generated
  kubeconfigs were skipped. Discovery now uses the same whole-file check as
  Add File… and as the desktop app. That check also follows symlinks now, so
  a symlinked kubeconfig is discovered and can be added again.

- **Add File… rejects non-kubeconfig files** (macOS, #450): same rule as
  the desktop fix for #448. A file picked in Preferences must parse as a
  kubeconfig with `kind: Config` (YAML or JSON, checked on the whole file);
  otherwise an alert names it and the list is unchanged. Valid files picked
  together with a rejected one are still added.

- **Dependency audit** (#470): `minimatch` is pinned to `>=11.0.1` through a
  root `pnpm.overrides` entry so `pnpm audit` passes GHSA-g3hv-75wg-m249. The
  package reaches the tree only through dev tooling (`eslint`,
  `@eslint/config-array`, `@typescript-eslint/typescript-estree`), which
  still declare `^10` while their own bumps are in flight; the override goes
  once they ship minimatch 11. On the Rust side `tauri-plugin-updater` moves
  to 2.14.1, which extracts bundles with `zip` 9: this closes
  RUSTSEC-2026-0429 and lets the zip 4 allow-list from #445 go from
  `.cargo/audit.toml`.

## [0.6.0] - 2026-10-21

### Added

- **Manage kubeconfig files from Preferences** (desktop, #428): Add file…
  opens a file picker, each file has Remove, and "Use defaults" returns to
  `KUBECONFIG` / `~/.kube`. The custom list replaces the environment, as in
  the macOS app. A caption shows where the list comes from, and when a listed
  file changes on disk the contexts reload with a "Kubeconfig updated" toast.

- **Kubeconfig discovery** (desktop, core): without `KUBECONFIG`, CubeLite now
  merges `~/.kube/config` with every other kubeconfig found in `~/.kube/`
  (files whose head says `kind: Config`; hidden files and `cache/` ignored),
  matching the macOS app. The backend also exposes an origin-aware
  `kubeconfig_sources`, spec-aware context commands and a debounced
  `kubeconfig-changed` watcher, ready for file management in Preferences.

### Fixed

- **Add file… rejects non-kubeconfig files** (desktop, #448): a file picked
  in Preferences must be a kubeconfig document (`kind: Config`), like the
  files discovered in `~/.kube`. Before, any YAML or JSON file was added with
  0 contexts; now the error toast shows and the list is unchanged.

- **Dependency audit** (#445): `rustls-webpki` 0.103.16 and
  `webpki-root-certs` 1.0.10 pick up the RUSTSEC-2026-0382/0383 fixes. The
  three `zip` 4.x advisories (RUSTSEC-2026-0367/0368/0369) are allow-listed in
  `.cargo/audit.toml`: the crate comes only from `tauri-plugin-updater`, which
  extracts a bundle only after verifying its signature, and no published
  plugin release uses zip 9 yet.

### Changed

- **SonarCloud scope** — the analysis exclusions (Swift test targets,
  `tests/` directories, `target/`, `design/`) move to `.sonarcloud.properties`.
  SonarCloud Automatic Analysis reads only that file, so the old
  `sonar-project.properties` was never applied and is removed. Its Swift
  test-naming rule exceptions are covered by excluding the test targets.

- **SvelteKit 3** — the desktop moves to SvelteKit 3 and
  `@sveltejs/adapter-static` 4, with TypeScript 6, which Kit 3 requires.
  The Kit config moves from the removed `svelte.config.js` into
  `sveltekit({...})` in `vite.config.ts`, and `tsconfig.json` extends the
  generated `$app/tsconfig`. Library imports use the `#lib` subpath import
  declared in `package.json` `imports`, with explicit file extensions
  (`#lib/tauri.ts`), replacing the removed `$lib` alias. Vitest therefore needs
  no alias of its own. Node.js 22.17+ is now required.
  SonarCloud now leaves desktop unit tests out of its duplication metric
  (`.sonarcloud.properties`), because their shared `vi.mock` headers repeat
  by design.

## [0.5.0] - 2026-10-02

### Added

- **macOS Overview parity** (#359): the native Overview counts through
  `OverviewSummary`, which mirrors the desktop `overview-summary.ts` and is
  tested against the same fixture. It now matches the desktop. Cards use
  design-token surfaces with sidebar-section tints, metric values are mono
  `data` and coloured only when non-zero, and denied kinds show a "forbidden"
  badge. The capacity and recent-warnings cards sit side by side, and the
  warnings card gains an "All events →" link to the Events view. The meters
  share the desktop thresholds (accent, warn from 60%, err from 75%). The
  extra "Cluster" card is gone, since the header shows connection state.

- **Desktop Overview parity** (#359, part 1): the Overview gains the resource
  grid of the macOS app. It has eight cards (Pods, Deployments, Services,
  Namespaces, Secrets, ConfigMaps, Ingresses, Helm Releases), and a card shows
  a "forbidden" badge when RBAC denies its kind. The stat row reads
  `running/total` pods and `healthy/total` deployments, with tinted icons, and
  the capacity meters add absolute `used / allocatable` sub-labels. Counts come
  from a pure `overview-summary.ts`, and the macOS app will mirror it. The
  Overview now loads its extra kinds in one batch, also on auto-refresh. Meter
  thresholds are unified at warn from 60% and err from 75%.

- **macOS Events view** (#358, part 1): a new Events item in the sidebar's
  Observe section lists every event (Normal and Warning), most recent first,
  in the desktop's grid: Type pill, Reason with `×count`, Object, Message and
  Age. Warning rows get a faint warn tint, and an RBAC denial reads as such
  instead of an empty list.
- **macOS header, status bar and commands** (#358): the header matches the
  desktop titlebar — identity dot, name, provider chip (AKS, EKS, GKE, K3S,
  KIND, LOCAL, K8S) and connection state, a "Search & switch…" button that
  opens the ⌘K palette, and a namespace dropdown with per-namespace pod counts.
  The status bar shows the API server, the Kubernetes version and the refresh
  interval, plus warning (opens Events) and error (opens Diagnostics) counts.
  Refresh moves to ⌘R in the View menu and the palette ("Refresh cluster
  data"); the "Logs & Errors" sheet is now "Diagnostics…" (⇧⌘D) in the
  Window menu.

- **Multiple kubeconfig files** (desktop, #392): the app follows `KUBECONFIG`
  like kubectl. It reads every listed file, first file wins on name clashes,
  and missing files are skipped. Before, contexts from extra files showed up
  in the rail, but connecting to them failed because commands only read
  `~/.kube/config`. The list is imported from the login shell when the app
  is launched from the Dock or Finder, and it is split with the platform
  separator (`;` on Windows). Preferences list each file with its context
  count and note merged or missing files. The rail tooltip names the file
  that defines a context.

- **Design lint** (#360): `scripts/design-lint.sh` runs in CI (job "Design
  Lint", with its own self-test). It blocks `text-[Npx]` classes and raw hex
  colours in desktop Svelte components (held at 0), and system fonts and colours
  in native views (capped per file by `scripts/design-lint-allow.txt`; the
  residue is tracked in #395). Audit report: `docs/design-audit-2026-09.md`.
- **Handoff v1.1 amendments** (#360): the handoff README and `tokens-v2.json`
  now record the contrast-fixed tokens (`text/tertiary` `#7d7d86`, `err/solid`
  `#d72929`), the v1.1 type scale and the parity decisions. The contrast audit
  confirms every v1.1 type size meets AA and non-text contrast reaches 3:1, and records a light-theme accent gap (#396).
- **All Clusters dashboard** (desktop, #362): stat cards now show clusters
  online, total pods, warnings and contexts watched aggregated across every
  context; each online cluster card shows its pods, warnings and CPU/MEM
  bars (or "metrics unavailable"). The background health probe now also
  returns pod, issue-pod and capacity totals per cluster.

### Changed

- **ESLint 10 + eslint-plugin-svelte 3** (#414): the desktop lint stack moves
  to ESLint 10, with `@eslint/js` as a direct dev dependency, and
  eslint-plugin-svelte 3. The config now uses the v3 `recommended` preset and
  parses `.svelte.ts`/`.svelte.js` runes modules with the TypeScript parser
  and the Svelte config. The stores satisfy the new
  `svelte/prefer-svelte-reactivity` rule: copy-on-write sets and maps are
  built without in-place mutation, the log-search match set is a `SvelteSet`,
  and the unused `podCountByNamespace` getter is removed. Dependabot no longer
  proposes TypeScript major updates until typescript-eslint supports
  TypeScript 7.

- **Vite 8** — the desktop builds with Vite 8 (Rolldown), the version
  vite-plugin-svelte 7 requires, which clears its unmet-peer warning.
  SvelteKit 2.70 and Vitest 5 already support it. Node.js 20.19+ or 22.12+
  is now required (root `engines` and README updated), and the Vitest config
  uses `import.meta.dirname` instead of `__dirname`.

- **Vitest config** — dropped the obsolete `hot` option of
  vite-plugin-svelte (an svelte-hmr option, gone since Svelte 5 builds HMR
  into the compiler), which made every test run print "invalid plugin option
  `hot`". Behaviour is unchanged.

- **macOS design tokens, batch 5** (#395): Overview and the cross-cluster
  dashboard use cluster-identity tints per resource (the same ones as the type
  tags) and status tokens for health metrics, with `stat`, `subtitle` and
  `dataSm` text. The design-lint allow-list is now empty, so the macOS app,
  like the desktop, is held at zero system fonts and raw colors.
- **macOS design tokens, batch 4** (#395): onboarding, Preferences, the error
  banner, the menu-bar extra, the toolbar, aggregated logs and exec drop their
  last system fonts and colors (`title`, `subtitle`, `body`, `caption`,
  `micro`, `dataSm`; `statusOk`/`statusWarn`/`statusErr`). Only Overview and
  the cross-cluster dashboard remain: 71 matches in 2 files, down from 104 in 11.
- **macOS design tokens, batch 3** (#395): the deployment and resource detail
  views, Logs and the sidebar use the drawer mapping from the desktop (`title`,
  `section`, `caption`, `dataSm`, mono `micro` for log timestamps) and status
  tokens for replica, reachability and severity colors. The `icon` tokens gain
  `lg`/`xl`/`2xl` (14/28/40px). The allow-list shrinks from 164 matches in 15
  files to 104 in 11.
- **macOS design tokens, batch 2** (#395): the 12 list views (`*ListView.swift`)
  use `Typography.data` for the Name column and `dataSm` for every other cell,
  as the desktop tables do, and status and type-tag colors come from the
  status and cluster-identity tokens. The design-lint allow-list shrinks from
  222 matches in 27 files to 164 in 15.
- **macOS design tokens, batch 1** (#395): the log panel (`LogPanel/*`) and
  shell (`Shell/*`) views drop their last 16 system fonts for
  `DesignTokens.Typography` (`log`, and `micro` in mono for timestamps, source
  and level chips, as on the desktop). A new `icon` token group (`2xs`/`xs`/
  `sm`/`md`: 7/8/10/11px) sizes SF Symbol glyphs and badge digits through
  `View.iconSize(_:)`, which also makes them follow Dynamic Type. The
  design-lint allow-list shrinks from 238 matches in 33 files to 222 in 27.
- **kube 4.2 / k8s-openapi 0.28** (#399): the workspace moves from kube 0.97 and
  k8s-openapi 0.23 to kube 4.2 and k8s-openapi 0.28, on Kubernetes API level
  `v1_32` (the oldest that 0.28 supports). k8s-openapi now uses `jiff` instead
  of `chrono`, so timestamps sent to the UI read `…Z` instead of `…+00:00`
  (same instant; the UI parses both). TLS verification now goes through
  `rustls-platform-verifier`, which uses the OS trust store. `client.rs` gains
  tests against a mock API server: list scoping, delete, scale and restart
  patches, version and node count, events, and error mapping.
- **Core dependencies** (#366): `cubelite-core` and the desktop app now take
  `kube`, `k8s-openapi` and `dirs` from `[workspace.dependencies]`. The whole
  workspace targets one Kubernetes API level (`k8s-openapi` `v1_31`, was
  `v1_30` in core), and `dirs` 5 is gone from the lockfile. `error.rs` and
  `resources.rs` gain unit tests. The kube 4.x upgrade is tracked in #399.

- **Desktop design parity, part 1** (#363):
  - pod and deployment drawers stay pinned to the right edge while the view
    scrolls;
  - the pod drawer shows label chips;
  - a pod row shows an inline spinner while the pod is being terminated;
  - Succeeded pods are green (ok);
  - compact controls (replica stepper, Restart, Reveal, Stop) are 28px and
    the "logs" chip has a 28×28 hit area;
  - the sidebar shows one count per item, red with a tooltip when pods or
    events need attention, including on-demand kinds once loaded;
  - the namespace menu shows per-namespace pod counts.
- **Desktop design parity, part 2** (#363):
  - the deployment replica stepper batches clicks for 800 ms before scaling
    and shows ready/target replica segments;
  - Preferences add row density (default/compact), accent color
    (blue/violet/teal) and a per-cluster identity color override.

- **Tauri 2.12** (desktop): `tauri` 2.12.0 with `@tauri-apps/api` and
  `@tauri-apps/plugin-updater` 2.12, kept in lockstep; plus the Rust
  minor/patch updates from Dependabot (tokio 1.53, serde, thiserror, …).
  Tauri packages are now excluded from Dependabot and updated manually.

- **Type scale v1.1** (both apps): body 13px, caption 11.5px, section 10px,
  column headers 11px, data 12.5px; new `stat` and `micro` styles. The scale is
  generated from `design/tokens.json` into Tailwind `type-*` utilities and
  `DesignTokens.Typography` for SwiftUI; no size falls below the 10pt HIG floor.
- **macOS**: Geist and Geist Mono (OFL 1.1) are bundled and used by every
  `scaledFont` call and the new `typeStyle` modifier — same families as the
  desktop app.

### Fixed

- **Desktop log pop-out follow-ups** (#351):
  - ⌘F / Ctrl+F focuses log search in a popped-out log window;
  - re-attaching or detaching an all-containers session resumes each
    container from its own last line, so a slower container no longer loses
    lines;
  - a re-attach that races a cluster switch is dropped with a toast instead of
    opening a tab against the new cluster.
- **Light-theme accent contrast** (#396): the violet and teal alternate accents
  in the light theme now pass WCAG AA as text and as primary-button fills
  (violet `#7c5ce8` → `#7756e7`, teal `#0f9e8e` → `#0c7e72`; only lightness
  changes). The contrast suite now audits every accent token.
- **Desktop cluster identity colors** (#391): the pink identity color (and
  any color not referenced literally) no longer renders transparent; dynamic
  colors now use the always-emitted `--cl-color-cluster-*` variables.
- **Desktop design cleanup** (#364): log toolbar popovers use the overlay
  elevation tokens instead of Tailwind `shadow-lg`; Unicode glyphs (✕ ⏎ ↺ ✓)
  replaced with Lucide icons; the Timestamps/Wrap toggles expose their state
  as `menuitemcheckbox`.

- **Desktop**: Esc closes the topmost overlay first — the Delete Pod and YAML
  dialogs now close before the drawer underneath them, and Esc cancels an
  in-flight cluster switch (#361). Table rows, log level chips and the Follow
  toggle show the accent focus ring.

### Security

- Bumped vulnerable transitive dependencies: js-yaml 4.3.2, nanoid 3.3.19,
  devalue 5.9.4, @humanfs/node, postcss-selector-parser 6.1.4, tsx 4.23 /
  esbuild 0.28 (npm); rustls 0.23.45 and plist 1.10 / quick-xml 0.42 (Rust).
  `pnpm audit` and `cargo audit` now run in CI (#365).

## [0.4.2] - 2026-08-19

### Added

- **Pop out log session to a separate OS window** (#298, both apps): the `⧉`
  button in the log panel toolbar detaches the active session into its own
  window with full toolbar parity (container picker, search, follow/pause,
  tail, previous, export); closing the window — or `⏷` — returns the tab to
  the panel with history and stream intact. One window per session, unlimited
  windows; on desktop the handoff is gapless (the stream resumes from the
  last transferred line)

## [0.4.1] - 2026-08-09

### Fixed

- Pod drawer "Logs" button now opens the pod log panel instead of the empty
  aggregated Logs view (#346)

## [0.4.0] - 2026-08-09

### Added

- **Pod log viewer** on both apps (#294 macOS, #295 desktop): persistent bottom
  panel with session tabs, live follow with reconnect/backoff, search with
  n/N navigation and filter mode, previous-instance logs, tail control,
  export to Downloads (visible or full buffer)
- **Merged "all containers" stream** (#297, both apps): one interleaved,
  identity-color-tagged stream of every container in the pod, per-container
  reconnect, `<pod>_all.log` export
- **Desktop auto-update** (#250): signed update channel (minisign), silent
  startup check, in-app update banner and Preferences section, `latest.json`
  manifest published with every release
- **Accessibility pass** (#120, macOS): WCAG AA contrast across both themes
  (permanent audit in CI), VoiceOver labels/traits/state on every interactive
  element, full keyboard operability, Dynamic Type up to AX5 for primary text
- Desktop pod port-forward with kube-rs relay and auto-assigned local ports
  (#318); aggregated log viewer with label filtering on macOS (#316);
  Overview parity — capacity metrics, warnings, All Clusters cards (#315)

### Fixed

- ATS exception for user-supplied cluster API hosts (macOS, #329)
- Client-identity signing verification and stale keychain pairing cleanup (#313)
- TLS-skip propagation from Preferences to the API service at init (#311)
- Cancellable, fail-fast cluster switch on desktop (#312); window drag
  fallback (#317); log flood freeze (#316)

## [0.3.0] - 2026-07-12

### Added

- macOS native app: `KubeconfigService`, `KubeAPIService`, `KeychainService` actors
  - `KubeconfigService`: resolves `KUBECONFIG` env paths, merges multiple configs, sandbox-safe home directory resolution via `getpwuid`
  - `KubeAPIService`: typed access to Kubernetes REST API via `URLSession` (namespaces, pods, deployments); bearer token and custom CA trust
  - `KeychainService`: generic password items tagged by service + account; store, retrieve, delete, and update via Security framework
- macOS GUI: `NavigationSplitView` Lens-like layout with sidebar context list and detail pane
  - Toolbar with reload action and error indicator
  - Graceful no-config state with user-facing guidance
- macOS menu bar: `MenuBarExtra` quick context-switch with active context header, context rows, and "Show Details…" shortcut
- macOS models: `ClusterState` (`@Observable`) with contexts, currentContext, pods, namespaces, deployments, isLoading, noConfig, errorMessage
- macOS tests: XCTest suite for `KubeconfigService` (merge, current-context priority, path resolution) and `KeychainService` (store/retrieve/delete round-trip)
- Rust core (`cubelite-core`): kubeconfig parsing, multi-path merge, `list_contexts`, `set_active_context` with disk persistence
- Rust core: `KubeClient` — async kube-rs wrapper; `list_pods`, `list_namespaces`, `list_deployments`
- Rust core: `PodInfo`, `NamespaceInfo`, `DeploymentInfo` resource models with serde
- Rust core: `ConfigError` enum via `thiserror` (FileNotFound, ParseError, ContextNotFound, MergeError, ClientError, Io)
- Desktop: Tauri v2 + Svelte 5 scaffold with shadcn-svelte and Tailwind CSS v4
- Desktop: Tauri command bridges — `list_pods`, `list_namespaces`, `list_deployments`
- Design system: `design/tokens.json` and `design/export-tokens.ts` CSS codegen pipeline
- CI: GitHub Actions workflows for Rust (lint + test), Desktop (lint + test), and macOS (build + test)
- Agent roster: coordinator, core, desktop, macos, design, devops, qa, docs, pages, security
- Repository governance: `CONTRIBUTING.md`, `CODEOWNERS`, branch protection rules, PR template
- GitHub Pages: CubeLite landing page (#32)
- macOS M2: namespace browser, pod/deployment list views, and resource detail panel (#33)
- Agent: PR reviewer agent definition added to `.github/agents/` (#45)
- Config: Penpot MCP server integrated, replacing Figma (#46)
- Rust core + Desktop: Kubernetes watch stream with Tauri event bridge for live resource updates (#50)
- Desktop M4: functional Svelte UI with context sidebar, resource tables, and watch integration (#57)
- macOS: Namespace View enhanced with CPU/Memory/IP columns and pod count badges (#68)
- macOS: Deployment Detail view with spec grid and conditions table (#69)
- macOS: First Launch onboarding flow with kubeconfig guidance (#71)
- macOS: auto-discovery of kubeconfig files across `~/.kube/` directory (#90)
- macOS: RBAC-resilient resource loading with per-resource 403 tolerance (#91)
- Tests: comprehensive e2e and integration test suites across all stacks (#84)
- Tests: TLS temporal validity fallback tests for macOS (#83)

### Changed

- macOS + core: M3 QA pass — fixed test race conditions and stabilised CI (#51)
- Docs: added Bug Discovery Workflow and Pre-Commit Rule to `AGENTS.md` (#95)

### Fixed

- macOS: addressed review findings from initial macOS PR (#44)
- Docs: corrected documentation issues from PR #32 review (#43)
- macOS: show 'Cluster not reachable' with grey dot for unreachable clusters (#59)
- macOS: apply dark mode toggle from Preferences to app chrome (#79)
- macOS: add toolbar with title and close button to LogsView sheet (#80)
- macOS: make 'All Namespaces' visually distinct in the sidebar (#81)
- macOS: handle `errSecCertificateValidityPeriodTooLong` in TLS trust evaluation (#82)
- macOS: persist Skip TLS verification setting and invalidate session on toggle (#94)
- macOS: handle `secureConnectionFailed` error and add task-level TLS delegate (#96)
- macOS: replace invalid `cloud.slash` SF Symbol and fix sidebar collapse layout constraints (#98)

### Security

- CI: upgrade CodeQL Action from v3 to v4 to resolve deprecation (#92)

[Unreleased]: https://github.com/massimilianolapuma/cubelite/compare/main...HEAD
