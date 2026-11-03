//! Integration credentials in the OS keychain (Elasticsearch #483,
//! Prometheus #484): one entry per (service, kube context) holding the
//! secret and the endpoint binding it was saved for. Secrets never travel
//! back to the frontend.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// Keychain record: the credentials and the endpoint binding they belong to.
#[derive(Serialize, Deserialize)]
pub(crate) struct Stored<A> {
    pub(crate) binding: String,
    pub(crate) auth: A,
}

fn entry(service: &str, context: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, context).map_err(|e| format!("Keychain unavailable: {e}"))
}

/// The record stored for `context`, if any.
pub(crate) fn read<A: DeserializeOwned>(
    service: &str,
    context: &str,
) -> Result<Option<Stored<A>>, String> {
    match entry(service, context)?.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|_| "Stored credentials are unreadable; save them again".to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Keychain error: {e}")),
    }
}

/// Stores `record` for `context`; `None` deletes the entry.
pub(crate) fn write<A: Serialize>(
    service: &str,
    context: &str,
    record: Option<&Stored<A>>,
) -> Result<(), String> {
    let entry = entry(service, context)?;
    let Some(record) = record else {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Keychain error: {e}")),
        };
    };
    let json = serde_json::to_string(record).map_err(|e| e.to_string())?;
    entry
        .set_password(&json)
        .map_err(|e| format!("Keychain error: {e}"))
}

/// Credentials stored for `context` usable with `binding`; `none` when
/// nothing is stored, an error when they belong to another endpoint.
pub(crate) fn load<A: DeserializeOwned>(
    service: &str,
    context: &str,
    binding: &str,
    none: A,
) -> Result<A, String> {
    match read::<A>(service, context)? {
        None => Ok(none),
        Some(stored) if stored.binding == binding => Ok(stored.auth),
        Some(_) => Err(
            "The saved credentials belong to another endpoint or TLS setting; save them again for this one"
                .to_string(),
        ),
    }
}

/// Runs a keychain call on the blocking pool: it can block on a system
/// prompt (macOS keychain ACL) and must not stall the async runtime.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Keychain task failed: {e}"))?
}
