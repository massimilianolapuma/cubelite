//! Checks of the namespaces and object names the desktop passes to the core
//! (#671).
//!
//! kube-rs puts a namespace into the request path as it is, and its check of
//! a name only refuses an empty one: a namespace such as
//! `shop/secrets/api?x=` turns a pod's log request into a read of a Secret.
//! Every entry point that takes a namespace or a name from the webview checks
//! it here, before any request.
//!
//! - A namespace is a DNS-1123 label.
//! - The name of an object of a typed kind (Pod, Deployment, Service,
//!   ConfigMap, Secret, Ingress) is a DNS-1123 subdomain: Kubernetes accepts
//!   no other name for any of them.
//! - The name of an object of any kind (the generic kind views, where a
//!   ClusterRole may be called `system:controller:job-controller`) only has
//!   to be one path segment: not `.` or `..`, no `/`, `?`, `#`, `%`, `\`,
//!   whitespace or control character.

use std::fmt;

use crate::KubeconfigError;

/// How many characters of a refused value the message shows.
pub(crate) const SHOWN_CHARS: usize = 80;

/// A value refused by one of the checks; its message names the value (the
/// first [`SHOWN_CHARS`] characters of it) and nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Invalid(String);

impl fmt::Display for Invalid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<Invalid> for KubeconfigError {
    fn from(invalid: Invalid) -> Self {
        KubeconfigError::ClientError { reason: invalid.0 }
    }
}

/// A letter or a digit: what a label starts and ends with.
fn is_edge(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit()
}

/// One label of a DNS name, without a length limit: lowercase letters,
/// digits and `-`, starting and ending with a letter or a digit.
fn is_label_text(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.first().copied().is_some_and(is_edge)
        && bytes.last().copied().is_some_and(is_edge)
        && bytes.iter().all(|&b| is_edge(b) || b == b'-')
}

/// A DNS-1123 label (a namespace, a Service): at most 63 characters.
pub(crate) fn is_dns_label(value: &str) -> bool {
    value.len() <= 63 && is_label_text(value)
}

/// A DNS-1123 subdomain (the name of most kinds): labels joined by `.`, at
/// most 253 characters. Never `.` or `..`, never a `/`.
pub(crate) fn is_dns_subdomain(value: &str) -> bool {
    value.len() <= 253 && value.split('.').all(is_label_text)
}

/// One request path segment that names an object of any kind: what
/// Kubernetes accepts for every kind (not `.` or `..`, no `/` or `%`),
/// without `?`, `#`, `\`, whitespace or control characters either.
pub(crate) fn is_path_segment_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.chars().any(|c| {
            matches!(c, '/' | '?' | '#' | '%' | '\\') || c.is_whitespace() || c.is_control()
        })
}

/// `value` for a message: its first [`SHOWN_CHARS`] characters, control
/// characters escaped, an ellipsis when it is longer.
fn shown(value: &str) -> String {
    let mut out = String::new();
    for c in value.chars().take(SHOWN_CHARS) {
        if c.is_control() {
            out.extend(c.escape_default());
        } else {
            out.push(c);
        }
    }
    if value.chars().nth(SHOWN_CHARS).is_some() {
        out.push('…');
    }
    out
}

/// Refuses a namespace that is not a DNS-1123 label.
pub(crate) fn check_namespace(namespace: &str) -> Result<(), Invalid> {
    if is_dns_label(namespace) {
        Ok(())
    } else {
        Err(Invalid(format!(
            "Invalid namespace \"{}\"",
            shown(namespace)
        )))
    }
}

/// [`check_namespace`] for an optional namespace: `None` (all namespaces)
/// passes.
pub(crate) fn check_scope(namespace: Option<&str>) -> Result<(), Invalid> {
    namespace.map_or(Ok(()), check_namespace)
}

/// Refuses an object name of a typed kind that is not a DNS-1123 subdomain.
pub(crate) fn check_name(name: &str) -> Result<(), Invalid> {
    if is_dns_subdomain(name) {
        Ok(())
    } else {
        Err(invalid_name(name))
    }
}

/// [`check_namespace`], then [`check_name`]: the namespace and name of one
/// object of a typed kind.
pub(crate) fn check_object(namespace: &str, name: &str) -> Result<(), Invalid> {
    check_namespace(namespace)?;
    check_name(name)
}

/// Refuses an object name of any kind that is not one
/// [path segment](is_path_segment_name).
pub(crate) fn check_any_name(name: &str) -> Result<(), Invalid> {
    if is_path_segment_name(name) {
        Ok(())
    } else {
        Err(invalid_name(name))
    }
}

fn invalid_name(name: &str) -> Invalid {
    Invalid(format!("Invalid name \"{}\"", shown(name)))
}

#[cfg(test)]
mod guards;

#[cfg(test)]
mod tests {
    use super::*;

    /// Values the app meets on real clusters and in its fixtures (the core's
    /// tests and the e2e Tauri mock).
    const REAL_NAMESPACES: &[&str] = &[
        "default",
        "kube-system",
        "kube-public",
        "kube-node-lease",
        "cert-manager",
        "monitoring",
        "ingress-nginx",
        "argocd",
        "elastic-system",
        "team",
        "dev",
        "prod",
        "shop",
        "payments",
        "a",
        "0",
        "ns-1",
    ];

