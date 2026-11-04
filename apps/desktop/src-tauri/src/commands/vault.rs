//! Integration credentials in the OS keychain (Elasticsearch #483,
//! Prometheus #484): one entry per (service, kube context) holding the
//! secret and the endpoint binding it was saved for. Secrets never travel
//! back to the frontend.
//!
//! The default endpoint shared by every context (#528) keeps its
//! credentials once, in a keychain service of its own (`<service>.default`,
//! see [`location`]), so no context name can collide with it. A context
//! reads them only when its resolved endpoint is the default (`shared`), and
//! only for the binding they were saved with.
//!
//! The binding is the endpoint's origin (scheme, host, port) plus the TLS
//! setting, for per-context and default credentials alike: a path change on
//! the same origin keeps the stored secret, any other change needs it typed
//! again. Changing that rule would invalidate every stored credential.

use cubelite_core::integration::{DEFAULT_ACCOUNT, DEFAULT_SERVICE_SUFFIX};

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

const MOVED: &str =
    "The saved credentials belong to another endpoint or TLS setting; save them again for this one";

/// Keychain service of the default endpoint's credentials.
fn default_service(service: &str) -> String {
    format!("{service}{DEFAULT_SERVICE_SUFFIX}")
}

/// Keychain (service, account) of the credentials saved for `context`'s
/// endpoint: the default's own service when it is the shared default.
pub(crate) fn location<'a>(service: &str, context: &'a str, shared: bool) -> (String, &'a str) {
    if shared {
        (default_service(service), DEFAULT_ACCOUNT)
    } else {
        (service.to_string(), context)
    }
}

/// The credentials usable with `binding`: the context's own record, else
/// (shared endpoints only) the default's. `None` when nothing applies; an
/// error when the record that would apply was saved for another endpoint,
/// so a secret never reaches a URL it was not saved for.
pub(crate) fn pick<A>(
    own: Option<Stored<A>>,
    default: impl FnOnce() -> Result<Option<Stored<A>>, String>,
    shared: bool,
    binding: &str,
) -> Result<Option<A>, String> {
    match own {
        Some(stored) if stored.binding == binding => return Ok(Some(stored.auth)),
        // Without the default, the context's own record is the only one.
        Some(_) if !shared => return Err(MOVED.to_string()),
        _ if !shared => return Ok(None),
        _ => {}
    }
    match default()? {
        None => Ok(None),
        Some(stored) if stored.binding == binding => Ok(Some(stored.auth)),
        Some(_) => Err(MOVED.to_string()),
    }
}

/// Credentials stored for `context` usable with `binding` (see [`pick`]);
/// `none` when nothing is stored.
pub(crate) fn load<A: DeserializeOwned>(
    service: &str,
    context: &str,
    shared: bool,
    binding: &str,
    none: A,
) -> Result<A, String> {
    let own = read::<A>(service, context)?;
    let default = || read::<A>(&default_service(service), DEFAULT_ACCOUNT);
    let found = pick(own, default, shared, binding)?;
    Ok(found.unwrap_or(none))
}

/// The stored credentials that apply to `binding`, if any (never an error
/// for a record of another endpoint: the form shows "none" then).
pub(crate) fn stored<A: DeserializeOwned>(
    service: &str,
    context: &str,
    shared: bool,
    binding: &str,
) -> Result<Option<A>, String> {
    let own = read::<A>(service, context)?;
    let default = || read::<A>(&default_service(service), DEFAULT_ACCOUNT);
    Ok(pick(own, default, shared, binding).unwrap_or(None))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn record(binding: &str, auth: &str) -> Option<Stored<String>> {
        Some(Stored {
            binding: binding.into(),
            auth: auth.into(),
        })
    }

    fn nothing_saved() -> Result<Option<Stored<String>>, String> {
        Ok(None)
    }

    fn no_default() -> Result<Option<Stored<String>>, String> {
        panic!("the default's account must not be read")
    }

    #[test]
    fn own_credentials_win_and_must_match_the_binding() {
        assert_eq!(
            pick(
                record("https://a|false", "own"),
                no_default,
                false,
                "https://a|false"
            ),
            Ok(Some("own".to_string()))
        );
        assert!(pick(
            record("https://b|false", "own"),
            no_default,
            false,
            "https://a|false"
        )
        .is_err());
        assert_eq!(pick(None, no_default, false, "https://a|false"), Ok(None));
    }

    #[test]
    fn shared_endpoints_fall_back_to_the_default_account() {
        let default = || Ok(record("https://a|false", "default"));
        assert_eq!(
            pick(None, default, true, "https://a|false"),
            Ok(Some("default".to_string()))
        );
        // A stale record of the context does not hide the default's.
        assert_eq!(
            pick(
                record("https://old|false", "own"),
                default,
                true,
                "https://a|false"
            ),
            Ok(Some("default".to_string()))
        );
        assert_eq!(
            pick(
                record("https://a|false", "own"),
                no_default,
                true,
                "https://a|false"
            ),
            Ok(Some("own".to_string()))
        );
        assert_eq!(pick(None, nothing_saved, true, "https://a|false"), Ok(None));
    }

    #[test]
    fn default_credentials_never_go_to_another_binding() {
        let default = || Ok(record("https://a|false", "default"));
        assert!(pick(None, default, true, "https://evil|false").is_err());
        assert!(pick(None, default, true, "https://a|true").is_err());
    }

    #[test]
    fn the_default_has_a_service_of_its_own() {
        assert_eq!(
            location("cubelite.elastic", "prod", false),
            ("cubelite.elastic".to_string(), "prod")
        );
        assert_eq!(
            location("cubelite.elastic", "prod", true),
            ("cubelite.elastic.default".to_string(), "default")
        );
        // A context named like the default's account never reaches it.
        for name in [DEFAULT_ACCOUNT, "*default*"] {
            assert_ne!(
                location("cubelite.elastic", name, false),
                location("cubelite.elastic", name, true)
            );
        }
    }
}
