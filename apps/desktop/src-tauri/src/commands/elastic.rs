//! Elasticsearch log history and Kibana links (#483, #500).
//!
//! Endpoints (no secrets) live in the frontend's settings; credentials live
//! in the OS keychain under service `cubelite.elastic`, account = kube
//! context, bound to the endpoint they were saved for, and never travel
//! back to the frontend.

use std::collections::HashMap;
use std::sync::Arc;

use cubelite_core::elastic::transport::{self, DetectedService, EsConnection, EsInfo};
use cubelite_core::elastic::{
    kibana_discover_url as discover_url, ElasticError, EsAuth, EsEndpoint, EsTarget, FieldPreset,
    HistoryPage, HistoryQuery,
};
use cubelite_core::KubeClient;
use serde::{Deserialize, Serialize};
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

/// What stored credentials are bound to: the endpoint's origin (external
/// scheme + host + port, or the in-cluster service) and whether TLS
/// verification was off. Stored secrets are only sent to the same binding,
/// so a request naming another endpoint (e.g. from a compromised webview)
/// cannot exfiltrate them.
fn binding(endpoint: &EsEndpoint) -> Result<String, String> {
    let origin = match &endpoint.target {
        EsTarget::External { url } => url::Url::parse(url.trim())
            .map_err(|e| format!("Invalid URL \"{url}\": {e}"))?
            .origin()
            .ascii_serialization(),
        EsTarget::InCluster {
            namespace,
            service,
            port,
            https,
        } => format!(
            "in-cluster:{namespace}/{service}:{port}:{}",
            if *https { "https" } else { "http" }
        ),
    };
    Ok(if endpoint.skip_tls_verify {
        format!("{origin}|insecure")
    } else {
        origin
    })
}

/// Keychain record: the secret and the endpoint binding it was saved for.
#[derive(Serialize, Deserialize)]
struct StoredAuth {
    binding: String,
    auth: EsAuth,
}

fn read_record(context: &str) -> Result<Option<StoredAuth>, String> {
    match entry(context)?.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|_| "Stored credentials are unreadable; save them again".to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Keychain error: {e}")),
    }
}

/// Credentials stored for `context`, usable only with `endpoint`;
/// `EsAuth::None` when nothing is stored.
fn load_auth(context: &str, endpoint: &EsEndpoint) -> Result<EsAuth, String> {
    let Some(stored) = read_record(context)? else {
        return Ok(EsAuth::None);
    };
    if stored.binding != binding(endpoint)? {
        return Err(
            "The saved credentials belong to another endpoint or TLS setting; save them again for this one"
                .to_string(),
        );
    }
    Ok(stored.auth)
}

fn store_auth(context: &str, endpoint: &EsEndpoint, auth: &EsAuth) -> Result<(), String> {
    let entry = entry(context)?;
    if *auth == EsAuth::None {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Keychain error: {e}")),
        };
    }
    let record = StoredAuth {
        binding: binding(endpoint)?,
        auth: auth.clone(),
    };
    let json = serde_json::to_string(&record).map_err(|e| e.to_string())?;
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
        None => load_auth(&context, &endpoint)?,
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
                let auth = load_auth(&context, &endpoint)?;
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

/// Saves `auth` for `context` in the keychain, bound to `endpoint`
/// (`none` deletes it), and drops the cached connection.
#[tauri::command]
pub async fn elastic_save_auth(
    state: State<'_, ElasticState>,
    context: String,
    endpoint: EsEndpoint,
    auth: EsAuth,
) -> Result<(), String> {
    store_auth(&context, &endpoint, &auth)?;
    state.connections.lock().await.remove(&context);
    Ok(())
}

/// The auth method stored for `endpoint` (`none`, `basic`, `api-key`,
/// `bearer`), never the secret; `none` when the stored one belongs to
/// another endpoint.
#[tauri::command]
pub async fn elastic_auth_method(context: String, endpoint: EsEndpoint) -> Result<String, String> {
    let current = binding(&endpoint)?;
    Ok(match read_record(&context)? {
        Some(stored) if stored.binding == current => method(&stored.auth),
        _ => "none",
    }
    .to_string())
}

/// Reads ECK's `elastic` user from the cluster and stores it in the
/// keychain for this in-cluster endpoint.
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
    let auth = transport::eck_credentials(
        kube(&kubeconfig_path, &context).await?.client(),
        namespace,
        service,
    )
    .await
    .map_err(text)?;
    store_auth(&context, &endpoint, &auth)?;
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

    fn endpoint(target: EsTarget) -> EsEndpoint {
        EsEndpoint {
            target,
            index_pattern: "logs-*".into(),
            preset: FieldPreset::Ecs,
            kibana_url: None,
            skip_tls_verify: false,
        }
    }

    #[test]
    fn binding_is_the_origin_and_tls_setting() {
        let ext = |u: &str| endpoint(EsTarget::External { url: u.into() });
        let a = binding(&ext("https://es.example:9243/")).expect("a");
        assert_eq!(a, "https://es.example:9243");
        assert_eq!(
            binding(&ext("https://es.example:9243/some/path")).expect("same origin"),
            a
        );
        assert_ne!(binding(&ext("https://evil.example:9243")).expect("host"), a);
        assert_ne!(binding(&ext("http://es.example:9243")).expect("scheme"), a);
        let mut insecure = ext("https://es.example:9243");
        insecure.skip_tls_verify = true;
        assert_ne!(binding(&insecure).expect("insecure"), a);
        let in_cluster = endpoint(EsTarget::InCluster {
            namespace: "logging".into(),
            service: "quickstart-es-http".into(),
            port: 9200,
            https: true,
        });
        assert_eq!(
            binding(&in_cluster).expect("in-cluster"),
            "in-cluster:logging/quickstart-es-http:9200:https"
        );
        assert!(binding(&ext("not a url")).is_err());
    }

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
