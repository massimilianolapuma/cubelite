# Integrations: detect on connect, enable in one click — design

Date: 2026-11-03 · Issue: #527 · Owners: desktop-agent, macos-agent · Status: approved by the user on 2026-11-03 as part of the integration improvements batch. The author's defaults below are marked.

## 1. Why

Turning on Elasticsearch or Prometheus history takes six or seven steps in Preferences:

1. In cluster
2. Detect
3. Use
4. Use (Kibana / Grafana)
5. auth method
6. Save

Nothing tells the user the feature exists. The services are usually already in the cluster: ECK, kube-prometheus-stack, a Helm chart. CubeLite can find them by itself and offer to switch them on.

## 2. Behaviour

- **When.** After a context connects and its first resource load succeeds, CubeLite lists the services once, in the background. The list is shared by both integrations: one `GET /api/v1/services` across namespaces, classified by the existing Elasticsearch and Prometheus classifiers.
  - Detection runs again only after a reconnect or a Preferences change, never on every refresh.
  - If listing services across namespaces is forbidden (RBAC), detection gives up silently.
- **What it offers.** For each integration that is not configured in this context (and was not dismissed):
  - **Elasticsearch:** the first Elasticsearch service, preferring ECK `*-es-http`, plus the first Kibana service.
    - **Auth:** "ECK elastic user" when the service is ECK and its `{cluster}-es-elastic-user` secret is readable. Otherwise none, and the user is told credentials may be needed.
  - **Prometheus:** `prometheus-operated` when present, else the first Prometheus service, plus the first Grafana service.
- **Where.** A slim, dismissible banner at the top of the content area: "Elasticsearch and Prometheus found in this cluster — Enable · Review · ✕".
  - **Enable** saves the in-cluster endpoints with those defaults. Prometheus is first checked with Test connection; Elasticsearch is checked with Test plus the ECK choice. A short toast reports each result.
  - **Review** opens Preferences on the integration, pre-filled but not saved.
  - **✕** hides the banner for that context and integration. It is remembered per context in settings, and Preferences can clear it.
- **Failure.** If Test fails, nothing is saved. The banner switches to "Couldn't connect to Elasticsearch: <reason> — Review".
- **Never.**
  - No banner when the integration is already configured: a URL or in-cluster target exists for the context.
  - No traffic to Elasticsearch or Prometheus before the user clicks.
  - No secrets read before the user clicks: the ECK secret is read only on Enable.

## 3. Structure

- **Core:** `integration::detect_all(client) -> Detected { elasticsearch, kibana, prometheus, grafana }`. It reuses the existing classifiers; the Tauri command is `integrations_detect`.
- **Desktop:**
  - `stores/integrations.svelte.ts` holds the per-context detection result, the dismissals (persisted) and `enable(kind)`. `enable` reuses the preferences save logic in `integration.ts`.
  - `components/IntegrationsBanner.svelte` is rendered by the shell above the content.
- **macOS:**
  - `IntegrationsSuggestionStore`: `@Observable`, injected into the main window.
  - `IntegrationsBannerView` sits in `MainView` above the detail area.
  - Enable reuses `ElasticPreferencesModel` / `PrometheusPreferencesModel`: draft, then `save`.
- **Desktop and macOS** share the same defaults and the same copy.

## 4. Author's calls

- The banner appears once per connect. A dismissal is permanent per context and integration until Preferences resets it.
- Elasticsearch's index pattern stays the default `logs-*,filebeat-*,logstash-*`, with the ECS preset. Fluent Bit is not detected in v1.
- With several matching services, the first by namespace and name is picked, and "Review" is the escape hatch.

## 5. Tests

- **Core:** `detect_all` classification across a mixed service list.
- **Desktop and macOS models:**
  - no banner when configured, dismissed, or when nothing is found;
  - Enable saves the expected endpoints and auth, and a failed Test saves nothing;
  - dismissals persist.
