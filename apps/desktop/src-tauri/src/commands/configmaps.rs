//! A ConfigMap's values, one at a time, on request (#668, spec §6).
//!
//! `read_configmap_value` answers one value as text and the resource version
//! of the ConfigMap it was read from; it refuses a `binaryData` value and a
//! text over 64 KiB. `copy_configmap_value` writes one value to the
//! clipboard from here, plain (a ConfigMap value is not a credential: no
//! "do not keep" mark, no clear), and answers only the format used.
//!
//! Both serve the main window only and answer errors as an object the view
//! switches on ([`ConfigMapCommandError`]), as the Secret commands do. No
//! value goes into an error or a log line: the rule costs nothing.

use base64::Engine;
use cubelite_core::{ConfigMapRead, ConfigMapValue, KubeClient, KubeconfigError, NotOffered};
use serde::Serialize;

use super::secrets::{CopyFormat, RevealedValue};
use crate::clipboard::ClipboardState;

/// What the view switches on when a ConfigMap command fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigMapErrorKind {
    /// The API server refused the read (a 403).
    Forbidden,
    /// The ConfigMap does not exist.
    ConfigmapMissing,
    /// The ConfigMap has no such key.
    KeyMissing,
    /// The value is under `binaryData`.
    Binary,
    /// The text is over 64 KiB.
    TooLarge,
    /// Anything else.
    Other,
}

/// A ConfigMap command's error: a `kind` and a `message` for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigMapCommandError {
    pub kind: ConfigMapErrorKind,
    pub message: String,
}

impl ConfigMapCommandError {
    fn other(message: impl Into<String>) -> Self {
        Self {
            kind: ConfigMapErrorKind::Other,
            message: message.into(),
        }
    }
}

