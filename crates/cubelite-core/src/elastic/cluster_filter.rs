//! Per-context cluster filter (#528): one Elasticsearch deployment holding
//! the logs of many clusters (an Elastic Cloud deployment shared by every
//! kube context) is narrowed to the context's cluster with one term filter.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::FieldPreset;

/// ECS field naming the cluster a document comes from.
pub const ECS_CLUSTER_FIELD: &str = "orchestrator.cluster.name";

/// A `field: value` term filter added to every history query.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterFilter {
    /// Document field; empty uses [`ECS_CLUSTER_FIELD`] with the ECS preset.
    #[serde(default)]
    pub field: String,
    /// Value the field must equal.
    pub value: String,
}

impl ClusterFilter {
    /// The `(field, value)` to filter on; `None` when the value is blank,
    /// or the field is blank with a preset that has no cluster field.
    pub fn term(&self, preset: FieldPreset) -> Option<(&str, &str)> {
        let value = self.value.trim();
        if value.is_empty() {
            return None;
        }
        let field = match self.field.trim() {
            "" if preset == FieldPreset::Ecs => ECS_CLUSTER_FIELD,
            "" => return None,
            field => field,
        };
        Some((field, value))
    }
}

/// Adds the cluster term to a `_search` body built by
/// [`super::search_body`] (its `query.bool.filter` list); a no-op without
/// a usable filter.
pub fn apply(body: &mut Value, filter: Option<&ClusterFilter>, preset: FieldPreset) {
    let Some((field, value)) = filter.and_then(|f| f.term(preset)) else {
        return;
    };
    if let Some(list) = body
        .pointer_mut("/query/bool/filter")
        .and_then(Value::as_array_mut)
    {
        list.push(json!({ "term": { field: value } }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(field: &str, value: &str) -> ClusterFilter {
        ClusterFilter {
            field: field.into(),
            value: value.into(),
        }
    }

    #[test]
    fn term_defaults_to_the_ecs_field_and_skips_blank_values() {
        let f = filter(" ", " aks-prod ");
        assert_eq!(
            f.term(FieldPreset::Ecs),
            Some((ECS_CLUSTER_FIELD, "aks-prod"))
        );
        assert_eq!(f.term(FieldPreset::FluentBit), None);
        assert_eq!(
            filter("cluster", "eu").term(FieldPreset::FluentBit),
            Some(("cluster", "eu"))
        );
        assert_eq!(filter("cluster", "  ").term(FieldPreset::Ecs), None);
    }

    #[test]
    fn apply_adds_one_term_filter() {
        let mut body =
            json!({ "query": { "bool": { "filter": [{ "term": { "a": "b" } }], "must": [] } } });
        apply(&mut body, Some(&filter("", "aks-prod")), FieldPreset::Ecs);
        assert_eq!(
            body["query"]["bool"]["filter"][1],
            json!({ "term": { "orchestrator.cluster.name": "aks-prod" } })
        );
        let before = body.clone();
        apply(&mut body, None, FieldPreset::Ecs);
        apply(&mut body, Some(&filter("", "")), FieldPreset::Ecs);
        assert_eq!(body, before);
    }

    #[test]
    fn old_endpoints_load_without_filter_or_shared_flag() {
        let endpoint: super::super::EsEndpoint = serde_json::from_str(
            r#"{"target":{"kind":"external","url":"https://es"},"indexPattern":"logs-*"}"#,
        )
        .expect("old json");
        assert_eq!(endpoint.cluster_filter, None);
        assert!(!endpoint.shared);
        let json = serde_json::to_string(&endpoint).expect("json");
        assert!(
            !json.contains("shared") && !json.contains("clusterFilter"),
            "{json}"
        );
    }

    #[tokio::test]
    async fn history_searches_carry_the_filter() {
        use super::super::transport::connect;
        use super::super::{EsAuth, EsEndpoint, HistoryQuery};
        let hits = json!({ "hits": { "total": { "value": 0, "relation": "eq" }, "hits": [] } });
        // No point in time (404), then the plain search.
        let (url, server) = crate::test_support::mock_server(vec![
            (404, "{}".to_string()),
            (200, hits.to_string()),
        ])
        .await;
        let endpoint: EsEndpoint = serde_json::from_value(json!({
            "target": { "kind": "external", "url": url },
            "indexPattern": "logs-*",
            "clusterFilter": { "value": "aks-prod" },
            "shared": true
        }))
        .expect("endpoint");
        let query: HistoryQuery = serde_json::from_value(json!({
            "namespace": "shop", "pod": "api-0", "from": "now-1h", "to": "now"
        }))
        .expect("query");
        let conn = connect(None, &endpoint, &EsAuth::None)
            .await
            .expect("connect");
        conn.search(&endpoint, &query).await.expect("search");
        let requests = server.await.expect("server");
        let (_, body) = requests[1].split_once("\r\n\r\n").expect("body");
        let body: Value = serde_json::from_str(body).expect("json");
        let filters = body["query"]["bool"]["filter"].as_array().expect("filters");
        assert!(filters.contains(&json!({ "term": { ECS_CLUSTER_FIELD: "aks-prod" } })));
    }

    #[test]
    fn serde_defaults_the_field() {
        let f: ClusterFilter = serde_json::from_str(r#"{"value":"eu"}"#).expect("json");
        assert_eq!(f, filter("", "eu"));
    }
}
