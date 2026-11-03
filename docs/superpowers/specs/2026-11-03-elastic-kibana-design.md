# Elasticsearch + Kibana integration (desktop + macOS) — design

Date: 2026-11-03 · Issue: #483 · Owner: core-agent, desktop-agent, macos-agent · Status: approved 2026-11-03 (A: history + Kibana link + health in Preferences, B: per context, C: port-forward (revised, see §3), D: reqwest + keyring, E: pod only)
(User asked to proceed without questions: every choice below is the author's
default, listed in §10 for review.)

## 1. Intent

The clusters CubeLite is used on ship their logs to Elasticsearch, and the
user reads history in Kibana. CubeLite's log panel only sees what the kubelet
still holds (current and previous container, bounded tail). When a pod has
restarted twice, was rescheduled, or the problem was yesterday, the user
leaves CubeLite for Kibana and rebuilds the same filter (namespace, pod,
container) by hand.

Goal: from the pod (or deployment) the user is already looking at, show its
**log history from Elasticsearch** in the same log panel, with the same Raw ·
JSON · ECS rendering (#486), and jump to **Kibana Discover** pre-filtered when
Kibana's own tools are needed. Works with an Elasticsearch **in the cluster**
(no setup) or an **external** deployment (Elastic Cloud, Elastic on Azure,
self-hosted).

## 2. Goals, non-goals, anti-goals

Goals
- Per-context Elasticsearch endpoint: auto-detected in-cluster, or configured
  external URL + credentials.
- **History** source in the log panel for a pod (workloads later, decision E): time range, text
  query, newest first, load older, live tail stays one click away.
- **Open in Kibana**: Discover with the same filter and time range.
- Connection status and cluster health (green/yellow/red) in Preferences.

Non-goals (v1)
- No index management, ILM, mappings, ingest pipelines, dashboards or alerts.
- No writing to Elasticsearch.
- No Kibana embedded in CubeLite (deep link to the browser only).
- No aggregated multi-pod history in the Logs view (log panel only; later).
- No Entra ID / OAuth flows (Elastic on Azure uses Elastic API keys; see §6).

Anti-goals
- Credentials never in plain settings / localStorage / UserDefaults:
  OS keychain only, never logged, never sent anywhere but the configured
  endpoint.
- Nothing is queried until the user opens History: no background traffic to
  Elasticsearch.
- A missing or broken Elasticsearch never degrades the live log panel.
- No new colours or font sizes outside the tokens (design-lint at 0).

## 3. Endpoint model

Per **kube context** (a cluster's logs live in one place; namespaces share it):

| field | in-cluster | external |
|---|---|---|
| kind | `in-cluster` | `external` |
| target | namespace + service + port (+ scheme) | base URL (`https://…:9243`) |
| auth | none, basic or API key (ECK puts `elastic` user in a Secret) | API key, basic, bearer |
| index pattern | default `logs-*,filebeat-*,logstash-*` | same |
| field preset | ECS (Elastic Agent / Filebeat) or Fluent Bit (`kubernetes.namespace_name`, `kubernetes.pod_name`, `kubernetes.container_name`, `log`) | same |
| Kibana URL | optional (in-cluster Kibana is opened through a port-forward, §5.3) | optional |
| TLS | via API server (no extra trust) | system trust store, plus "skip verification" opt-in per endpoint |

- **In-cluster detection** (on demand, Preferences "Detect"): services with
  label `common.k8s.elastic.co/type=elasticsearch` (ECK, port 9200 `https`),
  `app.kubernetes.io/name=elasticsearch` or name `elasticsearch*` /
  `*-es-http`; Kibana likewise (`common.k8s.elastic.co/type=kibana`, port
  5601). The user picks one when several match.
- **Transport (revised 2026-11-03)**: in-cluster requests go through a
  **port-forward** to a ready pod behind the service (the core's existing
  `forward_pod_port`), opened on demand and closed when idle, using the
  user's kube credentials (`pods/portforward` RBAC). The API server service
  proxy was the first choice but it strips the `Authorization` header before
  forwarding (kubernetes/kubernetes#38775), so it cannot reach a secured
  Elasticsearch (ECK enables security by default). TLS: the request targets
  the service DNS name (`https://{name}-es-http.{ns}.svc:9200`) resolved to
  the local port, so SNI and hostname match the certificate, and the ECK CA
  from the `{name}-es-http-certs-public` Secret is trusted for that request;
  without a CA the user can opt into "skip verification". ECK's `elastic`
  password may be read from the `{name}-es-elastic-user` Secret with one
  click ("Use ECK credentials"), never stored in CubeLite.
- **Storage**: endpoint settings (no secrets) in the app's settings,
  secrets in the OS keychain keyed `cubelite.elastic.<context>`.

## 4. Querying

- One `_search` per page on the index pattern:
  `bool.filter` = term on namespace + pod (or a `prefix`/`terms` on pod names
  for a workload), optional container, `range @timestamp [from, to]`; the
  text box becomes a `simple_query_string` on the message field
  (`message` / `log`); `sort @timestamp desc`, `size 500`, `search_after`
  for "Load older", `_source` only (no aggregations).
- Results map to the existing `LogLine` (time = `@timestamp`, level from
  `log.level` / detection, message = `message` or the raw `_source` JSON when
  the line was structured) so the panel's search, Raw · JSON · ECS modes,
  wrap, timestamps and export all work unchanged. The `_source` document is
  kept so ECS mode shows the stored document instead of re-converting.
- Time range presets: 15 min, 1 h, 24 h, 7 d, custom (from/to); default 1 h.
- Errors (401/403, index not found, timeout 15 s, RBAC on pods/portforward)
  show inline in the panel with the server's reason; Live keeps working.

## 5. UI

### 5.1 Log panel

```
[worker ▾] [prev] [Live | History]  [1h ▾] [query…]      … Raw·JSON·ECS  ⋯
```
- New segmented **Live · History** control per session (hidden when the
  context has no Elasticsearch endpoint).
- History mode: the live stream pauses for that tab (not stopped; switching
  back resumes with the buffer intact); time-range picker and query field
  replace the tail-lines picker; a "Load older" row at the top; status line
  "1,234 hits · showing 500 · 1h" in `type-caption`.
- Container picker still applies; merged "all containers" queries all.
- "Open in Kibana" in the overflow menu (also in History empty/error state).

### 5.2 Preferences → Integrations (new section, both apps)

Per context (current context preselected): Elasticsearch on/off, Detect,
in-cluster target or external URL, auth method + secret fields, index
pattern, field preset, Kibana URL, **Test connection** (shows version,
cluster health colour, matched index count). macOS: new "Integrations"
tab; desktop: new section in the Preferences modal.

### 5.3 Open in Kibana

(v1, #501: only with a configured Kibana URL; the in-cluster port-forward
below is follow-up #505. The URL is built and opened from Rust, which
accepts http(s) only; the webview has no generic "open URL" permission.)

Discover URL built with `_g=(time:(from:…,to:…))` and a KQL query
`kubernetes.namespace:"ns" and kubernetes.pod.name:"pod"` (field names from
the preset). External Kibana: the configured URL. In-cluster Kibana without a
URL: start a port-forward to the Kibana service through the existing
port-forward feature and open `http(s)://localhost:<port>/app/discover…`.

## 6. Auth (v1)

Security rules (from the security review, 2026-11-03): stored credentials
are bound to the endpoint origin (external scheme + host + port, or the
in-cluster service) and its TLS setting, and are never sent anywhere else;
credentials are refused in the URL and over plain `http://` (except
loopback); the in-cluster tunnel bypasses `HTTP(S)_PROXY`; ECK's `elastic`
user is stored only as a choice and read from the cluster at each
connection.

API key (`Authorization: ApiKey …`, the recommended path for Elastic Cloud
and Elastic on Azure), basic (user/password), bearer token, none (in-cluster
without security). Entra ID / OIDC and AWS SigV4 (OpenSearch on AWS) are
follow-ups. OpenSearch compatibility is a stretch: same `_search` API, no
Kibana link (Dashboards URL differs).

## 7. Structure

- **Core (Rust)**: `crates/cubelite-core/src/elastic.rs` — endpoint types,
  query builder (pure, unit-tested), response → `LogLine` mapping, in-cluster
  transport via a port-forward + `reqwest` (service DNS name resolved to the
  local port, ECK CA trusted), external transport via `reqwest` (rustls) —
  **new dependency**, see decision D.
  Discovery of ES/Kibana services.
- **Desktop (Tauri)**: commands `elastic_detect`, `elastic_test`,
  `elastic_search`, `kibana_url`; secrets via the `keyring` crate (macOS
  Keychain / Windows Credential Manager / Secret Service) — **new
  dependency**; frontend `stores/elastic.svelte.ts`, Live/History control
  in `LogToolbar.svelte`, Preferences section.
- **macOS (Swift)**: `ElasticService` (URLSession for external, and for in-cluster
  through the existing `PortForwardService` with the ECK CA pinned in the
  URLSession delegate), `KeychainService`
  for secrets, History mode in `LogSessionStore`, Integrations tab.
- Same query-builder and mapping test vectors on both sides.

## 8. Tests

- Query builder: filters per preset, workload prefix, container, time range,
  text query escaping, `search_after` paging.
- Mapping: ECS hit, Fluent Bit hit, structured vs plain message, missing
  `@timestamp`.
- Transport: port-forward target resolution (service → ready pod, port), TLS name/CA setup, auth headers,
  error mapping (401, 403, 404 index, timeout) — with a mock HTTP server
  in Rust and `URLProtocol` stubs in Swift.
- UI: Live/History switch keeps the live buffer; Load older; error state;
  Open in Kibana URL; Preferences Test connection states. Playwright with the
  mocked Tauri layer.
- No test hits a real cluster; a manual checklist covers ECK in kind and one
  external endpoint.

## 9. Delivery

Four issues/PRs: (1) core `elastic.rs` + Tauri commands + keyring;
(2) desktop UI (History + Preferences + Kibana); (3) macOS service +
keychain; (4) macOS UI. #483 closes with the last. #484 (Prometheus +
Grafana) reuses the endpoint/credential model from (1) and gets its own
design afterwards.

## 10. Decisions for the user (author's defaults, recommended first)

A. **What CubeLite does with Elasticsearch in v1.** Log *history* in the log
   panel + Open in Kibana + health in Preferences (recommended) — **or**
   only Open in Kibana deep links (tiny, no ES client) — **or** also a
   cluster/index health view (bigger, closer to an admin tool).

B. **Endpoint scope.** Per kube context (recommended) **or** global (one
   Elasticsearch for every cluster).

C. **In-cluster transport** (author's call, revised): port-forward to a
   pod behind the service. The service proxy strips `Authorization`, so it
   only works for unsecured clusters.

D. **New dependencies.** `reqwest` (rustls) in the core for external
   endpoints and `keyring` in the Tauri app for secrets (recommended; both
   widely used, audited by `cargo audit` in CI) — **or** hand-rolled HTTP on
   `hyper` and credentials only via environment/kubeconfig-style files.

E. **Workload history.** v1 = pod only (recommended, simplest filter) **or**
   pod + deployment/statefulset (prefix query on pod names).
