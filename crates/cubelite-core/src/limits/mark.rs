//! The override mark: the annotation the app writes on a Deployment when it
//! changes its requests and limits (spec §6).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::types::{PairText, ResourceTexts};
use crate::resources::TemplateContainerInfo;

/// The annotation that holds the mark, on the Deployment's metadata.
pub const OVERRIDE_ANNOTATION: &str = "cubelite.app/resources-override";

/// One container of the mark: its values before the first change and the
/// values the app applied last.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OverrideContainer {
    /// Container name.
    pub name: String,
    /// The values before the first change from the app.
    pub original: ResourceTexts,
    /// The values the app applied last.
    pub applied: ResourceTexts,
}

/// The override mark as the app wrote it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OverrideInfo {
    /// RFC 3339 time of the last change from the app.
    pub at: String,
    /// The changed containers, in name order.
    pub containers: Vec<OverrideContainer>,
}

/// The version of the mark's JSON this app writes and reads.
const MARK_VERSION: u64 = 1;

/// The annotation's JSON, as written: containers keyed by name.
#[derive(Deserialize)]
struct MarkJson {
    v: u64,
    at: String,
    containers: BTreeMap<String, MarkContainerJson>,
}

#[derive(Deserialize)]
struct MarkContainerJson {
    original: ResourceTexts,
    applied: ResourceTexts,
}

/// The mark, when the annotation is one the app wrote (`v` = 1). None for anything else.
pub fn parse_mark(annotation: Option<&str>) -> Option<OverrideInfo> {
    let mark: MarkJson = serde_json::from_str(annotation?).ok()?;
    if mark.v != MARK_VERSION || mark.containers.is_empty() {
        return None;
    }
    Some(OverrideInfo {
        at: mark.at,
        containers: mark
            .containers
            .into_iter()
            .map(|(name, c)| OverrideContainer {
                name,
                original: c.original,
                applied: c.applied,
            })
            .collect(),
    })
}

/// The mark when it is active: every container it lists exists and its four cluster values equal `applied` as amounts.
pub fn active_override(
    annotation: Option<&str>,
    containers: &[TemplateContainerInfo],
) -> Option<OverrideInfo> {
    let mark = parse_mark(annotation)?;
    let active = mark.containers.iter().all(|listed| {
        containers
            .iter()
            .find(|c| c.name == listed.name)
            .is_some_and(|c| ResourceTexts::from(&c.resources).same_amounts(&listed.applied))
    });
    active.then_some(mark)
}

/// The JSON of one container's values, every value present (`null` when not set).
fn texts_json(t: &ResourceTexts) -> serde_json::Value {
    let pair = |p: &PairText| serde_json::json!({ "request": p.request, "limit": p.limit });
    serde_json::json!({ "cpu": pair(&t.cpu), "memory": pair(&t.memory) })
}

