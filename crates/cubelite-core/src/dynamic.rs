//! Any resource kind, without a typed client: discovery of the kinds a
//! cluster serves, lists through the API server's Table (the columns
//! `kubectl get` prints) and single objects as YAML.

use kube::discovery::{verbs, Discovery, Scope};
use serde::{Deserialize, Serialize};

use crate::{KubeClient, KubeconfigError};

/// `Accept` for aggregated discovery (`apidiscovery.k8s.io/v2`, GA in 1.30).
const AGGREGATED_DISCOVERY: &str =
    "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList";

/// One listable resource kind the cluster serves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceKindInfo {
    /// API group; `""` for the core group (`/api/v1`).
    pub group: String,
    /// The group's preferred version (the first one discovery lists).
    pub version: String,
    /// Kind, e.g. `HorizontalPodAutoscaler`.
    pub kind: String,
    /// Plural resource name used in URLs, e.g. `horizontalpodautoscalers`.
    pub plural: String,
    /// Whether objects live in a namespace.
    pub namespaced: bool,
    /// Short names (`hpa`), empty when the server lists none.
    pub short_names: Vec<String>,
}

// Serde mirrors of the `apidiscovery.k8s.io/v2` APIGroupDiscoveryList.
#[derive(Deserialize)]
struct DiscoveryList {
    kind: String,
    #[serde(default)]
    items: Vec<DiscoveryGroup>,
}

#[derive(Deserialize)]
struct DiscoveryGroup {
    #[serde(default)]
    metadata: DiscoveryMeta,
    #[serde(default)]
    versions: Vec<DiscoveryVersion>,
}

