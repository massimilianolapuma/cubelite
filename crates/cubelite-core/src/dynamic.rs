//! Any resource kind, without a typed client: discovery of the kinds a
//! cluster serves, lists through the API server's Table (the columns
//! `kubectl get` prints) and single objects as YAML.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{KubeClient, KubeconfigError};

/// `Accept` for aggregated discovery, as kubectl sends it: v2 (GA in 1.30),
/// v2beta1 (1.27–1.29), else the plain legacy document.
const AGGREGATED_DISCOVERY: &str = "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json;g=apidiscovery.k8s.io;v=v2beta1;as=APIGroupDiscoveryList,application/json";

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
/// `/apis`), each at the most preferred version that serves it; `None` when `doc` is not
/// an `APIGroupDiscoveryList` (a server without aggregated discovery).
pub(crate) fn parse_aggregated(doc: &serde_json::Value) -> Option<Vec<ResourceKindInfo>> {
    let list: DiscoveryList = serde_json::from_value(doc.clone()).ok()?;
    if list.kind != "APIGroupDiscoveryList" {
        return None;
    }
    let mut kinds = Vec::new();
    for group in list.items {
        let name = group.metadata.name;
        // Versions come in preference order; a kind served only in an older
        // version keeps that version (kubectl's preferred resources).
        let mut seen = HashSet::new();
        for version in group.versions {
            for r in version.resources {
                if r.resource.contains('/') || !r.verbs.iter().any(|v| v == "list") {
                    continue;
                }
                let Some(kind) = r.response_kind else {
                    continue;
                };
                if seen.insert(r.resource.clone()) {
                    kinds.push(ResourceKindInfo {
                        group: name.clone(),
                        version: version.version.clone(),
                        kind: kind.kind,
                        plural: r.resource,
                        namespaced: r.scope == "Namespaced",
                        short_names: r.short_names,
                    });
                }
            }
        }
    }
    kinds.sort_by(|a, b| (&a.group, &a.kind).cmp(&(&b.group, &b.kind)));
    Some(kinds)
}

fn client_error(e: impl std::fmt::Display) -> KubeconfigError {
    KubeconfigError::ClientError {
        reason: e.to_string(),
    }
}

/// `Accept` for the server-side Table (what `kubectl get` prints).
const TABLE_ACCEPT: &str = "application/json;as=Table;v=v1;g=meta.k8s.io";
/// Rows per Table page, as `kubectl get` chunks.
const PAGE_SIZE: &str = "500";

/// Which resource to list or fetch: what discovery tells about a kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceRef {
    /// API group; `""` for the core group.
    pub group: String,
    pub version: String,
    pub plural: String,
    pub namespaced: bool,
}

/// One column of a Table (a `priority: 0` column definition).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableColumn {
    pub name: String,
    /// OpenAPI type: `string`, `integer`, `number`, `boolean` or `date`.
    pub column_type: String,
    pub format: String,
    pub description: String,
}

/// One object of a Table: its identity plus the cells of [`ResourceTable::columns`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableRow {
    pub name: String,
    pub namespace: Option<String>,
    /// RFC 3339 creation timestamp.
    pub creation_timestamp: Option<String>,
    /// Cells of the `priority: 0` columns, in column order.
    pub cells: Vec<serde_json::Value>,
}

/// A whole list as the API server's Table: the columns `kubectl get` shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResourceTable {
    pub columns: Vec<TableColumn>,
    pub rows: Vec<TableRow>,
}

// Serde mirrors of `meta.k8s.io/v1` Table (with `includeObject=Metadata`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TablePage {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    metadata: ListMeta,
    #[serde(default)]
    column_definitions: Vec<ColumnDefinition>,
    #[serde(default)]
    rows: Vec<PageRow>,
}

#[derive(Deserialize, Default)]
struct ListMeta {
    #[serde(rename = "continue")]
    cont: Option<String>,
}

#[derive(Deserialize)]
struct ColumnDefinition {
    name: String,
    #[serde(rename = "type", default)]
    column_type: String,
    #[serde(default)]
    format: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    priority: i32,
}

#[derive(Deserialize)]
struct PageRow {
    #[serde(default)]
    cells: Vec<serde_json::Value>,
    object: Option<RowObject>,
}

