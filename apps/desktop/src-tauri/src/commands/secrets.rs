//! Secret values, one at a time, on request (#661, spec §6).
//!
//! `reveal_secret_value` answers one value as text and the resource version
//! of the Secret it was read from. It serves the main window only, refuses a
//! binary value and a text over 64 KiB, and answers errors as an object the
//! view switches on ([`SecretCommandError`]). No value goes into an error, a
//! log line or a `Debug` output.

use std::fmt;

use cubelite_core::{KubeClient, KubeconfigError, NotOffered, RevealedSecret};
use serde::Serialize;

/// The label of the app's main window; the log pop-outs are `logs-…`.
const MAIN_WINDOW: &str = "main";

/// What the view switches on when a Secret command fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretErrorKind {
    /// The API server refused the read (a 403).
    Forbidden,
    /// The Secret does not exist.
    SecretMissing,
    /// The Secret has no such key.
    KeyMissing,
    /// A Helm release payload.
    NotAValue,
    /// The value is not text.
    Binary,
    /// The text is over 64 KiB.
    TooLarge,
    /// Anything else.
    Other,
}

/// A Secret command's error: a `kind` and a `message` for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SecretCommandError {
    pub kind: SecretErrorKind,
    pub message: String,
}

impl SecretCommandError {
    fn other(message: impl Into<String>) -> Self {
        Self {
            kind: SecretErrorKind::Other,
            message: message.into(),
        }
    }
}

impl From<KubeconfigError> for SecretCommandError {
    fn from(error: KubeconfigError) -> Self {
        let kind = match &error {
            KubeconfigError::Api { code: 403, .. } => SecretErrorKind::Forbidden,
            KubeconfigError::SecretNotFound { .. } => SecretErrorKind::SecretMissing,
            KubeconfigError::SecretKeyNotFound { .. } => SecretErrorKind::KeyMissing,
            KubeconfigError::SecretValueNotOffered { reason, .. } => match reason {
                NotOffered::HelmPayload => SecretErrorKind::NotAValue,
                NotOffered::Binary => SecretErrorKind::Binary,
                NotOffered::TooLarge => SecretErrorKind::TooLarge,
            },
            _ => SecretErrorKind::Other,
        };
        // The sentence alone, without the error-kind prefix (as the other
        // commands' errors are shown).
        let message = match error {
            KubeconfigError::Api { reason, .. } | KubeconfigError::ClientError { reason } => reason,
            other => other.to_string(),
        };
        Self { kind, message }
    }
}

/// One value as the webview gets it, with the Secret's resource version.
///
/// `Serialize`, since it is the answer; its `Debug` prints the length only.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct RevealedValue {
    pub value: String,
    pub resource_version: Option<String>,
}

impl fmt::Debug for RevealedValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RevealedValue")
            .field("value", &format_args!("{} bytes", self.value.len()))
            .field("resource_version", &self.resource_version)
            .finish()
    }
}

/// Refuse a caller that is not the main window.
///
/// The log pop-out windows share the main window's capability, and they have
/// no business with Secrets.
fn main_window_only(label: &str) -> Result<(), SecretCommandError> {
    if label == MAIN_WINDOW {
        Ok(())
    } else {
        Err(SecretCommandError::other(
            "Secret values are served to the main window only",
        ))
    }
}

/// The answer to a reveal: the value as text, unless binary or too large.
fn shown(
    revealed: RevealedSecret,
    namespace: &str,
    name: &str,
    key: &str,
) -> Result<RevealedValue, SecretCommandError> {
    // The view offers no Reveal for either; the backend does not rely on that.
    let value = revealed.value.into_shown_text().map_err(|reason| {
        SecretCommandError::from(KubeconfigError::SecretValueNotOffered {
            namespace: namespace.to_string(),
            name: name.to_string(),
            key: key.to_string(),
            reason,
        })
    })?;
    Ok(RevealedValue {
        value,
        resource_version: revealed.resource_version,
    })
}

