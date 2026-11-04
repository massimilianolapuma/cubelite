//! Elasticsearch log history and Kibana links (#483, #500).
//!
//! Endpoints (no secrets) live in the frontend's settings; credentials live
//! in the OS keychain under service `cubelite.elastic`, account = kube
//! context, bound to the endpoint they were saved for, and never travel
//! back to the frontend.

use cubelite_core::elastic::transport::{self, DetectedService, EsConnection, EsInfo};
use cubelite_core::elastic::{
    kibana_deployment_discover_url, kibana_discover_home, kibana_discover_url as discover_url,
    ElasticError, EsAuth, EsEndpoint, EsTarget, FieldPreset, HistoryCursor, HistoryPage,
    HistoryQuery, KibanaService,
};

use cubelite_core::integration;
use cubelite_core::KubeClient;

use super::vault;
use super::web_ui::{http_base, open_in_browser};
use tauri::State;

use super::cache::{ConnCache, ConnKey, ServiceForwards};

const KEYCHAIN_SERVICE: &str = "cubelite.elastic";

/// Open connections per (kubeconfig, context), and the port-forwards to
/// in-cluster Kibanas (#505).
#[derive(Default)]
pub struct ElasticState {
    connections: ConnCache<EsEndpoint, EsConnection>,
    kibana: ServiceForwards,
}

impl ElasticState {
    /// Closes the context's connections and Kibana forwards (endpoint
    /// saved, credentials changed, disconnect).
    async fn forget(&self, context: &str, every_context: bool) {
        if every_context {
            // The default's credentials changed (#528).
            self.connections.clear().await;
        } else {
            self.connections.forget(context).await;
        }
        self.kibana.forget(context).await;
    }
}

fn binding(endpoint: &EsEndpoint) -> Result<String, String> {
    integration::check_shared(&endpoint.target, endpoint.shared)?;
    integration::binding(&endpoint.target, endpoint.skip_tls_verify)
}

/// Credentials stored for `context` (or the default, #528), usable only
/// with `endpoint`; `EsAuth::None` when nothing is stored.
fn load_auth(context: &str, endpoint: &EsEndpoint) -> Result<EsAuth, String> {
    let binding = binding(endpoint)?;
    vault::load(
        KEYCHAIN_SERVICE,
        context,
        endpoint.shared,
        &binding,
        EsAuth::None,
    )
}

fn store_auth(context: &str, endpoint: &EsEndpoint, auth: &EsAuth) -> Result<(), String> {
    let record = match auth {
        EsAuth::None => None,
        _ => Some(vault::Stored {
            binding: binding(endpoint)?,
            auth: auth.clone(),
        }),
    };
    let account = vault::account(context, endpoint.shared);
    vault::write(KEYCHAIN_SERVICE, account, record.as_ref())
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

/// Closes the point in time of a history cursor (#531) when its search is
/// replaced or closed. Best effort and never an error: only a cached
/// connection is used (none means the PIT's tunnel is gone, and the PIT
/// expires on its own).
#[tauri::command]
pub async fn elastic_close_cursor(
    state: State<'_, ElasticState>,
    kubeconfig_path: String,
    context: String,
    endpoint: EsEndpoint,
    cursor: HistoryCursor,
) -> Result<(), String> {
    let key: ConnKey = (kubeconfig_path, context);
    let cached = state
        .connections
        .get_or_connect(&key, &endpoint, || async {
            Err("not connected".to_string())
        })
        .await;
    if let Ok(conn) = cached {
        conn.close_cursor(&cursor).await;
    }
    Ok(())
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
    let shared = endpoint.shared;
    keychain(move || store_auth(&c, &endpoint, &auth)).await?;
    state.forget(&context, shared).await;
    Ok(())
}

/// The auth method stored for `endpoint` (`none`, `basic`, `api-key`,
/// `bearer`, `eck-user`), never the secret; `none` when the stored one
/// belongs to another endpoint.
#[tauri::command]
pub async fn elastic_auth_method(context: String, endpoint: EsEndpoint) -> Result<String, String> {
    let current = binding(&endpoint)?;
    let stored = keychain(move || {
        vault::stored::<EsAuth>(KEYCHAIN_SERVICE, &context, endpoint.shared, &current)
    })
    .await?;
    Ok(stored.as_ref().map_or("none", method).to_string())
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
    state.forget(&context, false).await;
    Ok(method(&EsAuth::EckUser).to_string())
}

/// Closes the cached connections of `context` (their port-forwards too).
#[tauri::command]
pub async fn elastic_disconnect(
    state: State<'_, ElasticState>,
    context: String,
) -> Result<(), String> {
    state.forget(&context, false).await;
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
    state.kibana.port(kubeconfig_path, context, service).await
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

/// Opens Kibana Discover for a pod's logs in the default browser (the URL
/// is built here, see `web_ui`).
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
    let base = http_base(&kibana_url, "Kibana")?;
    let target = discover_url(
        base.as_str(),
        preset,
        &namespace,
        &pod,
        container.as_deref(),
        &from,
        &to,
    );
    open_in_browser(&app, target)
}

/// Opens Kibana Discover for a deployment's pods (#526).
#[tauri::command]
pub fn open_kibana_deployment(
    app: tauri::AppHandle,
    kibana_url: String,
    preset: FieldPreset,
    namespace: String,
    deployment: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let base = http_base(&kibana_url, "Kibana")?;
    let target =
        kibana_deployment_discover_url(base.as_str(), preset, &namespace, &deployment, &from, &to);
    open_in_browser(&app, target)
}

/// Opens Kibana Discover without a filter (#526).
#[tauri::command]
pub fn open_kibana_home(app: tauri::AppHandle, kibana_url: String) -> Result<(), String> {
    let base = http_base(&kibana_url, "Kibana")?;
    open_in_browser(&app, kibana_discover_home(base.as_str()))
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
