# Prometheus + Grafana integration (desktop + macOS) — design

Date: 2026-11-03 · Issue: #484 · Owner: core-agent, desktop-agent, macos-agent · Status: approved 2026-11-03

Decisions taken with the user on 2026-11-03 (recommended options):

- **A. v1 views:** charts plus Grafana. Pod and deployment charts (CPU, memory, restarts, network), sparklines in lists, and "Open in Grafana".
- **B. Auth:** none, basic and bearer, plus Azure Monitor managed Prometheus with an Entra ID token from the Azure CLI. AWS SigV4 comes later.
- **C. metrics-server:** Prometheus adds history; the live meters stay on metrics-server.
- **D. Grafana:** deep links into Explore.

Everything else below is the author's default and is listed in §11.

## 1. Intent

Today CubeLite shows **instant** usage from metrics-server. That covers Overview capacity meters, pod CPU and memory, and node usage. It cannot answer the questions people open Grafana for:

- When did this pod start using more memory?
- Is the deployment CPU-throttled at peak?
- How often has the container restarted this week?

Goal: when a cluster has Prometheus, show the **recent history** of what the user is already looking at. That means a pod or deployment in its drawer or detail view, and the rows of the pod and deployment lists. A one-click deep link opens the same query in Grafana when its tools are needed. Two kinds of endpoint are supported:

- a Prometheus **in the cluster** (kube-prometheus-stack, prometheus-operator, a plain chart);
- a **managed** service: Azure Monitor managed service for Prometheus, Grafana Cloud, or a self-hosted URL.

## 2. Goals, non-goals, anti-goals

**Goals**