/// The annotation value after a change: Some(json) to write, None to remove the annotation.
/// `changed` lists, for each container the change touches, its values before and after.
pub fn next_mark(
    active: Option<&OverrideInfo>,
    changed: &[OverrideContainer],
    at: &str,
) -> Option<String> {
    let mut containers: BTreeMap<String, OverrideContainer> = active
        .map(|m| {
            m.containers
                .iter()
                .map(|c| (c.name.clone(), c.clone()))
                .collect()
        })
        .unwrap_or_default();
    for c in changed {
        match containers.get_mut(&c.name) {
            Some(listed) => listed.applied = c.applied.clone(),
            None => {
                containers.insert(c.name.clone(), c.clone());
            }
        }
    }
    containers.retain(|_, c| !c.applied.same_amounts(&c.original));
    if containers.is_empty() {
        return None;
    }
    let listed: serde_json::Map<String, serde_json::Value> = containers
        .into_iter()
        .map(|(name, c)| {
            let value = serde_json::json!({
                "original": texts_json(&c.original),
                "applied": texts_json(&c.applied),
            });
            (name, value)
        })
        .collect();
    let mark = serde_json::json!({ "v": MARK_VERSION, "at": at, "containers": listed });
    Some(mark.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::{ContainerResourcesInfo, QuantityInfo, ResourcePairInfo};

    const SPEC_EXAMPLE: &str = r#"{ "v": 1, "at": "2026-11-13T11:20:00Z",
      "containers": { "api": {
        "original": { "cpu": { "request": "250m", "limit": "500m" }, "memory": { "request": "256Mi", "limit": "512Mi" } },
        "applied":  { "cpu": { "request": "250m", "limit": "500m" }, "memory": { "request": "256Mi", "limit": "768Mi" } } } } }"#;

    fn texts(
        cpu: (Option<&str>, Option<&str>),
        memory: (Option<&str>, Option<&str>),
    ) -> ResourceTexts {
        let s = |v: Option<&str>| v.map(str::to_string);
        ResourceTexts {
            cpu: PairText {
                request: s(cpu.0),
                limit: s(cpu.1),
            },
            memory: PairText {
                request: s(memory.0),
                limit: s(memory.1),
            },
        }
    }

    fn api(memory_limit: &str) -> ResourceTexts {
        texts(
            (Some("250m"), Some("500m")),
            (Some("256Mi"), Some(memory_limit)),
        )
    }

    /// A template container whose cluster values are `t`.
    fn container(name: &str, t: &ResourceTexts) -> TemplateContainerInfo {
        let q = |v: &Option<String>, parse: fn(&str) -> Option<f64>| {
            v.as_ref().map(|text| QuantityInfo {
                text: text.clone(),
                amount: parse(text),
            })
        };
        let cpu = |s: &str| crate::limits::ResourceName::Cpu.parse(s);
        let mem = |s: &str| crate::limits::ResourceName::Memory.parse(s);
        TemplateContainerInfo {
            name: name.into(),
            image: None,
            sidecar: false,
            resources: ContainerResourcesInfo {
                cpu: ResourcePairInfo {
                    request: q(&t.cpu.request, cpu),
                    limit: q(&t.cpu.limit, cpu),
                },
                memory: ResourcePairInfo {
                    request: q(&t.memory.request, mem),
                    limit: q(&t.memory.limit, mem),
                },
            },
        }
    }

    fn mark_json(original: &ResourceTexts, applied: &ResourceTexts) -> String {
        next_mark(
            None,
            &[OverrideContainer {
                name: "api".into(),
                original: original.clone(),
                applied: applied.clone(),
            }],
            "2026-11-13T11:20:00Z",
        )
        .expect("a mark")
    }

    #[test]
    fn the_spec_example_parses() {
        let mark = parse_mark(Some(SPEC_EXAMPLE)).expect("the spec's mark");
        assert_eq!(mark.at, "2026-11-13T11:20:00Z");
        assert_eq!(mark.containers.len(), 1);
        let c = &mark.containers[0];
        assert_eq!(c.name, "api");
        assert_eq!(c.original.memory.limit.as_deref(), Some("512Mi"));
        assert_eq!(c.applied.memory.limit.as_deref(), Some("768Mi"));
        assert_eq!(c.original, api("512Mi"));
        assert_eq!(c.applied, api("768Mi"));
    }

    #[test]
    fn the_mark_is_written_exactly_as_the_spec_shows() {
        let json = mark_json(&api("512Mi"), &api("768Mi"));
        let written: serde_json::Value = serde_json::from_str(&json).unwrap();
        let spec: serde_json::Value = serde_json::from_str(SPEC_EXAMPLE).unwrap();
        assert_eq!(written, spec);
        // A value not set is written as null, not left out.
        let unset = mark_json(
            &texts((None, None), (Some("256Mi"), None)),
            &texts((None, None), (Some("256Mi"), Some("512Mi"))),
        );
        let v: serde_json::Value = serde_json::from_str(&unset).unwrap();
        assert!(v["containers"]["api"]["original"]["memory"]["limit"].is_null());
        assert!(v["containers"]["api"]["original"]["memory"]
            .as_object()
            .unwrap()
            .contains_key("limit"));
        assert!(v["containers"]["api"]["applied"]["cpu"]["request"].is_null());
    }

    #[test]
    fn active_when_the_cluster_equals_applied_as_amounts() {
        let json = mark_json(&api("512Mi"), &api("1024Mi"));
        let cluster = [
            container("api", &api("1Gi")),
            container("envoy", &texts((None, None), (None, None))),
        ];
        let active = active_override(Some(&json), &cluster).expect("active");
        assert_eq!(
            active.containers[0].applied.memory.limit.as_deref(),
            Some("1024Mi")
        );
        assert_eq!(
            active.containers[0].original.memory.limit.as_deref(),
            Some("512Mi")
        );
    }

    #[test]
    fn stale_when_a_value_differs_or_the_container_is_gone() {
        let json = mark_json(&api("512Mi"), &api("768Mi"));
        // The fix arrived from git with another value.
        assert_eq!(
            active_override(Some(&json), &[container("api", &api("1Gi"))]),
            None
        );
        // The container was renamed or removed.
        assert_eq!(
            active_override(Some(&json), &[container("web", &api("768Mi"))]),
            None
        );
        // And it is active when nothing moved.
        assert!(active_override(Some(&json), &[container("api", &api("768Mi"))]).is_some());
    }

    #[test]
    fn unset_matches_null_only() {
        let applied = texts((Some("250m"), None), (Some("256Mi"), Some("512Mi")));
        let json = mark_json(
            &texts((Some("250m"), None), (Some("256Mi"), Some("256Mi"))),
            &applied,
        );
        let with_limit = texts((Some("250m"), Some("1")), (Some("256Mi"), Some("512Mi")));
        assert_eq!(
            active_override(Some(&json), &[container("api", &with_limit)]),
            None
        );
        assert!(active_override(Some(&json), &[container("api", &applied)]).is_some());
    }

    #[test]
    fn garbage_another_version_or_empty_is_no_mark() {
        let v2 = SPEC_EXAMPLE.replace("\"v\": 1", "\"v\": 2");
        let no_v = SPEC_EXAMPLE.replace("\"v\": 1,", "");
        let no_containers = r#"{"v":1,"at":"2026-11-13T11:20:00Z","containers":{}}"#;
        let wrong_shape =
            r#"{"v":1,"at":"2026-11-13T11:20:00Z","containers":{"api":{"original":3}}}"#;
        for bad in [
            "{",
            v2.as_str(),
            no_v.as_str(),
            "",
            "[]",
            "null",
            no_containers,
            wrong_shape,
        ] {
            assert_eq!(parse_mark(Some(bad)), None, "{bad:?}");
            assert_eq!(
                active_override(Some(bad), &[container("api", &api("768Mi"))]),
                None,
                "{bad:?}"
            );
        }
        assert_eq!(parse_mark(None), None);
        // A mark for a container that no longer exists is no mark either, and
        // the next change replaces it.
        let json = mark_json(&api("512Mi"), &api("768Mi"));
        assert_eq!(active_override(Some(&json), &[]), None);
    }

    #[test]
    fn second_change_keeps_the_first_original() {
        let first = mark_json(&api("512Mi"), &api("768Mi"));
        let active = parse_mark(Some(&first)).unwrap();
        let next = next_mark(
            Some(&active),
            &[OverrideContainer {
                name: "api".into(),
                original: api("768Mi"),
                applied: api("1Gi"),
            }],
            "2026-11-13T12:00:00Z",
        )
        .expect("a mark");
        let mark = parse_mark(Some(&next)).unwrap();
        assert_eq!(mark.at, "2026-11-13T12:00:00Z");
        assert_eq!(mark.containers.len(), 1);
        assert_eq!(mark.containers[0].original, api("512Mi"));
        assert_eq!(mark.containers[0].applied, api("1Gi"));
    }

    #[test]
    fn a_container_not_yet_listed_is_added_and_one_not_touched_stays() {
        let first = mark_json(&api("512Mi"), &api("768Mi"));
        let active = parse_mark(Some(&first)).unwrap();
        let envoy_before = texts((Some("100m"), None), (Some("64Mi"), Some("128Mi")));
        let envoy_after = texts((Some("200m"), None), (Some("64Mi"), Some("128Mi")));
        let next = next_mark(
            Some(&active),
            &[OverrideContainer {
                name: "envoy".into(),
                original: envoy_before.clone(),
                applied: envoy_after.clone(),
            }],
            "2026-11-13T12:00:00Z",
        )
        .unwrap();
        let mark = parse_mark(Some(&next)).unwrap();
        let names: Vec<_> = mark.containers.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["api", "envoy"]);
        assert_eq!(mark.containers[0].applied, api("768Mi"));
        assert_eq!(mark.containers[1].original, envoy_before);
        assert_eq!(mark.containers[1].applied, envoy_after);
    }

    #[test]
    fn a_stale_mark_is_replaced_not_merged() {
        // The caller passes no active mark when the one on the cluster is stale:
        // the result lists only the containers of this change.
        let envoy_before = texts((Some("100m"), None), (Some("64Mi"), Some("128Mi")));
        let envoy_after = texts((Some("100m"), None), (Some("64Mi"), Some("256Mi")));
        let next = next_mark(
            None,
            &[OverrideContainer {
                name: "envoy".into(),
                original: envoy_before.clone(),
                applied: envoy_after.clone(),
            }],
            "2026-11-13T12:00:00Z",
        )
        .unwrap();
        let mark = parse_mark(Some(&next)).unwrap();
        assert_eq!(
            mark.containers,
            [OverrideContainer {
                name: "envoy".into(),
                original: envoy_before,
                applied: envoy_after
            }]
        );
    }

    #[test]
    fn changing_back_to_the_original_removes_the_mark() {
        let first = mark_json(&api("512Mi"), &api("768Mi"));
        let active = parse_mark(Some(&first)).unwrap();
        // Back to 512Mi, typed as 0.5Gi: the same amount.
        let next = next_mark(
            Some(&active),
            &[OverrideContainer {
                name: "api".into(),
                original: api("768Mi"),
                applied: api("0.5Gi"),
            }],
            "2026-11-13T12:00:00Z",
        );
        assert_eq!(next, None);
    }
}