- **Desktop UI:** a Playwright test for banner → Enable with the mocked Tauri layer.
- **Live:** against minikube with ECK and kube-prometheus-stack, the banner finds all four services.

## 6. Decisions after review (2026-11-04)

These supersede §2 and §4 where they differ.

- **Service spoofing (security review, MEDIUM).** In a shared cluster, anyone allowed to create Services in their own namespace can name one `foo-es-http` or `prometheus-operated`, and a one-click Enable would then show their "history" or metrics. ECK credentials stay safe (the secret is read from the service's namespace), but the data would be fake. Labels and owner references are user-settable too, and a fake reference to a resource whose CRD is not installed is never garbage-collected. A look-alike Kibana or Grafana would also put an attacker's login page on localhost through "Open Grafana". So (second review, which replaces label-based trust):
  - **Trust = a verified owner, nothing else.** The Service has an owner reference of kind `Elasticsearch` in API group `elasticsearch.k8s.elastic.co`, or `Prometheus` in `monitoring.coreos.com`, and that resource resolves: `GET /apis/elasticsearch.k8s.elastic.co/v1/namespaces/{ns}/elasticsearches/{name}` (or `/apis/monitoring.coreos.com/v1/namespaces/{ns}/prometheuses/{name}`) succeeds and its `metadata.uid` equals the reference's uid. 403, 404 or any other error means not trusted, silently.
    - This is Kubernetes API traffic only (no secrets, nothing to Elasticsearch or Prometheus), sent at detection time like the services list.
    - Only the best claimed candidates are checked, at most 3 per integration, so a flood of fake claims cannot make detection send many requests.
  - **Labels and names only rank.** Verified first, then the well-known namespaces `logging`, `elastic-system`, `monitoring`, `observability`, then the conventional name (`-es-http`, `prometheus-operated`), then namespace and name.
  - **Verified per integration:** a Service verified for the Elasticsearch rule never counts as a verified Prometheus, and vice versa.
  - **One-click Enable** requires all of the following. Otherwise the banner offers Review only, which pre-fills the best guess and lists every candidate. Enable also refuses in the model, not only in the UI.
    - The best candidate is verified.
    - Its owner reference is a controller reference (`controller: true`).
    - Its own selector names that instance: `elasticsearch.k8s.elastic.co/cluster-name` for ECK, or `operator.prometheus.io/name` or `prometheus` for Prometheus, equal to the owner's name.
    - It is the only Elasticsearch (or Prometheus) candidate in the cluster, trusted or not. The one exception is a Service in the same namespace whose selector names the same instance by those labels: it is the same server, not a second candidate. Claiming the same owner is not enough. Creating such a Service needs write access to the operator's namespace.
  - **Checked live on minikube with kubectl (2026-11-04):**
    - ECK's `quickstart-es-http` has a controller reference to Elasticsearch `quickstart` and selects `elasticsearch.k8s.elastic.co/cluster-name=quickstart`, so Elasticsearch is one-click.
    - kube-prometheus-stack's `prometheus-operated` is the operator's governing Service. Its owner reference to Prometheus `kps-kube-prometheus-stack-prometheus` has no `controller` field, and it selects only `app.kubernetes.io/name=prometheus`, which matches every Prometheus in the namespace. `kps-kube-prometheus-stack-prometheus` has no owner reference at all. So Prometheus from kube-prometheus-stack is **Review only**, which is accepted: Review pre-fills `prometheus-operated`, and saving takes one more click.
  - Kibana and Grafana are taken only from the namespace of the service they go with.
  - **Banner text** always names what Enable would use: "Elasticsearch found (logging/quickstart-es-http) and Prometheus (monitoring/prometheus-operated) — Enable · Review · ✕".
- **Turning an integration off** in Preferences records it as dismissed for that context, so the banner does not offer it again; "Suggest detected integrations again" clears it.
- **Prometheus without cAdvisor series:** Enable still saves it, and reports a warning, "Prometheus enabled for <context> — no container metrics (cAdvisor) found yet".
