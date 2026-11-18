//! Secret values, one at a time, on request (#661, spec §6).
//!
//! `reveal_secret_value` answers one value as text and the resource version
//! of the Secret it was read from; it refuses a binary value and a text over
//! 64 KiB. `copy_secret_value` writes one value to the clipboard from here
//! and answers only the format used. `export_secret_env` asks for a path in
//! the system's save dialog, opened here, and writes the Secret as a `.env`
//! file; it takes no path, so the webview cannot aim the write.
//!
//! All three serve the main window only and answer errors as an object the
//! view switches on ([`SecretCommandError`]). No value goes into an error, a
//! log line or a `Debug` output.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use cubelite_core::{
    KubeClient, KubeconfigError, LeftOutKey, NotOffered, RevealedSecret, SecretValue,
};
use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

use crate::clipboard::ClipboardState;

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
            KubeconfigError::SecretValueNotOffered { reason, .. }
            | KubeconfigError::SecretNotOffered { reason, .. } => match reason {
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

/// How a copied value went to the clipboard: text as it is, binary as base64.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyFormat {
    Text,
    Base64,
}

/// The text to put on the clipboard for `value`, and its format.
fn clipboard_text(value: SecretValue) -> (String, CopyFormat) {
    match value {
        SecretValue::Text(text) => (text, CopyFormat::Text),
        SecretValue::Bytes(bytes) => (
            base64::engine::general_purpose::STANDARD.encode(bytes),
            CopyFormat::Base64,
        ),
    }
}

/// The time after which a copied value is cleared; none (or 0) is Never.
fn clear_after(secs: Option<u64>) -> Option<Duration> {
    secs.filter(|s| *s > 0).map(Duration::from_secs)
}

/// Read the value of `key` in Secret `namespace/name` and write it to the
/// clipboard (text as it is, binary as base64). With `clear_after_secs`, the
/// clipboard is cleared after that time if it still holds the value. Answers
/// the format used, never the value.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn copy_secret_value(
    webview_window: tauri::WebviewWindow,
    clipboard: tauri::State<'_, ClipboardState>,
    kubeconfig_path: String,
    namespace: String,
    name: String,
    key: String,
    clear_after_secs: Option<u64>,
    context: Option<String>,
) -> Result<CopyFormat, SecretCommandError> {
    main_window_only(webview_window.label())?;
    let client = KubeClient::new(&kubeconfig_path, context.as_deref()).await?;
    let revealed = client.secret_value(&namespace, &name, &key).await?;
    let (text, format) = clipboard_text(revealed.value);
    clipboard
        .copy(text, clear_after(clear_after_secs))
        .await
        .map_err(SecretCommandError::other)?;
    Ok(format)
}

/// What `export_secret_env` did: whether a file was saved, where, and the
/// keys written and left out (with the reason).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EnvExport {
    pub saved: bool,
    pub path: Option<String>,
    pub written: Vec<String>,
    pub left_out: Vec<LeftOutKey>,
}

/// The file name proposed in the save dialog: `<secret>.env`.
fn proposed_file_name(name: &str) -> String {
    // A Secret's name is a DNS subdomain; anything else is not proposed.
    if !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        && !name.starts_with('.')
    {
        format!("{name}.env")
    } else {
        "secret.env".to_string()
    }
}

/// Write `text` to `path`, readable by its owner only on Unix (`0600`),
/// whether the file is created or overwritten: the mode is set on the open
/// file before anything is written. On Windows the file takes the folder's
/// permissions.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.set_len(0)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

/// The path the user chooses in the system's save dialog, a child of
/// `window`; `None` when the dialog is cancelled.
async fn choose_path(
    window: &tauri::WebviewWindow,
    name: &str,
) -> Result<Option<PathBuf>, SecretCommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(window)
        .set_file_name(proposed_file_name(name))
        .save_file(move |chosen| {
            let _ = tx.send(chosen);
        });
    let chosen = rx
        .await
        .map_err(|_| SecretCommandError::other("The save dialog closed without an answer"))?;
    chosen
        .map(|p| p.into_path())
        .transpose()
        .map_err(|e| SecretCommandError::other(format!("Not a file path: {e}")))
}

