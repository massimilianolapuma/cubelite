//! Secret values stay in the backend until one is asked for (#661).
//!
//! Listing Secrets carries key names and sizes ([`crate::SecretInfo`]); one
//! value is read only by [`KubeClient::secret_value`], into a type that
//! cannot be serialized and whose `Debug` prints its kind and length only.
//! A Secret rendered as YAML is redacted ([`redact_secrets`]).

use std::fmt;

use base64::Engine;
use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use serde_json::Value;

use crate::{KubeClient, KubeconfigError};

/// `type` of the Secrets Helm keeps its releases in: their payload is a
/// release, not a value.
pub const HELM_RELEASE_TYPE: &str = "helm.sh/release.v1";

/// The longest text shown as a value, in bytes (64 KiB).
pub const MAX_SHOWN_BYTES: usize = 64 * 1024;

/// Values shorter than this are not looked for in annotations (§5.3).
const MIN_NEEDLE_BYTES: usize = 4;

/// The annotation `kubectl apply` writes: after it, the whole Secret.
const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// Why a value that exists is not offered as a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotOffered {
    /// The Secret holds a Helm release.
    HelmPayload,
    /// The value is not UTF-8 text.
    Binary,
    /// The text is longer than [`MAX_SHOWN_BYTES`].
    TooLarge,
}

impl fmt::Display for NotOffered {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::HelmPayload => "a Helm release payload is not a value",
            Self::Binary => "a binary value is not shown",
            Self::TooLarge => "a value over 64 KiB is not shown",
        })
    }
}

/// One Secret value, read from the API server.
///
/// Not `Serialize`, and its `Debug` prints the kind and the length only, so
/// it cannot be sent or logged by accident.
#[derive(Clone, PartialEq, Eq)]
pub enum SecretValue {
    /// Valid UTF-8.
    Text(String),
    /// Anything else.
    Bytes(Vec<u8>),
}

impl SecretValue {
    /// Length of the value, in bytes.
    pub fn len(&self) -> usize {
        match self {
            Self::Text(text) => text.len(),
            Self::Bytes(bytes) => bytes.len(),
        }
    }

    /// Whether the value is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The value as text to show: refused when binary or over
    /// [`MAX_SHOWN_BYTES`].
    ///
    /// # Errors
    ///
    /// [`NotOffered::Binary`] or [`NotOffered::TooLarge`].
    pub fn into_shown_text(self) -> Result<String, NotOffered> {
        match self {
            Self::Bytes(_) => Err(NotOffered::Binary),
            Self::Text(text) if text.len() > MAX_SHOWN_BYTES => Err(NotOffered::TooLarge),
            Self::Text(text) => Ok(text),
        }
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            Self::Text(_) => "Text",
            Self::Bytes(_) => "Bytes",
        };
        write!(f, "SecretValue::{kind}({} bytes)", self.len())
    }
}

/// One value and the resource version of the Secret it was read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevealedSecret {
    /// The value.
    pub value: SecretValue,
    /// `metadata.resourceVersion` of the Secret read.
    pub resource_version: Option<String>,
}