#[derive(Deserialize)]
struct RowObject {
    #[serde(default)]
    metadata: RowMeta,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RowMeta {
    #[serde(default)]
    name: String,
    namespace: Option<String>,
    creation_timestamp: Option<String>,
}

/// The collection URL of `resource`: in `namespace` for a namespaced kind
/// (all namespaces when `None`); a cluster-scoped kind ignores `namespace`.
pub(crate) fn resource_path(resource: &ResourceRef, namespace: Option<&str>) -> String {
    let base = if resource.group.is_empty() {
        format!("/api/{}", resource.version)
    } else {
        format!("/apis/{}/{}", resource.group, resource.version)
    };
    match namespace {
        Some(ns) if resource.namespaced => format!("{base}/namespaces/{ns}/{}", resource.plural),
        _ => format!("{base}/{}", resource.plural),
    }
}

/// The query of one Table page. A plain function: the serializer is not
/// `Send`, so it must not live across an `.await`.
fn table_query(cont: Option<&str>) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("includeObject", "Metadata");
    query.append_pair("limit", PAGE_SIZE);
    if let Some(token) = cont {
        query.append_pair("continue", token);
    }
    query.finish()
}

/// The listable resources of one legacy `APIResourceList` not already in
/// `seen` (plural names of this group, from more preferred versions).
fn push_legacy(
    kinds: &mut Vec<ResourceKindInfo>,
    seen: &mut HashSet<String>,
    group: &str,
    version: &str,
    list: k8s_openapi::apimachinery::pkg::apis::meta::v1::APIResourceList,
) {
    for r in list.resources {
        if r.name.contains('/') || !r.verbs.iter().any(|v| v == "list") {
            continue;
        }
        if seen.insert(r.name.clone()) {
            kinds.push(ResourceKindInfo {
                group: group.to_string(),
                version: version.to_string(),
                kind: r.kind,
                plural: r.name,
                namespaced: r.namespaced,
                short_names: r.short_names.unwrap_or_default(),
            });
        }
    }
}

