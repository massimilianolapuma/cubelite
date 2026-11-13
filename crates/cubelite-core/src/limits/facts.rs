//! Reading what a change of a Deployment's requests and limits is checked
//! against (spec §4.3, §7.1): the only part of the check with I/O.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use k8s_openapi::api::apps::v1::{Deployment, DeploymentStrategy};
use k8s_openapi::api::autoscaling::v2::{HorizontalPodAutoscaler, MetricTarget};
use k8s_openapi::api::core::v1::{
    Container, LimitRange, LimitRangeItem, Node, Pod, PodSpec, ResourceQuota,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{Api, ListParams};
use kube::core::Selector;
use kube::Client;

use super::manager::detect_manager;
use super::pod_math::{effective, pod_figures, EffectiveContainer};
use super::types::{
    Amounts, Fact, HpaFacts, LimitRangeFacts, LimitRangeItemFacts, NodeFacts, OwnPodFacts,
    PerResource, PodFigures, QuotaFacts, ResourceFacts, RolloutFacts, SeenState, VpaFacts,
    WorkloadFacts,
};
use super::OVERRIDE_ANNOTATION;
use crate::metrics::{
    parse_cpu_millis, parse_memory_bytes, pod_metrics_from_item, ContainerUsageInfo,
};
use crate::resources::TemplateContainerInfo;
use crate::watcher::container_resources;
use crate::{KubeClient, KubeconfigError};

/// Why `usage` is missing, whichever of the two metrics calls failed.
const NO_METRICS: &str = "metrics-server is not installed or did not answer";

/// The quota keys spec B5 reads.
const QUOTA_KEYS: [&str; 6] = [
    "requests.cpu",
    "requests.memory",
    "limits.cpu",
    "limits.memory",
    "cpu",
    "memory",
];

/// The pods that still hold their room: neither `Succeeded` nor `Failed`.
const NOT_FINISHED: &str = "status.phase!=Succeeded,status.phase!=Failed";

impl KubeClient {
    /// The facts a change of `namespace/name`'s requests and limits is
    /// checked against.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] with the API's message when
    /// the Deployment or its own pods cannot be read. Every other part is
    /// optional: a failed read becomes a `Missing` fact with its reason.
    pub async fn resource_facts(
        &self,
        namespace: &str,
        name: &str,
    ) -> Result<ResourceFacts, KubeconfigError> {
        let client = self.client();
        let deployment = Api::<Deployment>::namespaced(client.clone(), namespace)
            .get(name)
            .await
            .map_err(client_error)?;
        let selector = deployment
            .spec
            .as_ref()
            .map(|s| s.selector.clone())
            .unwrap_or_default();
        let selector = Selector::try_from(selector).map_err(|e| KubeconfigError::ClientError {
            reason: format!("The deployment's selector cannot be read: {e}"),
        })?;

        let own_params = ListParams::default().labels_from(&selector);
        let not_finished = ListParams::default().fields(NOT_FINISHED);
        let all = ListParams::default();
        let own_pods_api = Api::<Pod>::namespaced(client.clone(), namespace);
        let all_pods_api = Api::<Pod>::all(client.clone());
        let nodes_api = Api::<Node>::all(client.clone());
        let limit_ranges_api = Api::<LimitRange>::namespaced(client.clone(), namespace);
        let quotas_api = Api::<ResourceQuota>::namespaced(client.clone(), namespace);
        let hpas_api = Api::<HorizontalPodAutoscaler>::namespaced(client.clone(), namespace);
        let pod_metrics_path = format!("/apis/metrics.k8s.io/v1beta1/namespaces/{namespace}/pods");
        let vpas_path =
            format!("/apis/autoscaling.k8s.io/v1/namespaces/{namespace}/verticalpodautoscalers");
        let (own, nodes, all_pods, node_metrics, pod_metrics, limit_ranges, quotas, hpas, vpas) = tokio::join!(
            own_pods_api.list(&own_params),
            nodes_api.list(&all),
            all_pods_api.list(&not_finished),
            get_json(&client, "/apis/metrics.k8s.io/v1beta1/nodes"),
            get_json(&client, &pod_metrics_path),
            limit_ranges_api.list(&all),
            quotas_api.list(&all),
            hpas_api.list(&all),
            get_json(&client, &vpas_path),
        );
        // The selector may match pods of other workloads (a canary, a Job):
        // only the ones its own ReplicaSets control are this Deployment's.
        // The others are in the all-namespaces list and count there.
        let own: Vec<Pod> = own
            .map_err(client_error)?
            .items
            .into_iter()
            .filter(|p| !finished(p) && owned_by(p, name))
            .collect();

        // Usage: both metrics calls, or none.
        let usage = match (node_metrics, pod_metrics) {
            (Ok(nodes), Ok(pods)) => Some((node_memory_used(&nodes), pod_usage(&pods))),
            _ => None,
        };

        let pods: Vec<OwnPodFacts> = own
            .iter()
            .map(|p| {
                let name = p.metadata.name.clone().unwrap_or_default();
                OwnPodFacts {
                    usage: usage
                        .as_ref()
                        .and_then(|(_, by_pod)| by_pod.get(&name).cloned())
                        .unwrap_or_default(),
                    node: p.spec.as_ref().and_then(|s| s.node_name.clone()),
                    figures: p.spec.as_ref().map(spec_figures).unwrap_or_default(),
                    name,
                }
            })
            .collect();
        let own_names: BTreeSet<&str> = own
            .iter()
            .filter_map(|p| p.metadata.name.as_deref())
            .collect();

        let nodes = match (nodes, all_pods) {
            (Err(e), _) => Fact::Missing {
                reason: optional_reason(&e, "not allowed to list nodes"),
            },
            (Ok(_), Err(e)) => Fact::Missing {
                reason: optional_reason(&e, "not allowed to list pods in other namespaces"),
            },
            (Ok(nodes), Ok(all_pods)) => {
                let others: Vec<&Pod> = all_pods
                    .items
                    .iter()
                    .filter(|p| !finished(p))
                    .filter(|p| {
                        !(p.metadata.namespace.as_deref() == Some(namespace)
                            && p.metadata
                                .name
                                .as_deref()
                                .is_some_and(|n| own_names.contains(n)))
                    })
                    .collect();
                let memory_used = usage.as_ref().map(|(by_node, _)| by_node);
                Fact::Known {
                    value: nodes
                        .items
                        .iter()
                        .filter_map(|n| node_facts(n, &others, memory_used))
                        .collect(),
                }
            }
        };

        let limit_ranges = match limit_ranges {
            Ok(list) => Fact::Known {
                value: list.items.iter().map(limit_range_facts).collect(),
            },
            Err(e) => Fact::Missing {
                reason: optional_reason(&e, "not allowed to read LimitRange"),
            },
        };
        let quotas = match quotas {
            Ok(list) => Fact::Known {
                value: list.items.iter().map(quota_facts).collect(),
            },
            Err(e) => Fact::Missing {
                reason: optional_reason(&e, "not allowed to read ResourceQuota"),
            },
        };
        let hpas = match hpas {
            Ok(list) => Fact::Known {
                value: list
                    .items
                    .iter()
                    .filter_map(|h| hpa_facts(h, name))
                    .collect(),
            },
            Err(e) => Fact::Missing {
                reason: optional_reason(&e, "not allowed to read HorizontalPodAutoscaler"),
            },
        };
        let vpas = match vpas {
            Ok(doc) => Fact::Known {
                value: vpa_facts(&doc, name),
            },
            // No VPA API: no VPA can exist.
            Err(e) if api_status_is(&e, 404, "NotFound") => Fact::Known { value: Vec::new() },
            Err(e) => Fact::Missing {
                reason: optional_reason(&e, "not allowed to read VerticalPodAutoscaler"),
            },
        };

        let overhead = own
            .first()
            .and_then(|p| p.spec.as_ref())
            .map(|s| amounts(s.overhead.as_ref()))
            .unwrap_or_default();
        let (workload, seen) = workload_facts(&deployment, namespace, name, overhead);
        Ok(ResourceFacts {
            workload,
            seen,
            pods,
            usage: match usage {
                Some(_) => Fact::Known { value: () },
                None => Fact::Missing {
                    reason: NO_METRICS.to_string(),
                },
            },
            nodes,
            limit_ranges,
            quotas,
            hpas,
            vpas,
        })
    }
}

/// GET an API path as JSON, keeping the API's status on failure.
async fn get_json(client: &Client, path: &str) -> Result<serde_json::Value, kube::Error> {
    let request = http::Request::get(path)
        .body(Vec::new())
        .map_err(kube::Error::HttpError)?;
    client.request::<serde_json::Value>(request).await
}

/// The API's message, or the error itself when there is none.
pub(crate) fn api_message(error: &kube::Error) -> String {
    match error {
        kube::Error::Api(status) if !status.message.is_empty() => status.message.clone(),
        other => other.to_string(),
    }
}

/// A failure that fails the call: the API's message.
fn client_error(error: kube::Error) -> KubeconfigError {
    KubeconfigError::ClientError {
        reason: api_message(&error),
    }
}

/// The API answered with this HTTP status. The code or the reason is
/// enough: a body that is not a `Status` (a plain-text 404) keeps only the
/// code, and kube's own `is_not_found` ignores the code in that case.
pub(crate) fn api_status_is(error: &kube::Error, code: u16, reason: &str) -> bool {
    matches!(error, kube::Error::Api(status) if status.code == code || status.reason == reason)
}

/// Why an optional part is missing: `forbidden` for a 403, else what the API said.
fn optional_reason(error: &kube::Error, forbidden: &str) -> String {
    if api_status_is(error, 403, "Forbidden") {
        forbidden.to_string()
    } else {
        format!("could not be read: {}", api_message(error))
    }
}

/// A pod that no longer holds its room.
fn finished(pod: &Pod) -> bool {
    matches!(
        pod.status.as_ref().and_then(|s| s.phase.as_deref()),
        Some("Succeeded" | "Failed")
    )
}

/// A pod of the Deployment `deployment`: its controller is the ReplicaSet
/// `{deployment}-{pod-template-hash}`, the name the Deployment controller
/// gives the ReplicaSet of each template.
fn owned_by(pod: &Pod, deployment: &str) -> bool {
    let Some(hash) = pod
        .metadata
        .labels
        .as_ref()
        .and_then(|l| l.get("pod-template-hash"))
    else {
        return false;
    };
    let replica_set = format!("{deployment}-{hash}");
    pod.metadata
        .owner_references
        .iter()
        .flatten()
        .any(|o| o.controller == Some(true) && o.kind == "ReplicaSet" && o.name == replica_set)
}

fn cpu(q: &Quantity) -> Option<f64> {
    parse_cpu_millis(&q.0)
}

fn memory(q: &Quantity) -> Option<f64> {
    parse_memory_bytes(&q.0).map(|b| b as f64)
}

/// CPU and memory of a resource map; what is absent or unreadable is 0.
fn amounts(map: Option<&BTreeMap<String, Quantity>>) -> Amounts {
    Amounts {
        cpu_millis: map.and_then(|m| m.get("cpu")).and_then(cpu).unwrap_or(0.0),
        memory_bytes: map
            .and_then(|m| m.get("memory"))
            .and_then(memory)
            .unwrap_or(0.0),
    }
}

/// The effective values of a container of a pod: the API already applied
/// the LimitRange defaults, so none are added here.
fn effective_of(c: &Container) -> EffectiveContainer {
    let r = container_resources(c);
    let amount = |q: &Option<crate::resources::QuantityInfo>| q.as_ref().and_then(|q| q.amount);
    effective(
        &c.name,
        (amount(&r.cpu.request), amount(&r.cpu.limit)),
        (amount(&r.memory.request), amount(&r.memory.limit)),
        &[],
    )
}

/// A native sidecar: an init container with `restartPolicy: Always`.
fn is_sidecar(c: &Container) -> bool {
    c.restart_policy.as_deref() == Some("Always")
}

/// A pod's figures from its own spec, with its overhead.
fn spec_figures(spec: &PodSpec) -> PodFigures {
    let regular: Vec<EffectiveContainer> = spec.containers.iter().map(effective_of).collect();
    let init: Vec<(EffectiveContainer, bool)> = spec
        .init_containers
        .iter()
        .flatten()
        .map(|c| (effective_of(c), is_sidecar(c)))
        .collect();
    pod_figures(&regular, &init, &amounts(spec.overhead.as_ref()))
}

/// Memory in use per node, from metrics-server.
fn node_memory_used(doc: &serde_json::Value) -> HashMap<String, f64> {
    doc["items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|item| {
            let name = item["metadata"]["name"].as_str()?.to_string();
            let used = item["usage"]["memory"]
                .as_str()
                .and_then(parse_memory_bytes)?;
            Some((name, used as f64))
        })
        .collect()
}