/// Read the value of `key` in Secret `namespace/name` and answer it as text,
/// with the resource version of the Secret it was read from.
#[tauri::command]
pub async fn reveal_secret_value(
    webview_window: tauri::WebviewWindow,
    kubeconfig_path: String,
    namespace: String,
    name: String,
    key: String,
    context: Option<String>,
) -> Result<RevealedValue, SecretCommandError> {
    main_window_only(webview_window.label())?;
    let client = KubeClient::new(&kubeconfig_path, context.as_deref()).await?;
    let revealed = client.secret_value(&namespace, &name, &key).await?;
    shown(revealed, &namespace, &name, &key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cubelite_core::{SecretValue, MAX_SHOWN_BYTES};

    const VALUE: &str = "s3cr3t-p4ss!";

    fn revealed(value: SecretValue) -> RevealedSecret {
        RevealedSecret {
            value,
            resource_version: Some("41".into()),
        }
    }

    #[test]
    fn a_text_value_is_answered_with_its_resource_version() {
        let answer = shown(
            revealed(SecretValue::Text(VALUE.into())),
            "shop",
            "api",
            "K",
        )
        .expect("shown");
        assert_eq!(answer.value, VALUE);
        assert_eq!(answer.resource_version.as_deref(), Some("41"));
        let json = serde_json::to_value(&answer).expect("json");
        assert_eq!(
            json,
            serde_json::json!({"value": VALUE, "resource_version": "41"})
        );
        assert!(!format!("{answer:?}").contains(VALUE));
    }

    #[test]
    fn reveal_refuses_binary_and_oversized_text() {
        let binary = shown(
            revealed(SecretValue::Bytes(vec![0xff])),
            "shop",
            "api",
            "ca.crt",
        )
        .expect_err("binary");
        assert_eq!(binary.kind, SecretErrorKind::Binary);
        let large = shown(
            revealed(SecretValue::Text("a".repeat(MAX_SHOWN_BYTES + 1))),
            "shop",
            "api",
            "K",
        )
        .expect_err("too large");
        assert_eq!(large.kind, SecretErrorKind::TooLarge);
        assert!(large.message.contains("K"), "{}", large.message);
        assert!(large.message.contains("shop/api"), "{}", large.message);
        assert!(shown(
            revealed(SecretValue::Text("a".repeat(MAX_SHOWN_BYTES))),
            "shop",
            "api",
            "K"
        )
        .is_ok());
    }

    #[test]
    fn a_caller_that_is_not_the_main_window_is_refused() {
        assert!(main_window_only("main").is_ok());
        for label in ["logs-ZGVmYXVsdC9hcGktMA", "logs-x", "other", ""] {
            let err = main_window_only(label).expect_err(label);
            assert_eq!(err.kind, SecretErrorKind::Other);
            assert!(err.message.contains("main window"), "{}", err.message);
        }
    }

    #[test]
    fn each_error_becomes_its_kind() {
        let cases = [
            (
                KubeconfigError::Api {
                    code: 403,
                    reason: "secrets \"api\" is forbidden".into(),
                },
                SecretErrorKind::Forbidden,
                "secrets \"api\" is forbidden",
            ),
            (
                KubeconfigError::Api {
                    code: 500,
                    reason: "etcd is down".into(),
                },
                SecretErrorKind::Other,
                "etcd is down",
            ),
            (
                KubeconfigError::SecretNotFound {
                    namespace: "shop".into(),
                    name: "api".into(),
                },
                SecretErrorKind::SecretMissing,
                "Secret shop/api no longer exists",
            ),
            (
                KubeconfigError::SecretKeyNotFound {
                    namespace: "shop".into(),
                    name: "api".into(),
                    key: "K".into(),
                },
                SecretErrorKind::KeyMissing,
                "Secret shop/api has no key K",
            ),
            (
                KubeconfigError::SecretValueNotOffered {
                    namespace: "shop".into(),
                    name: "api".into(),
                    key: "release".into(),
                    reason: NotOffered::HelmPayload,
                },
                SecretErrorKind::NotAValue,
                "release of Secret shop/api: a Helm release payload is not a value",
            ),
            (
                KubeconfigError::SecretValueNotOffered {
                    namespace: "shop".into(),
                    name: "api".into(),
                    key: "K".into(),
                    reason: NotOffered::Binary,
                },
                SecretErrorKind::Binary,
                "K of Secret shop/api: a binary value is not shown",
            ),
            (
                KubeconfigError::SecretValueNotOffered {
                    namespace: "shop".into(),
                    name: "api".into(),
                    key: "K".into(),
                    reason: NotOffered::TooLarge,
                },
                SecretErrorKind::TooLarge,
                "K of Secret shop/api: a value over 64 KiB is not shown",
            ),
            (
                KubeconfigError::ClientError {
                    reason: "connection refused".into(),
                },
                SecretErrorKind::Other,
                "connection refused",
            ),
            (
                KubeconfigError::FileNotFound {
                    path: "/nope".into(),
                },
                SecretErrorKind::Other,
                "kubeconfig file not found: /nope",
            ),
        ];
        for (error, kind, message) in cases {
            let object = SecretCommandError::from(error);
            assert_eq!((object.kind, object.message.as_str()), (kind, message));
        }
    }

    #[test]
    fn the_error_object_serializes_as_kind_and_message() {
        let json = serde_json::to_value(SecretCommandError {
            kind: SecretErrorKind::KeyMissing,
            message: "m".into(),
        })
        .expect("json");
        assert_eq!(
            json,
            serde_json::json!({"kind": "key_missing", "message": "m"})
        );
        for (kind, text) in [
            (SecretErrorKind::Forbidden, "forbidden"),
            (SecretErrorKind::SecretMissing, "secret_missing"),
            (SecretErrorKind::NotAValue, "not_a_value"),
            (SecretErrorKind::Binary, "binary"),
            (SecretErrorKind::TooLarge, "too_large"),
            (SecretErrorKind::Other, "other"),
        ] {
            assert_eq!(serde_json::to_value(kind).expect("json"), text);
        }
    }
}
