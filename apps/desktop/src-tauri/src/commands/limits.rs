//! Tauri commands for a change of a Deployment's requests and limits (spec
//! §7.2): read the facts once, check each proposal against them without a
//! cluster call, apply (or dry-run) a checked change, and remove the
//! override mark alone.

use cubelite_core::{Evaluation, KubeClient, KubeconfigError, Proposal, ResourceFacts, SeenState};

/// The sentence to show: a client error's reason alone, without the
/// error-kind prefix (as `apply_resource_yaml` does).
fn reason(e: KubeconfigError) -> String {
    match e {
        KubeconfigError::ClientError { reason } => reason,
        other => other.to_string(),
    }
}

async fn client(kubeconfig_path: &str, context: Option<&str>) -> Result<KubeClient, String> {
    KubeClient::new(kubeconfig_path, context)
        .await
        .map_err(reason)
}

/// Read what a change of `namespace/name`'s requests and limits is checked against.
#[tauri::command]
pub async fn resource_facts(
    kubeconfig_path: String,
    namespace: String,
    name: String,
    context: Option<String>,
) -> Result<ResourceFacts, String> {
    client(&kubeconfig_path, context.as_deref())
        .await?
        .resource_facts(&namespace, &name)
        .await
        .map_err(reason)
}

/// Check a proposal against facts the frontend holds: no cluster call.
#[tauri::command]
pub fn evaluate_resources(facts: ResourceFacts, proposal: Proposal) -> Evaluation {
    cubelite_core::limits::evaluate(&facts, &proposal)
}

/// Apply a proposal, or dry-run it: the core reads the facts again and runs
/// the same check before it writes.
#[tauri::command]
pub async fn apply_resources(
    kubeconfig_path: String,
    namespace: String,
    name: String,
    proposal: Proposal,
    seen: SeenState,
    dry_run: bool,
    context: Option<String>,
) -> Result<Evaluation, String> {
    client(&kubeconfig_path, context.as_deref())
        .await?
        .apply_resources(&namespace, &name, &proposal, &seen, dry_run)
        .await
        .map_err(reason)
}

