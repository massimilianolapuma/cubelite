//! Helm v3 release discovery via release secrets.
//!
//! Helm stores each release revision in a Secret of type
//! `helm.sh/release.v1` labelled `owner=helm`, with the payload in
//! `data.release`: base64 text wrapping a gzip-compressed JSON document.
//! [`parse_release_secret`] reads the cheap metadata from labels and
//! decodes the payload for chart/app-version/updated details.

use std::collections::BTreeMap;
use std::io::Read;

use base64::Engine;
use k8s_openapi::api::core::v1::Secret;
use serde::{Deserialize, Serialize};

/// Lightweight representation of a Helm release (latest revision).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HelmReleaseInfo {
    /// Release name.
    pub name: String,
    /// Namespace the release is installed into.
    pub namespace: String,
    /// Revision number.
    pub revision: i32,
    /// Release status (e.g. `"deployed"`, `"pending-upgrade"`, `"failed"`).
    pub status: Option<String>,
    /// Chart `name-version` (e.g. `"nginx-15.1.2"`), when decodable.
    pub chart: Option<String>,
    /// Chart appVersion, when decodable.
    pub app_version: Option<String>,
    /// RFC 3339 last-deployed timestamp (falls back to secret creation).
    pub updated: Option<String>,
}

/// Decode the double-encoded Helm payload: base64 text → gzip → JSON.
fn decode_release_payload(raw: &[u8]) -> Option<serde_json::Value> {
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(raw.strip_suffix(b"\n").unwrap_or(raw))
        .ok()?;
    let mut json = String::new();
    flate2::read::GzDecoder::new(compressed.as_slice())
        .read_to_string(&mut json)
        .ok()?;
    serde_json::from_str(&json).ok()
}

/// Parse a Helm release secret into a [`HelmReleaseInfo`].
///
/// Returns `None` when the secret is not a Helm release secret (missing
/// the `name` label or the `release` payload key).
pub fn parse_release_secret(secret: &Secret) -> Option<HelmReleaseInfo> {
    let labels: &BTreeMap<String, String> = secret.metadata.labels.as_ref()?;
    let name = labels.get("name")?.clone();
    let namespace = secret.metadata.namespace.clone().unwrap_or_default();
    let revision = labels
        .get("version")
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(0);
    let status = labels.get("status").cloned();

    let payload = secret
        .data
        .as_ref()
        .and_then(|d| d.get("release"))
        .and_then(|bs| decode_release_payload(&bs.0));

    let (chart, app_version, updated) = match &payload {
        Some(doc) => {
            let meta = &doc["chart"]["metadata"];
            let chart = match (meta["name"].as_str(), meta["version"].as_str()) {
                (Some(n), Some(v)) => Some(format!("{n}-{v}")),
                (Some(n), None) => Some(n.to_string()),
                _ => None,
            };
            let app_version = meta["appVersion"].as_str().map(str::to_string);
            let updated = doc["info"]["last_deployed"].as_str().map(str::to_string);
            (chart, app_version, updated)
        }
        None => (None, None, None),
    };

    let updated = updated.or_else(|| {
        secret
            .metadata
            .creation_timestamp
            .as_ref()
            .map(|t| t.0.to_rfc3339())
    });

    Some(HelmReleaseInfo {
        name,
        namespace,
        revision,
        status,
        chart,
        app_version,
        updated,
    })
}

/// Keep only the latest revision per (namespace, release name), sorted by name.
pub fn latest_releases(mut releases: Vec<HelmReleaseInfo>) -> Vec<HelmReleaseInfo> {
    let mut latest: BTreeMap<(String, String), HelmReleaseInfo> = BTreeMap::new();
    for release in releases.drain(..) {
        let key = (release.namespace.clone(), release.name.clone());
        match latest.get(&key) {
            Some(existing) if existing.revision >= release.revision => {}
            _ => {
                latest.insert(key, release);
            }
        }
    }
    latest.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
    use k8s_openapi::ByteString;
    use std::io::Write;

    fn helm_secret(name: &str, revision: &str, status: &str, payload: Option<&str>) -> Secret {
        let mut data = BTreeMap::new();
        if let Some(json) = payload {
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            gz.write_all(json.as_bytes()).expect("gzip write");
            let compressed = gz.finish().expect("gzip finish");
            let encoded = base64::engine::general_purpose::STANDARD.encode(compressed);
            data.insert("release".to_string(), ByteString(encoded.into_bytes()));
        }
        Secret {
            metadata: ObjectMeta {
                name: Some(format!("sh.helm.release.v1.{name}.v{revision}")),
                namespace: Some("default".to_string()),
                labels: Some(BTreeMap::from([
                    ("owner".to_string(), "helm".to_string()),
                    ("name".to_string(), name.to_string()),
                    ("version".to_string(), revision.to_string()),
                    ("status".to_string(), status.to_string()),
                ])),
                ..Default::default()
            },
            type_: Some("helm.sh/release.v1".to_string()),
            data: Some(data),
            ..Default::default()
        }
    }

    #[test]
    fn parses_labels_and_decoded_payload() {
        let payload = r#"{
            "chart": { "metadata": { "name": "nginx", "version": "15.1.2", "appVersion": "1.27" } },
            "info": { "last_deployed": "2026-07-10T09:00:00Z" }
        }"#;
        let secret = helm_secret("web", "3", "deployed", Some(payload));
        let info = parse_release_secret(&secret).expect("parse");
        assert_eq!(info.name, "web");
        assert_eq!(info.revision, 3);
        assert_eq!(info.status.as_deref(), Some("deployed"));
        assert_eq!(info.chart.as_deref(), Some("nginx-15.1.2"));
        assert_eq!(info.app_version.as_deref(), Some("1.27"));
        assert_eq!(info.updated.as_deref(), Some("2026-07-10T09:00:00Z"));
    }

    #[test]
    fn survives_undecodable_payload() {
        let mut secret = helm_secret("web", "1", "failed", None);
        secret.data = Some(BTreeMap::from([(
            "release".to_string(),
            ByteString(b"not-base64!!".to_vec()),
        )]));
        let info = parse_release_secret(&secret).expect("parse");
        assert_eq!(info.status.as_deref(), Some("failed"));
        assert!(info.chart.is_none());
    }

    #[test]
    fn ignores_non_helm_secrets() {
        let secret = Secret::default();
        assert!(parse_release_secret(&secret).is_none());
    }

    #[test]
    fn latest_releases_keeps_max_revision_per_release() {
        let mk = |name: &str, rev: i32| HelmReleaseInfo {
            name: name.to_string(),
            namespace: "default".to_string(),
            revision: rev,
            ..Default::default()
        };
        let out = latest_releases(vec![mk("web", 1), mk("web", 3), mk("db", 2), mk("web", 2)]);
        assert_eq!(out.len(), 2);
        let web = out.iter().find(|r| r.name == "web").expect("web");
        assert_eq!(web.revision, 3);
    }
}