/// Ask for a path in the system's save dialog, read Secret `namespace/name`
/// and write it there as a `.env` file (spec §5.4). Takes no path: the
/// webview cannot aim the write. Cancelling the dialog writes nothing.
#[tauri::command]
pub async fn export_secret_env(
    webview_window: tauri::WebviewWindow,
    kubeconfig_path: String,
    namespace: String,
    name: String,
    context: Option<String>,
) -> Result<EnvExport, SecretCommandError> {
    main_window_only(webview_window.label())?;
    let client = KubeClient::new(&kubeconfig_path, context.as_deref()).await?;
    let Some(path) = choose_path(&webview_window, &name).await? else {
        return Ok(EnvExport {
            saved: false,
            path: None,
            written: Vec::new(),
            left_out: Vec::new(),
        });
    };
    let file = client.secret_env(&namespace, &name).await?;
    if file.written.is_empty() {
        return Err(SecretCommandError::other(format!(
            "No value of Secret {namespace}/{name} can be written to a .env file"
        )));
    }
    let shown = path.display().to_string();
    let text = file.text().to_string();
    let target = path.clone();
    tokio::task::spawn_blocking(move || write_private(&target, &text))
        .await
        .map_err(|_| SecretCommandError::other(format!("Could not write {shown}")))?
        .map_err(|e| SecretCommandError::other(format!("Could not write {shown}: {e}")))?;
    Ok(EnvExport {
        saved: true,
        path: Some(shown),
        written: file.written.clone(),
        left_out: file.left_out.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cubelite_core::{LeftOut, MAX_SHOWN_BYTES};

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
    fn a_whole_secret_not_offered_is_not_a_value() {
        let object = SecretCommandError::from(KubeconfigError::SecretNotOffered {
            namespace: "shop".into(),
            name: "sh.helm.release.v1.api.v7".into(),
            reason: NotOffered::HelmPayload,
        });
        assert_eq!(object.kind, SecretErrorKind::NotAValue);
        assert_eq!(
            object.message,
            "Secret shop/sh.helm.release.v1.api.v7: a Helm release payload is not a value"
        );
    }

    #[test]
    fn text_is_copied_as_it_is_and_binary_as_base64() {
        assert_eq!(
            clipboard_text(SecretValue::Text(VALUE.into())),
            (VALUE.to_string(), CopyFormat::Text)
        );
        assert_eq!(
            clipboard_text(SecretValue::Bytes(vec![0xff, 0xfe, 0x00])),
            ("//4A".to_string(), CopyFormat::Base64)
        );
        // The answer is the format only.
        assert_eq!(
            serde_json::to_value(CopyFormat::Text).expect("json"),
            "text"
        );
        assert_eq!(
            serde_json::to_value(CopyFormat::Base64).expect("json"),
            "base64"
        );
    }

    #[test]
    fn the_clear_time_comes_from_the_view_and_none_or_zero_is_never() {
        assert_eq!(clear_after(Some(30)), Some(Duration::from_secs(30)));
        assert_eq!(clear_after(Some(0)), None);
        assert_eq!(clear_after(None), None);
    }

    #[test]
    fn the_proposed_file_name_is_the_secret_s() {
        assert_eq!(proposed_file_name("api-credentials"), "api-credentials.env");
        assert_eq!(proposed_file_name("a.b"), "a.b.env");
        for odd in ["", "../x", "a/b", ".hidden", "a\\b"] {
            assert_eq!(proposed_file_name(odd), "secret.env", "{odd}");
        }
    }

    #[test]
    fn a_new_env_file_is_written_as_it_is() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("api-credentials.env");
        write_private(&path, "# c\nK='v'\n").expect("write");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "# c\nK='v'\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_env_file_is_0600_whether_created_or_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("dir");
        let mode = |p: &Path| std::fs::metadata(p).expect("meta").permissions().mode() & 0o777;

        let created = dir.path().join("new.env");
        write_private(&created, "K=v\n").expect("write");
        assert_eq!(mode(&created), 0o600);

        // An existing file, readable by all and longer than the new text.
        let existing = dir.path().join("old.env");
        std::fs::write(&existing, "OLD=a much longer text than the new one\n").expect("write");
        std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        write_private(&existing, "K=v\n").expect("write");
        assert_eq!(mode(&existing), 0o600);
        assert_eq!(std::fs::read_to_string(&existing).expect("read"), "K=v\n");
    }

    #[test]
    fn the_export_answer_names_keys_and_reasons() {
        let answer = EnvExport {
            saved: true,
            path: Some("/home/u/api-credentials.env".into()),
            written: vec!["API_KEY".into()],
            left_out: vec![LeftOutKey {
                key: "ca.crt".into(),
                reason: LeftOut::NotAName,
            }],
        };
        assert_eq!(
            serde_json::to_value(&answer).expect("json"),
            serde_json::json!({
                "saved": true,
                "path": "/home/u/api-credentials.env",
                "written": ["API_KEY"],
                "left_out": [{"key": "ca.crt", "reason": "not_a_name"}],
            })
        );
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