impl KubeClient {
    /// Read the value of `key` in Secret `namespace/name`, with the Secret's
    /// resource version.
    ///
    /// # Errors
    ///
    /// - [`KubeconfigError::SecretNotFound`]: no such Secret (a 404);
    /// - [`KubeconfigError::SecretKeyNotFound`]: the Secret has no `key`;
    /// - [`KubeconfigError::SecretValueNotOffered`]: a Helm release Secret;
    /// - [`KubeconfigError::Api`]: any other refusal (a 403 keeps its code);
    /// - [`KubeconfigError::ClientError`]: an invalid name, or a failure to
    ///   reach or read the API server. No message holds any part of a value.
    pub async fn secret_value(
        &self,
        namespace: &str,
        name: &str,
        key: &str,
    ) -> Result<RevealedSecret, KubeconfigError> {
        crate::names::check_object(namespace, name)?;
        let api: Api<Secret> = Api::namespaced(self.client(), namespace);
        let secret = api
            .get(name)
            .await
            .map_err(|e| secret_read_error(e, namespace, Some(name)))?;
        // Refused here too, so the rule does not depend on the view.
        if secret.type_.as_deref() == Some(HELM_RELEASE_TYPE) {
            return Err(KubeconfigError::SecretValueNotOffered {
                namespace: namespace.to_string(),
                name: name.to_string(),
                key: key.to_string(),
                reason: NotOffered::HelmPayload,
            });
        }
        let resource_version = secret.metadata.resource_version;
        let Some(bytes) = secret.data.unwrap_or_default().remove(key) else {
            return Err(KubeconfigError::SecretKeyNotFound {
                namespace: namespace.to_string(),
                name: name.to_string(),
                key: key.to_string(),
            });
        };
        let value = match String::from_utf8(bytes.0) {
            Ok(text) => SecretValue::Text(text),
            Err(not_text) => SecretValue::Bytes(not_text.into_bytes()),
        };
        Ok(RevealedSecret {
            value,
            resource_version,
        })
    }
}

/// A failed read of Secrets as an error that holds no part of a value: the
/// API server's status as it is (a 404 of `name` is
/// [`KubeconfigError::SecretNotFound`]), and an answer that could not be
/// read named without what the reader saw in it.
pub(crate) fn secret_read_error(
    error: kube::Error,
    namespace: &str,
    name: Option<&str>,
) -> KubeconfigError {
    let what = match name {
        Some(name) => format!("Secret {namespace}/{name}"),
        None => format!("the Secrets of {namespace}"),
    };
    let missing = name.map(|name| KubeconfigError::SecretNotFound {
        namespace: namespace.to_string(),
        name: name.to_string(),
    });
    read_error(error, &what, missing)
}

/// A failed read as an error that holds no part of what was read: the API
/// server's status as it is (a 404 is `missing`, when given), and an answer
/// that could not be read named as `what`, without what the reader saw in it.
pub(crate) fn read_error(
    error: kube::Error,
    what: &str,
    missing: Option<KubeconfigError>,
) -> KubeconfigError {
    match (error, missing) {
        (kube::Error::Api(status), Some(missing)) if status.code == 404 => missing,
        (kube::Error::Api(status), _) => KubeconfigError::Api {
            code: status.code,
            reason: if status.message.is_empty() {
                format!("the API server refused to read {what} ({})", status.code)
            } else {
                status.message
            },
        },
        // A reader's message may quote what it could not read: a value.
        (kube::Error::SerdeError(_), _) => KubeconfigError::ClientError {
            reason: format!("the API server's answer for {what} could not be read"),
        },
        (other, _) => KubeconfigError::ClientError {
            reason: other.to_string(),
        },
    }
}

/// Redact every Secret in an API answer about to be shown as YAML, decided by
/// what the answer is (`kind: Secret` of `apiVersion: v1`, or the items of a
/// `SecretList` or a `List`), not by what was asked for.
///
/// Each value under `data` and `stringData` becomes `REDACTED (12 bytes)`
/// (the decoded length); the `last-applied-configuration` annotation, and any
/// annotation holding one of the values (4 bytes or more, decoded or in
/// base64), become `REDACTED`.
pub(crate) fn redact_secrets(value: &mut Value) {
    // A typed Secret always carries `apiVersion: v1`; an answer without one is
    // taken as the core group's, so a Secret is never let through for lack of it.
    let core = value
        .get("apiVersion")
        .and_then(Value::as_str)
        .is_none_or(|v| v == "v1");
    if !core {
        return;
    }
    match value.get("kind").and_then(Value::as_str) {
        Some("Secret") => redact_secret(value),
        Some("SecretList") => {
            for item in items(value) {
                redact_secret(item);
            }
        }
        Some("List") => {
            for item in items(value) {
                redact_secrets(item);
            }
        }
        _ => {}
    }
}

