//! Prometheus history charts, list sparklines and Grafana links (#484, #509).
//!
//! Endpoints (no secrets) live in the frontend's settings; credentials live
//! in the OS keychain under service `cubelite.prometheus`, account = kube
//! context, bound to the endpoint they were saved for, and never travel
//! back to the frontend. Azure CLI tokens are fetched when connecting and
//! never stored.

use cubelite_core::integration;
use cubelite_core::prometheus::transport::{self, DetectedPrometheus, PromConnection, PromInfo};
use cubelite_core::prometheus::{
    grafana_explore_url, metrics_queries, Chart, GrafanaService, MetricsRange, MetricsRequest,
    MetricsResult, PromAuth, PromEndpoint, PromError, PromTarget, Sparklines, Workload,
};
use tauri::State;

use super::cache::{ConnCache, ConnKey, ServiceForwards};
use super::elastic::kube;
use super::vault::{self, blocking as keychain};
use super::web_ui::{http_base, open_in_browser};

const KEYCHAIN_SERVICE: &str = "cubelite.prometheus";

/// Open connections per (kubeconfig, context), and the port-forwards to
/// in-cluster Grafanas (#525).
#[derive(Default)]
pub struct PrometheusState {
    connections: ConnCache<PromEndpoint, PromConnection>,
    grafana: ServiceForwards,
}

impl PrometheusState {
    /// Closes the context's connections and Grafana forwards (credentials
    /// saved, disconnect).
    async fn forget(&self, context: &str) {
        self.connections.forget(context).await;
        self.grafana.forget(context).await;
    }
}

fn binding(endpoint: &PromEndpoint) -> Result<String, String> {
    integration::binding(&endpoint.target, endpoint.skip_tls_verify)
}

fn load_auth(context: &str, endpoint: &PromEndpoint) -> Result<PromAuth, String> {
    vault::load(
        KEYCHAIN_SERVICE,
        context,
        &binding(endpoint)?,
        PromAuth::None,
    )
}

fn store_auth(context: &str, endpoint: &PromEndpoint, auth: &PromAuth) -> Result<(), String> {
    let record = match auth {
        PromAuth::None => None,
        _ => Some(vault::Stored {
            binding: binding(endpoint)?,
            auth: auth.clone(),
        }),
    };
    vault::write(KEYCHAIN_SERVICE, context, record.as_ref())
}

/// A dead tunnel or network change, or rejected credentials (an expired
/// Azure token): the next call connects again.
fn must_reconnect<T>(result: &Result<T, PromError>) -> bool {
    matches!(
        result,
        Err(PromError::Connect(_)
            | PromError::Http {
                status: 401 | 403,
                ..
            })
    )
}

fn text(e: PromError) -> String {
    e.to_string()
}

async fn open(
    kubeconfig_path: &str,
    context: &str,
    endpoint: &PromEndpoint,
    auth: &PromAuth,
) -> Result<PromConnection, String> {
    let client = match endpoint.target {
        PromTarget::InCluster { .. } => Some(kube(kubeconfig_path, context).await?.client()),
        PromTarget::External { .. } => None,
    };
    transport::connect(client, endpoint, auth)
        .await
        .map_err(text)
}

/// The cached connection for `endpoint`, with the stored credentials.
async fn connection(
    state: &PrometheusState,
    key: &ConnKey,
    endpoint: &PromEndpoint,
) -> Result<std::sync::Arc<PromConnection>, String> {
    let (kubeconfig_path, context) = key;
    state
        .connections
        .get_or_connect(key, endpoint, || async {
            let (c, e) = (context.clone(), endpoint.clone());
            let auth = keychain(move || load_auth(&c, &e)).await?;
            open(kubeconfig_path, context, endpoint, &auth).await
        })
        .await
}

/// Prometheus services the user can see in the cluster.
#[tauri::command]
pub async fn prometheus_detect(
    kubeconfig_path: String,
    context: String,
) -> Result<Vec<DetectedPrometheus>, String> {
    transport::detect(kube(&kubeconfig_path, &context).await?.client())
        .await
        .map_err(text)
}

/// Connects once and reports version, exporters and `cluster` values.
/// `auth` tests credentials before saving them; `None` uses the stored ones
/// (only when they were saved for this endpoint).
#[tauri::command]
pub async fn prometheus_test(
    kubeconfig_path: String,
    context: String,
    endpoint: PromEndpoint,
    auth: Option<PromAuth>,
) -> Result<PromInfo, String> {
    let auth = match auth {
        Some(a) => a,
        None => {
            let (c, e) = (context.clone(), endpoint.clone());
            keychain(move || load_auth(&c, &e)).await?
        }
    };
    let conn = open(&kubeconfig_path, &context, &endpoint, &auth).await?;
    conn.info(&endpoint).await.map_err(text)
}

/// The Metrics section of a pod or deployment.
#[tauri::command]
pub async fn prometheus_metrics(
    state: State<'_, PrometheusState>,
    kubeconfig_path: String,
    context: String,
    endpoint: PromEndpoint,
    request: MetricsRequest,
) -> Result<MetricsResult, String> {
    let key: ConnKey = (kubeconfig_path, context);
    let conn = connection(&state, &key, &endpoint).await?;
    let result = conn.metrics(&endpoint, &request).await;
    if must_reconnect(&result) {
        state.connections.invalidate(&key, &conn).await;
    }
    result.map_err(text)
}

