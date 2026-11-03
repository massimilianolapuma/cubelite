//! Elasticsearch log history and Kibana links (#483, #500).
//!
//! Endpoints (no secrets) live in the frontend's settings; credentials live
//! in the OS keychain under service `cubelite.elastic`, account = kube
//! context, bound to the endpoint they were saved for, and never travel
//! back to the frontend.

use cubelite_core::elastic::transport::{self, DetectedService, EsConnection, EsInfo};
use cubelite_core::elastic::{
    kibana_discover_url as discover_url, ElasticError, EsAuth, EsEndpoint, EsTarget, FieldPreset,
    HistoryPage, HistoryQuery, KibanaService,
};
use std::collections::HashMap;

use cubelite_core::integration;
use cubelite_core::KubeClient;

use super::vault;
use tauri::State;

use super::cache::{ConnCache, ConnKey};

const KEYCHAIN_SERVICE: &str = "cubelite.elastic";

/// Kibana forwards per (kubeconfig, context, service); stopped on drop.
type KibanaForwards = HashMap<(String, String, KibanaService), integration::ServiceTunnel>;

/// Open connections per (kubeconfig, context), and the port-forwards to
/// in-cluster Kibanas (#505).
#[derive(Default)]
pub struct ElasticState {
    connections: ConnCache<EsEndpoint, EsConnection>,
    kibana: tokio::sync::Mutex<KibanaForwards>,
}

impl ElasticState {
    /// Closes the context's connections and Kibana forwards (endpoint
    /// saved, credentials changed, disconnect).
    async fn forget(&self, context: &str) {
        self.connections.forget(context).await;
        self.kibana.lock().await.retain(|(_, c, _), _| c != context);
    }
}

fn binding(endpoint: &EsEndpoint) -> Result<String, String> {
    integration::binding(&endpoint.target, endpoint.skip_tls_verify)
}

/// Credentials stored for `context`, usable only with `endpoint`;
/// `EsAuth::None` when nothing is stored.
fn load_auth(context: &str, endpoint: &EsEndpoint) -> Result<EsAuth, String> {
    vault::load(KEYCHAIN_SERVICE, context, &binding(endpoint)?, EsAuth::None)
}

fn store_auth(context: &str, endpoint: &EsEndpoint, auth: &EsAuth) -> Result<(), String> {
    let record = match auth {
        EsAuth::None => None,
        _ => Some(vault::Stored {
            binding: binding(endpoint)?,
            auth: auth.clone(),
        }),
    };
    vault::write(KEYCHAIN_SERVICE, context, record.as_ref())
}

fn method(auth: &EsAuth) -> &'static str {
    match auth {
        EsAuth::None => "none",
        EsAuth::Basic { .. } => "basic",
        EsAuth::ApiKey { .. } => "api-key",
        EsAuth::Bearer { .. } => "bearer",
        EsAuth::EckUser => "eck-user",
    }
}

use vault::blocking as keychain;

fn text(e: ElasticError) -> String {
    e.to_string()
}

pub(crate) async fn kube(kubeconfig_path: &str, context: &str) -> Result<KubeClient, String> {
    KubeClient::new(kubeconfig_path, Some(context))
        .await
        .map_err(|e| e.to_string())
}

async fn open(
    kubeconfig_path: &str,
    context: &str,
    endpoint: &EsEndpoint,
    auth: &EsAuth,
) -> Result<EsConnection, String> {
    let client = match endpoint.target {
        EsTarget::InCluster { .. } => Some(kube(kubeconfig_path, context).await?.client()),
        EsTarget::External { .. } => None,
    };
    transport::connect(client, endpoint, auth)
        .await
        .map_err(text)
}

/// Elasticsearch and Kibana services the user can see in the cluster.
#[tauri::command]
pub async fn elastic_detect(
    kubeconfig_path: String,
    context: String,
) -> Result<Vec<DetectedService>, String> {
    transport::detect(kube(&kubeconfig_path, &context).await?.client())
        .await
        .map_err(text)
}