#[derive(Deserialize, Default)]
struct DiscoveryMeta {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct DiscoveryVersion {
    version: String,
    #[serde(default)]
    resources: Vec<DiscoveryResource>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryResource {
    resource: String,
    #[serde(default)]
    scope: String,
    response_kind: Option<DiscoveryKind>,
    #[serde(default)]
    short_names: Vec<String>,
    #[serde(default)]
    verbs: Vec<String>,
}

#[derive(Deserialize)]
struct DiscoveryKind {
    kind: String,
}

/// The listable kinds of an aggregated discovery document (`/api` or
/// `/apis`), each at its group's preferred version; `None` when `doc` is not
/// an `APIGroupDiscoveryList` (a server without aggregated discovery).
pub(crate) fn parse_aggregated(doc: &serde_json::Value) -> Option<Vec<ResourceKindInfo>> {
    let list: DiscoveryList = serde_json::from_value(doc.clone()).ok()?;
    if list.kind != "APIGroupDiscoveryList" {
        return None;
    }
    let mut kinds: Vec<ResourceKindInfo> = list
        .items
        .into_iter()
        .filter_map(|group| {
            let name = group.metadata.name;
            let preferred = group.versions.into_iter().next()?;
            let version = preferred.version;
            Some(
                preferred
                    .resources
                    .into_iter()
                    .filter(|r| !r.resource.contains('/') && r.verbs.iter().any(|v| v == "list"))
                    .filter_map(move |r| {
                        Some(ResourceKindInfo {
                            group: name.clone(),
                            version: version.clone(),
                            kind: r.response_kind?.kind,
                            plural: r.resource,
                            namespaced: r.scope == "Namespaced",
                            short_names: r.short_names,
                        })
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .flatten()
        .collect();
    kinds.sort_by(|a, b| (&a.group, &a.kind).cmp(&(&b.group, &b.kind)));
    Some(kinds)
}

fn client_error(e: impl std::fmt::Display) -> KubeconfigError {
    KubeconfigError::ClientError {
        reason: e.to_string(),
    }
}

/// What one aggregated discovery request gave.
enum Aggregated {
    Kinds(Vec<ResourceKindInfo>),
    /// The server does not do aggregated discovery: use the legacy one.
    Unsupported,
}

impl KubeClient {
    /// Every listable resource kind the cluster serves (core and named
    /// groups, CRDs included), each at its group's preferred version,
    /// sorted by group and kind.
    ///
    /// One aggregated discovery request each for `/api` and `/apis`; servers
    /// without aggregated discovery (before 1.30, or 406 / 404 / a legacy
    /// document) fall back to the per-group legacy discovery.
    ///
    /// # Errors
    ///
    /// [`KubeconfigError::ClientError`] when the API server refuses or
    /// cannot be reached (a 403 keeps its status in the message).
    pub async fn discover_kinds(&self) -> Result<Vec<ResourceKindInfo>, KubeconfigError> {
        let mut kinds = Vec::new();
        for path in ["/api", "/apis"] {
            match self.aggregated(path).await? {
                Aggregated::Kinds(found) => kinds.extend(found),
                Aggregated::Unsupported => return self.legacy_kinds().await,
            }
        }
        kinds.sort_by(|a, b| (&a.group, &a.kind).cmp(&(&b.group, &b.kind)));
        Ok(kinds)
    }

    async fn aggregated(&self, path: &str) -> Result<Aggregated, KubeconfigError> {
        let request = http::Request::get(path)
            .header(http::header::ACCEPT, AGGREGATED_DISCOVERY)
            .body(Vec::new())
            .map_err(client_error)?;
        match self.client().request::<serde_json::Value>(request).await {
            Ok(doc) => {
                Ok(parse_aggregated(&doc).map_or(Aggregated::Unsupported, Aggregated::Kinds))
            }
            Err(kube::Error::Api(status)) if status.code == 406 || status.code == 404 => {
                Ok(Aggregated::Unsupported)
            }
            Err(e) => Err(client_error(e)),
        }
    }

    async fn legacy_kinds(&self) -> Result<Vec<ResourceKindInfo>, KubeconfigError> {
        let discovery = Discovery::new(self.client())
            .run()
            .await
            .map_err(client_error)?;
        let mut kinds: Vec<ResourceKindInfo> = discovery
            .groups()
            .flat_map(|group| {
                let version = group.preferred_version_or_latest().to_string();
                group
                    .versioned_resources(&version)
                    .into_iter()
                    .filter(|(ar, caps)| {
                        !ar.plural.contains('/') && caps.supports_operation(verbs::LIST)
                    })
                    .map(|(ar, caps)| ResourceKindInfo {
                        group: ar.group,
                        version: ar.version,
                        kind: ar.kind,
                        plural: ar.plural,
                        namespaced: matches!(caps.scope, Scope::Namespaced),
                        short_names: Vec::new(),
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        kinds.sort_by(|a, b| (&a.group, &a.kind).cmp(&(&b.group, &b.kind)));
        Ok(kinds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apis_doc() -> serde_json::Value {
        serde_json::json!({
            "kind": "APIGroupDiscoveryList", "apiVersion": "apidiscovery.k8s.io/v2",
            "items": [{
                "metadata": {"name": "autoscaling"},
                "versions": [
                    {"version": "v2", "resources": [{
                        "resource": "horizontalpodautoscalers", "scope": "Namespaced",
                        "responseKind": {"group": "autoscaling", "version": "v2", "kind": "HorizontalPodAutoscaler"},
                        "shortNames": ["hpa"], "verbs": ["get", "list", "watch"],
                        "subresources": [{"subresource": "status"}]
                    }]},
                    {"version": "v1", "resources": [{
                        "resource": "horizontalpodautoscalers", "scope": "Namespaced",
                        "responseKind": {"group": "autoscaling", "version": "v1", "kind": "HorizontalPodAutoscaler"},
                        "verbs": ["get", "list"]
                    }]}
                ]
            }]
        })
    }

    fn core_doc() -> serde_json::Value {
        serde_json::json!({
            "kind": "APIGroupDiscoveryList", "apiVersion": "apidiscovery.k8s.io/v2",
            "items": [{"metadata": {}, "versions": [{"version": "v1", "resources": [
                {"resource": "namespaces", "scope": "Cluster",
                 "responseKind": {"group": "", "version": "v1", "kind": "Namespace"}, "shortNames": ["ns"], "verbs": ["list"]},
                {"resource": "bindings", "scope": "Namespaced",
                 "responseKind": {"group": "", "version": "v1", "kind": "Binding"}, "verbs": ["create"]}
            ]}]}]
        })
    }

    #[test]
    fn parse_aggregated_reads_kinds_with_the_preferred_version() {
        let kinds = parse_aggregated(&apis_doc()).expect("aggregated");
        assert_eq!(
            kinds,
            vec![ResourceKindInfo {
                group: "autoscaling".into(),
                version: "v2".into(),
                kind: "HorizontalPodAutoscaler".into(),
                plural: "horizontalpodautoscalers".into(),
                namespaced: true,
                short_names: vec!["hpa".into()],
            }]
        );
    }

    #[test]
    fn parse_aggregated_skips_unlistable_and_reads_the_core_group() {
        let kinds = parse_aggregated(&core_doc()).expect("aggregated");
        assert_eq!(kinds.len(), 1);
        assert_eq!(
            (
                kinds[0].group.as_str(),
                kinds[0].kind.as_str(),
                kinds[0].namespaced
            ),
            ("", "Namespace", false)
        );
    }

    use crate::test_support::{mock_client, requests};
    use http::StatusCode;
    use std::sync::{Arc, Mutex};

    const AGGREGATED: &str = "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList";

    #[tokio::test]
    async fn discover_kinds_asks_for_aggregated_discovery_on_api_and_apis() {
        let (client, server) = mock_client(|_, uri| match uri {
            "/api" => (StatusCode::OK, core_doc()),
            "/apis" => (StatusCode::OK, apis_doc()),
            other => panic!("unexpected {other}"),
        });
        let kinds = client.discover_kinds().await.expect("discover");
        assert_eq!(
            kinds.iter().map(|k| k.kind.as_str()).collect::<Vec<_>>(),
            vec!["Namespace", "HorizontalPodAutoscaler"]
        );
        let seen = requests(client, server).await;
        assert_eq!(seen.len(), 2);
        assert!(seen.iter().all(|s| s.accept.as_deref() == Some(AGGREGATED)));
    }

    #[tokio::test]
    async fn discover_kinds_falls_back_to_legacy_discovery_on_406() {
        // The first /api answers 406 to the aggregated Accept; legacy follows.
        let refused = Arc::new(Mutex::new(false));
        let (client, _server) = mock_client(move |_, uri| {
            let mut done = refused.lock().expect("lock");
            if uri == "/api" && !*done {
                *done = true;
                return (
                    StatusCode::NOT_ACCEPTABLE,
                    serde_json::json!({
                        "kind": "Status", "apiVersion": "v1", "status": "Failure", "code": 406, "reason": "NotAcceptable"
                    }),
                );
            }
            match uri {
                "/api" => (
                    StatusCode::OK,
                    serde_json::json!({"kind": "APIVersions", "versions": ["v1"], "serverAddressByClientCIDRs": []}),
                ),
                "/api/v1" => (
                    StatusCode::OK,
                    serde_json::json!({"kind": "APIResourceList", "groupVersion": "v1", "resources": [
                        {"name": "namespaces", "singularName": "namespace", "namespaced": false, "kind": "Namespace", "verbs": ["list"], "shortNames": ["ns"]},
                        {"name": "namespaces/status", "singularName": "", "namespaced": false, "kind": "Namespace", "verbs": ["get"]}
                    ]}),
                ),
                "/apis" => (
                    StatusCode::OK,
                    serde_json::json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": [{
                        "name": "autoscaling",
                        "versions": [{"groupVersion": "autoscaling/v2", "version": "v2"}, {"groupVersion": "autoscaling/v1", "version": "v1"}],
                        "preferredVersion": {"groupVersion": "autoscaling/v2", "version": "v2"}
                    }]}),
                ),
                "/apis/autoscaling/v2" | "/apis/autoscaling/v1" => {
                    let version = uri.rsplit('/').next().unwrap_or("v2");
                    (
                        StatusCode::OK,
                        serde_json::json!({"kind": "APIResourceList", "groupVersion": format!("autoscaling/{version}"), "resources": [
                            {"name": "horizontalpodautoscalers", "singularName": "horizontalpodautoscaler", "namespaced": true, "kind": "HorizontalPodAutoscaler", "verbs": ["list"]}
                        ]}),
                    )
                }
                other => panic!("unexpected {other}"),
            }
        });
        let kinds = client.discover_kinds().await.expect("discover");
        let found: Vec<(&str, &str, &str, bool)> = kinds
            .iter()
            .map(|k| {
                (
                    k.group.as_str(),
                    k.version.as_str(),
                    k.kind.as_str(),
                    k.namespaced,
                )
            })
            .collect();
        assert_eq!(
            found,
            vec![
                ("", "v1", "Namespace", false),
                ("autoscaling", "v2", "HorizontalPodAutoscaler", true)
            ]
        );
    }

    #[tokio::test]
    async fn discover_kinds_reports_403() {
        let (client, _server) = mock_client(|_, _| {
            (
                StatusCode::FORBIDDEN,
                serde_json::json!({
                    "kind": "Status", "apiVersion": "v1", "status": "Failure", "code": 403, "reason": "Forbidden", "message": "forbidden"
                }),
            )
        });
        let err = client.discover_kinds().await.expect_err("403");
        let text = err.to_string();
        assert!(text.contains("403") || text.contains("orbidden"), "{text}");
    }

    #[test]
    fn parse_aggregated_rejects_a_legacy_document() {
        let legacy = serde_json::json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []});
        assert_eq!(parse_aggregated(&legacy), None);
    }
}
