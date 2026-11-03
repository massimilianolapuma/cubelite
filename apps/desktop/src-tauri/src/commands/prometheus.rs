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
    grafana_explore_url, MetricsRange, MetricsRequest, MetricsResult, PromAuth, PromEndpoint,
    PromError, PromTarget, Sparklines,
};
use tauri::State;

use super::cache::{ConnCache, ConnKey};
use super::elastic::kube;
use super::vault::{self, blocking as keychain};

const KEYCHAIN_SERVICE: &str = "cubelite.prometheus";

/// Open connections per (kubeconfig, context).
#[derive(Default)]
pub struct PrometheusState {
    connections: ConnCache<PromEndpoint, PromConnection>,
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

/// Last hour of CPU and memory per pod of `namespace` (list sparklines).
#[tauri::command]
pub async fn prometheus_sparklines(
    state: State<'_, PrometheusState>,
    kubeconfig_path: String,
    context: String,
    endpoint: PromEndpoint,
    namespace: String,
) -> Result<Sparklines, String> {
    let key: ConnKey = (kubeconfig_path, context);
    let conn = connection(&state, &key, &endpoint).await?;
    let result = conn.sparklines(&endpoint, &namespace).await;
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
    state.connections.forget(&context).await;
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

/// Closes the cached connections of `context` (their port-forwards too).
#[tauri::command]
pub async fn prometheus_disconnect(
    state: State<'_, PrometheusState>,
    context: String,
) -> Result<(), String> {
    state.connections.forget(&context).await;
    Ok(())
}

/// Grafana Explore URL for `queries` over the last `range`.
fn explore_url(
    grafana_url: &str,
    datasource: Option<&str>,
    queries: &[String],
    range: MetricsRange,
) -> Result<String, String> {
    let mut base =
        url::Url::parse(grafana_url.trim()).map_err(|e| format!("Invalid Grafana URL: {e}"))?;
    base.set_query(None);
    base.set_fragment(None);
    if !matches!(base.scheme(), "http" | "https") {
        return Err("Grafana URL must start with http:// or https://".to_string());
    }
    Ok(grafana_explore_url(
        base.as_str(),
        datasource,
        queries,
        range.grafana_from(),
        "now",
    ))
}

/// Opens Grafana Explore with `queries` in the default browser. The URL is
/// built here and must be http(s), so the webview cannot open other schemes
/// through this command (same accepted risk as Open in Kibana).
#[tauri::command]
pub fn open_grafana_explore(
    app: tauri::AppHandle,
    grafana_url: String,
    datasource: Option<String>,
    queries: Vec<String>,
    range: MetricsRange,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let target = explore_url(&grafana_url, datasource.as_deref(), &queries, range)?;
    app.opener()
        .open_url(target, None::<&str>)
        .map_err(|e| format!("Cannot open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
