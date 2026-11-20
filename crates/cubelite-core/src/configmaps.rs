//! A ConfigMap's values, one at a time, on request (#668).
//!
//! Listing ConfigMaps carries key names and sizes ([`crate::ConfigMapInfo`]):
//! a ConfigMap can hold files of up to 1 MiB, and the list stays light. One
//! value is read only by [`KubeClient::configmap_value`]. A ConfigMap value
//! is not a credential, but no value goes into an error or a `Debug` output
//! either: the rule costs nothing and keeps one habit with Secrets.

use std::fmt;

use k8s_openapi::api::core::v1::ConfigMap;
use kube::Api;

use crate::secrets::{read_error, NotOffered, MAX_SHOWN_BYTES};
use crate::{KubeClient, KubeconfigError};

/// One ConfigMap value, read from the API server: text under `data`, bytes
/// under `binaryData` (whether or not they happen to be UTF-8).
///
/// Its `Debug` prints the kind and the length only.
#[derive(Clone, PartialEq, Eq)]
pub enum ConfigMapValue {
    /// A value of `data`.
    Text(String),
    /// A value of `binaryData`, decoded.
    Bytes(Vec<u8>),
}

impl ConfigMapValue {
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

impl fmt::Debug for ConfigMapValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            Self::Text(_) => "Text",
            Self::Bytes(_) => "Bytes",
        };
        write!(f, "ConfigMapValue::{kind}({} bytes)", self.len())
    }
}

/// One value and the resource version of the ConfigMap it was read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigMapRead {
    /// The value.
    pub value: ConfigMapValue,
    /// `metadata.resourceVersion` of the ConfigMap read.
    pub resource_version: Option<String>,
}