- A per-context Prometheus endpoint, either auto-detected in the cluster or an external URL with credentials. Same model and keychain rules as Elasticsearch (#483).
- A **Metrics** section in the pod and deployment drawer (desktop) and detail view (macOS):
  - CPU (with request and limit lines), memory working set (with request and limit), restarts and network rx/tx;
  - ranges 1 h, 6 h, 24 h, 7 d;
  - per container, or summed.
- **Sparklines** for the last hour of CPU and memory in the Pods and Deployments lists, next to the current metrics-server values.
- **Open in Grafana** on each chart: Explore with the same PromQL and range.
- Preferences → Integrations → Prometheus:
  - endpoint, auth, cluster label (for shared workspaces), Grafana URL and datasource;
  - Test connection, which reports the version and whether cAdvisor and kube-state-metrics series exist.

**Non-goals (v1)**

- No PromQL console, no alert list (Alertmanager), no recording or alerting rules, no dashboards inside CubeLite.
- Grafana is not embedded and no Grafana dashboard is selected (deep links into Explore only).
- No node or cluster-level charts. The Overview keeps its metrics-server meters; node history is a follow-up.
- No AWS SigV4 (Amazon Managed Prometheus) and no Grafana service accounts (follow-ups).
- No writing to Prometheus.

**Anti-goals**

- Without a Prometheus endpoint, nothing changes. No empty chart areas and no "connect Prometheus" nags in lists.
- No background traffic. Queries run only while a chart or a list with sparklines is on screen. They refresh on the list's existing auto-refresh cadence, never faster than every 30 s.
- A slow or broken Prometheus never delays or breaks a list. Sparklines load after the rows and fail silently, with a tooltip explaining why.
- Credentials are never stored in settings files, never logged, and never sent to any host except the configured endpoint (§6).
- No new colours or font sizes outside the tokens (design-lint stays at 0).

## 3. Endpoint model

The endpoint is set per **kube context**, mirroring `EsEndpoint`.

| field | in-cluster | external |
|---|---|---|
| target | namespace + service + port (+ scheme) | base URL (`https://<workspace>.<region>.prometheus.monitor.azure.com`, `https://prometheus-prod-…grafana.net/api/prom`, …) |
| auth | none | none, basic, bearer, **azure-cli** |
| cluster label | optional `cluster="…"` matcher added to every query (a shared Azure Monitor workspace or Thanos holds many clusters) | same |
| Grafana | optional base URL + datasource (UID or name; empty uses Grafana's default) | same |
| TLS | via the API server / tunnel | system trust store, plus a per-endpoint "skip verification" opt-in |

**In-cluster detection** runs on demand (Preferences → Detect). It looks for services:

- labelled `app.kubernetes.io/name=prometheus` or `operated-prometheus=true`;
- named `prometheus-operated`, `*-prometheus` or `prometheus-server`, with port 9090 (or the port named `web` / `http`);
- excluding services named `*-alertmanager`, `*-node-exporter`, `*-operator` and `*-pushgateway`.

The user picks one when several match. `prometheus-operated` is preferred: it is headless, so it is reached through a pod.

**In-cluster transport** goes through the **API server service proxy** (`/api/v1/namespaces/{ns}/services/{scheme}:{svc}:{port}/proxy/api/v1/…`) with the user's kube credentials.

- An in-cluster Prometheus normally has no authentication, so the header-stripping problem that forced port-forward for Elasticsearch does not apply.
- When the proxy is forbidden (403 on `services/proxy`) or the service is headless, the app falls back to the **port-forward tunnel** already built for Elasticsearch. That is `forward_pod_port` in the core and `ElasticTunnel` on macOS, generalised into a shared tunnel.

**Storage:** endpoint settings (no secrets) live in the app settings under `prometheus.endpoints`. Secrets go in the OS keychain:

- desktop: service `cubelite.prometheus`;
- macOS: tag `it.lapuma.cubelite.prometheus`.

In both cases the account is the context and the value is `{binding, auth}`, as for Elasticsearch.

## 4. Queries

All queries are PromQL against `/api/v1/query_range`, or `/api/v1/query` for list sparklines that only need one range vector. Metric names come from cAdvisor and kube-state-metrics, which kube-prometheus-stack and Azure Monitor (container insights Prometheus) both ship.

`{sel}` means `namespace="ns", pod="p"` plus the cluster matcher when set. For a **deployment** it means `namespace="ns", pod=~"<name>-[a-z0-9]{6,10}-[a-z0-9]{5}"` (ReplicaSet hash plus pod suffix). A **StatefulSet** uses `pod=~"<name>-[0-9]+"`; StatefulSet charts come later, but the selector is in the builder so the follow-up only adds UI. Label values are escaped for PromQL string literals.

| chart | PromQL (per container: `sum by (container)`; summed: `sum`) |
|---|---|
| CPU (cores) | `rate(container_cpu_usage_seconds_total{{sel}, container!="", container!="POD"}[{w}])` |
| CPU request / limit | `kube_pod_container_resource_requests{{sel}, resource="cpu"}` / `…limits…` |
| Memory (bytes) | `container_memory_working_set_bytes{{sel}, container!="", container!="POD"}` |
| Memory request / limit | `kube_pod_container_resource_requests{{sel}, resource="memory"}` / `…limits…` |
| Restarts | `increase(kube_pod_container_status_restarts_total{{sel}}[{w}])` |
| Network rx / tx (B/s) | `rate(container_network_receive_bytes_total{{sel}}[{w}])` / `…transmit…` (pod level, summed) |

- **Range and step:** the ranges are 1 h, 6 h, 24 h and 7 d. The step is `max(15 s, range / 240)`, rounded to a whole number of seconds. The rate window `{w}` is `max(4 × step, 1m)`, so a missed scrape never leaves gaps.
- **Sparklines:** one query per list and namespace, never one per row: `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="ns", container!="", container!="POD"}[5m]))` over 1 h at a 2 m step, plus the memory equivalent. A deployment sums the pods its regex matches, computed client-side from the pod series.
- **Missing series:** a chart with no series says which exporter it needs ("needs kube-state-metrics"). Test connection checks `count(container_cpu_usage_seconds_total)` and `count(kube_pod_container_resource_requests)` up front.
- **Limits:** request timeout 15 s, and at most 11 000 points per series (Prometheus's own cap). Errors show the server's `error` field inline, with the same 401, 403 and 404 wording as Elasticsearch.

## 5. UI

### 5.1 Drawer / detail: Metrics section

```
Metrics                      [1h · 6h · 24h · 7d]  [per container ▾]   ↗ Grafana
┌ CPU ─────────────────────────────── 0.42 / req 0.5 / lim 1 cores ┐
│ ╱╲__╱‾‾╲___╱‾╲  (line per container, dashed request/limit)       │
└──────────────────────────────────────────────────────────────────┘
┌ Memory ───────────────────────────── 312 MiB / req 256 / lim 512 ┐
└──────────────────────────────────────────────────────────────────┘
┌ Restarts ─────────── 3 in range ┐ ┌ Network ────── ↓ 1.2 ↑ 0.3 MB/s ┐
└─────────────────────────────────┘ └──────────────────────────────────┘
```

- **Placement:** the section goes below the existing pod/deployment info. It appears only when the context has a Prometheus endpoint.
- **Loading:** the section loads when it scrolls into view.
- **Hover:** hovering shows a crosshair with the time and the value of each series.
- **Grafana:** "↗ Grafana" on the section header opens Explore with all the section's queries. Each chart title also has a link for that chart alone.
- **Rendering:**
  - Desktop draws the charts as hand-rolled SVG (line and area). This adds no chart dependency (author's call, §11-F).
  - macOS uses **Swift Charts** (system framework, macOS 14 target).
  - Colours are the existing tokens: per-container colours come from `ContainerIdentity` (the same as the merged log view), requests and limits use `textTertiary` dashed lines, and warn/err only appear when usage passes the limit.

### 5.2 Lists: sparklines

- The Pods and Deployments lists get a 48×14 sparkline next to the CPU and Memory values when the context has Prometheus; there is no new column.
- Rows without data show nothing. The column header tooltip says "last hour, from Prometheus".

### 5.3 Preferences → Integrations → Prometheus

This sits next to Elasticsearch:

- Desktop: a section in the Preferences modal.
- macOS: the Integrations tab gets an Elasticsearch | Prometheus segmented picker.

It is per context and holds:

- on/off, Detect, an in-cluster target or an external URL;
- the auth method, with secret fields for basic and bearer; **Azure CLI** has no secret: it shows the account `az` is logged in as;
- the cluster label, the Grafana URL and the Grafana datasource;
- **Test connection**, which shows the version, whether cAdvisor and kube-state-metrics series are present, and the matched `cluster` values when the label is set.

### 5.4 Open in Grafana

The link is `{grafana}/explore?schemaVersion=1&panes={"a":{"datasource":"<ds>","queries":[{"refId":"A","expr":"…"},…],"range":{"from":"now-1h","to":"now"}}}&orgId=1`, URL-encoded.

- It is built and opened like Open in Kibana: from Rust on the desktop (http(s) only), and with `NSWorkspace` on macOS.
- Without a Grafana URL the link is hidden.

## 6. Auth and security

These are the same rules as Elasticsearch (spec 2026-11-03-elastic-kibana §6):

- credentials are bound to the endpoint origin and its TLS setting;
- credentials are never placed in the URL, and never sent over plain `http://` except to loopback;
- the tunnel bypasses proxies;
- redirects are never followed with credentials.

**Methods:** none, basic, bearer and **azure-cli**.

**azure-cli** gets an Entra ID access token for `https://prometheus.monitor.azure.com` by running `az account get-access-token --resource https://prometheus.monitor.azure.com --output json`.

- It is run with the user's shell PATH, the same way exec credential plugins are resolved for kubeconfig today.
- The token is cached in memory until 5 minutes before its `expiresOn` and is never stored.
- The method is accepted only for `https://*.prometheus.monitor.azure.com` URLs, so the token cannot be sent anywhere else.
- When `az` is missing or the user is not logged in, the message says so ("run `az login`"). The app never starts a login flow itself.

## 7. Structure

**Core (Rust)**

- `crates/cubelite-core/src/prometheus/`:
  - `mod.rs`: endpoint and auth types, the PromQL builder (pure, unit-tested), step and window maths, and `query_range` response parsing into `{labels, points[(t, v)]}` with NaN/Inf handled.
  - `transport.rs`: the service proxy through the kube client, with port-forward fallback. It shares the tunnel code with `elastic::transport` by moving it into a small `tunnel` module.
  - `grafana.rs`: the Explore URL.
  - `azure.rs`: the token via `az`.
- There are **no new dependencies**: `reqwest`, `url` and `serde_json` are already present.

**Desktop**

- Tauri commands: `prometheus_detect`, `prometheus_test`, `prometheus_query_range`, `prometheus_sparklines`, `prometheus_save_auth`, `prometheus_auth_method` and `open_grafana_explore`.
- `stores/prometheus.svelte.ts` holds the endpoints and a small per-view query cache.
- Components: `components/metrics/MetricsSection.svelte`, `LineChart.svelte` (SVG) and `Sparkline.svelte`, plus a Preferences section.

**macOS**

- `PrometheusService`, an actor reusing `ElasticService`'s connection, trust and keychain patterns. The shared parts move into a generic `IntegrationConnection`.
- `AzureCLIToken`, which reuses `ExecCredentialService`'s process runner.
- `MetricsSectionView` (Swift Charts), `SparklineView`, and a Prometheus form in Integrations.
- The same PromQL and Grafana-URL test vectors are used on both sides.

## 8. Tests

**PromQL builder**

- pod vs deployment vs StatefulSet selector;
- cluster matcher;
- escaping of `"`, `\` and newlines in label values;
- per container vs summed;
- the step/window table for each range.

**Response parsing**

- matrix and vector results;
- `NaN`/`+Inf` values;
- empty results;
- `status: error` with `errorType`.

**Transport**

- service proxy path building, including the scheme prefix and the headless case → port-forward;
- the 403 fallback;
- auth headers and binding;
- the Azure host check;
- an `az` output parse, and `az` missing or not logged in.

Rust uses a mock HTTP server and Swift uses `URLProtocol` stubs.

**Grafana URL**

- encoding of the `panes` JSON, the datasource, the range and several queries.

**UI**

- the Metrics section is hidden without an endpoint, plus its loading, error and "needs kube-state-metrics" states;
- range switch;
- sparklines are fetched once per list, and a list renders before its sparklines;
- Preferences Test connection states.

Playwright covers this with the mocked Tauri layer, and XCTest covers the macOS models.

No test hits a real cluster. A manual checklist covers kube-prometheus-stack in minikube and one Azure Monitor workspace.

## 9. Delivery

There are four issues and PRs, as for #483:

1. core `prometheus` + Tauri commands (+ shared tunnel);
2. desktop UI (Metrics section, sparklines, Preferences, Grafana);
3. macOS service + Azure CLI token;
4. macOS UI.

#484 closes with the last one. Follow-ups: node and cluster charts, AWS SigV4, StatefulSet and DaemonSet charts, alerts.

## 10. Open risks

- **Deployment regex:** the ReplicaSet-hash regex can also match pods of another deployment whose name extends this one (`api` vs `api-gateway-…` is excluded by the hash shape, but `api-v2` with a 6–10 character segment is not). A kube-state-metrics owner join (`kube_pod_owner` ⨝ `kube_replicaset_owner`) is exact but heavier. v1 uses the regex and the drawer lists the matched pod names; the join is a follow-up if it bites.
- **Azure Monitor naming:** Azure Monitor's default scrape config drops some cAdvisor series unless "full" profile is enabled. The "needs …" message names the missing metric.

## 11. Author's calls (check while reading)

- **E.** In-cluster goes through the service proxy first, with port-forward fallback. The alternative is port-forward only, as for Elasticsearch.
- **F.** Desktop charts are hand-rolled SVG with no new dependency. The alternative is a chart library such as uPlot (about 45 KB) or LayerChart.
- **G.** Ranges are 1 h / 6 h / 24 h / 7 d, with no custom range in v1.
- **H.** Sparklines show only the last hour, with one query per list.
- **I.** Deployment pods are matched with a regex in v1 (§10).
- **J.** Design-first: the ASCII layout in §5 is the design. Penpot boards for the Metrics section and sparklines can be drawn before implementation if wanted.