/// Remove the override mark and nothing else ("Keep these values").
#[tauri::command]
pub async fn clear_resources_override(
    kubeconfig_path: String,
    namespace: String,
    name: String,
    context: Option<String>,
) -> Result<(), String> {
    client(&kubeconfig_path, context.as_deref())
        .await?
        .clear_resources_override(&namespace, &name)
        .await
        .map_err(reason)
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use cubelite_core::limits::{
        evaluate, Amounts, BeforeAfter, Change, ContainerProposal, Fact, Finding, FindingCode,
        HpaFacts, Level, LimitRangeFacts, LimitRangeItemFacts, ManagerInfo, ManagerKind, NodeFacts,
        NodeProjection, OwnPodFacts, PerResource, PodFigures, ProposalKind, QuotaFacts,
        ResourceField, ResourceName, RolloutFacts, VpaFacts, WorkloadFacts,
    };
    use cubelite_core::resources::{
        ContainerResourcesInfo, QuantityInfo, ResourcePairInfo, TemplateContainerInfo,
    };
    use cubelite_core::ContainerUsageInfo;
    use serde::Serialize;
    use serde_json::{json, Value};

    use super::*;

    const TAURI_TS: &str = include_str!("../../../src/lib/tauri.ts");

    const MI: f64 = 1024.0 * 1024.0;

    fn quantity(text: &str, amount: f64) -> Option<QuantityInfo> {
        Some(QuantityInfo {
            text: text.into(),
            amount: Some(amount),
        })
    }

    fn api_resources(memory_limit: (&str, f64)) -> ContainerResourcesInfo {
        ContainerResourcesInfo {
            cpu: ResourcePairInfo {
                request: quantity("250m", 250.0),
                limit: quantity("500m", 500.0),
            },
            memory: ResourcePairInfo {
                request: quantity("256Mi", 256.0 * MI),
                limit: quantity(memory_limit.0, memory_limit.1),
            },
        }
    }

    /// A small cluster: one container, one pod, one node; LimitRanges not
    /// readable.
    fn sample_facts() -> ResourceFacts {
        let resources = api_resources(("512Mi", 512.0 * MI));
        let containers = vec![TemplateContainerInfo {
            name: "api".into(),
            image: Some("ghcr.io/x/api:1.0".into()),
            sidecar: false,
            resources: resources.clone(),
        }];
        ResourceFacts {
            workload: WorkloadFacts {
                namespace: "default".into(),
                name: "api".into(),
                resource_version: Some("812".into()),
                generation: 7,
                replicas: 2,
                rollout: RolloutFacts {
                    recreate: false,
                    max_surge: 1,
                    max_unavailable: 0,
                },
                containers,
                manager: ManagerInfo {
                    kind: ManagerKind::Helm,
                    release: Some("orders".into()),
                },
                ..WorkloadFacts::default()
            },
            seen: SeenState {
                generation: 7,
                resources: BTreeMap::from([("api".to_string(), resources)]),
                override_annotation: None,
            },
            pods: vec![OwnPodFacts {
                name: "api-1".into(),
                node: Some("aks-pool-1".into()),
                figures: PodFigures {
                    request: Amounts {
                        cpu_millis: 250.0,
                        memory_bytes: 256.0 * MI,
                    },
                    cpu_limit: Some(500.0),
                    memory_limit: Some(512.0 * MI),
                },
                usage: vec![ContainerUsageInfo {
                    name: "api".into(),
                    cpu_millis: 412.0,
                    memory_bytes: 498 * 1024 * 1024,
                }],
            }],
            usage: Fact::Known { value: () },
            nodes: Fact::Known {
                value: vec![NodeFacts {
                    name: "aks-pool-1".into(),
                    schedulable: true,
                    allocatable: Amounts {
                        cpu_millis: 4000.0,
                        memory_bytes: 16384.0 * MI,
                    },
                    others_requests: Amounts {
                        cpu_millis: 1000.0,
                        memory_bytes: 8192.0 * MI,
                    },
                    others_cpu_limits: 2000.0,
                    others_memory_limits: 11264.0 * MI,
                    memory_used: Some(13312.0 * MI),
                }],
            },
            limit_ranges: Fact::Missing {
                reason: "not allowed to read LimitRange".into(),
            },
            quotas: Fact::Known { value: Vec::new() },
            hpas: Fact::Known { value: Vec::new() },
            vpas: Fact::Known { value: Vec::new() },
        }
    }

    fn sample_proposal() -> Proposal {
        let mut resources = cubelite_core::ResourceTexts::from(&api_resources(("512Mi", 0.0)));
        resources.memory.limit = Some("768Mi".into());
        Proposal {
            kind: ProposalKind::Adjust,
            containers: vec![ContainerProposal {
                name: "api".into(),
                resources,
            }],
        }
    }

    /// Through JSON, as the frontend holds and sends it back.
    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(value: &T) -> T {
        let text = serde_json::to_string(value).expect("serialise");
        serde_json::from_str(&text).expect("deserialise")
    }

    #[test]
    fn a_client_error_reaches_the_user_without_its_prefix() {
        assert_eq!(
            reason(KubeconfigError::ClientError {
                reason: "Nothing to change.".into()
            }),
            "Nothing to change."
        );
        // Any other error keeps its own text.
        let other = KubeconfigError::FileNotFound {
            path: "/nowhere".into(),
        };
        let text = other.to_string();
        assert_eq!(reason(other), text);
    }

    #[test]
    fn facts_survive_the_round_trip_through_the_frontend() {
        let facts = sample_facts();
        let proposal = sample_proposal();
        let seen = facts.seen.clone();
        let (facts_back, proposal_back, seen_back) =
            (round_trip(&facts), round_trip(&proposal), round_trip(&seen));
        assert_eq!(facts_back, facts);
        assert_eq!(proposal_back, proposal);
        assert_eq!(seen_back, seen);
        let direct = evaluate(&facts, &proposal);
        assert_eq!(
            direct.changes.len(),
            1,
            "the sample proposal changes one field"
        );
        assert_eq!(evaluate_resources(facts_back, proposal_back), direct);
        // And the evaluation itself survives the way back.
        assert_eq!(round_trip(&direct), direct);
    }

    #[test]
    fn the_payload_shape_the_frontend_types_rely_on() {
        assert_eq!(
            serde_json::to_value(Fact::<Vec<NodeFacts>>::Missing { reason: "x".into() })
                .expect("json"),
            json!({ "state": "missing", "reason": "x" })
        );
        assert_eq!(
            serde_json::to_value(Fact::Known { value: () }).expect("json"),
            json!({ "state": "known", "value": null })
        );
        assert_eq!(
            serde_json::to_value(ProposalKind::Restore).expect("json"),
            json!("restore")
        );
        assert_eq!(
            serde_json::to_value(FindingCode::W1r).expect("json"),
            json!("w1r")
        );
        assert_eq!(
            serde_json::to_value(Level::NotChecked).expect("json"),
            json!("not_checked")
        );
    }

    // --- The TypeScript types of `tauri.ts` against the serde output ------

    /// The text of `export type <name> = ...;` in tauri.ts.
    fn ts_type(name: &str) -> &'static str {
        let start = [
            format!("export type {name} ="),
            format!("export type {name}<"),
        ]
        .iter()
        .find_map(|head| TAURI_TS.find(head.as_str()))
        .unwrap_or_else(|| panic!("tauri.ts has no type {name}"));
        let rest = &TAURI_TS[start..];
        let mut depth = 0i32;
        for (i, ch) in rest.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => depth -= 1,
                ';' if depth == 0 => return &rest[..i],
                _ => {}
            }
        }
        panic!("type {name} does not end");
    }

    /// The field names of an object type.
    fn ts_fields(name: &str) -> BTreeSet<String> {
        let text = ts_type(name);
        let open = text
            .find('{')
            .unwrap_or_else(|| panic!("{name} is not an object"));
        let body = &text[open + 1..text.rfind('}').unwrap_or(text.len())];
        body.split(['\n', ';'])
            .map(str::trim)
            .filter(|s| !(s.is_empty() || s.starts_with('/') || s.starts_with('*')))
            .filter_map(|s| {
                let field = s.split(':').next()?.trim().trim_end_matches('?');
                field
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
                    .then(|| field.to_string())
            })
            .collect()
    }

    /// The string literals of a union type.
    fn ts_union(name: &str) -> BTreeSet<String> {
        ts_type(name)
            .split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect()
    }

    /// The keys a value serialises to.
    fn keys<T: Serialize>(value: &T) -> BTreeSet<String> {
        match serde_json::to_value(value).expect("json") {
            Value::Object(map) => map.keys().cloned().collect(),
            other => panic!("not an object: {other}"),
        }
    }

    /// The names an enum's variants serialise to.
    fn names<T: Serialize>(variants: &[T]) -> BTreeSet<String> {
        variants
            .iter()
            .map(|v| match serde_json::to_value(v).expect("json") {
                Value::String(s) => s,
                other => panic!("not a string: {other}"),
            })
            .collect()
    }

    /// Every finding code. A new variant fails to compile here until it is listed.
    fn every_code() -> Vec<FindingCode> {
        use FindingCode::*;
        let all = vec![
            B1,
            B2,
            B3,
            B4,
            B5,
            Cleared,
            UnknownContainer,
            NoOverride,
            W0,
            W1,
            W1r,
            W2,
            W3,
            W4,
            W5,
            W6,
            W7,
            W8,
            MilliMemory,
            W9,
            NoteFits,
            NoteCpuLimits,
            NoteQos,
            NoteNoPods,
        ];
        for code in &all {
            match code {
                B1 | B2 | B3 | B4 | B5 | Cleared | UnknownContainer | NoOverride | W0 | W1
                | W1r | W2 | W3 | W4 | W5 | W6 | W7 | W8 | MilliMemory | W9 | NoteFits
                | NoteCpuLimits | NoteQos | NoteNoPods => {}
            }
        }
        all
    }

    #[test]
    fn the_typescript_enums_are_the_serde_names() {
        use Level::*;
        assert_eq!(ts_union("FindingCode"), names(&every_code()));
        for level in [Blocked, Warning, NotChecked, Note] {
            match level {
                Blocked | Warning | NotChecked | Note => {}
            }
        }
        assert_eq!(
            ts_union("FindingLevel"),
            names(&[Blocked, Warning, NotChecked, Note])
        );
        assert_eq!(
            ts_union("ProposalKind"),
            names(&[ProposalKind::Adjust, ProposalKind::Restore])
        );
        assert_eq!(
            ts_union("ResourceName"),
            names(&[ResourceName::Cpu, ResourceName::Memory])
        );
        assert_eq!(
            ts_union("ResourceField"),
            names(&[ResourceField::Request, ResourceField::Limit])
        );
        assert_eq!(
            ts_union("Fact"),
            BTreeSet::from(["known".to_string(), "missing".to_string()])
        );
    }

    #[test]
    fn the_typescript_types_have_the_serde_fields() {
        let facts = sample_facts();
        let finding = Finding {
            code: FindingCode::W2,
            level: Level::Warning,
            message: "m".into(),
            container: None,
            resource: None,
            field: None,
            node: None,
        };
        let change = Change {
            container: "api".into(),
            sidecar: false,
            resource: ResourceName::Memory,
            field: ResourceField::Limit,
            before: None,
            after: None,
        };
        let evaluation = Evaluation {
            findings: vec![finding.clone()],
            changes: vec![change.clone()],
            nodes: vec![NodeProjection::default()],
        };
        let cases: [(&str, BTreeSet<String>); 22] = [
            ("ResourceFacts", keys(&facts)),
            ("WorkloadFacts", keys(&facts.workload)),
            ("RolloutFacts", keys(&facts.workload.rollout)),
            ("SeenState", keys(&facts.seen)),
            ("OwnPodFacts", keys(&facts.pods[0])),
            ("PodFigures", keys(&PodFigures::default())),
            ("Amounts", keys(&Amounts::default())),
            ("NodeFacts", keys(&NodeFacts::default())),
            ("PerResource", keys(&PerResource::default())),
            ("LimitRangeItemFacts", keys(&LimitRangeItemFacts::default())),
            ("LimitRangeFacts", keys(&LimitRangeFacts::default())),
            ("QuotaFacts", keys(&QuotaFacts::default())),
            ("HpaFacts", keys(&HpaFacts::default())),
            ("VpaFacts", keys(&VpaFacts::default())),
            ("ContainerProposal", keys(&ContainerProposal::default())),
            ("ResourceProposal", keys(&sample_proposal())),
            ("Finding", keys(&finding)),
            ("ResourceChange", keys(&change)),
            ("BeforeAfter", keys(&BeforeAfter::default())),
            ("NodeProjection", keys(&NodeProjection::default())),
            ("ResourceEvaluation", keys(&evaluation)),
            ("ManagerInfo", keys(&ManagerInfo::default())),
        ];
        for (name, rust) in cases {
            assert_eq!(ts_fields(name), rust, "{name}");
        }
    }
}
