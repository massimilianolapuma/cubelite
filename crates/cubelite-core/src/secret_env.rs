//! A Secret as a `.env` file, written for a shell (#661, spec §5.4).
//!
//! `set -a; . ./api-credentials.env` gives back every written value exactly
//! as it is in the Secret: a value made only of safe characters is written
//! bare, any other in single quotes (a `'` inside as `'\''`), line breaks
//! included. Binary values, values with a NUL (a shell cannot hold one) and
//! keys that are not variable names are left out and named, not transformed.
//! A Helm release Secret is refused whole.

use std::fmt;

use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use serde::Serialize;

use crate::secrets::{secret_read_error, NotOffered, SecretValue, HELM_RELEASE_TYPE};
use crate::{KubeClient, KubeconfigError};

/// Why a key of the Secret is not in the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LeftOut {
    /// The key is not `[A-Za-z_][A-Za-z0-9_]*`.
    NotAName,
    /// The value is not UTF-8 text.
    Binary,
    /// The value holds a NUL character.
    Nul,
}

/// A key left out of the file, with the reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeftOutKey {
    pub key: String,
    pub reason: LeftOut,
}

/// The text of a `.env` file and what went into it.
///
/// Not `Serialize`, and its `Debug` prints the text's length only: the text
/// holds the values.
#[derive(Clone, PartialEq, Eq)]
pub struct EnvFile {
    text: String,
    /// Keys written, sorted.
    pub written: Vec<String>,
    /// Keys left out, sorted, each with its reason.
    pub left_out: Vec<LeftOutKey>,
}

impl EnvFile {
    /// The file's text.
    pub fn text(&self) -> &str {
        &self.text
    }
}

impl fmt::Debug for EnvFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EnvFile")
            .field("text", &format_args!("{} bytes", self.text.len()))
            .field("written", &self.written)
            .field("left_out", &self.left_out)
            .finish()
    }
}

/// Whether `key` can be a shell variable's name: `[A-Za-z_][A-Za-z0-9_]*`.
pub fn is_env_name(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Characters a value may hold and still be written bare.
fn is_bare(c: char) -> bool {
    c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c)
}