impl From<KubeconfigError> for ConfigMapCommandError {
    fn from(error: KubeconfigError) -> Self {
        let kind = match &error {
            KubeconfigError::Api { code: 403, .. } => ConfigMapErrorKind::Forbidden,
            KubeconfigError::ConfigMapNotFound { .. } => ConfigMapErrorKind::ConfigmapMissing,
            KubeconfigError::ConfigMapKeyNotFound { .. } => ConfigMapErrorKind::KeyMissing,
            _ => ConfigMapErrorKind::Other,
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

/// Refuse a caller that is not the main window, as the Secret commands do.
fn main_window_only(label: &str) -> Result<(), ConfigMapCommandError> {
    if super::is_main_window(label) {
        Ok(())
    } else {
        Err(ConfigMapCommandError::other(
            "ConfigMap values are served to the main window only",
        ))
    }
}

/// The answer to a read: the value as text, unless binary or too large.
fn shown(
    read: ConfigMapRead,
    namespace: &str,
    name: &str,
    key: &str,
) -> Result<RevealedValue, ConfigMapCommandError> {
    // The view offers no Show for either; the backend does not rely on that.
    let value = read.value.into_shown_text().map_err(|reason| {
        let kind = match reason {
            NotOffered::Binary => ConfigMapErrorKind::Binary,
            NotOffered::TooLarge => ConfigMapErrorKind::TooLarge,
            NotOffered::HelmPayload => ConfigMapErrorKind::Other,
        };
        ConfigMapCommandError {
            kind,
            message: format!("{key} of ConfigMap {namespace}/{name}: {reason}"),
        }
    })?;
    Ok(RevealedValue {
        value,
        resource_version: read.resource_version,
    })
}

/// Read the value of `key` in ConfigMap `namespace/name` and answer it as
/// text, with the resource version of the ConfigMap it was read from.
#[tauri::command]
pub async fn read_configmap_value(
    webview_window: tauri::WebviewWindow,
    kubeconfig_path: String,
    namespace: String,
    name: String,
    key: String,
    context: Option<String>,
) -> Result<RevealedValue, ConfigMapCommandError> {
    main_window_only(webview_window.label())?;
    let client = KubeClient::new(&kubeconfig_path, context.as_deref()).await?;
    let read = client.configmap_value(&namespace, &name, &key).await?;
    shown(read, &namespace, &name, &key)
}

/// The text to put on the clipboard for `value`, and its format: `data` as
/// it is, `binaryData` as base64.
fn clipboard_text(value: ConfigMapValue) -> (String, CopyFormat) {
    match value {
        ConfigMapValue::Text(text) => (text, CopyFormat::Text),
        ConfigMapValue::Bytes(bytes) => (
            base64::engine::general_purpose::STANDARD.encode(bytes),
            CopyFormat::Base64,
        ),
    }
}

/// Write `value` to the clipboard, plain, in its place among the copies
/// (`ticket`): no mark, no clear, and any pending Secret clear dropped.
async fn copy_plain(
    clipboard: &ClipboardState,
    ticket: u64,
    value: ConfigMapValue,
) -> Result<CopyFormat, ConfigMapCommandError> {
    let (text, format) = clipboard_text(value);
    clipboard
        .copy_plain(ticket, text)
        .await
        .map_err(ConfigMapCommandError::other)?;
    Ok(format)
}

/// Read the value of `key` in ConfigMap `namespace/name` and write it to the
/// clipboard, plain (text as it is, `binaryData` as base64). Answers the
/// format used, never the value. When a copy asked for later was written
/// first, this one writes nothing and answers an `other` error
/// ([`crate::clipboard::SUPERSEDED`]).
#[tauri::command]
pub async fn copy_configmap_value(
    webview_window: tauri::WebviewWindow,
    clipboard: tauri::State<'_, ClipboardState>,
    kubeconfig_path: String,
    namespace: String,
    name: String,
    key: String,
    context: Option<String>,
) -> Result<CopyFormat, ConfigMapCommandError> {
    main_window_only(webview_window.label())?;
    // Its place among the copies, before the read: a later copy whose read
    // answers first is not overwritten by this one.
    let ticket = clipboard.ticket();
    let client = KubeClient::new(&kubeconfig_path, context.as_deref()).await?;
    let read = client.configmap_value(&namespace, &name, &key).await?;
    copy_plain(&clipboard, ticket, read.value).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::{Board, EXIT_WAIT};
    use cubelite_core::MAX_SHOWN_BYTES;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn read(value: ConfigMapValue) -> ConfigMapRead {
        ConfigMapRead {
            value,
            resource_version: Some("77".into()),
        }
    }

    #[test]
    fn a_text_value_is_answered_with_its_resource_version() {
        let answer = shown(
            read(ConfigMapValue::Text("info".into())),
            "shop",
            "app-config",
            "LOG_LEVEL",
        )
        .expect("shown");
        assert_eq!(
            serde_json::to_value(&answer).expect("json"),
            serde_json::json!({"value": "info", "resource_version": "77"})
        );
    }

    #[test]
    fn read_refuses_binary_data_and_oversized_text() {
        // binaryData is binary, UTF-8 or not.
        let binary = shown(
            read(ConfigMapValue::Bytes(b"plain".to_vec())),
            "shop",
            "app-config",
            "logo.png",
        )
        .expect_err("binary");
        assert_eq!(binary.kind, ConfigMapErrorKind::Binary);
        assert_eq!(
            binary.message,
            "logo.png of ConfigMap shop/app-config: a binary value is not shown"
        );
        let large = shown(
            read(ConfigMapValue::Text("a".repeat(MAX_SHOWN_BYTES + 1))),
            "shop",
            "app-config",
            "big.json",
        )
        .expect_err("too large");
        assert_eq!(large.kind, ConfigMapErrorKind::TooLarge);
        assert_eq!(
            large.message,
            "big.json of ConfigMap shop/app-config: a value over 64 KiB is not shown"
        );
        assert!(shown(
            read(ConfigMapValue::Text("a".repeat(MAX_SHOWN_BYTES))),
            "shop",
            "app-config",
            "K"
        )
        .is_ok());
    }

    #[test]
    fn a_caller_that_is_not_the_main_window_is_refused() {
        assert!(main_window_only("main").is_ok());
        for label in ["logs-ZGVmYXVsdC9hcGktMA", "logs-x", "other", ""] {
            let err = main_window_only(label).expect_err(label);
            assert_eq!(err.kind, ConfigMapErrorKind::Other);
            assert_eq!(
                err.message,
                "ConfigMap values are served to the main window only"
            );
        }
    }

    #[test]
    fn each_error_becomes_its_kind() {
        let cases = [
            (
                KubeconfigError::Api {
                    code: 403,
                    reason: "configmaps \"app-config\" is forbidden".into(),
                },
                ConfigMapErrorKind::Forbidden,
                "configmaps \"app-config\" is forbidden",
            ),
            (
                KubeconfigError::Api {
                    code: 500,
                    reason: "etcd is down".into(),
                },
                ConfigMapErrorKind::Other,
                "etcd is down",
            ),
            (
                KubeconfigError::ConfigMapNotFound {
                    namespace: "shop".into(),
                    name: "app-config".into(),
                },
                ConfigMapErrorKind::ConfigmapMissing,
                "ConfigMap shop/app-config no longer exists",
            ),
            (
                KubeconfigError::ConfigMapKeyNotFound {
                    namespace: "shop".into(),
                    name: "app-config".into(),
                    key: "K".into(),
                },
                ConfigMapErrorKind::KeyMissing,
                "ConfigMap shop/app-config has no key K",
            ),
            (
                KubeconfigError::ClientError {
                    reason: "connection refused".into(),
                },
                ConfigMapErrorKind::Other,
                "connection refused",
            ),
            (
                KubeconfigError::FileNotFound {
                    path: "/nope".into(),
                },
                ConfigMapErrorKind::Other,
                "kubeconfig file not found: /nope",
            ),
        ];
        for (error, kind, message) in cases {
            let object = ConfigMapCommandError::from(error);
            assert_eq!((object.kind, object.message.as_str()), (kind, message));
        }
    }

    #[test]
    fn the_error_object_serializes_as_kind_and_message() {
        let json = serde_json::to_value(ConfigMapCommandError {
            kind: ConfigMapErrorKind::ConfigmapMissing,
            message: "m".into(),
        })
        .expect("json");
        assert_eq!(
            json,
            serde_json::json!({"kind": "configmap_missing", "message": "m"})
        );
        for (kind, text) in [
            (ConfigMapErrorKind::Forbidden, "forbidden"),
            (ConfigMapErrorKind::KeyMissing, "key_missing"),
            (ConfigMapErrorKind::Binary, "binary"),
            (ConfigMapErrorKind::TooLarge, "too_large"),
            (ConfigMapErrorKind::Other, "other"),
        ] {
            assert_eq!(serde_json::to_value(kind).expect("json"), text);
        }
    }

    #[test]
    fn text_is_copied_as_it_is_and_binary_data_as_base64() {
        assert_eq!(
            clipboard_text(ConfigMapValue::Text("a: 1\n".into())),
            ("a: 1\n".to_string(), CopyFormat::Text)
        );
        assert_eq!(
            clipboard_text(ConfigMapValue::Bytes(vec![0xff, 0xfe, 0x00])),
            ("//4A".to_string(), CopyFormat::Base64)
        );
        // UTF-8 bytes under binaryData are base64 too.
        assert_eq!(
            clipboard_text(ConfigMapValue::Bytes(b"hi".to_vec())),
            ("aGk=".to_string(), CopyFormat::Base64)
        );
    }

    /// A clipboard stand-in: what it holds, whether the last write was
    /// marked, and how many clears it saw.
    #[derive(Clone, Default)]
    struct Fake {
        held: Arc<Mutex<Option<String>>>,
        marked: Arc<Mutex<Option<bool>>>,
        clears: Arc<Mutex<u32>>,
    }

    impl Board for Fake {
        fn write(&mut self, text: &str) -> Result<(), String> {
            *self.held.lock().expect("lock") = Some(text.into());
            *self.marked.lock().expect("lock") = Some(true);
            Ok(())
        }
        fn write_plain(&mut self, text: &str) -> Result<(), String> {
            *self.held.lock().expect("lock") = Some(text.into());
            *self.marked.lock().expect("lock") = Some(false);
            Ok(())
        }
        fn read(&mut self) -> Result<Option<String>, String> {
            Ok(self.held.lock().expect("lock").clone())
        }
        fn clear(&mut self) -> Result<(), String> {
            *self.held.lock().expect("lock") = None;
            *self.clears.lock().expect("lock") += 1;
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_copy_is_written_plain_and_drops_a_pending_secret_clear() {
        let fake = Fake::default();
        let board = fake.clone();
        let clipboard = ClipboardState::with(move || Ok(board.clone()));
        // A Secret value copied first, its clear an hour away.
        let t = clipboard.ticket();
        clipboard
            .copy(t, "s3cr3t".into(), Some(Duration::from_secs(3600)))
            .await
            .expect("secret copy");

        // The ConfigMap value is the same text: only a dropped clear spares it.
        let t = clipboard.ticket();
        let format = copy_plain(&clipboard, t, ConfigMapValue::Text("s3cr3t".into()))
            .await
            .expect("copy");
        assert_eq!(format, CopyFormat::Text);
        assert_eq!(*fake.marked.lock().expect("lock"), Some(false));
        clipboard.clear_pending_now(EXIT_WAIT);
        assert_eq!(fake.held.lock().expect("lock").as_deref(), Some("s3cr3t"));
        assert_eq!(*fake.clears.lock().expect("lock"), 0);

        let t = clipboard.ticket();
        let format = copy_plain(&clipboard, t, ConfigMapValue::Bytes(vec![0xff]))
            .await
            .expect("copy");
        assert_eq!(format, CopyFormat::Base64);
        assert_eq!(fake.held.lock().expect("lock").as_deref(), Some("/w=="));
    }
}