impl KubeClient {
    /// Read the value of `key` in ConfigMap `namespace/name`, with the
    /// ConfigMap's resource version.
    ///
    /// # Errors
    ///
    /// - [`KubeconfigError::ConfigMapNotFound`]: no such ConfigMap (a 404);
    /// - [`KubeconfigError::ConfigMapKeyNotFound`]: the ConfigMap has no `key`
    ///   under `data` or `binaryData`;
    /// - [`KubeconfigError::Api`]: any other refusal (a 403 keeps its code);
    /// - [`KubeconfigError::ClientError`]: an invalid name, or a failure to
    ///   reach or read the API server. No message holds any part of a value.
    pub async fn configmap_value(
        &self,
        namespace: &str,
        name: &str,
        key: &str,
    ) -> Result<ConfigMapRead, KubeconfigError> {
        crate::names::check_object(namespace, name)?;
        let api: Api<ConfigMap> = Api::namespaced(self.client(), namespace);
        let configmap = api.get(name).await.map_err(|e| {
            let missing = KubeconfigError::ConfigMapNotFound {
                namespace: namespace.to_string(),
                name: name.to_string(),
            };
            read_error(e, &format!("ConfigMap {namespace}/{name}"), Some(missing))
        })?;
        let resource_version = configmap.metadata.resource_version;
        let value = match configmap.data.unwrap_or_default().remove(key) {
            Some(text) => Some(ConfigMapValue::Text(text)),
            None => configmap
                .binary_data
                .unwrap_or_default()
                .remove(key)
                .map(|bytes| ConfigMapValue::Bytes(bytes.0)),
        };
        let Some(value) = value else {
            return Err(KubeconfigError::ConfigMapKeyNotFound {
                namespace: namespace.to_string(),
                name: name.to_string(),
                key: key.to_string(),
            });
        };
        Ok(ConfigMapRead {
            value,
            resource_version,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{mock_client, requests};
    use crate::watcher::{configmap_to_info, ResourceInfo, WatchEvent};
    use base64::Engine;
    use http::StatusCode;
    use serde_json::Value;

    /// Two values no list output may hold, in any form.
    const SENTINEL: &str = "c0nfigm4p-s3ntinel-v4lue";
    const SENTINEL_2: &str = "bin4ry-s3ntinel-bytes";

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// Fails when `text` holds either sentinel, as it is or in base64.
    fn assert_no_sentinel(text: &str, what: &str) {
        for s in [SENTINEL, SENTINEL_2] {
            assert!(!text.contains(s), "{what} holds a value: {text}");
            assert!(
                !text.contains(&b64(s.as_bytes())),
                "{what} holds a value in base64: {text}"
            );
        }
    }

    /// A ConfigMap as the API server answers it: text and binary keys, out
    /// of order, an empty one, and a binary value that happens to be UTF-8.
    fn configmap_json() -> Value {
        serde_json::json!({
            "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": {"name": "app-config", "namespace": "shop", "resourceVersion": "77"},
            "data": {
                "application.yaml": format!("server:\n  port: 8080\n  token: {SENTINEL}\n"),
                "LOG_LEVEL": "info",
                "unused": "",
            },
            "binaryData": {
                "logo.png": b64(&[0x89, 0x50, 0x4e, 0x47, 0xff]),
                "notes.txt": b64(SENTINEL_2.as_bytes()),
            },
        })
    }

    fn configmap() -> ConfigMap {
        serde_json::from_value(configmap_json()).expect("a ConfigMap")
    }

    #[test]
    fn a_configmap_info_lists_keys_sorted_with_sizes_the_binary_mark_and_the_version() {
        let info = configmap_to_info(configmap()).expect("named");
        let keys: Vec<(&str, u64, bool)> = info
            .keys
            .iter()
            .map(|k| (k.key.as_str(), k.size, k.binary))
            .collect();
        let yaml_len = format!("server:\n  port: 8080\n  token: {SENTINEL}\n").len() as u64;
        assert_eq!(
            keys,
            vec![
                ("LOG_LEVEL", 4, false),
                ("application.yaml", yaml_len, false),
                ("logo.png", 5, true),
                // binaryData is binary, UTF-8 or not.
                ("notes.txt", SENTINEL_2.len() as u64, true),
                ("unused", 0, false),
            ]
        );
        assert_eq!(info.resource_version.as_deref(), Some("77"));
        assert_eq!(info.name, "app-config");
        assert_eq!(info.namespace, "shop");
    }

    #[test]
    fn the_size_of_a_text_value_is_its_length_in_utf8_bytes() {
        let mut cm = configmap();
        cm.data = Some([("greeting".to_string(), "héllo €".to_string())].into());
        cm.binary_data = None;
        let info = configmap_to_info(cm).expect("named");
        assert_eq!(info.keys[0].size, "héllo €".len() as u64);
        assert_eq!(info.keys[0].size, 10);
    }

    #[test]
    fn a_configmap_info_and_its_watch_event_hold_no_value() {
        let info = configmap_to_info(configmap()).expect("named");
        let json = serde_json::to_string(&info).expect("json");
        assert_no_sentinel(&json, "ConfigMapInfo");
        assert!(!json.contains("data_count"), "{json}");
        let event = WatchEvent::Applied(ResourceInfo::ConfigMap(info));
        assert_no_sentinel(&serde_json::to_string(&event).expect("json"), "watch event");
    }

    #[test]
    fn a_configmap_without_data_has_no_keys() {
        let mut cm = configmap();
        cm.data = None;
        cm.binary_data = None;
        assert!(configmap_to_info(cm).expect("named").keys.is_empty());
    }

    #[test]
    fn a_value_prints_its_kind_and_length_only() {
        let text = ConfigMapValue::Text(SENTINEL.to_string());
        assert_eq!(
            format!("{text:?}"),
            format!("ConfigMapValue::Text({} bytes)", SENTINEL.len())
        );
        let read = ConfigMapRead {
            value: ConfigMapValue::Bytes(SENTINEL_2.as_bytes().to_vec()),
            resource_version: Some("77".into()),
        };
        let debug = format!("{read:?} {read:#?}");
        assert_no_sentinel(&debug, "Debug");
        assert!(debug.contains("77"), "{debug}");
    }

    #[test]
    fn shown_text_refuses_binary_and_oversized_values() {
        let edge = "a".repeat(MAX_SHOWN_BYTES);
        assert_eq!(
            ConfigMapValue::Text(edge.clone()).into_shown_text(),
            Ok(edge.clone())
        );
        assert_eq!(
            ConfigMapValue::Text(edge + "a").into_shown_text(),
            Err(NotOffered::TooLarge)
        );
        // Bytes that are UTF-8 are still binary.
        assert_eq!(
            ConfigMapValue::Bytes(b"plain".to_vec()).into_shown_text(),
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
    async fn configmap_value_reads_one_text_value_with_the_resource_version() {
        let (client, server) = mock_client(|_, _| (StatusCode::OK, configmap_json()));
        let read = client
            .configmap_value("shop", "app-config", "LOG_LEVEL")
            .await
            .expect("value");
        assert_eq!(read.value, ConfigMapValue::Text("info".to_string()));
        assert_eq!(read.resource_version.as_deref(), Some("77"));
        let seen = requests(client, server).await;
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].uri, "/api/v1/namespaces/shop/configmaps/app-config");
    }

    #[tokio::test]
    async fn configmap_value_reads_binary_data_as_bytes_even_when_utf8() {
        let (client, _server) = mock_client(|_, _| (StatusCode::OK, configmap_json()));
        let read = client
            .configmap_value("shop", "app-config", "logo.png")
            .await
            .expect("value");
        assert_eq!(
            read.value,
            ConfigMapValue::Bytes(vec![0x89, 0x50, 0x4e, 0x47, 0xff])
        );
        let read = client
            .configmap_value("shop", "app-config", "notes.txt")
            .await
            .expect("value");
        assert_eq!(
            read.value,
            ConfigMapValue::Bytes(SENTINEL_2.as_bytes().to_vec())
        );
    }

    #[tokio::test]
    async fn configmap_value_reads_an_empty_value() {
        let (client, _server) = mock_client(|_, _| (StatusCode::OK, configmap_json()));
        let read = client
            .configmap_value("shop", "app-config", "unused")
            .await
            .expect("value");
        assert_eq!(read.value, ConfigMapValue::Text(String::new()));
    }

    #[tokio::test]
    async fn configmap_value_tells_a_missing_key_from_a_missing_configmap() {
        let (client, _server) = mock_client(|_, _| (StatusCode::OK, configmap_json()));
        let err = client
            .configmap_value("shop", "app-config", "NOPE")
            .await
            .expect_err("no key");
        assert!(
            matches!(&err, KubeconfigError::ConfigMapKeyNotFound { key, .. } if key == "NOPE"),
            "{err:?}"
        );
        assert_eq!(err.to_string(), "ConfigMap shop/app-config has no key NOPE");

        let (client, _server) = mock_client(|_, _| {
            (
                StatusCode::NOT_FOUND,
                status(404, "NotFound", "configmaps \"gone\" not found"),
            )
        });
        let err = client
            .configmap_value("shop", "gone", "LOG_LEVEL")
            .await
            .expect_err("no configmap");
        assert!(
            matches!(&err, KubeconfigError::ConfigMapNotFound { name, .. } if name == "gone"),
            "{err:?}"
        );
        assert_eq!(err.to_string(), "ConfigMap shop/gone no longer exists");
    }

    #[tokio::test]
    async fn configmap_value_keeps_a_403_as_the_api_error_it_is() {
        let message =
            "configmaps \"app-config\" is forbidden: User \"dev\" cannot get resource \"configmaps\"";
        let (client, _server) =
            mock_client(move |_, _| (StatusCode::FORBIDDEN, status(403, "Forbidden", message)));
        let err = client
            .configmap_value("shop", "app-config", "LOG_LEVEL")
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
    async fn an_answer_that_cannot_be_read_is_named_without_what_it_held() {
        // `data` that is not a map: serde quotes the string it found.
        let (client, _server) = mock_client(|_, _| {
            let mut v = configmap_json();
            v["data"] = Value::String(SENTINEL.into());
            (StatusCode::OK, v)
        });
        let err = client
            .configmap_value("shop", "app-config", "LOG_LEVEL")
            .await
            .expect_err("unreadable");
        assert_no_sentinel(&err.to_string(), "error");
        assert_no_sentinel(&format!("{err:?}"), "error Debug");
        assert!(err.to_string().contains("shop/app-config"), "{err}");
    }

    #[tokio::test]
    async fn configmap_value_rejects_a_name_that_is_not_a_name_without_a_request() {
        let (client, server) = mock_client(|_, _| (StatusCode::OK, configmap_json()));
        for (ns, name, expected) in [
            ("shop", "../secrets/x", "Invalid name \"../secrets/x\""),
            ("shop/x", "app-config", "Invalid namespace \"shop/x\""),
            ("", "app-config", "Invalid namespace \"\""),
            ("shop", "", "Invalid name \"\""),
        ] {
            let Err(KubeconfigError::ClientError { reason }) =
                client.configmap_value(ns, name, "k").await
            else {
                panic!("{ns}/{name}: expected a ClientError refusal");
            };
            assert_eq!(reason, expected);
        }
        assert!(requests(client, server).await.is_empty());
    }

    #[tokio::test]
    async fn list_configmaps_carries_keys_and_no_value() {
        let (client, _server) = mock_client(|_, _| {
            (
                StatusCode::OK,
                serde_json::json!({"apiVersion": "v1", "kind": "ConfigMapList", "metadata": {}, "items": [configmap_json()]}),
            )
        });
        let list = client.list_configmaps(Some("shop")).await.expect("list");
        assert_no_sentinel(&serde_json::to_string(&list).expect("json"), "list");
        assert_eq!(list[0].keys.len(), 5);
        assert_eq!(list[0].resource_version.as_deref(), Some("77"));
    }
}