fn items(value: &mut Value) -> impl Iterator<Item = &mut Value> {
    value
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
}

/// `REDACTED (n bytes)`.
fn redacted(bytes: usize) -> Value {
    let unit = if bytes == 1 { "byte" } else { "bytes" };
    Value::String(format!("REDACTED ({bytes} {unit})"))
}

/// Redact one Secret object, whatever its `kind` field says.
fn redact_secret(secret: &mut Value) {
    // What an annotation must not hold: each value, decoded and as written.
    let mut needles: Vec<String> = Vec::new();
    if let Some(data) = secret.get_mut("data").and_then(Value::as_object_mut) {
        for value in data.values_mut() {
            let decoded = value
                .as_str()
                .map(|b| base64::engine::general_purpose::STANDARD.decode(b));
            if let (Some(written), Some(Ok(bytes))) = (value.as_str(), &decoded) {
                needles.push(written.to_string());
                if let Ok(text) = std::str::from_utf8(bytes) {
                    needles.push(text.to_string());
                }
            }
            *value = match decoded {
                Some(Ok(bytes)) => redacted(bytes.len()),
                _ => Value::String("REDACTED".to_string()),
            };
        }
    }
    if let Some(data) = secret.get_mut("stringData").and_then(Value::as_object_mut) {
        for value in data.values_mut() {
            if let Some(text) = value.as_str() {
                needles.push(text.to_string());
                needles.push(base64::engine::general_purpose::STANDARD.encode(text));
            }
            *value = match value.as_str() {
                Some(text) => redacted(text.len()),
                None => Value::String("REDACTED".to_string()),
            };
        }
    }
    // A short value would match at random: it is not looked for.
    needles.retain(|n| n.len() >= MIN_NEEDLE_BYTES);
    if let Some(notes) = secret
        .get_mut("metadata")
        .and_then(|m| m.get_mut("annotations"))
        .and_then(Value::as_object_mut)
    {
        for (name, note) in notes.iter_mut() {
            let holds_a_value = note
                .as_str()
                .is_some_and(|text| needles.iter().any(|n| text.contains(n.as_str())));
            if name == LAST_APPLIED || holds_a_value {
                *note = Value::String("REDACTED".to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{mock_client, requests};
    use crate::watcher::{secret_to_info, ResourceInfo, WatchEvent};
    use http::StatusCode;

    /// Two values no output may hold, in any form.
    const SENTINEL: &str = "s3ntinel-hunter2-c4n4ry";
    const SENTINEL_2: &str = "another-s3ntinel-v4lue";

    fn b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    /// Fails when `text` holds either sentinel, decoded or in base64.
    fn assert_no_sentinel(text: &str, what: &str) {
        for s in [SENTINEL, SENTINEL_2] {
            assert!(!text.contains(s), "{what} holds a value: {text}");
            assert!(
                !text.contains(&b64(s)),
                "{what} holds a value in base64: {text}"
            );
        }
    }

    /// A Secret as the API server answers it, after a `kubectl apply`.
    fn secret_json() -> Value {
        let applied = serde_json::json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": {"name": "api", "namespace": "shop"},
            "data": {"DB_PASSWORD": b64(SENTINEL)},
            "stringData": {"TOKEN": SENTINEL_2},
        });
        serde_json::json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": {
                "name": "api", "namespace": "shop", "resourceVersion": "41",
                "annotations": {LAST_APPLIED: applied.to_string(), "team": "shop"},
            },
            "type": "Opaque",
            "data": {
                "DB_PASSWORD": b64(SENTINEL),
                "TOKEN": b64(SENTINEL_2),
                "ca.crt": base64::engine::general_purpose::STANDARD.encode([0xff_u8, 0xfe, 0x00]),
                "EMPTY": "",
            },
        })
    }

    fn secret() -> Secret {
        serde_json::from_value(secret_json()).expect("a Secret")
    }

    #[test]
    fn a_secret_info_and_its_watch_event_hold_no_value() {
        let info = secret_to_info(secret()).expect("named");
        let json = serde_json::to_string(&info).expect("json");
        assert_no_sentinel(&json, "SecretInfo");
        let event = WatchEvent::Applied(ResourceInfo::Secret(info));
        assert_no_sentinel(&serde_json::to_string(&event).expect("json"), "watch event");
    }

    #[test]
    fn a_secret_info_has_sizes_the_binary_mark_and_the_resource_version() {
        let info = secret_to_info(secret()).expect("named");
        let keys: Vec<(&str, u64, bool)> = info
            .keys
            .iter()
            .map(|k| (k.key.as_str(), k.size, k.binary))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("DB_PASSWORD", SENTINEL.len() as u64, false),
                ("EMPTY", 0, false),
                ("TOKEN", SENTINEL_2.len() as u64, false),
                ("ca.crt", 3, true),
            ]
        );
        assert!(!info.helm_release);
        assert_eq!(info.resource_version.as_deref(), Some("41"));
        assert_eq!(info.secret_type.as_deref(), Some("Opaque"));
    }

    #[test]
    fn string_data_is_not_read() {
        let mut s = secret();
        s.string_data = Some([("ONLY_WRITTEN".to_string(), "x".to_string())].into());
        let info = secret_to_info(s).expect("named");
        assert!(info.keys.iter().all(|k| k.key != "ONLY_WRITTEN"));
    }

    #[test]
    fn a_helm_release_secret_is_marked() {
        let mut s = secret();
        s.type_ = Some(HELM_RELEASE_TYPE.to_string());
        assert!(secret_to_info(s).expect("named").helm_release);
    }

    #[test]
    fn redacted_yaml_holds_no_value_and_says_how_long_each_was() {
        let yaml = crate::client::to_clean_yaml(&secret_json()).expect("yaml");
        assert_no_sentinel(&yaml, "YAML");
        assert!(
            yaml.contains(&format!("DB_PASSWORD: REDACTED ({} bytes)", SENTINEL.len())),
            "{yaml}"
        );
        assert!(yaml.contains("ca.crt: REDACTED (3 bytes)"), "{yaml}");
        assert!(yaml.contains("EMPTY: REDACTED (0 bytes)"), "{yaml}");
        assert!(
            yaml.contains("kubectl.kubernetes.io/last-applied-configuration: REDACTED"),
            "{yaml}"
        );
        // What is not a value stays.
        assert!(yaml.contains("team: shop"), "{yaml}");
        assert!(yaml.contains("type: Opaque"), "{yaml}");
    }

    #[test]
    fn an_annotation_that_holds_a_value_is_redacted_and_others_stay() {
        let mut v = secret_json();
        v["data"]["PIN"] = Value::String(b64("ab"));
        v["metadata"]["annotations"] = serde_json::json!({
            "example.com/copied-plain": format!("token={SENTINEL};"),
            "example.com/copied-b64": format!("x {} y", b64(SENTINEL_2)),
            "example.com/from-string-data": "holds nothing",
            // A value shorter than 4 bytes is not looked for: "ab" is everywhere.
            "example.com/short": "tab, cab, slab",
            "team": "shop",
        });
        v["stringData"] = serde_json::json!({"EXTRA": "string-d4ta-v4lue"});
        v["metadata"]["annotations"]["example.com/from-string-data"] =
            Value::String("see string-d4ta-v4lue".into());
        let yaml = crate::client::to_clean_yaml(&v).expect("yaml");
        assert_no_sentinel(&yaml, "YAML");
        assert!(!yaml.contains("string-d4ta-v4lue"), "{yaml}");
        assert!(
            yaml.contains("example.com/copied-plain: REDACTED"),
            "{yaml}"
        );
        assert!(yaml.contains("example.com/copied-b64: REDACTED"), "{yaml}");
        assert!(
            yaml.contains("example.com/from-string-data: REDACTED"),
            "{yaml}"
        );
        assert!(yaml.contains("example.com/short: tab, cab, slab"), "{yaml}");
        assert!(yaml.contains("team: shop"), "{yaml}");
    }

    #[test]
    fn string_data_is_redacted_too() {
        let mut v = secret_json();
        v["stringData"] = serde_json::json!({"TOKEN": SENTINEL_2, "ONE": "x"});
        let yaml = crate::client::to_clean_yaml(&v).expect("yaml");
        assert_no_sentinel(&yaml, "YAML");
        assert!(yaml.contains("ONE: REDACTED (1 byte)"), "{yaml}");
    }

    #[test]
    fn every_item_of_a_secret_list_is_redacted() {
        // Items of a SecretList carry no apiVersion and kind of their own.
        let mut bare = secret_json();
        if let Some(o) = bare.as_object_mut() {
            o.remove("apiVersion");
            o.remove("kind");
        }
        let list = serde_json::json!({
            "apiVersion": "v1", "kind": "SecretList", "metadata": {}, "items": [bare.clone(), bare],
        });
        assert_no_sentinel(
            &crate::client::to_clean_yaml(&list).expect("yaml"),
            "SecretList",
        );
        // A plain List names each item's kind.
        let list = serde_json::json!({
            "apiVersion": "v1", "kind": "List", "metadata": {}, "items": [secret_json()],
        });
        assert_no_sentinel(&crate::client::to_clean_yaml(&list).expect("yaml"), "List");
    }

    #[test]
    fn what_is_not_a_secret_is_not_redacted() {
        let cm = serde_json::json!({
            "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": {"name": "settings", "annotations": {LAST_APPLIED: "{}"}},
            "data": {"mode": "fast"},
        });
        let yaml = crate::client::to_clean_yaml(&cm).expect("yaml");
        assert!(yaml.contains("mode: fast"), "{yaml}");
        assert!(!yaml.contains("REDACTED"), "{yaml}");
        // A kind called Secret in another group is somebody else's.
        let other = serde_json::json!({
            "apiVersion": "example.com/v1", "kind": "Secret", "data": {"mode": "fast"},
        });
        assert!(!crate::client::to_clean_yaml(&other)
            .expect("yaml")
            .contains("REDACTED"));
    }

    #[test]
    fn a_value_prints_its_kind_and_length_only() {
        let text = SecretValue::Text(SENTINEL.to_string());
        assert_eq!(
            format!("{text:?}"),
            format!("SecretValue::Text({} bytes)", SENTINEL.len())
        );
        let bytes = SecretValue::Bytes(SENTINEL.as_bytes().to_vec());
        assert_eq!(
            format!("{bytes:?}"),
            format!("SecretValue::Bytes({} bytes)", SENTINEL.len())
        );
        let revealed = RevealedSecret {
            value: text,
            resource_version: Some("41".into()),
        };
        let debug = format!("{revealed:?} {revealed:#?}");
        assert_no_sentinel(&debug, "Debug");
        assert!(debug.contains("41"), "{debug}");
    }

    #[test]
    fn shown_text_refuses_binary_and_oversized_values() {
        assert_eq!(
            SecretValue::Text("ok".into()).into_shown_text(),
            Ok("ok".to_string())
        );
        let edge = "a".repeat(MAX_SHOWN_BYTES);
        assert_eq!(
            SecretValue::Text(edge.clone()).into_shown_text(),
            Ok(edge.clone())
        );
        assert_eq!(
            SecretValue::Text(edge + "a").into_shown_text(),
            Err(NotOffered::TooLarge)
        );
        assert_eq!(
            SecretValue::Bytes(vec![0xff]).into_shown_text(),
            Err(NotOffered::Binary)
        );
    }

    fn status(code: u16, reason: &str, message: &str) -> Value {
        serde_json::json!({
            "kind": "Status", "apiVersion": "v1", "status": "Failure",
            "code": code, "reason": reason, "message": message,
        })
    }

    #[tokio::test]
    async fn secret_value_reads_one_text_value_with_the_resource_version() {
        let (client, server) = mock_client(|_, _| (StatusCode::OK, secret_json()));
        let revealed = client
            .secret_value("shop", "api", "DB_PASSWORD")
            .await
            .expect("value");
        assert_eq!(revealed.value, SecretValue::Text(SENTINEL.to_string()));
        assert_eq!(revealed.resource_version.as_deref(), Some("41"));
        let seen = requests(client, server).await;
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].uri, "/api/v1/namespaces/shop/secrets/api");
    }

    #[tokio::test]
    async fn secret_value_reads_a_binary_value_as_bytes() {
        let (client, _server) = mock_client(|_, _| (StatusCode::OK, secret_json()));
        let revealed = client
            .secret_value("shop", "api", "ca.crt")
            .await
            .expect("value");
        assert_eq!(revealed.value, SecretValue::Bytes(vec![0xff, 0xfe, 0x00]));
    }

    #[tokio::test]
    async fn secret_value_tells_a_missing_key_from_a_missing_secret() {
        let (client, _server) = mock_client(|_, _| (StatusCode::OK, secret_json()));
        let err = client
            .secret_value("shop", "api", "NOPE")
            .await
            .expect_err("no key");
        assert!(
            matches!(&err, KubeconfigError::SecretKeyNotFound { key, .. } if key == "NOPE"),
            "{err:?}"
        );

        let (client, _server) = mock_client(|_, _| {
            (
                StatusCode::NOT_FOUND,
                status(404, "NotFound", "secrets \"gone\" not found"),
            )
        });
        let err = client
            .secret_value("shop", "gone", "DB_PASSWORD")
            .await
            .expect_err("no secret");
        assert!(
            matches!(&err, KubeconfigError::SecretNotFound { name, .. } if name == "gone"),
            "{err:?}"
        );
        assert_eq!(err.to_string(), "Secret shop/gone no longer exists");
    }

    #[tokio::test]
    async fn secret_value_keeps_a_403_as_the_api_error_it_is() {
        let message = "secrets \"api\" is forbidden: User \"dev\" cannot get resource \"secrets\"";
        let (client, _server) =
            mock_client(move |_, _| (StatusCode::FORBIDDEN, status(403, "Forbidden", message)));
        let err = client
            .secret_value("shop", "api", "DB_PASSWORD")
            .await
            .expect_err("403");
        match err {
            KubeconfigError::Api { code, reason } => {
                assert_eq!(code, 403);
                assert_eq!(reason, message);
            }
            other => panic!("not an API error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn secret_value_refuses_a_helm_release() {
        let (client, _server) = mock_client(|_, _| {
            let mut v = secret_json();
            v["type"] = Value::String(HELM_RELEASE_TYPE.into());
            (StatusCode::OK, v)
        });
        let err = client
            .secret_value("shop", "api", "DB_PASSWORD")
            .await
            .expect_err("helm");
        assert!(
            matches!(
                &err,
                KubeconfigError::SecretValueNotOffered {
                    reason: NotOffered::HelmPayload,
                    ..
                }
            ),
            "{err:?}"
        );
        assert_eq!(
            err.to_string(),
            "DB_PASSWORD of Secret shop/api: a Helm release payload is not a value"
        );
    }

    #[tokio::test]
    async fn an_answer_that_cannot_be_read_is_named_without_what_it_held() {
        // `data` that is not a map: serde quotes the string it found.
        let (client, _server) = mock_client(|_, _| {
            let mut v = secret_json();
            v["data"] = Value::String(SENTINEL.into());
            (StatusCode::OK, v)
        });
        let err = client
            .secret_value("shop", "api", "DB_PASSWORD")
            .await
            .expect_err("unreadable");
        assert_no_sentinel(&err.to_string(), "error");
        assert_no_sentinel(&format!("{err:?}"), "error Debug");
        assert!(err.to_string().contains("shop/api"), "{err}");
    }

    #[tokio::test]
    async fn get_resource_yaml_of_a_secret_is_redacted() {
        let (client, _server) = mock_client(|_, _| (StatusCode::OK, secret_json()));
        let yaml = client
            .get_resource_yaml(crate::ResourceType::Secret, "shop", "api")
            .await
            .expect("yaml");
        assert_no_sentinel(&yaml, "typed YAML");
        assert!(yaml.contains("DB_PASSWORD: REDACTED"), "{yaml}");
        assert!(
            yaml.contains("kubectl.kubernetes.io/last-applied-configuration: REDACTED"),
            "{yaml}"
        );

        let (client, _server) = mock_client(|_, _| {
            let mut v = secret_json();
            v["data"] = Value::String(SENTINEL.into());
            (StatusCode::OK, v)
        });
        let err = client
            .get_resource_yaml(crate::ResourceType::Secret, "shop", "api")
            .await
            .expect_err("unreadable");
        assert_no_sentinel(&err.to_string(), "YAML error");
    }

    #[tokio::test]
    async fn apply_resource_yaml_refuses_a_secret_without_a_request() {
        let (client, server) = mock_client(|_, _| (StatusCode::OK, secret_json()));
        let yaml = crate::client::to_clean_yaml(&secret_json()).expect("yaml");
        let err = client
            .apply_resource_yaml(crate::ResourceType::Secret, "shop", "api", &yaml)
            .await
            .expect_err("refused");
        assert!(err.to_string().contains("redacted"), "{err}");
        assert!(requests(client, server).await.is_empty());
    }

    #[tokio::test]
    async fn list_secrets_reads_no_value_and_names_an_unreadable_answer_without_it() {
        let (client, _server) = mock_client(|_, _| {
            (
                StatusCode::OK,
                serde_json::json!({"apiVersion": "v1", "kind": "SecretList", "metadata": {}, "items": [secret_json()]}),
            )
        });
        let list = client.list_secrets(Some("shop")).await.expect("list");
        assert_no_sentinel(&serde_json::to_string(&list).expect("json"), "list");
        assert_eq!(list[0].keys.len(), 4);

        let (client, _server) = mock_client(|_, _| {
            // `data` that is not a map: serde quotes the string it found.
            let mut item = secret_json();
            item["data"] = Value::String(SENTINEL.into());
            (
                StatusCode::OK,
                serde_json::json!({"apiVersion": "v1", "kind": "SecretList", "metadata": {}, "items": [item]}),
            )
        });
        let err = client
            .list_secrets(Some("shop"))
            .await
            .expect_err("unreadable");
        assert_no_sentinel(&err.to_string(), "list error");
    }

    #[tokio::test]
    async fn secret_value_rejects_a_name_that_is_not_a_name_without_a_request() {
        let (client, server) = mock_client(|_, _| (StatusCode::OK, secret_json()));
        // The shared check (#671): a namespace is a DNS label, a Secret's
        // name a DNS subdomain, and the message shows the value refused, cut
        // at 80 characters.
        let long = "n".repeat(254);
        let cut = format!("Invalid name \"{}…\"", "n".repeat(80));
        for (ns, name, expected) in [
            (
                "shop",
                "../configmaps/x",
                "Invalid name \"../configmaps/x\"",
            ),
            ("shop/x", "api", "Invalid namespace \"shop/x\""),
            ("", "api", "Invalid namespace \"\""),
            ("shop", "", "Invalid name \"\""),
            ("kube.system", "api", "Invalid namespace \"kube.system\""),
            ("shop", "a..b", "Invalid name \"a..b\""),
            ("shop", long.as_str(), cut.as_str()),
        ] {
            // The result is not printed on failure: on a wrong Ok it would
            // carry a Secret value into the test output.
            let Err(KubeconfigError::ClientError { reason }) =
                client.secret_value(ns, name, "k").await
            else {
                panic!("{ns}/{name}: expected a ClientError refusal");
            };
            assert_eq!(reason, expected);
        }
        assert!(requests(client, server).await.is_empty());
    }
}