/// Usage per container, by pod name, from metrics-server.
fn pod_usage(doc: &serde_json::Value) -> HashMap<String, Vec<ContainerUsageInfo>> {
    doc["items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(pod_metrics_from_item)
        .map(|m| (m.name, m.containers))
        .collect()
}

/// One node: its allocatable, whether a new pod can land on it, and what
/// the pods of other workloads on it ask for.
fn node_facts(
    node: &Node,
    others: &[&Pod],
    memory_used: Option<&HashMap<String, f64>>,
) -> Option<NodeFacts> {
    let name = node.metadata.name.clone()?;
    let ready = node
        .status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .is_some_and(|conditions| {
            conditions
                .iter()
                .any(|c| c.type_ == "Ready" && c.status == "True")
        });
    let cordoned = node
        .spec
        .as_ref()
        .and_then(|s| s.unschedulable)
        .unwrap_or(false);
    let mut facts = NodeFacts {
        schedulable: ready && !cordoned,
        allocatable: amounts(node.status.as_ref().and_then(|s| s.allocatable.as_ref())),
        memory_used: memory_used.and_then(|m| m.get(&name).copied()),
        ..NodeFacts::default()
    };
    for figures in others
        .iter()
        .filter_map(|p| p.spec.as_ref())
        .filter(|s| s.node_name.as_deref() == Some(name.as_str()))
        .map(spec_figures)
    {
        facts.others_requests.cpu_millis += figures.request.cpu_millis;
        facts.others_requests.memory_bytes += figures.request.memory_bytes;
        facts.others_cpu_limits += figures.cpu_limit.unwrap_or(0.0);
        facts.others_memory_limits += figures.memory_limit.unwrap_or(0.0);
    }
    facts.name = name;
    Some(facts)
}

/// A count or a percentage of `replicas`, as Kubernetes resolves it.
fn scaled(value: Option<&IntOrString>, replicas: i32, round_up: bool) -> i32 {
    let percent = |p: i64| {
        // A percentage the API would never hold must not overflow: saturate.
        let total = p.saturating_mul(i64::from(replicas.max(0)));
        let count = if round_up {
            total.saturating_add(99) / 100
        } else {
            total / 100
        };
        i32::try_from(count).unwrap_or(i32::MAX)
    };
    match value {
        Some(IntOrString::Int(n)) => (*n).max(0),
        Some(IntOrString::String(s)) => match s.strip_suffix('%') {
            Some(p) => p.trim().parse::<i64>().map(|p| percent(p.max(0))),
            None => s.trim().parse::<i32>().map(|n| n.max(0)),
        }
        // A value the API would not accept: the default.
        .unwrap_or_else(|_| percent(25)),
        None => percent(25),
    }
}

/// How the Deployment rolls out, its counts resolved against the replicas.
fn rollout_facts(strategy: Option<&DeploymentStrategy>, replicas: i32) -> RolloutFacts {
    if strategy.and_then(|s| s.type_.as_deref()) == Some("Recreate") {
        return RolloutFacts {
            recreate: true,
            max_surge: 0,
            max_unavailable: 0,
        };
    }
    let rolling = strategy.and_then(|s| s.rolling_update.as_ref());
    let max_surge = scaled(rolling.and_then(|r| r.max_surge.as_ref()), replicas, true);
    let mut max_unavailable = scaled(
        rolling.and_then(|r| r.max_unavailable.as_ref()),
        replicas,
        false,
    );
    if max_surge == 0 && max_unavailable == 0 {
        max_unavailable = 1;
    }
    RolloutFacts {
        recreate: false,
        max_surge,
        max_unavailable,
    }
}

/// The Deployment's own facts and what the editor will send back.
fn workload_facts(
    deployment: &Deployment,
    namespace: &str,
    name: &str,
    overhead: Amounts,
) -> (WorkloadFacts, SeenState) {
    let meta = &deployment.metadata;
    let no_map = BTreeMap::new();
    let annotations = meta.annotations.as_ref().unwrap_or(&no_map);
    let override_annotation = annotations.get(OVERRIDE_ANNOTATION).cloned();
    let spec = deployment.spec.as_ref();
    let pod_spec = spec.and_then(|s| s.template.spec.as_ref());
    let template = |c: &Container, sidecar: bool| TemplateContainerInfo {
        name: c.name.clone(),
        image: c.image.clone(),
        sidecar,
        resources: container_resources(c),
    };
    let containers: Vec<TemplateContainerInfo> = pod_spec
        .map(|s| s.containers.iter().map(|c| template(c, false)).collect())
        .unwrap_or_default();
    let init_containers: Vec<TemplateContainerInfo> = pod_spec
        .and_then(|s| s.init_containers.as_ref())
        .map(|init| init.iter().map(|c| template(c, is_sidecar(c))).collect())
        .unwrap_or_default();
    // The API defaults an unset replica count to 1.
    let replicas = spec.and_then(|s| s.replicas).unwrap_or(1);
    let generation = meta.generation.unwrap_or(0);
    let seen = SeenState {
        generation,
        resources: containers
            .iter()
            .chain(init_containers.iter())
            .map(|c| (c.name.clone(), c.resources.clone()))
            .collect(),
        override_annotation: override_annotation.clone(),
    };
    let workload = WorkloadFacts {
        namespace: namespace.to_string(),
        name: name.to_string(),
        resource_version: meta.resource_version.clone(),
        generation,
        replicas,
        rollout: rollout_facts(spec.and_then(|s| s.strategy.as_ref()), replicas),
        containers,
        init_containers,
        overhead,
        manager: detect_manager(meta.labels.as_ref().unwrap_or(&no_map), annotations),
        override_annotation,
    };
    (workload, seen)
}

/// One resource map of a LimitRange item, per resource.
fn per_resource(map: Option<&BTreeMap<String, Quantity>>) -> PerResource {
    PerResource {
        cpu: map.and_then(|m| m.get("cpu")).and_then(cpu),
        memory: map.and_then(|m| m.get("memory")).and_then(memory),
    }
}

/// `maxLimitRequestRatio`: plain numbers, whatever the resource.
fn ratios(map: Option<&BTreeMap<String, Quantity>>) -> PerResource {
    let ratio = |key: &str| {
        map.and_then(|m| m.get(key))
            .and_then(cpu)
            .map(|millis| millis / 1000.0)
    };
    PerResource {
        cpu: ratio("cpu"),
        memory: ratio("memory"),
    }
}

fn limit_range_item(item: &LimitRangeItem) -> LimitRangeItemFacts {
    LimitRangeItemFacts {
        kind: item.type_.clone(),
        min: per_resource(item.min.as_ref()),
        max: per_resource(item.max.as_ref()),
        default: per_resource(item.default.as_ref()),
        default_request: per_resource(item.default_request.as_ref()),
        max_ratio: ratios(item.max_limit_request_ratio.as_ref()),
    }
}

fn limit_range_facts(lr: &LimitRange) -> LimitRangeFacts {
    LimitRangeFacts {
        name: lr.metadata.name.clone().unwrap_or_default(),
        items: lr
            .spec
            .as_ref()
            .map(|s| s.limits.iter().map(limit_range_item).collect())
            .unwrap_or_default(),
    }
}

/// A quota key's amount: millicores for the CPU keys, bytes for the memory ones.
fn quota_amount(key: &str, q: &Quantity) -> Option<f64> {
    if key.ends_with("cpu") {
        cpu(q)
    } else {
        memory(q)
    }
}

fn quota_facts(q: &ResourceQuota) -> QuotaFacts {
    let spec = q.spec.as_ref();
    let status = q.status.as_ref();
    let scoped = spec.is_some_and(|s| {
        s.scopes.as_ref().is_some_and(|scopes| !scopes.is_empty()) || s.scope_selector.is_some()
    });
    let status_hard = status.and_then(|s| s.hard.as_ref());
    let spec_hard = spec.and_then(|s| s.hard.as_ref());
    let used = status.and_then(|s| s.used.as_ref());
    let read = |maps: &[Option<&BTreeMap<String, Quantity>>]| -> BTreeMap<String, f64> {
        QUOTA_KEYS
            .iter()
            .filter_map(|key| {
                // The first map that has the key.
                let q = maps.iter().flatten().find_map(|m| m.get(*key))?;
                Some((key.to_string(), quota_amount(key, q)?))
            })
            .collect()
    };
    QuotaFacts {
        name: q.metadata.name.clone().unwrap_or_default(),
        scoped,
        hard: read(&[status_hard, spec_hard]),
        used: read(&[used]),
    }
}

/// An HPA that targets the Deployment `name`, and what it scales on.
fn hpa_facts(hpa: &HorizontalPodAutoscaler, name: &str) -> Option<HpaFacts> {
    let spec = hpa.spec.as_ref()?;
    let target = &spec.scale_target_ref;
    if target.kind != "Deployment" || target.name != name {
        return None;
    }
    let mut facts = HpaFacts {
        name: hpa.metadata.name.clone().unwrap_or_default(),
        ..HpaFacts::default()
    };
    let utilization = |resource: &str, t: &MetricTarget| -> Option<String> {
        (t.type_ == "Utilization").then(|| resource.to_string())
    };
    let metrics = spec.metrics.as_deref().unwrap_or(&[]);
    if metrics.is_empty() {
        // autoscaling/v2: with no metric, 80% average CPU utilisation.
        facts.cpu_utilization = true;
    }
    for m in metrics {
        let on = match m.type_.as_str() {
            "Resource" => m
                .resource
                .as_ref()
                .and_then(|r| utilization(&r.name, &r.target)),
            "ContainerResource" => m
                .container_resource
                .as_ref()
                .and_then(|r| utilization(&r.name, &r.target)),
            _ => None,
        };
        match on.as_deref() {
            Some("cpu") => facts.cpu_utilization = true,
            Some("memory") => facts.memory_utilization = true,
            _ => {}
        }
    }
    Some(facts)
}

/// The VPAs of the list that target the Deployment `name`.
fn vpa_facts(doc: &serde_json::Value, name: &str) -> Vec<VpaFacts> {
    doc["items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|v| {
            let target = &v["spec"]["targetRef"];
            target["kind"].as_str() == Some("Deployment") && target["name"].as_str() == Some(name)
        })
        .map(|v| VpaFacts {
            name: v["metadata"]["name"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            update_mode: v["spec"]["updatePolicy"]["updateMode"]
                .as_str()
                .unwrap_or("Auto")
                .to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use http::Method;
    use serde_json::{json, Value};

    use super::*;
    use crate::limits::fixtures::{
        baseline_containers_json, cluster, container, container_json, facts, forbidden_json,
        node_json, own_pod_json, owned_pod_json, pod_json, pod_metrics_json, status_json, Cluster,
        ALL_PODS, DEPLOYMENT, GI, HPAS, LIMIT_RANGES, MI, NODES, NODE_METRICS, OWN_PODS,
        POD_METRICS, QUOTAS, TEMPLATE_HASH, VPAS,
    };
    use crate::limits::types::{
        Amounts, Fact, HpaFacts, LimitRangeFacts, LimitRangeItemFacts, PerResource, QuotaFacts,
        RolloutFacts, VpaFacts,
    };
    use crate::limits::{ManagerKind, OVERRIDE_ANNOTATION};
    use crate::test_support::requests;

    /// The facts of `cluster`, and the requests it saw.
    async fn read(cluster: Cluster) -> (ResourceFacts, Vec<crate::test_support::Seen>) {
        let (client, server) = cluster.client();
        let facts = client
            .resource_facts("default", "api")
            .await
            .expect("facts");
        (facts, requests(client, server).await)
    }

    /// The reason of an error of `resource_facts`.
    async fn refused(cluster: Cluster) -> String {
        let (client, server) = cluster.client();
        let err = client
            .resource_facts("default", "api")
            .await
            .expect_err("refused");
        requests(client, server).await;
        match err {
            KubeconfigError::ClientError { reason } => reason,
            other => panic!("unexpected error {other:?}"),
        }
    }

    fn missing<T>(reason: &str) -> Fact<T> {
        Fact::Missing {
            reason: reason.to_string(),
        }
    }

    #[tokio::test]
    async fn facts_of_the_baseline_cluster_equal_the_baseline_facts() {
        let (read, _) = read(cluster()).await;
        assert_eq!(read, facts());
    }

    #[tokio::test]
    async fn the_deployment_missing_is_an_error_with_the_api_message() {
        let gone = cluster().with(
            DEPLOYMENT,
            404,
            status_json(404, "NotFound", "deployments.apps \"api\" not found"),
        );
        assert_eq!(refused(gone).await, "deployments.apps \"api\" not found");
    }

    #[tokio::test]
    async fn its_own_pods_unreadable_is_an_error_with_the_api_message() {
        let message = "pods is forbidden: User \"dev\" cannot list resource \"pods\" in API group \"\" in the namespace \"default\"";
        let hidden = cluster().with(OWN_PODS, 403, forbidden_json(message));
        assert_eq!(refused(hidden).await, message);
    }

    #[tokio::test]
    async fn without_metrics_server_nodes_still_carry_allocatable() {
        let not_found = status_json(
            404,
            "NotFound",
            "the server could not find the requested resource",
        );
        let (f, _) = read(cluster().with(NODE_METRICS, 404, not_found.clone()).with(
            POD_METRICS,
            404,
            not_found,
        ))
        .await;
        assert_eq!(
            f.usage,
            missing("metrics-server is not installed or did not answer")
        );
        let nodes = f.nodes.known().expect("nodes known");
        assert_eq!(nodes.len(), 2);
        for n in nodes {
            assert_eq!(
                n.allocatable,
                Amounts {
                    cpu_millis: 4000.0,
                    memory_bytes: 16.0 * GI
                }
            );
            assert_eq!(n.memory_used, None);
        }
        assert!(f.pods.iter().all(|p| p.usage.is_empty()));
        assert_eq!(f.pods.len(), 3);

        // Either call failing is enough: the two are one fact.
        for route in [POD_METRICS, NODE_METRICS] {
            let (f, _) = read(cluster().with(
                route,
                503,
                status_json(
                    503,
                    "ServiceUnavailable",
                    "the server is currently unable to handle the request",
                ),
            ))
            .await;
            assert_eq!(
                f.usage,
                missing("metrics-server is not installed or did not answer"),
                "{route}"
            );
            assert!(f.pods.iter().all(|p| p.usage.is_empty()), "{route}");
            assert!(
                f.nodes
                    .known()
                    .expect("nodes")
                    .iter()
                    .all(|n| n.memory_used.is_none()),
                "{route}"
            );
        }
    }

    #[tokio::test]
    async fn a_namespace_scoped_user_gets_nodes_missing_and_the_namespace_rules() {
        let (f, _) = read(
            cluster()
                .with(NODES, 403, forbidden_json("nodes is forbidden"))
                .with(ALL_PODS, 403, forbidden_json("pods is forbidden"))
                .with(
                    NODE_METRICS,
                    403,
                    forbidden_json("nodes.metrics.k8s.io is forbidden"),
                ),
        )
        .await;
        assert_eq!(f.nodes, missing("not allowed to list nodes"));
        assert_eq!(f.limit_ranges, Fact::Known { value: Vec::new() });
        assert_eq!(f.quotas, Fact::Known { value: Vec::new() });
        assert_eq!(f.hpas, Fact::Known { value: Vec::new() });
        assert_eq!(f.pods.len(), 3);
    }

    #[tokio::test]
    async fn each_forbidden_part_is_missing_with_its_reason() {
        let base = facts();
        let cases: [(&str, &str); 5] = [
            (LIMIT_RANGES, "not allowed to read LimitRange"),
            (QUOTAS, "not allowed to read ResourceQuota"),
            (HPAS, "not allowed to read HorizontalPodAutoscaler"),
            (VPAS, "not allowed to read VerticalPodAutoscaler"),
            (ALL_PODS, "not allowed to list pods in other namespaces"),
        ];
        for (route, reason) in cases {
            let (f, _) = read(cluster().with(route, 403, forbidden_json("forbidden"))).await;
            let mut want = base.clone();
            match route {
                LIMIT_RANGES => want.limit_ranges = missing(reason),
                QUOTAS => want.quotas = missing(reason),
                HPAS => want.hpas = missing(reason),
                VPAS => want.vpas = missing(reason),
                _ => want.nodes = missing(reason),
            }
            assert_eq!(f, want, "{route}");
        }
    }

    #[tokio::test]
    async fn any_other_failure_of_an_optional_read_says_what_the_api_said() {
        let (f, _) = read(cluster().with(
            QUOTAS,
            500,
            status_json(500, "InternalError", "etcdserver: request timed out"),
        ))
        .await;
        assert_eq!(
            f.quotas,
            missing("could not be read: etcdserver: request timed out")
        );
        let (f, _) = read(cluster().with(
            NODES,
            500,
            status_json(500, "InternalError", "etcdserver: leader changed"),
        ))
        .await;
        assert_eq!(
            f.nodes,
            missing("could not be read: etcdserver: leader changed")
        );
        let (f, _) = read(cluster().with(
            VPAS,
            500,
            status_json(500, "InternalError", "conversion webhook failed"),
        ))
        .await;
        assert_eq!(
            f.vpas,
            missing("could not be read: conversion webhook failed")
        );
    }

    #[tokio::test]
    async fn no_vpa_api_is_known_and_empty() {
        // The API server answers 404 for a group it does not serve, as text.
        let (f, _) = read(cluster().with(VPAS, 404, json!("404 page not found"))).await;
        assert_eq!(f.vpas, Fact::Known { value: Vec::new() });
        let (f, _) = read(cluster().with(
            VPAS,
            404,
            status_json(
                404,
                "NotFound",
                "the server could not find the requested resource",
            ),
        ))
        .await;
        assert_eq!(f.vpas, Fact::Known { value: Vec::new() });
    }

    #[tokio::test]
    async fn terminal_pods_are_not_counted() {
        let mut c = cluster();
        let big = json!([container_json(
            "job",
            (Some("3"), Some("3")),
            (Some("8Gi"), Some("8Gi"))
        )]);
        c.own_pods.push(own_pod_json(
            "api-old",
            "aks-pool-1",
            "Failed",
            crate::limits::fixtures::baseline_containers_json(),
        ));
        c.other_pods.push(pod_json(
            "data",
            "job-1",
            "aks-pool-1",
            "Succeeded",
            big.clone(),
        ));
        c.other_pods
            .push(pod_json("data", "job-2", "aks-pool-1", "Failed", big));
        let (f, seen) = read(c).await;
        // The own pods and the node sums are the baseline's.
        assert_eq!(f, facts());
        let all = seen
            .iter()
            .find(|s| s.uri.starts_with(ALL_PODS))
            .expect("all-namespaces pods listed");
        assert!(
            all.uri
                .contains("fieldSelector=status.phase%21%3DSucceeded%2Cstatus.phase%21%3DFailed"),
            "{}",
            all.uri
        );
        let own = seen
            .iter()
            .find(|s| s.uri.starts_with(OWN_PODS))
            .expect("own pods listed");
        assert!(own.uri.contains("labelSelector=app%3Dapi"), "{}", own.uri);
    }

    #[tokio::test]
    async fn a_pod_of_another_namespace_with_an_own_pods_name_is_counted() {
        let mut c = cluster();
        c.other_pods.push(pod_json(
            "staging",
            "api-1",
            "aks-pool-2",
            "Running",
            json!([container_json(
                "api",
                (Some("500m"), Some("1")),
                (Some("1Gi"), Some("2Gi"))
            )]),
        ));
        let (f, _) = read(c).await;
        let pool2 = &f.nodes.known().expect("nodes")[1];
        assert_eq!(pool2.others_requests.cpu_millis, 2500.0);
        assert_eq!(pool2.others_requests.memory_bytes, 9.0 * GI);
        assert_eq!(pool2.others_cpu_limits, 3000.0);
        assert_eq!(pool2.others_memory_limits, 10.0 * GI);
    }

    #[tokio::test]
    async fn a_pod_of_another_workload_with_the_same_labels_is_not_an_own_pod() {
        // A canary Deployment's pod carries `app: api` too: the selector
        // lists it, its controller is another ReplicaSet.
        let mut c = cluster();
        let canary_hash = "7f9c6d5b8";
        let canary = format!("api-canary-{canary_hash}-x2k4p");
        c.own_pods.push(owned_pod_json(
            &canary,
            "aks-pool-2",
            "Running",
            json!([container_json(
                "api",
                (Some("100m"), Some("100m")),
                (Some("1Gi"), Some("1Gi"))
            )]),
            &format!("api-canary-{canary_hash}"),
            canary_hash,
        ));
        // A ReplicaSet named like this Deployment's, but not for the pod's hash.
        c.own_pods.push(owned_pod_json(
            "api-old-hash",
            "aks-pool-2",
            "Running",
            baseline_containers_json(),
            &format!("api-{TEMPLATE_HASH}"),
            "0000000000",
        ));
        // A bare pod with the labels and no owner.
        c.own_pods.push(pod_json(
            "default",
            "api-debug",
            "aks-pool-2",
            "Running",
            baseline_containers_json(),
        ));
        let mut busy = pod_metrics_json(&canary);
        busy["containers"][0]["usage"]["memory"] = json!("3Gi");
        c.pod_metrics.push(busy);
        c.quotas = vec![json!({
            "metadata": { "name": "team", "namespace": "default" },
            "spec": { "hard": { "requests.memory": "3Gi" } },
            "status": {
                "hard": { "requests.memory": "3Gi" },
                // The three own pods (3 x 320Mi), the canary (1Gi), the two others (2 x 320Mi).
                "used": { "requests.memory": "2624Mi" },
            },
        })];
        let (f, _) = read(c).await;
        let names: Vec<&str> = f.pods.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["api-1", "api-2", "api-3"]);
        // They count where they run, with the other workloads' pods.
        let pool2 = &f.nodes.known().expect("nodes")[1];
        assert_eq!(pool2.others_requests.memory_bytes, 9.0 * GI + 640.0 * MI);
        assert_eq!(pool2.others_requests.cpu_millis, 2000.0 + 100.0 + 700.0);
        // And in the quota they are not this workload's to free: 3Gi less
        // what the others hold (2624Mi - 960Mi) leaves 1408Mi for 3 replicas.
        let e = crate::limits::evaluate(
            &f,
            &crate::limits::fixtures::set_on(
                &f,
                "api",
                crate::limits::ResourceName::Memory,
                crate::limits::ResourceField::Request,
                Some("448Mi"),
            ),
        );
        let b5: Vec<_> = e
            .findings
            .iter()
            .filter(|x| x.code == crate::limits::FindingCode::B5)
            .collect();
        assert_eq!(b5.len(), 1, "{:#?}", e.findings);
        assert_eq!(b5[0].level, crate::limits::Level::Blocked);
        assert_eq!(
            b5[0].message,
            "Quota `team`: 3 replicas need 1.5Gi of requests.memory; 1.4Gi is free of 3Gi."
        );
        // The canary's 3Gi of usage does not count as this workload's.
        let e = crate::limits::evaluate(
            &f,
            &crate::limits::fixtures::set_on(
                &f,
                "api",
                crate::limits::ResourceName::Memory,
                crate::limits::ResourceField::Limit,
                Some("1Gi"),
            ),
        );
        assert!(
            e.findings
                .iter()
                .all(|x| x.code != crate::limits::FindingCode::W4),
            "{:#?}",
            e.findings
        );
    }

    #[tokio::test]
    async fn a_pod_without_a_limit_adds_nothing_to_the_limits_of_its_node() {
        let mut c = cluster();
        c.other_pods.push(pod_json(
            "data",
            "free-0",
            "aks-pool-2",
            "Running",
            json!([container_json(
                "free",
                (Some("100m"), None),
                (Some("1Gi"), None)
            )]),
        ));
        let (f, _) = read(c).await;
        let pool2 = &f.nodes.known().expect("nodes")[1];
        assert_eq!(pool2.others_requests.cpu_millis, 2100.0);
        assert_eq!(pool2.others_cpu_limits, 2000.0);
        assert_eq!(pool2.others_memory_limits, 8.0 * GI);
    }

    #[tokio::test]
    async fn a_cordoned_or_not_ready_node_is_not_schedulable() {
        let mut c = cluster();
        c.nodes[0]["spec"]["unschedulable"] = json!(true);
        c.nodes[1]["status"]["conditions"] = json!([{ "type": "Ready", "status": "False" }]);
        let mut silent = node_json("aks-pool-3", "4", "16Gi");
        silent["status"]["conditions"] = json!([]);
        c.nodes.push(silent);
        c.nodes.push(node_json("aks-pool-4", "4", "16Gi"));
        let (f, _) = read(c).await;
        let schedulable: Vec<(&str, bool)> = f
            .nodes
            .known()
            .expect("nodes")
            .iter()
            .map(|n| (n.name.as_str(), n.schedulable))
            .collect();
        assert_eq!(
            schedulable,
            [
                ("aks-pool-1", false),
                ("aks-pool-2", false),
                ("aks-pool-3", false),
                ("aks-pool-4", true)
            ]
        );
    }

    #[tokio::test]
    async fn an_unreadable_allocatable_reads_as_zero() {
        let mut c = cluster();
        c.nodes.push(node_json("odd", "lots", "plenty"));
        let (f, _) = read(c).await;
        let odd = &f.nodes.known().expect("nodes")[2];
        assert_eq!(odd.allocatable, Amounts::default());
        assert_eq!(odd.memory_used, None);
    }

    async fn rollout_of(strategy: Value, replicas: i64) -> RolloutFacts {
        let mut c = cluster();
        c.deployment["spec"]["strategy"] = strategy;
        c.deployment["spec"]["replicas"] = json!(replicas);
        read(c).await.0.workload.rollout
    }

    fn rolling(surge: i32, unavailable: i32) -> RolloutFacts {
        RolloutFacts {
            recreate: false,
            max_surge: surge,
            max_unavailable: unavailable,
        }
    }

    #[tokio::test]
    async fn rollout_counts_are_resolved() {
        let percent = |s: &str, u: &str| json!({ "type": "RollingUpdate", "rollingUpdate": { "maxSurge": s, "maxUnavailable": u } });
        // 25% of 3: surge rounds up, unavailable rounds down.
        assert_eq!(rollout_of(percent("25%", "25%"), 3).await, rolling(1, 0));
        // The defaults are 25% and 25%.
        assert_eq!(
            rollout_of(json!({ "type": "RollingUpdate" }), 3).await,
            rolling(1, 0)
        );
        assert_eq!(rollout_of(json!({}), 8).await, rolling(2, 2));
        assert_eq!(rollout_of(percent("50%", "50%"), 3).await, rolling(2, 1));
        // Both 0: unavailable is 1.
        assert_eq!(
            rollout_of(
                json!({ "type": "RollingUpdate", "rollingUpdate": { "maxSurge": 0, "maxUnavailable": 0 } }),
                3
            )
            .await,
            rolling(0, 1)
        );
        assert_eq!(rollout_of(percent("10%", "10%"), 3).await, rolling(1, 0));
        assert_eq!(rollout_of(percent("0%", "10%"), 3).await, rolling(0, 1));
        // A percentage too large to multiply saturates instead of overflowing.
        assert_eq!(
            rollout_of(percent("9223372036854775807%", "9223372036854775807%"), 3).await,
            rolling(i32::MAX, i32::MAX)
        );
        assert_eq!(
            rollout_of(json!({ "type": "Recreate" }), 3).await,
            RolloutFacts {
                recreate: true,
                max_surge: 0,
                max_unavailable: 0
            }
        );
    }

    fn hpa(name: &str, kind: &str, target: &str, metrics: Value) -> Value {
        json!({
            "metadata": { "name": name, "namespace": "default" },
            "spec": {
                "scaleTargetRef": { "apiVersion": "apps/v1", "kind": kind, "name": target },
                "maxReplicas": 10,
                "metrics": metrics,
            },
        })
    }

    fn resource_metric(kind: &str, resource: &str, target: &str) -> Value {
        let key = if kind == "Resource" {
            "resource"
        } else {
            "containerResource"
        };
        let mut source = json!({ "name": resource, "target": { "type": target } });
        if kind == "ContainerResource" {
            source["container"] = json!("api");
        }
        if target == "Utilization" {
            source["target"]["averageUtilization"] = json!(70);
        } else {
            source["target"]["averageValue"] = json!("500Mi");
        }
        json!({ "type": kind, key: source })
    }

    fn vpa(name: &str, kind: &str, target: &str, mode: Option<&str>) -> Value {
        let mut v = json!({
            "apiVersion": "autoscaling.k8s.io/v1",
            "kind": "VerticalPodAutoscaler",
            "metadata": { "name": name, "namespace": "default" },
            "spec": { "targetRef": { "apiVersion": "apps/v1", "kind": kind, "name": target } },
        });
        if let Some(mode) = mode {
            v["spec"]["updatePolicy"] = json!({ "updateMode": mode });
        }
        v
    }

    #[tokio::test]
    async fn hpa_and_vpa_of_other_workloads_are_left_out() {
        let mut c = cluster();
        c.hpas = vec![
            hpa(
                "api-cpu",
                "Deployment",
                "api",
                json!([resource_metric("Resource", "cpu", "Utilization")]),
            ),
            hpa(
                "web",
                "Deployment",
                "web",
                json!([resource_metric("Resource", "cpu", "Utilization")]),
            ),
            hpa(
                "api-sts",
                "StatefulSet",
                "api",
                json!([resource_metric("Resource", "cpu", "Utilization")]),
            ),
            hpa(
                "api-memory",
                "Deployment",
                "api",
                json!([
                    resource_metric("ContainerResource", "memory", "Utilization"),
                    resource_metric("Resource", "cpu", "AverageValue"),
                ]),
            ),
            hpa(
                "api-value",
                "Deployment",
                "api",
                json!([resource_metric("Resource", "memory", "AverageValue")]),
            ),
        ];
        c.vpas = vec![
            vpa("api-off", "Deployment", "api", Some("Off")),
            vpa("web", "Deployment", "web", Some("Auto")),
            vpa("api-sts", "StatefulSet", "api", Some("Auto")),
            vpa("api-default", "Deployment", "api", None),
            vpa("api-initial", "Deployment", "api", Some("Initial")),
        ];
        let (f, _) = read(c).await;
        let hpa = |name: &str, cpu: bool, memory: bool| HpaFacts {
            name: name.into(),
            cpu_utilization: cpu,
            memory_utilization: memory,
        };
        assert_eq!(
            f.hpas,
            Fact::Known {
                value: vec![
                    hpa("api-cpu", true, false),
                    hpa("api-memory", false, true),
                    hpa("api-value", false, false),
                ]
            }
        );
        let vpa = |name: &str, mode: &str| VpaFacts {
            name: name.into(),
            update_mode: mode.into(),
        };
        assert_eq!(
            f.vpas,
            Fact::Known {
                value: vec![
                    vpa("api-off", "Off"),
                    vpa("api-default", "Auto"),
                    vpa("api-initial", "Initial"),
                ]
            }
        );
    }

    #[tokio::test]
    async fn an_hpa_without_metrics_scales_on_cpu_utilisation() {
        // autoscaling/v2: "If not set, the default metric will be set to 80%
        // average CPU utilization."
        let mut c = cluster();
        let mut bare = hpa("api", "Deployment", "api", json!(null));
        bare["spec"]
            .as_object_mut()
            .expect("spec")
            .remove("metrics");
        c.hpas = vec![bare];
        let (f, _) = read(c).await;
        assert_eq!(
            f.hpas,
            Fact::Known {
                value: vec![HpaFacts {
                    name: "api".into(),
                    cpu_utilization: true,
                    memory_utilization: false,
                }]
            }
        );
    }

    #[tokio::test]
    async fn scoped_quota_is_flagged() {
        let mut c = cluster();
        c.quotas = vec![
            json!({
                "metadata": { "name": "team", "namespace": "default" },
                "spec": { "hard": { "requests.memory": "2Gi", "limits.cpu": "8", "pods": "20" } },
                "status": {
                    "hard": { "requests.memory": "2Gi", "limits.cpu": "8", "pods": "20" },
                    "used": { "requests.memory": "1Gi", "limits.cpu": "3500m", "pods": "4" },
                },
            }),
            json!({
                "metadata": { "name": "best-effort", "namespace": "default" },
                "spec": { "hard": { "cpu": "1" }, "scopes": ["BestEffort"] },
            }),
            json!({
                "metadata": { "name": "priority", "namespace": "default" },
                "spec": {
                    "hard": { "memory": "4Gi" },
                    "scopeSelector": { "matchExpressions": [
                        { "scopeName": "PriorityClass", "operator": "In", "values": ["high"] }
                    ] },
                },
            }),
        ];
        let (f, _) = read(c).await;
        let map = |entries: &[(&str, f64)]| {
            entries
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect::<std::collections::BTreeMap<_, _>>()
        };
        assert_eq!(
            f.quotas,
            Fact::Known {
                value: vec![
                    QuotaFacts {
                        name: "team".into(),
                        scoped: false,
                        hard: map(&[("limits.cpu", 8000.0), ("requests.memory", 2.0 * GI)]),
                        used: map(&[("limits.cpu", 3500.0), ("requests.memory", GI)]),
                    },
                    // No status yet: hard falls back to the spec.
                    QuotaFacts {
                        name: "best-effort".into(),
                        scoped: true,
                        hard: map(&[("cpu", 1000.0)]),
                        used: map(&[]),
                    },
                    QuotaFacts {
                        name: "priority".into(),
                        scoped: true,
                        hard: map(&[("memory", 4.0 * GI)]),
                        used: map(&[]),
                    },
                ]
            }
        );
    }

    #[tokio::test]
    async fn limit_ranges_are_read_per_item_and_resource() {
        let mut c = cluster();
        c.limit_ranges = vec![json!({
            "metadata": { "name": "limits", "namespace": "default" },
            "spec": { "limits": [
                {
                    "type": "Container",
                    "min": { "cpu": "50m" },
                    "max": { "memory": "1Gi" },
                    "default": { "cpu": "200m", "memory": "256Mi" },
                    "defaultRequest": { "cpu": "100m" },
                    "maxLimitRequestRatio": { "cpu": "4", "memory": "1500m" },
                },
                { "type": "Pod", "max": { "cpu": "2", "memory": "2Gi" } },
            ] },
        })];
        let (f, _) = read(c).await;
        let per = |cpu: Option<f64>, memory: Option<f64>| PerResource { cpu, memory };
        assert_eq!(
            f.limit_ranges,
            Fact::Known {
                value: vec![LimitRangeFacts {
                    name: "limits".into(),
                    items: vec![
                        LimitRangeItemFacts {
                            kind: "Container".into(),
                            min: per(Some(50.0), None),
                            max: per(None, Some(GI)),
                            default: per(Some(200.0), Some(256.0 * MI)),
                            default_request: per(Some(100.0), None),
                            max_ratio: per(Some(4.0), Some(1.5)),
                        },
                        LimitRangeItemFacts {
                            kind: "Pod".into(),
                            max: per(Some(2000.0), Some(2.0 * GI)),
                            ..Default::default()
                        },
                    ],
                }]
            }
        );
    }

    #[tokio::test]
    async fn native_sidecars_and_plain_init_containers_are_told_apart() {
        let mut c = cluster();
        let mut mesh = container_json("mesh", (Some("100m"), None), (Some("64Mi"), Some("64Mi")));
        mesh["restartPolicy"] = json!("Always");
        let migrate = container_json(
            "migrate",
            (Some("1"), Some("1")),
            (Some("128Mi"), Some("128Mi")),
        );
        let init = json!([mesh, migrate]);
        c.deployment["spec"]["template"]["spec"]["initContainers"] = init.clone();
        for p in &mut c.own_pods {
            p["spec"]["initContainers"] = init.clone();
        }
        let (f, _) = read(c).await;
        assert_eq!(
            f.workload.init_containers,
            vec![
                container(
                    "mesh",
                    true,
                    (Some("100m"), None),
                    (Some("64Mi"), Some("64Mi"))
                ),
                container(
                    "migrate",
                    false,
                    (Some("1"), Some("1")),
                    (Some("128Mi"), Some("128Mi"))
                ),
            ]
        );
        assert_eq!(f.workload.containers, facts().workload.containers);
        let names: Vec<&str> = f.seen.resources.keys().map(String::as_str).collect();
        assert_eq!(names, ["api", "envoy", "mesh", "migrate"]);
        // The scheduler's formula: max(350m + 100m, 1000m + 100m) and
        // max(320Mi + 64Mi, 128Mi + 64Mi); a sidecar's memory limit adds to
        // the regular ones', the CPU limit stays unset (envoy has none).
        let figures = &f.pods[0].figures;
        assert_eq!(figures.request.cpu_millis, 1100.0);
        assert_eq!(figures.request.memory_bytes, 384.0 * MI);
        assert_eq!(figures.cpu_limit, None);
        assert_eq!(figures.memory_limit, Some(704.0 * MI));
    }

    #[tokio::test]
    async fn the_pod_overhead_comes_from_a_running_pod() {
        let mut c = cluster();
        for p in &mut c.own_pods {
            p["spec"]["overhead"] = json!({ "cpu": "250m", "memory": "120Mi" });
        }
        let (f, _) = read(c).await;
        assert_eq!(
            f.workload.overhead,
            Amounts {
                cpu_millis: 250.0,
                memory_bytes: 120.0 * MI
            }
        );
        assert_eq!(f.pods[0].figures.request.cpu_millis, 600.0);
        assert_eq!(f.pods[0].figures.memory_limit, Some(760.0 * MI));
    }

    #[tokio::test]
    async fn the_manager_the_annotation_and_the_pending_pods_are_read() {
        let mut c = cluster();
        c.deployment["metadata"]["annotations"] = json!({
            "meta.helm.sh/release-name": "orders",
            OVERRIDE_ANNOTATION: "not a mark",
        });
        c.own_pods[2]["spec"]
            .as_object_mut()
            .expect("spec")
            .remove("nodeName");
        c.own_pods[2]["status"]["phase"] = json!("Pending");
        let (f, _) = read(c).await;
        assert_eq!(f.workload.manager.kind, ManagerKind::Helm);
        assert_eq!(f.workload.manager.release.as_deref(), Some("orders"));
        assert_eq!(
            f.workload.override_annotation.as_deref(),
            Some("not a mark")
        );
        assert_eq!(f.seen.override_annotation.as_deref(), Some("not a mark"));
        assert_eq!(f.pods.len(), 3);
        assert_eq!(f.pods[2].node, None);
    }

    #[tokio::test]
    async fn only_reads_are_sent() {
        let (_, seen) = read(cluster()).await;
        assert_eq!(seen.len(), 10, "one request per part");
        assert!(seen.iter().all(|s| s.method == Method::GET));
        for route in [
            DEPLOYMENT,
            OWN_PODS,
            ALL_PODS,
            NODES,
            NODE_METRICS,
            POD_METRICS,
            LIMIT_RANGES,
            QUOTAS,
            HPAS,
            VPAS,
        ] {
            assert!(
                seen.iter().any(|s| s.uri.starts_with(route)),
                "{route} not read"
            );
        }
    }
}