/// A value as a shell reads it back exactly (POSIX quoting).
fn quoted(value: &str) -> String {
    if value.chars().all(is_bare) {
        // Bare, or empty: `KEY=`.
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// The `.env` text of Secret `namespace/name` with `values`, exported at
/// `at` (RFC 3339): a comment line, then one `KEY=value` line per written
/// key, sorted by key, and a final newline.
pub fn env_file(
    namespace: &str,
    name: &str,
    values: impl IntoIterator<Item = (String, SecretValue)>,
    at: &str,
) -> EnvFile {
    let mut values: Vec<(String, SecretValue)> = values.into_iter().collect();
    values.sort_by(|a, b| a.0.cmp(&b.0));
    let mut text = format!("# {namespace}/{name}, exported by CubeLite {at}\n");
    let mut written = Vec::new();
    let mut left_out = Vec::new();
    for (key, value) in values {
        // The value's reason first: `ca.crt` is binary before it is a bad name.
        let reason = match &value {
            SecretValue::Bytes(_) => Some(LeftOut::Binary),
            SecretValue::Text(text) if text.contains('\0') => Some(LeftOut::Nul),
            SecretValue::Text(_) if !is_env_name(&key) => Some(LeftOut::NotAName),
            SecretValue::Text(_) => None,
        };
        match (reason, value) {
            (Some(reason), _) => left_out.push(LeftOutKey { key, reason }),
            (None, SecretValue::Text(value)) => {
                text.push_str(&key);
                text.push('=');
                text.push_str(&quoted(&value));
                text.push('\n');
                written.push(key);
            }
            // Binary is a reason above.
            (None, SecretValue::Bytes(_)) => {}
        }
    }
    EnvFile {
        text,
        written,
        left_out,
    }
}

impl KubeClient {
    /// Read Secret `namespace/name` and make its `.env` text, stamped now.
    ///
    /// # Errors
    ///
    /// - [`KubeconfigError::SecretNotFound`]: no such Secret (a 404);
    /// - [`KubeconfigError::SecretNotOffered`]: a Helm release Secret;
    /// - [`KubeconfigError::Api`]: any other refusal (a 403 keeps its code);
    /// - [`KubeconfigError::ClientError`]: an invalid name, or a failure to
    ///   reach or read the API server. No message holds any part of a value.
    pub async fn secret_env(
        &self,
        namespace: &str,
        name: &str,
    ) -> Result<EnvFile, KubeconfigError> {
        // The check `secret_value` makes, before any request.
        if !crate::dynamic::is_path_segment(namespace) || !crate::dynamic::is_path_segment(name) {
            return Err(KubeconfigError::ClientError {
                reason: format!("invalid Secret reference {namespace}/{name}"),
            });
        }
        let api: Api<Secret> = Api::namespaced(self.client(), namespace);
        let secret = api
            .get(name)
            .await
            .map_err(|e| secret_read_error(e, namespace, Some(name)))?;
        if secret.type_.as_deref() == Some(HELM_RELEASE_TYPE) {
            return Err(KubeconfigError::SecretNotOffered {
                namespace: namespace.to_string(),
                name: name.to_string(),
                reason: NotOffered::HelmPayload,
            });
        }
        let values = secret
            .data
            .unwrap_or_default()
            .into_iter()
            .map(|(key, bytes)| {
                let value = match String::from_utf8(bytes.0) {
                    Ok(text) => SecretValue::Text(text),
                    Err(not_text) => SecretValue::Bytes(not_text.into_bytes()),
                };
                (key, value)
            });
        Ok(env_file(namespace, name, values, &now()))
    }
}

/// Now, to the second, in RFC 3339 (`2026-11-14T09:30:00Z`).
fn now() -> String {
    let now = k8s_openapi::jiff::Timestamp::now();
    k8s_openapi::jiff::Timestamp::from_second(now.as_second())
        .unwrap_or(now)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{mock_client, requests};
    use http::StatusCode;
    use serde_json::Value;

    const AT: &str = "2026-11-14T09:30:00Z";

    fn text(key: &str, value: &str) -> (String, SecretValue) {
        (key.to_string(), SecretValue::Text(value.to_string()))
    }

    fn file(values: Vec<(String, SecretValue)>) -> EnvFile {
        env_file("shop", "api-credentials", values, AT)
    }

    fn lines(f: &EnvFile) -> Vec<&str> {
        f.text().lines().skip(1).collect()
    }

    #[test]
    fn a_comment_line_then_one_line_per_key_sorted_with_a_final_newline() {
        let f = file(vec![
            text("DB_USER", "shop"),
            text("API_KEY", "ak"),
            text("B", "b"),
        ]);
        assert_eq!(
            f.text(),
            "# shop/api-credentials, exported by CubeLite 2026-11-14T09:30:00Z\n\
             API_KEY=ak\nB=b\nDB_USER=shop\n"
        );
        assert_eq!(f.written, ["API_KEY", "B", "DB_USER"]);
        assert!(f.left_out.is_empty());
    }

    #[test]
    fn a_value_of_safe_characters_only_is_written_bare() {
        let safe = "AZaz09_@%+=:,./-";
        assert_eq!(lines(&file(vec![text("K", safe)])), [format!("K={safe}")]);
    }

    #[test]
    fn an_empty_value_is_written_as_key_equals() {
        assert_eq!(lines(&file(vec![text("EMPTY", "")])), ["EMPTY="]);
        assert_eq!(file(vec![text("EMPTY", "")]).written, ["EMPTY"]);
    }

    #[test]
    fn any_other_value_is_written_in_single_quotes_as_it_is() {
        for (value, written) in [
            ("two words", "'two words'"),
            ("$HOME", "'$HOME'"),
            ("`id`", "'`id`'"),
            (r#"say "hi""#, r#"'say "hi"'"#),
            (r"back\slash", r"'back\slash'"),
            ("~/x", "'~/x'"),
            ("a*b", "'a*b'"),
            ("tab\there", "'tab\there'"),
        ] {
            assert_eq!(
                lines(&file(vec![text("K", value)])),
                [format!("K={written}")],
                "{value}"
            );
        }
    }

    #[test]
    fn line_breaks_stay_inside_the_quotes() {
        let f = file(vec![text("PEM", "line one\nline two\n")]);
        assert_eq!(
            f.text().split_once('\n').map(|(_, rest)| rest),
            Some("PEM='line one\nline two\n'\n")
        );
    }

    #[test]
    fn a_single_quote_inside_is_written_as_quote_backslash_quote_quote() {
        assert_eq!(lines(&file(vec![text("K", "it's")])), [r"K='it'\''s'"]);
    }

    #[test]
    fn binary_values_values_with_a_nul_and_keys_that_are_not_names_are_left_out() {
        let f = file(vec![
            text("OK", "fine"),
            ("CA".to_string(), SecretValue::Bytes(vec![0xff, 0xfe])),
            text("WITH_NUL", "a\0b"),
            text("tls.crt", "pem"),
            text(".dockerconfigjson", "{}"),
            text("1ABC", "x"),
            text("A-B", "x"),
            text("", "x"),
            ("bin.crt".to_string(), SecretValue::Bytes(vec![0xff])),
            text("nul.key", "a\0b"),
        ]);
        assert_eq!(f.written, ["OK"]);
        let left: Vec<(&str, LeftOut)> = f
            .left_out
            .iter()
            .map(|k| (k.key.as_str(), k.reason))
            .collect();
        assert_eq!(
            left,
            [
                ("", LeftOut::NotAName),
                (".dockerconfigjson", LeftOut::NotAName),
                ("1ABC", LeftOut::NotAName),
                ("A-B", LeftOut::NotAName),
                ("CA", LeftOut::Binary),
                ("WITH_NUL", LeftOut::Nul),
                // The value's reason before the name's.
                ("bin.crt", LeftOut::Binary),
                ("nul.key", LeftOut::Nul),
                ("tls.crt", LeftOut::NotAName),
            ]
        );
        assert_eq!(lines(&f), ["OK=fine"]);
        assert!(!f.text().contains("pem"));
    }

    #[test]
    fn variable_names() {
        for good in ["A", "_", "_a1", "API_KEY", "a"] {
            assert!(is_env_name(good), "{good}");
        }
        for bad in ["", "1A", "A-B", "a.b", "é", "A B", "A=B"] {
            assert!(!is_env_name(bad), "{bad}");
        }
    }

    #[test]
    fn the_reasons_serialize_for_the_view() {
        for (reason, json) in [
            (LeftOut::NotAName, "not_a_name"),
            (LeftOut::Binary, "binary"),
            (LeftOut::Nul, "nul"),
        ] {
            assert_eq!(serde_json::to_value(reason).expect("json"), json);
        }
    }

    #[test]
    fn the_debug_output_holds_no_value() {
        let f = file(vec![text("K", "s3ntinel-v4lue")]);
        let debug = format!("{f:?} {f:#?}");
        assert!(!debug.contains("s3ntinel-v4lue"), "{debug}");
        assert!(debug.contains("bytes"), "{debug}");
    }

    /// What a shell reads back from the file is what was written, exactly.
    #[cfg(unix)]
    #[test]
    fn a_shell_reads_every_value_back_exactly() {
        let values = [
            ("PLAIN", "abc-123_x.y/z:1,2@h%+="),
            ("SPACES", "  two  spaces  "),
            ("DOUBLE", r#"say "hi""#),
            ("SINGLE", "it's 'quoted'"),
            ("DOLLAR", "$HOME ${PATH} $(id)"),
            ("BACKTICK", "`id` and `uname`"),
            ("BACKSLASH", r"C:\path\n\\ end\"),
            ("NEWLINES", "line one\nline two\n\nlast\n"),
            ("EMPTY", ""),
            ("GLOB", "*.txt ? [a-z] ~"),
            ("MIXED", "'\"$`\\\n\t!#;&|<>(){}"),
        ];
        let f = file(values.iter().map(|(k, v)| text(k, v)).collect());
        assert_eq!(f.written.len(), values.len());
        let dir = tempfile::tempdir().expect("dir");
        std::fs::write(dir.path().join("f.env"), f.text()).expect("write");
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("set -a; . ./f.env; exec env -0")
            .current_dir(dir.path())
            .env_clear()
            .output()
            .expect("sh");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let env = String::from_utf8(out.stdout).expect("utf-8");
        let read: std::collections::BTreeMap<&str, &str> = env
            .split('\0')
            .filter_map(|entry| entry.split_once('='))
            .collect();
        for (key, value) in values {
            assert_eq!(read.get(key), Some(&value), "{key}");
        }
    }

    fn secret_json() -> Value {
        let b64 = |b: &[u8]| {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(b)
        };
        serde_json::json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": {"name": "api", "namespace": "shop", "resourceVersion": "41"},
            "type": "Opaque",
            "data": {
                "DB_PASSWORD": b64(b"s3cr3t p4ss"),
                "API_KEY": b64(b"ak"),
                "ca.crt": b64(&[0xff, 0xfe]),
                "BLOB": b64(&[0xff]),
            },
        })
    }

    #[tokio::test]
    async fn secret_env_reads_the_secret_once_and_writes_its_text_values() {
        let (client, server) = mock_client(|_, _| (StatusCode::OK, secret_json()));
        let f = client.secret_env("shop", "api").await.expect("env");
        assert_eq!(f.written, ["API_KEY", "DB_PASSWORD"]);
        assert_eq!(
            f.left_out,
            [
                LeftOutKey {
                    key: "BLOB".into(),
                    reason: LeftOut::Binary
                },
                LeftOutKey {
                    key: "ca.crt".into(),
                    reason: LeftOut::Binary
                },
            ]
        );
        let (head, body) = f.text().split_once('\n').expect("comment");
        assert!(
            head.starts_with("# shop/api, exported by CubeLite "),
            "{head}"
        );
        assert!(head.ends_with('Z'), "{head}");
        assert_eq!(body, "API_KEY=ak\nDB_PASSWORD='s3cr3t p4ss'\n");
        let seen = requests(client, server).await;
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].uri, "/api/v1/namespaces/shop/secrets/api");
    }

    #[tokio::test]
    async fn secret_env_refuses_a_helm_release_whole() {
        let (client, _server) = mock_client(|_, _| {
            let mut v = secret_json();
            v["type"] = Value::String(HELM_RELEASE_TYPE.into());
            (StatusCode::OK, v)
        });
        let err = client.secret_env("shop", "api").await.expect_err("helm");
        assert!(
            matches!(
                &err,
                KubeconfigError::SecretNotOffered {
                    reason: NotOffered::HelmPayload,
                    ..
                }
            ),
            "{err:?}"
        );
        assert_eq!(
            err.to_string(),
            "Secret shop/api: a Helm release payload is not a value"
        );
    }

    #[tokio::test]
    async fn secret_env_tells_a_missing_secret_and_keeps_a_403() {
        let (client, _server) = mock_client(|_, _| {
            (
                StatusCode::NOT_FOUND,
                serde_json::json!({"kind": "Status", "apiVersion": "v1", "status": "Failure",
                    "code": 404, "reason": "NotFound", "message": "secrets \"api\" not found"}),
            )
        });
        let err = client.secret_env("shop", "api").await.expect_err("404");
        assert!(
            matches!(err, KubeconfigError::SecretNotFound { .. }),
            "{err:?}"
        );

        let (client, _server) = mock_client(|_, _| {
            (
                StatusCode::FORBIDDEN,
                serde_json::json!({"kind": "Status", "apiVersion": "v1", "status": "Failure",
                    "code": 403, "reason": "Forbidden", "message": "forbidden"}),
            )
        });
        let err = client.secret_env("shop", "api").await.expect_err("403");
        assert!(
            matches!(err, KubeconfigError::Api { code: 403, .. }),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn secret_env_rejects_a_name_that_is_not_a_name_without_a_request() {
        let (client, server) = mock_client(|_, _| (StatusCode::OK, secret_json()));
        for (ns, name) in [
            ("shop", "../configmaps/x"),
            ("shop/x", "api"),
            ("", "api"),
            ("shop", ""),
        ] {
            assert!(client.secret_env(ns, name).await.is_err(), "{ns}/{name}");
        }
        assert!(requests(client, server).await.is_empty());
    }
}