/// Last hour of CPU and memory per pod of `namespace` (every namespace when
/// `None`), keyed `namespace/pod` (list sparklines).
#[tauri::command]
pub async fn prometheus_sparklines(
    state: State<'_, PrometheusState>,
    kubeconfig_path: String,
    context: String,
    endpoint: PromEndpoint,
    namespace: Option<String>,
) -> Result<Sparklines, String> {
    let key: ConnKey = (kubeconfig_path, context);
    let conn = connection(&state, &key, &endpoint).await?;
    let result = conn.sparklines(&endpoint, namespace.as_deref()).await;
    if must_reconnect(&result) {
        state.connections.invalidate(&key, &conn).await;
    }
    result.map_err(text)
}

/// Saves `auth` for `context` in the keychain, bound to `endpoint`
/// (`none` deletes it), and drops the cached connections.
#[tauri::command]
pub async fn prometheus_save_auth(
    state: State<'_, PrometheusState>,
    context: String,
    endpoint: PromEndpoint,
    auth: PromAuth,
) -> Result<(), String> {
    if let PromTarget::External { url } = &endpoint.target {
        if auth != PromAuth::None {
            integration::check_external_url(url, true)?;
        }
    }
    let c = context.clone();
    keychain(move || store_auth(&c, &endpoint, &auth)).await?;
    state.forget(&context).await;
    Ok(())
}

/// The auth method stored for `endpoint`, never the secret; `none` when the
/// stored one belongs to another endpoint.
#[tauri::command]
pub async fn prometheus_auth_method(
    context: String,
    endpoint: PromEndpoint,
) -> Result<String, String> {
    let current = binding(&endpoint)?;
    let stored = keychain(move || vault::read::<PromAuth>(KEYCHAIN_SERVICE, &context)).await?;
    Ok(match stored {
        Some(stored) if stored.binding == current => stored.auth.method(),
        _ => PromAuth::None.method(),
    }
    .to_string())
}

/// Closes the cached connections of `context` (their port-forwards too)
/// and its Grafana forwards.
#[tauri::command]
pub async fn prometheus_disconnect(
    state: State<'_, PrometheusState>,
    context: String,
) -> Result<(), String> {
    state.forget(&context).await;
    Ok(())
}

/// Port-forward to an in-cluster Grafana (#525), reused while its pod is ready.
#[tauri::command]
pub async fn grafana_port_forward(
    state: State<'_, PrometheusState>,
    kubeconfig_path: String,
    context: String,
    service: GrafanaService,
) -> Result<u16, String> {
    state.grafana.port(kubeconfig_path, context, service).await
}

/// Grafana Explore URL for `queries` over the last `range`.
fn explore_url(
    grafana_url: &str,
    datasource: Option<&str>,
    queries: &[String],
    range: MetricsRange,
) -> Result<String, String> {
    let mut base = http_base(grafana_url, "Grafana")?;
    base.set_query(None);
    base.set_fragment(None);
    Ok(grafana_explore_url(
        base.as_str(),
        datasource,
        queries,
        range.grafana_from(),
        "now",
    ))
}

/// The CPU chart's query for a workload, per container (#526).
fn workload_cpu_query(
    namespace: String,
    workload: Workload,
    cluster: Option<&str>,
    range: MetricsRange,
) -> Vec<String> {
    let request = MetricsRequest {
        namespace,
        workload,
        range,
        per_container: true,
    };
    metrics_queries(&request, cluster)
        .into_iter()
        .filter(|(chart, _)| *chart == Chart::Cpu)
        .map(|(_, query)| query)
        .collect()
}

/// Opens Grafana Explore with `queries` in the default browser (the URL is
/// built here, see `web_ui`).
#[tauri::command]
pub fn open_grafana_explore(
    app: tauri::AppHandle,
    grafana_url: String,
    datasource: Option<String>,
    queries: Vec<String>,
    range: MetricsRange,
) -> Result<(), String> {
    let target = explore_url(&grafana_url, datasource.as_deref(), &queries, range)?;
    open_in_browser(&app, target)
}

/// Opens Grafana Explore with a workload's CPU query, without loading its
/// metrics first (detail header link, #526).
#[tauri::command]
pub fn open_grafana_workload(
    app: tauri::AppHandle,
    grafana_url: String,
    datasource: Option<String>,
    cluster: Option<String>,
    namespace: String,
    workload: Workload,
    range: MetricsRange,
) -> Result<(), String> {
    let queries = workload_cpu_query(namespace, workload, cluster.as_deref(), range);
    let target = explore_url(&grafana_url, datasource.as_deref(), &queries, range)?;
    open_in_browser(&app, target)
}

/// Opens Grafana's home page (#526).
#[tauri::command]
pub fn open_grafana_home(app: tauri::AppHandle, grafana_url: String) -> Result<(), String> {
    let base = http_base(&grafana_url, "Grafana")?;
    open_in_browser(&app, base.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workload_cpu_query_selects_the_workload() {
        let queries = workload_cpu_query(
            "shop".into(),
            Workload::Deployment { name: "api".into() },
            Some("eu"),
            MetricsRange::Hour,
        );
        assert_eq!(queries.len(), 1);
        let q = &queries[0];
        assert!(q.starts_with("sum by (container) (rate(container_cpu_usage_seconds_total{"));
        assert!(q.contains(r#"namespace="shop""#), "{q}");
        assert!(q.contains("pod=~\"api-"), "{q}");
        assert!(q.contains(r#"cluster="eu""#), "{q}");
    }

    #[test]
    fn explore_url_accepts_http_only() {
        let url = explore_url(
            "https://grafana.example",
            None,
            &["up".into()],
            MetricsRange::Hour,
        )
        .expect("url");
        assert!(url.starts_with("https://grafana.example/explore?"));
        assert!(explore_url("javascript:alert(1)", None, &[], MetricsRange::Hour).is_err());
        assert!(explore_url("not a url", None, &[], MetricsRange::Hour).is_err());
    }
}