/// Connects once and reports version, health and matching indices.
/// `auth` tests credentials before saving them; `None` uses the stored ones
/// (only when they were saved for this endpoint).
#[tauri::command]
pub async fn elastic_test(
    kubeconfig_path: String,
    context: String,
    endpoint: EsEndpoint,
    auth: Option<EsAuth>,
) -> Result<EsInfo, String> {
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

/// One page of a pod's history, through a cached connection.
///
/// The cache lock is never held while connecting (port-forward, kube API
/// calls, keychain), so one slow cluster cannot block other contexts.
#[tauri::command]
pub async fn elastic_search(
    state: State<'_, ElasticState>,
    kubeconfig_path: String,
    context: String,
    endpoint: EsEndpoint,
    query: HistoryQuery,
) -> Result<HistoryPage, String> {
    let key: ConnKey = (kubeconfig_path.clone(), context.clone());
    let conn = state
        .connections
        .get_or_connect(&key, &endpoint, || async {
            let (c, e) = (context.clone(), endpoint.clone());
            let auth = keychain(move || load_auth(&c, &e)).await?;
            open(&kubeconfig_path, &context, &endpoint, &auth).await
        })
        .await?;
    let result = conn.search(&endpoint, &query).await;
    if let Err(ElasticError::Connect(_)) = &result {
        state.connections.invalidate(&key, &conn).await;
    }
    result.map_err(text)
}

/// Saves `auth` for `context` in the keychain, bound to `endpoint`
/// (`none` deletes it), and drops the cached connections.
#[tauri::command]
pub async fn elastic_save_auth(
    state: State<'_, ElasticState>,
    context: String,
    endpoint: EsEndpoint,
    auth: EsAuth,
) -> Result<(), String> {
    let c = context.clone();
    keychain(move || store_auth(&c, &endpoint, &auth)).await?;
    state.forget(&context).await;
    Ok(())
}

/// The auth method stored for `endpoint` (`none`, `basic`, `api-key`,
/// `bearer`, `eck-user`), never the secret; `none` when the stored one
/// belongs to another endpoint.
#[tauri::command]
pub async fn elastic_auth_method(context: String, endpoint: EsEndpoint) -> Result<String, String> {
    let current = binding(&endpoint)?;
    let stored = keychain(move || vault::read::<EsAuth>(KEYCHAIN_SERVICE, &context)).await?;
    Ok(match stored {
        Some(stored) if stored.binding == current => method(&stored.auth),
        _ => "none",
    }
    .to_string())
}

/// Uses ECK's `elastic` user for this in-cluster endpoint: checks it can be
/// read now, then stores only the choice (`eck-user`). The password is read
/// from the cluster at each connection, never stored, so rotations work.
#[tauri::command]
pub async fn elastic_use_eck_credentials(
    state: State<'_, ElasticState>,
    kubeconfig_path: String,
    context: String,
    endpoint: EsEndpoint,
) -> Result<String, String> {
    let EsTarget::InCluster {
        namespace, service, ..
    } = &endpoint.target
    else {
        return Err("ECK credentials apply to in-cluster endpoints only".to_string());
    };
    transport::eck_credentials(
        kube(&kubeconfig_path, &context).await?.client(),
        namespace,
        service,
    )
    .await
    .map_err(text)?;
    let c = context.clone();
    keychain(move || store_auth(&c, &endpoint, &EsAuth::EckUser)).await?;
    state.forget(&context).await;
    Ok(method(&EsAuth::EckUser).to_string())
}

/// Closes the cached connections of `context` (their port-forwards too).
#[tauri::command]
pub async fn elastic_disconnect(
    state: State<'_, ElasticState>,
    context: String,
) -> Result<(), String> {
    state.forget(&context).await;
    Ok(())
}

/// Port-forward to an in-cluster Kibana (#505), reused while its pod is ready.
#[tauri::command]
pub async fn kibana_port_forward(
    state: State<'_, ElasticState>,
    kubeconfig_path: String,
    context: String,
    service: KibanaService,
) -> Result<u16, String> {
    integration::check_target(&EsTarget::InCluster {
        namespace: service.namespace.clone(),
        service: service.service.clone(),
        port: service.port,
        https: service.https,
    })?;
    let client = kube(&kubeconfig_path, &context).await?.client();
    // Held while connecting: a double click or a second window waits for
    // the first forward instead of starting another one.
    let mut forwards = state.kibana.lock().await;
    let key = (kubeconfig_path, context, service.clone());
    if let Some(tunnel) = forwards.get(&key) {
        if tunnel.is_running()
            && integration::pod_ready(&client, &service.namespace, &tunnel.pod).await
        {
            return Ok(tunnel.local_port);
        }
        // The pod was replaced (rollout, eviction): forward to a new one.
        forwards.remove(&key);
    }
    let tunnel = integration::open_service_tunnel(
        &client,
        &service.namespace,
        &service.service,
        service.port,
    )
    .await
    .map_err(|e| match e {
        integration::TunnelError::Config(t) | integration::TunnelError::Connect(t) => t,
    })?;
    let port = tunnel.local_port;
    forwards.insert(key, tunnel);
    Ok(port)
}

/// Kibana Discover URL for a pod's logs.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn kibana_discover_url(
    kibana_url: String,
    preset: FieldPreset,
    namespace: String,
    pod: String,
    container: Option<String>,
    from: String,
    to: String,
) -> String {
    discover_url(
        &kibana_url,
        preset,
        &namespace,
        &pod,
        container.as_deref(),
        &from,
        &to,
    )
}

/// Opens Kibana Discover for a pod's logs in the default browser. The URL
/// is built here and must be http(s), so the webview cannot open other
/// schemes through this command. Accepted risk: the Kibana base comes from
/// the frontend's settings, so a compromised webview could open any http(s)
/// page in the browser; it could already show any page inside the app.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn open_kibana_discover(
    app: tauri::AppHandle,
    kibana_url: String,
    preset: FieldPreset,
    namespace: String,
    pod: String,
    container: Option<String>,
    from: String,
    to: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let base =
        url::Url::parse(kibana_url.trim()).map_err(|e| format!("Invalid Kibana URL: {e}"))?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err("Kibana URL must start with http:// or https://".to_string());
    }
    let target = discover_url(
        base.as_str(),
        preset,
        &namespace,
        &pod,
        container.as_deref(),
        &from,
        &to,
    );
    app.opener()
        .open_url(target, None::<&str>)
        .map_err(|e| format!("Cannot open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn method_names_match_the_auth_tags() {
        for auth in [
            EsAuth::None,
            EsAuth::Basic {
                username: "u".into(),
                password: "p".into(),
            },
            EsAuth::ApiKey { key: "k".into() },
            EsAuth::Bearer { token: "t".into() },
            EsAuth::EckUser,
        ] {
            let tag = serde_json::to_value(&auth).expect("json")["method"]
                .as_str()
                .map(str::to_owned);
            assert_eq!(tag.as_deref(), Some(method(&auth)));
        }
    }
}