/// The `priority: 0` columns and their indices in a row's cells.
fn shown_columns(defs: &[ColumnDefinition]) -> (Vec<TableColumn>, Vec<usize>) {
    defs.iter()
        .enumerate()
        .filter(|(_, d)| d.priority == 0)
        .map(|(i, d)| {
            (
                TableColumn {
                    name: d.name.clone(),
                    column_type: d.column_type.clone(),
                    format: d.format.clone(),
                    description: d.description.clone(),
                },
                i,
            )
        })
        .unzip()
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

    /// Every object of `resource` as the API server's Table: the
    /// `priority: 0` columns (`kubectl get` without `-o wide`) and, per row,
    /// name, namespace and creation time. Follows `continue` tokens.
    ///
    /// # Errors
    ///
    /// [`KubeconfigError::ClientError`] when the API server refuses (a 403
    /// keeps its status in the message) or answers something not a Table.
    pub async fn list_table(
        &self,
        resource: &ResourceRef,
        namespace: Option<&str>,
    ) -> Result<ResourceTable, KubeconfigError> {
        let path = resource_path(resource, namespace);
        let mut columns: Option<(Vec<TableColumn>, Vec<usize>)> = None;
        let mut rows = Vec::new();
        let mut cont: Option<String> = None;
        loop {
            let query = table_query(cont.as_deref());
            let request = http::Request::get(format!("{path}?{query}"))
                .header(http::header::ACCEPT, TABLE_ACCEPT)
                .body(Vec::new())
                .map_err(client_error)?;
            let page: TablePage = self.client().request(request).await.map_err(client_error)?;
            if page.kind != "Table" {
                return Err(client_error(format!(
                    "the API server answered {} instead of a Table for {path}",
                    if page.kind.is_empty() {
                        "an unknown document"
                    } else {
                        &page.kind
                    }
                )));
            }
            let (_, keep) = columns.get_or_insert_with(|| shown_columns(&page.column_definitions));
            let keep = keep.clone();
            rows.extend(page.rows.into_iter().map(|row| {
                let meta = row.object.map(|o| o.metadata).unwrap_or_default();
                TableRow {
                    name: meta.name,
                    namespace: meta.namespace,
                    creation_timestamp: meta.creation_timestamp,
                    cells: keep
                        .iter()
                        .map(|&i| row.cells.get(i).cloned().unwrap_or(serde_json::Value::Null))
                        .collect(),
                }
            }));
            match page.metadata.cont.filter(|c| !c.is_empty()) {
                Some(next) => cont = Some(next),
                None => break,
            }
        }
        let columns = columns.map(|(c, _)| c).unwrap_or_default();
        Ok(ResourceTable { columns, rows })
    }

    /// One object of `resource` as YAML, `managedFields` stripped (like
    /// `kubectl get -o yaml`). A cluster-scoped kind ignores `namespace`.
    ///
    /// # Errors
    ///
    /// [`KubeconfigError::ClientError`] when the API server refuses (a 403
    /// keeps its status in the message) or the object does not exist.
    pub async fn get_dynamic_yaml(
        &self,
        resource: &ResourceRef,
        namespace: Option<&str>,
        name: &str,
    ) -> Result<String, KubeconfigError> {
        let path = format!("{}/{name}", resource_path(resource, namespace));
        let request = http::Request::get(path)
            .body(Vec::new())
            .map_err(client_error)?;
        let object: serde_json::Value =
            self.client().request(request).await.map_err(client_error)?;
        crate::client::to_clean_yaml(&object)
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

    /// Legacy discovery (`/api`, `/apis` and one request per group
    /// version). A group version that fails (an APIService down, e.g.
    /// metrics-server) is skipped, as kubectl does, instead of failing all.
    async fn legacy_kinds(&self) -> Result<Vec<ResourceKindInfo>, KubeconfigError> {
        let client = self.client();
        let mut kinds = Vec::new();
        let core = client
            .list_core_api_versions()
            .await
            .map_err(client_error)?;
        let mut seen = HashSet::new();
        for version in &core.versions {
            if let Ok(list) = client.list_core_api_resources(version).await {
                push_legacy(&mut kinds, &mut seen, "", version, list);
            }
        }
        let groups = client.list_api_groups().await.map_err(client_error)?;
        for group in groups.groups {
            let preferred = group.preferred_version.as_ref().map(|v| v.version.clone());
            let mut versions: Vec<_> = group.versions.iter().collect();
            // Preferred version first, then the order the server lists.
            versions.sort_by_key(|v| Some(&v.version) != preferred.as_ref());
            let mut seen = HashSet::new();
            for v in versions {
                if let Ok(list) = client.list_api_group_resources(&v.group_version).await {
                    push_legacy(&mut kinds, &mut seen, &group.name, &v.version, list);
                }
            }
        }
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

    const AGGREGATED: &str = "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json;g=apidiscovery.k8s.io;v=v2beta1;as=APIGroupDiscoveryList,application/json";

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

    const TABLE: &str = "application/json;as=Table;v=v1;g=meta.k8s.io";

    fn hpa_ref() -> ResourceRef {
        ResourceRef {
            group: "autoscaling".into(),
            version: "v2".into(),
            plural: "horizontalpodautoscalers".into(),
            namespaced: true,
        }
    }

    fn table(rows: serde_json::Value, cont: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "kind": "Table", "apiVersion": "meta.k8s.io/v1",
            "metadata": {"resourceVersion": "1", "continue": cont},
            "columnDefinitions": [
                {"name": "Name", "type": "string", "format": "name", "description": "name", "priority": 0},
                {"name": "Reference", "type": "string", "format": "", "description": "ref", "priority": 0},
                {"name": "Targets", "type": "string", "format": "", "description": "targets", "priority": 0},
                {"name": "Age", "type": "date", "format": "", "description": "age", "priority": 0},
                {"name": "Selector", "type": "string", "format": "", "description": "sel", "priority": 1}
            ],
            "rows": rows
        })
    }

    fn row(name: &str) -> serde_json::Value {
        serde_json::json!({
            "cells": [name, "Deployment/web", "5%/80%", "6d", "app=web"],
            "object": {"kind": "PartialObjectMetadata", "apiVersion": "meta.k8s.io/v1",
                "metadata": {"name": name, "namespace": "shop", "creationTimestamp": "2026-11-01T10:00:00Z"}}
        })
    }

    #[test]
    fn resource_path_covers_core_named_namespaced_and_cluster_scope() {
        let pods = ResourceRef {
            group: "".into(),
            version: "v1".into(),
            plural: "pods".into(),
            namespaced: true,
        };
        let pv = ResourceRef {
            group: "".into(),
            version: "v1".into(),
            plural: "persistentvolumes".into(),
            namespaced: false,
        };
        assert_eq!(
            resource_path(&pods, Some("shop")),
            "/api/v1/namespaces/shop/pods"
        );
        assert_eq!(resource_path(&pods, None), "/api/v1/pods");
        assert_eq!(
            resource_path(&hpa_ref(), Some("shop")),
            "/apis/autoscaling/v2/namespaces/shop/horizontalpodautoscalers"
        );
        assert_eq!(
            resource_path(&pv, Some("shop")),
            "/api/v1/persistentvolumes"
        );
    }

    #[tokio::test]
    async fn list_table_keeps_priority_zero_columns_and_reads_row_metadata() {
        let (client, server) =
            mock_client(|_, _| (StatusCode::OK, table(serde_json::json!([row("web")]), None)));
        let t = client
            .list_table(&hpa_ref(), Some("shop"))
            .await
            .expect("table");
        assert_eq!(
            t.columns
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Name", "Reference", "Targets", "Age"]
        );
        assert_eq!(t.columns[3].column_type, "date");
        assert_eq!(t.rows.len(), 1);
        assert_eq!(t.rows[0].cells.len(), 4);
        assert_eq!(t.rows[0].cells[2], serde_json::json!("5%/80%"));
        assert_eq!(t.rows[0].name, "web");
        assert_eq!(t.rows[0].namespace.as_deref(), Some("shop"));
        assert_eq!(
            t.rows[0].creation_timestamp.as_deref(),
            Some("2026-11-01T10:00:00Z")
        );
        let seen = requests(client, server).await;
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].accept.as_deref(), Some(TABLE));
        assert!(seen[0]
            .uri
            .starts_with("/apis/autoscaling/v2/namespaces/shop/horizontalpodautoscalers?"));
        assert!(seen[0].uri.contains("includeObject=Metadata"));
        assert!(seen[0].uri.contains("limit=500"));
    }

    #[tokio::test]
    async fn list_table_follows_continue_tokens() {
        let (client, server) = mock_client(|_, uri| {
            if uri.contains("continue=abc%3D") {
                (StatusCode::OK, table(serde_json::json!([row("b")]), None))
            } else {
                (
                    StatusCode::OK,
                    table(serde_json::json!([row("a")]), Some("abc=")),
                )
            }
        });
        let t = client.list_table(&hpa_ref(), None).await.expect("table");
        assert_eq!(
            t.rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        let seen = requests(client, server).await;
        assert_eq!(seen.len(), 2);
        assert!(seen[0]
            .uri
            .starts_with("/apis/autoscaling/v2/horizontalpodautoscalers?"));
    }

    #[tokio::test]
    async fn list_table_with_no_rows_still_returns_columns() {
        let (client, _server) =
            mock_client(|_, _| (StatusCode::OK, table(serde_json::json!([]), None)));
        let t = client
            .list_table(&hpa_ref(), Some("shop"))
            .await
            .expect("table");
        assert_eq!(t.columns.len(), 4);
        assert!(t.rows.is_empty());
    }

    #[tokio::test]
    async fn list_table_reports_403() {
        let (client, _server) = mock_client(|_, _| {
            (
                StatusCode::FORBIDDEN,
                serde_json::json!({
                    "kind": "Status", "apiVersion": "v1", "status": "Failure", "code": 403, "reason": "Forbidden", "message": "forbidden"
                }),
            )
        });
        let text = client
            .list_table(&hpa_ref(), Some("shop"))
            .await
            .expect_err("403")
            .to_string();
        assert!(text.contains("403") || text.contains("orbidden"), "{text}");
    }

    #[tokio::test]
    async fn get_dynamic_yaml_fetches_the_object_and_strips_managed_fields() {
        let pdb = ResourceRef {
            group: "policy".into(),
            version: "v1".into(),
            plural: "poddisruptionbudgets".into(),
            namespaced: true,
        };
        let (client, server) = mock_client(|_, _| {
            (
                StatusCode::OK,
                serde_json::json!({
                    "apiVersion": "policy/v1", "kind": "PodDisruptionBudget",
                    "metadata": {"name": "web", "namespace": "shop", "managedFields": [{"manager": "kubectl"}]},
                    "spec": {"minAvailable": 1}
                }),
            )
        });
        let yaml = client
            .get_dynamic_yaml(&pdb, Some("shop"), "web")
            .await
            .expect("yaml");
        assert!(yaml.contains("name: web"), "{yaml}");
        assert!(yaml.contains("minAvailable: 1"), "{yaml}");
        assert!(!yaml.contains("managedFields"), "{yaml}");
        let seen = requests(client, server).await;
        assert_eq!(
            seen[0].uri,
            "/apis/policy/v1/namespaces/shop/poddisruptionbudgets/web"
        );
    }

    #[tokio::test]
    async fn get_dynamic_yaml_of_a_cluster_scoped_core_type() {
        let pv = ResourceRef {
            group: "".into(),
            version: "v1".into(),
            plural: "persistentvolumes".into(),
            namespaced: false,
        };
        let (client, server) = mock_client(|_, _| {
            (
                StatusCode::OK,
                serde_json::json!({"apiVersion": "v1", "kind": "PersistentVolume", "metadata": {"name": "pv-1"}}),
            )
        });
        let yaml = client
            .get_dynamic_yaml(&pv, Some("shop"), "pv-1")
            .await
            .expect("yaml");
        assert!(yaml.contains("kind: PersistentVolume"), "{yaml}");
        let seen = requests(client, server).await;
        assert_eq!(seen[0].uri, "/api/v1/persistentvolumes/pv-1");
    }

    #[tokio::test]
    async fn get_dynamic_yaml_reports_403() {
        let (client, _server) = mock_client(|_, _| {
            (
                StatusCode::FORBIDDEN,
                serde_json::json!({
                    "kind": "Status", "apiVersion": "v1", "status": "Failure", "code": 403, "reason": "Forbidden", "message": "forbidden"
                }),
            )
        });
        let text = client
            .get_dynamic_yaml(&hpa_ref(), Some("shop"), "web")
            .await
            .expect_err("403")
            .to_string();
        assert!(text.contains("403") || text.contains("orbidden"), "{text}");
    }

    /// Tauri commands spawn these futures on a multi-threaded runtime.
    #[tokio::test]
    async fn the_client_futures_are_send() {
        fn assert_send<T: Send>(_: &T) {}
        let (client, _server) = mock_client(|_, _| (StatusCode::OK, serde_json::json!({})));
        let r = hpa_ref();
        assert_send(&client.discover_kinds());
        assert_send(&client.list_table(&r, None));
        assert_send(&client.get_dynamic_yaml(&r, None, "x"));
    }

    #[test]
    fn parse_aggregated_keeps_kinds_served_only_in_an_older_version() {
        // kube-prometheus-stack: Alertmanager in v1 (preferred), AlertmanagerConfig only in v1alpha1.
        let doc = serde_json::json!({
            "kind": "APIGroupDiscoveryList", "apiVersion": "apidiscovery.k8s.io/v2",
            "items": [{"metadata": {"name": "monitoring.coreos.com"}, "versions": [
                {"version": "v1", "resources": [
                    {"resource": "alertmanagers", "scope": "Namespaced",
                     "responseKind": {"group": "monitoring.coreos.com", "version": "v1", "kind": "Alertmanager"}, "verbs": ["list"]}
                ]},
                {"version": "v1alpha1", "resources": [
                    {"resource": "alertmanagers", "scope": "Namespaced",
                     "responseKind": {"group": "monitoring.coreos.com", "version": "v1alpha1", "kind": "Alertmanager"}, "verbs": ["list"]},
                    {"resource": "alertmanagerconfigs", "scope": "Namespaced",
                     "responseKind": {"group": "monitoring.coreos.com", "version": "v1alpha1", "kind": "AlertmanagerConfig"}, "verbs": ["list"]}
                ]}
            ]}]
        });
        let kinds = parse_aggregated(&doc).expect("aggregated");
        let found: Vec<(&str, &str)> = kinds
            .iter()
            .map(|k| (k.kind.as_str(), k.version.as_str()))
            .collect();
        assert_eq!(
            found,
            vec![("Alertmanager", "v1"), ("AlertmanagerConfig", "v1alpha1")]
        );
    }

    #[tokio::test]
    async fn legacy_discovery_skips_a_broken_group_and_merges_versions() {
        // A plain APIGroupList answers the aggregated Accept (no aggregated discovery);
        // metrics.k8s.io is down (503); monitoring has a kind only in its older version.
        let (client, _server) = mock_client(|_, uri| match uri {
            "/api" => (
                StatusCode::OK,
                serde_json::json!({"kind": "APIVersions", "versions": ["v1"], "serverAddressByClientCIDRs": []}),
            ),
            "/api/v1" => (
                StatusCode::OK,
                serde_json::json!({"kind": "APIResourceList", "groupVersion": "v1", "resources": [
                    {"name": "pods", "singularName": "pod", "namespaced": true, "kind": "Pod", "verbs": ["list"], "shortNames": ["po"]}
                ]}),
            ),
            "/apis" => (
                StatusCode::OK,
                serde_json::json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": [
                    {"name": "metrics.k8s.io", "versions": [{"groupVersion": "metrics.k8s.io/v1beta1", "version": "v1beta1"}],
                     "preferredVersion": {"groupVersion": "metrics.k8s.io/v1beta1", "version": "v1beta1"}},
                    {"name": "monitoring.coreos.com",
                     "versions": [{"groupVersion": "monitoring.coreos.com/v1alpha1", "version": "v1alpha1"}, {"groupVersion": "monitoring.coreos.com/v1", "version": "v1"}],
                     "preferredVersion": {"groupVersion": "monitoring.coreos.com/v1", "version": "v1"}}
                ]}),
            ),
            "/apis/metrics.k8s.io/v1beta1" => (
                StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({
                    "kind": "Status", "apiVersion": "v1", "status": "Failure", "code": 503, "reason": "ServiceUnavailable"
                }),
            ),
            "/apis/monitoring.coreos.com/v1" => (
                StatusCode::OK,
                serde_json::json!({"kind": "APIResourceList", "groupVersion": "monitoring.coreos.com/v1", "resources": [
                    {"name": "alertmanagers", "singularName": "alertmanager", "namespaced": true, "kind": "Alertmanager", "verbs": ["list"]}
                ]}),
            ),
            "/apis/monitoring.coreos.com/v1alpha1" => (
                StatusCode::OK,
                serde_json::json!({"kind": "APIResourceList", "groupVersion": "monitoring.coreos.com/v1alpha1", "resources": [
                    {"name": "alertmanagers", "singularName": "alertmanager", "namespaced": true, "kind": "Alertmanager", "verbs": ["list"]},
                    {"name": "alertmanagerconfigs", "singularName": "alertmanagerconfig", "namespaced": true, "kind": "AlertmanagerConfig", "verbs": ["list"]}
                ]}),
            ),
            other => panic!("unexpected {other}"),
        });
        let kinds = client
            .discover_kinds()
            .await
            .expect("discover despite a broken group");
        let found: Vec<(&str, &str, &str)> = kinds
            .iter()
            .map(|k| (k.group.as_str(), k.version.as_str(), k.kind.as_str()))
            .collect();
        assert_eq!(
            found,
            vec![
                ("", "v1", "Pod"),
                ("monitoring.coreos.com", "v1", "Alertmanager"),
                ("monitoring.coreos.com", "v1alpha1", "AlertmanagerConfig"),
            ]
        );
        assert_eq!(kinds[0].short_names, vec!["po".to_string()]);
    }

    #[tokio::test]
    async fn list_table_rejects_an_answer_that_is_not_a_table() {
        let (client, _server) = mock_client(|_, _| {
            (
                StatusCode::OK,
                serde_json::json!({"kind": "HorizontalPodAutoscalerList", "apiVersion": "autoscaling/v2", "metadata": {}, "items": []}),
            )
        });
        let text = client
            .list_table(&hpa_ref(), Some("shop"))
            .await
            .expect_err("not a table")
            .to_string();
        assert!(text.contains("Table"), "{text}");
    }

    #[test]
    fn parse_aggregated_rejects_a_legacy_document() {
        let legacy = serde_json::json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []});
        assert_eq!(parse_aggregated(&legacy), None);
    }
}