    const REAL_NAMES: &[&str] = &[
        "api-0",
        "web",
        "api-7d9f8b6c5d-x2k9p",
        "coredns-787d4945fb-lmn2q",
        "sh.helm.release.v1.api.v7",
        "sh.helm.release.v1.kube-prometheus-stack.v12",
        "kube-root-ca.crt",
        "prometheus-operated",
        "quickstart-es-http",
        "quickstart-es-elastic-user",
        "my-app.example.com",
        "default-token-x7k2p",
        "1",
    ];

    /// Crafted values that would reach another object (a Secret) or another
    /// path if they went into a request as they are.
    const CRAFTED: &[&str] = &[
        "shop/secrets/api?x=",
        "a%2Fb",
        "..",
        ".",
        "",
        "a/b",
        "a?b",
        "a#b",
        "a\\b",
        "a b",
        "a\nb",
        "a\tb",
    ];

    #[test]
    fn real_namespaces_pass() {
        for ns in REAL_NAMESPACES {
            assert!(check_namespace(ns).is_ok(), "{ns}");
            assert!(check_scope(Some(ns)).is_ok(), "{ns}");
        }
        assert!(check_namespace(&"n".repeat(63)).is_ok());
    }

    #[test]
    fn all_namespaces_pass() {
        assert!(check_scope(None).is_ok());
    }

    #[test]
    fn real_names_pass_both_name_checks() {
        for name in REAL_NAMES {
            assert!(check_name(name).is_ok(), "{name}");
            assert!(check_any_name(name).is_ok(), "{name}");
            assert!(check_object("kube-system", name).is_ok(), "{name}");
        }
        assert!(check_name(&"n".repeat(253)).is_ok());
    }

    #[test]
    fn names_of_any_kind_may_hold_colons_and_capitals() {
        for name in [
            "system:controller:job-controller",
            "system:aggregate-to-admin",
            "system:kube-scheduler",
            "Admin_Role",
            "user@example.com",
        ] {
            assert!(check_any_name(name).is_ok(), "{name}");
            assert!(check_name(name).is_err(), "{name}");
        }
    }

    #[test]
    fn crafted_values_are_refused_by_every_check() {
        for value in CRAFTED {
            assert!(check_namespace(value).is_err(), "{value:?}");
            assert!(check_scope(Some(value)).is_err(), "{value:?}");
            assert!(check_name(value).is_err(), "{value:?}");
            assert!(check_any_name(value).is_err(), "{value:?}");
            assert!(check_object(value, "api").is_err(), "{value:?}");
            assert!(check_object("shop", value).is_err(), "{value:?}");
        }
    }

    #[test]
    fn namespaces_are_dns_labels() {
        for ns in [
            "Kube-System",
            "-team",
            "team-",
            "kube.system",
            "team_a",
            "équipe",
            &"n".repeat(64),
        ] {
            assert!(check_namespace(ns).is_err(), "{ns}");
        }
    }

    #[test]
    fn typed_names_are_dns_subdomains() {
        for name in [
            "Api",
            "-api",
            "api-",
            ".api",
            "api.",
            "a..b",
            "a.-b",
            "api_0",
            "system:node",
            &"n".repeat(254),
        ] {
            assert!(check_name(name).is_err(), "{name}");
        }
    }

    #[test]
    fn the_message_names_the_value_and_nothing_else() {
        assert_eq!(
            check_namespace("shop/secrets/api?x=")
                .unwrap_err()
                .to_string(),
            "Invalid namespace \"shop/secrets/api?x=\""
        );
        assert_eq!(
            check_object("shop", "a%2Fb").unwrap_err().to_string(),
            "Invalid name \"a%2Fb\""
        );
        assert_eq!(
            check_any_name("..").unwrap_err().to_string(),
            "Invalid name \"..\""
        );
    }

    #[test]
    fn a_long_value_is_cut_at_80_characters() {
        let value = format!("{}{}", "x/".repeat(40), "SECRET-TAIL");
        let message = check_namespace(&value).unwrap_err().to_string();
        assert_eq!(
            message,
            format!("Invalid namespace \"{}…\"", "x/".repeat(40))
        );
        assert!(!message.contains("SECRET"), "{message}");
        // Exactly 80 characters: no ellipsis.
        let exact = "/".repeat(80);
        assert_eq!(
            check_name(&exact).unwrap_err().to_string(),
            format!("Invalid name \"{exact}\"")
        );
    }

    #[test]
    fn control_characters_are_escaped_in_the_message() {
        assert_eq!(
            check_name("a\nb").unwrap_err().to_string(),
            "Invalid name \"a\\nb\""
        );
    }

    #[test]
    fn invalid_converts_into_a_client_error() {
        let err: KubeconfigError = check_namespace("..").unwrap_err().into();
        assert!(matches!(
            &err,
            KubeconfigError::ClientError { reason } if reason == "Invalid namespace \"..\""
        ));
    }
}
