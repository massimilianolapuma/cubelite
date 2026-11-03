//! Elasticsearch log history and Kibana links (#483, #500).
//!
//! Endpoints (no secrets) live in the frontend's settings; credentials live
//! in the OS keychain under service `cubelite.elastic`, account = kube
//! context, and never travel back to the frontend.

use std::collections::HashMap;
use std::sync::Arc;

use cubelite_core::elastic::transport::{self, DetectedService, EsConnection, EsInfo};
use cubelite_core::elastic::{
    kibana_discover_url as discover_url, ElasticError, EsAuth, EsEndpoint, FieldPreset,
    HistoryPage, HistoryQuery,
};
use cubelite_core::KubeClient;
use tauri::State;
use tokio::sync::Mutex;

const KEYCHAIN_SERVICE: &str = "cubelite.elastic";

/// Open connections per context, reused while the endpoint is unchanged
/// (an in-cluster connection holds a port-forward).
#[derive(Default)]
pub struct ElasticState {
    connections: Mutex<HashMap<String, (EsEndpoint, Arc<EsConnection>)>>,
}

fn entry(context: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, context).map_err(|e| format!("Keychain unavailable: {e}"))
}

/// Stored credentials for `context`; `EsAuth::None` when nothing is stored.
fn load_auth(context: &str) -> Result<EsAuth, String> {
    match entry(context)?.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map_err(|_| "Stored credentials are unreadable; save them again".to_string()),
        Err(keyring::Error::NoEntry) => Ok(EsAuth::None),
        Err(e) => Err(format!("Keychain error: {e}")),
    }
}

fn store_auth(context: &str, auth: &EsAuth) -> Result<(), String> {
    let entry = entry(context)?;
    if *auth == EsAuth::None {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Keychain error: {e}")),
        };
    }
    let json = serde_json::to_string(auth).map_err(|e| e.to_string())?;
    entry
        .set_password(&json)
        .map_err(|e| format!("Keychain error: {e}"))
}

fn method(auth: &EsAuth) -> &'static str {
    match auth {
        EsAuth::None => "none",
        EsAuth::Basic { .. } => "basic",
        EsAuth::ApiKey { .. } => "api-key",
        EsAuth::Bearer { .. } => "bearer",
    }
}

fn text(e: ElasticError) -> String {
    e.to_string()
}

async fn kube(kubeconfig_path: &str, context: &str) -> Result<KubeClient, String> {
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
        cubelite_core::elastic::EsTarget::InCluster { .. } => {
            Some(kube(kubeconfig_path, context).await?.client())
        }
        cubelite_core::elastic::EsTarget::External { .. } => None,
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
/// `auth` tests credentials before saving them; `None` uses the stored ones.
#[tauri::command]
pub async fn elastic_test(
    kubeconfig_path: String,
    context: String,
    endpoint: EsEndpoint,
    auth: Option<EsAuth>,
) -> Result<EsInfo, String> {
    let auth = match auth {
        Some(a) => a,
        None => load_auth(&context)?,
    };
    let conn = open(&kubeconfig_path, &context, &endpoint, &auth).await?;
    conn.info(&endpoint).await.map_err(text)
}

/// One page of a pod's history, through a cached connection.
#[tauri::command]
pub async fn elastic_search(
    state: State<'_, ElasticState>,
    kubeconfig_path: String,
    context: String,
    endpoint: EsEndpoint,
    query: HistoryQuery,
) -> Result<HistoryPage, String> {
    let conn = {
        let mut connections = state.connections.lock().await;
        match connections.get(&context) {
            Some((cached, conn)) if *cached == endpoint => conn.clone(),
            _ => {
                let auth = load_auth(&context)?;
                let conn = Arc::new(open(&kubeconfig_path, &context, &endpoint, &auth).await?);
                connections.insert(context.clone(), (endpoint.clone(), conn.clone()));
                conn
            }
        }
    };
    let result = conn.search(&endpoint, &query).await;
    if let Err(ElasticError::Connect(_)) = &result {
        // A dead port-forward or network change: reconnect on the next page.
        state.connections.lock().await.remove(&context);
    }
    result.map_err(text)
}

/// Saves `auth` for `context` in the keychain (`none` deletes it) and
/// drops the cached connection.
#[tauri::command]
pub async fn elastic_save_auth(
    state: State<'_, ElasticState>,
    context: String,
    auth: EsAuth,
) -> Result<(), String> {
    store_auth(&context, &auth)?;
    state.connections.lock().await.remove(&context);
    Ok(())
}

/// The stored auth method (`none`, `basic`, `api-key`, `bearer`), never the secret.
#[tauri::command]
pub async fn elastic_auth_method(context: String) -> Result<String, String> {
    Ok(method(&load_auth(&context)?).to_string())
}

/// Reads ECK's `elastic` user from the cluster and stores it in the keychain.
#[tauri::command]
pub async fn elastic_use_eck_credentials(
    state: State<'_, ElasticState>,
    kubeconfig_path: String,
    context: String,
    namespace: String,
    service: String,
) -> Result<String, String> {
    let auth = transport::eck_credentials(
        kube(&kubeconfig_path, &context).await?.client(),
        &namespace,
        &service,
    )
    .await
    .map_err(text)?;
    store_auth(&context, &auth)?;
    state.connections.lock().await.remove(&context);
    Ok(method(&auth).to_string())
}

/// Closes the cached connection of `context` (its port-forward too).
#[tauri::command]
pub async fn elastic_disconnect(
    state: State<'_, ElasticState>,
    context: String,
) -> Result<(), String> {
    state.connections.lock().await.remove(&context);
    Ok(())
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
        ] {
            let tag = serde_json::to_value(&auth).expect("json")["method"]
                .as_str()
                .map(str::to_owned);
            assert_eq!(tag.as_deref(), Some(method(&auth)));
        }
    }
}
