//! The baseline facts every table test of the check starts from.
//!
//! Deployment `default/api`, generation 7, 3 replicas, rolling update with
//! surge 1 and unavailable 0, no manager, no annotation; containers `api`
//! (CPU 250m / 500m, memory 256Mi / 512Mi) and `envoy` (CPU 100m / none,
//! memory 64Mi / 128Mi); pods `api-1` to `api-3` on `aks-pool-1`; nodes
//! `aks-pool-1` and `aks-pool-2`; usage known; no LimitRange, quota, HPA or
//! VPA.

use std::collections::BTreeMap;

use http::{Method, StatusCode};
use serde_json::{json, Value};

use super::types::{
    Amounts, ContainerProposal, Fact, NodeFacts, OwnPodFacts, PodFigures, Proposal, ProposalKind,
    ResourceFacts, ResourceField, ResourceName, ResourceTexts, RolloutFacts, SeenState,
    WorkloadFacts,
};
use crate::metrics::ContainerUsageInfo;
use crate::resources::{
    ContainerResourcesInfo, QuantityInfo, ResourcePairInfo, TemplateContainerInfo,
};
use crate::test_support::{mock_client, Seen};
use crate::KubeClient;

/// Bytes in a mebibyte.
pub(crate) const MI: f64 = 1024.0 * 1024.0;
/// Bytes in a gibibyte.
pub(crate) const GI: f64 = 1024.0 * MI;

/// The cluster's values of a container, as the core reads them.
pub(crate) fn resources(
    cpu: (Option<&str>, Option<&str>),
    memory: (Option<&str>, Option<&str>),
) -> ContainerResourcesInfo {
    let q = |text: Option<&str>, resource: ResourceName| {
        text.map(|t| QuantityInfo {
            text: t.to_string(),
            amount: resource.parse(t),
        })
    };
    ContainerResourcesInfo {
        cpu: ResourcePairInfo {
            request: q(cpu.0, ResourceName::Cpu),
            limit: q(cpu.1, ResourceName::Cpu),
        },
        memory: ResourcePairInfo {
            request: q(memory.0, ResourceName::Memory),
            limit: q(memory.1, ResourceName::Memory),
        },
    }
}

/// A container of the template.
pub(crate) fn container(
    name: &str,
    sidecar: bool,
    cpu: (Option<&str>, Option<&str>),
    memory: (Option<&str>, Option<&str>),
) -> TemplateContainerInfo {
    TemplateContainerInfo {
        name: name.to_string(),
        image: Some(format!("ghcr.io/x/{name}:1.0")),
        sidecar,
        resources: resources(cpu, memory),
    }
}

/// One pod of the baseline, on `node`.
pub(crate) fn pod(name: &str, node: &str) -> OwnPodFacts {
    OwnPodFacts {
        name: name.to_string(),
        node: Some(node.to_string()),
        figures: PodFigures {
            request: Amounts {
                cpu_millis: 350.0,
                memory_bytes: 320.0 * MI,
            },
            cpu_limit: None,
            memory_limit: Some(640.0 * MI),
        },
        usage: vec![
            ContainerUsageInfo {
                name: "api".into(),
                cpu_millis: 412.0,
                memory_bytes: 498 * 1024 * 1024,
            },
            ContainerUsageInfo {
                name: "envoy".into(),
                cpu_millis: 38.0,
                memory_bytes: 41 * 1024 * 1024,
            },
        ],
    }
}

/// A node with 4000m and 16Gi allocatable.
pub(crate) fn node(
    name: &str,
    others_requests: (f64, f64),
    others_cpu_limits: f64,
    others_memory_limits: f64,
    memory_used: f64,
) -> NodeFacts {
    NodeFacts {
        name: name.to_string(),
        schedulable: true,
        allocatable: Amounts {
            cpu_millis: 4000.0,
            memory_bytes: 16.0 * GI,
        },
        others_requests: Amounts {
            cpu_millis: others_requests.0,
            memory_bytes: others_requests.1,
        },
        others_cpu_limits,
        others_memory_limits,
        memory_used: Some(memory_used),
    }
}

/// The baseline facts.
pub(crate) fn facts() -> ResourceFacts {
    let containers = vec![
        container(
            "api",
            false,
            (Some("250m"), Some("500m")),
            (Some("256Mi"), Some("512Mi")),
        ),
        container(
            "envoy",
            false,
            (Some("100m"), None),
            (Some("64Mi"), Some("128Mi")),
        ),
    ];
    let seen = SeenState {
        generation: 7,
        resources: containers
            .iter()
            .map(|c| (c.name.clone(), c.resources.clone()))
            .collect::<BTreeMap<_, _>>(),
        override_annotation: None,
    };
    ResourceFacts {
        workload: WorkloadFacts {
            namespace: "default".into(),
            name: "api".into(),
            resource_version: Some("812".into()),
            generation: 7,
            replicas: 3,
            rollout: RolloutFacts {
                recreate: false,
                max_surge: 1,
                max_unavailable: 0,
            },
            containers,
            init_containers: Vec::new(),
            overhead: Amounts::default(),
            manager: Default::default(),
            override_annotation: None,
        },
        seen,
        pods: vec![
            pod("api-1", "aks-pool-1"),
            pod("api-2", "aks-pool-1"),
            pod("api-3", "aks-pool-1"),
        ],
        usage: Fact::Known { value: () },
        nodes: Fact::Known {
            value: vec![
                node(
                    "aks-pool-1",
                    (1000.0, 8.0 * GI),
                    2000.0,
                    11.0 * GI,
                    13.0 * GI,
                ),
                node("aks-pool-2", (2000.0, 8.0 * GI), 2000.0, 8.0 * GI, 8.0 * GI),
            ],
        },
        limit_ranges: Fact::Known { value: Vec::new() },
        quotas: Fact::Known { value: Vec::new() },
        hpas: Fact::Known { value: Vec::new() },
        vpas: Fact::Known { value: Vec::new() },
    }
}

/// The cluster's values of a container of `facts`, regular or init.
pub(crate) fn cluster_texts(facts: &ResourceFacts, name: &str) -> ResourceTexts {
    facts
        .workload
        .containers
        .iter()
        .chain(facts.workload.init_containers.iter())
        .find(|c| c.name == name)
        .map(|c| ResourceTexts::from(&c.resources))
        .unwrap_or_default()
}

/// An adjust proposal that lists `container` of the baseline with the
/// cluster's values and one field replaced (`None` clears it).
pub(crate) fn set(
    container: &str,
    resource: ResourceName,
    field: ResourceField,
    text: Option<&str>,
) -> Proposal {
    set_on(&facts(), container, resource, field, text)
}

/// [`set`] over other facts.
pub(crate) fn set_on(
    facts: &ResourceFacts,
    container: &str,
    resource: ResourceName,
    field: ResourceField,
    text: Option<&str>,
) -> Proposal {
    let mut resources = cluster_texts(facts, container);
    resources
        .pair_mut(resource)
        .set(field, text.map(str::to_string));
    Proposal {
        kind: ProposalKind::Adjust,
        containers: vec![ContainerProposal {
            name: container.to_string(),
            resources,
        }],
    }
}

// --- The baseline as a cluster: the mock API server's answers --------------

/// The Deployment `default/api`.
pub(crate) const DEPLOYMENT: &str = "/apis/apps/v1/namespaces/default/deployments/api";
/// Its pods, listed by its label selector.
pub(crate) const OWN_PODS: &str = "/api/v1/namespaces/default/pods";
/// Every pod of the cluster.
pub(crate) const ALL_PODS: &str = "/api/v1/pods";
/// The nodes.
pub(crate) const NODES: &str = "/api/v1/nodes";
/// metrics-server, nodes.
pub(crate) const NODE_METRICS: &str = "/apis/metrics.k8s.io/v1beta1/nodes";
/// metrics-server, the namespace's pods.
pub(crate) const POD_METRICS: &str = "/apis/metrics.k8s.io/v1beta1/namespaces/default/pods";
/// The namespace's LimitRanges.
pub(crate) const LIMIT_RANGES: &str = "/api/v1/namespaces/default/limitranges";
/// The namespace's ResourceQuotas.
pub(crate) const QUOTAS: &str = "/api/v1/namespaces/default/resourcequotas";
/// The namespace's HorizontalPodAutoscalers.
pub(crate) const HPAS: &str = "/apis/autoscaling/v2/namespaces/default/horizontalpodautoscalers";
/// The namespace's VerticalPodAutoscalers.
pub(crate) const VPAS: &str =
    "/apis/autoscaling.k8s.io/v1/namespaces/default/verticalpodautoscalers";

/// A list answer.
pub(crate) fn list_json(api_version: &str, kind: &str, items: &[Value]) -> Value {
    json!({
        "apiVersion": api_version,
        "kind": kind,
        "metadata": { "resourceVersion": "900" },
        "items": items,
    })
}

/// An API error answer, as the API server writes it.
pub(crate) fn status_json(code: u16, reason: &str, message: &str) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Status",
        "metadata": {},
        "status": "Failure",
        "message": message,
        "reason": reason,
        "code": code,
    })
}

/// A 403 answer.
pub(crate) fn forbidden_json(message: &str) -> Value {
    status_json(403, "Forbidden", message)
}

/// The `resources` of a container: `(request, limit)` per resource.
pub(crate) fn resources_json(
    cpu: (Option<&str>, Option<&str>),
    memory: (Option<&str>, Option<&str>),
) -> Value {
    let mut requests = serde_json::Map::new();
    let mut limits = serde_json::Map::new();
    for (key, (request, limit)) in [("cpu", cpu), ("memory", memory)] {
        if let Some(r) = request {
            requests.insert(key.into(), json!(r));
        }
        if let Some(l) = limit {
            limits.insert(key.into(), json!(l));
        }
    }
    json!({ "requests": requests, "limits": limits })
}

/// A container of the template or of a pod, with the baseline's image.
pub(crate) fn container_json(
    name: &str,
    cpu: (Option<&str>, Option<&str>),
    memory: (Option<&str>, Option<&str>),
) -> Value {
    json!({
        "name": name,
        "image": format!("ghcr.io/x/{name}:1.0"),
        "resources": resources_json(cpu, memory),
    })
}

/// The baseline's two containers: `api` and `envoy`.
pub(crate) fn baseline_containers_json() -> Value {
    json!([
        container_json(
            "api",
            (Some("250m"), Some("500m")),
            (Some("256Mi"), Some("512Mi"))
        ),
        container_json("envoy", (Some("100m"), None), (Some("64Mi"), Some("128Mi"))),
    ])
}

/// A pod of `namespace` on `node`, with `containers` and a phase.
pub(crate) fn pod_json(
    namespace: &str,
    name: &str,
    node: &str,
    phase: &str,
    containers: Value,
) -> Value {
    json!({
        "metadata": { "name": name, "namespace": namespace, "labels": { "app": "api" } },
        "spec": { "nodeName": node, "containers": containers },
        "status": { "phase": phase },
    })
}

/// The `pod-template-hash` of the baseline's ReplicaSet.
pub(crate) const TEMPLATE_HASH: &str = "5d8f7c9b4";

/// [`pod_json`] with the `pod-template-hash` label `hash` and a controller
/// owner reference to the ReplicaSet `replica_set`.
pub(crate) fn owned_pod_json(
    name: &str,
    node: &str,
    phase: &str,
    containers: Value,
    replica_set: &str,
    hash: &str,
) -> Value {
    let mut pod = pod_json("default", name, node, phase, containers);
    pod["metadata"]["labels"]["pod-template-hash"] = json!(hash);
    pod["metadata"]["ownerReferences"] = json!([{
        "apiVersion": "apps/v1",
        "kind": "ReplicaSet",
        "name": replica_set,
        "uid": format!("uid-{replica_set}"),
        "controller": true,
        "blockOwnerDeletion": true,
    }]);
    pod
}

/// A pod of the baseline Deployment: owned by its ReplicaSet `api-5d8f7c9b4`.
pub(crate) fn own_pod_json(name: &str, node: &str, phase: &str, containers: Value) -> Value {
    owned_pod_json(
        name,
        node,
        phase,
        containers,
        &format!("api-{TEMPLATE_HASH}"),
        TEMPLATE_HASH,
    )
}

/// A Ready node with `cpu` and `memory` allocatable.
pub(crate) fn node_json(name: &str, cpu: &str, memory: &str) -> Value {
    json!({
        "metadata": { "name": name },
        "spec": {},
        "status": {
            "allocatable": { "cpu": cpu, "memory": memory, "pods": "110" },
            "conditions": [ { "type": "Ready", "status": "True" } ],
        },
    })
}

/// The usage metrics-server reports for one pod of the baseline.
pub(crate) fn pod_metrics_json(name: &str) -> Value {
    json!({
        "metadata": { "name": name, "namespace": "default" },
        "containers": [
            { "name": "api", "usage": { "cpu": "412m", "memory": "498Mi" } },
            { "name": "envoy", "usage": { "cpu": "38m", "memory": "41Mi" } },
        ],
    })
}

/// The usage metrics-server reports for one node.
pub(crate) fn node_metrics_json(name: &str, cpu: &str, memory: &str) -> Value {
    json!({ "metadata": { "name": name }, "usage": { "cpu": cpu, "memory": memory } })
}

/// The baseline cluster as API objects, and the answers of the mock API
/// server built from them. Change an object to change every answer that
/// shows it; [`Cluster::with`] replaces one route's answer outright.
#[derive(Clone)]
pub(crate) struct Cluster {
    /// The Deployment, answered to a GET and to a PATCH.
    pub(crate) deployment: Value,
    /// The pods its selector matches.
    pub(crate) own_pods: Vec<Value>,
    /// The other pods of the cluster (the all-namespaces list holds both).
    pub(crate) other_pods: Vec<Value>,
    /// The nodes.
    pub(crate) nodes: Vec<Value>,
    /// metrics-server's node items.
    pub(crate) node_metrics: Vec<Value>,
    /// metrics-server's pod items.
    pub(crate) pod_metrics: Vec<Value>,
    /// LimitRange objects.
    pub(crate) limit_ranges: Vec<Value>,
    /// ResourceQuota objects.
    pub(crate) quotas: Vec<Value>,
    /// HorizontalPodAutoscaler objects.
    pub(crate) hpas: Vec<Value>,
    /// VerticalPodAutoscaler objects.
    pub(crate) vpas: Vec<Value>,
    /// Answers that replace a route's, the last added first.
    overrides: Vec<(Option<Method>, String, u16, Value)>,
}

/// The baseline cluster: the API objects [`facts`] is read from.
pub(crate) fn cluster() -> Cluster {
    let deployment = json!({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": "api",
            "namespace": "default",
            "resourceVersion": "812",
            "generation": 7,
            "labels": { "app": "api" },
        },
        "spec": {
            "replicas": 3,
            "selector": { "matchLabels": { "app": "api" } },
            "strategy": {
                "type": "RollingUpdate",
                "rollingUpdate": { "maxSurge": 1, "maxUnavailable": 0 },
            },
            "template": {
                "metadata": { "labels": { "app": "api" } },
                "spec": { "containers": baseline_containers_json() },
            },
        },
        "status": { "replicas": 3, "readyReplicas": 3 },
    });
    let own = |name: &str| own_pod_json(name, "aks-pool-1", "Running", baseline_containers_json());
    let other = |ns: &str, name: &str, node: &str, requests: (&str, &str), limits: (&str, &str)| {
        pod_json(
            ns,
            name,
            node,
            "Running",
            json!([container_json(
                name,
                (Some(requests.0), Some(limits.0)),
                (Some(requests.1), Some(limits.1)),
            )]),
        )
    };
    Cluster {
        deployment,
        own_pods: vec![own("api-1"), own("api-2"), own("api-3")],
        other_pods: vec![
            other("data", "db-0", "aks-pool-1", ("1", "8Gi"), ("2", "11Gi")),
            other("data", "cache-0", "aks-pool-2", ("2", "8Gi"), ("2", "8Gi")),
        ],
        nodes: vec![
            node_json("aks-pool-1", "4", "16Gi"),
            node_json("aks-pool-2", "4", "16Gi"),
        ],
        node_metrics: vec![
            node_metrics_json("aks-pool-1", "1300m", "13Gi"),
            node_metrics_json("aks-pool-2", "900m", "8Gi"),
        ],
        pod_metrics: vec![
            pod_metrics_json("api-1"),
            pod_metrics_json("api-2"),
            pod_metrics_json("api-3"),
        ],
        limit_ranges: Vec::new(),
        quotas: Vec::new(),
        hpas: Vec::new(),
        vpas: Vec::new(),
        overrides: Vec::new(),
    }
}

impl Cluster {
    /// Every request whose path starts with `prefix` is answered with
    /// `status` and `body`, whatever its method.
    pub(crate) fn with(mut self, prefix: &str, status: u16, body: Value) -> Self {
        self.overrides
            .push((None, prefix.to_string(), status, body));
        self
    }

    /// Requests of one method whose path starts with `prefix` are answered
    /// with `status` and `body`.
    pub(crate) fn on(mut self, method: Method, prefix: &str, status: u16, body: Value) -> Self {
        self.overrides
            .push((Some(method), prefix.to_string(), status, body));
        self
    }

    /// The answer to one request.
    pub(crate) fn respond(&self, method: &Method, uri: &str) -> (StatusCode, Value) {
        let replaced = self.overrides.iter().rev().find(|(m, prefix, _, _)| {
            m.as_ref().is_none_or(|m| m == method) && uri.starts_with(prefix.as_str())
        });
        if let Some((_, _, status, body)) = replaced {
            return (
                StatusCode::from_u16(*status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                body.clone(),
            );
        }
        let ok = |body: Value| (StatusCode::OK, body);
        let all_pods: Vec<Value> = self
            .own_pods
            .iter()
            .chain(self.other_pods.iter())
            .cloned()
            .collect();
        let routes: [(&str, &dyn Fn() -> Value); 10] = [
            (DEPLOYMENT, &|| self.deployment.clone()),
            (OWN_PODS, &|| list_json("v1", "PodList", &self.own_pods)),
            (ALL_PODS, &|| list_json("v1", "PodList", &all_pods)),
            (NODES, &|| list_json("v1", "NodeList", &self.nodes)),
            (NODE_METRICS, &|| {
                list_json(
                    "metrics.k8s.io/v1beta1",
                    "NodeMetricsList",
                    &self.node_metrics,
                )
            }),
            (POD_METRICS, &|| {
                list_json(
                    "metrics.k8s.io/v1beta1",
                    "PodMetricsList",
                    &self.pod_metrics,
                )
            }),
            (LIMIT_RANGES, &|| {
                list_json("v1", "LimitRangeList", &self.limit_ranges)
            }),
            (QUOTAS, &|| {
                list_json("v1", "ResourceQuotaList", &self.quotas)
            }),
            (HPAS, &|| {
                list_json("autoscaling/v2", "HorizontalPodAutoscalerList", &self.hpas)
            }),
            (VPAS, &|| {
                list_json(
                    "autoscaling.k8s.io/v1",
                    "VerticalPodAutoscalerList",
                    &self.vpas,
                )
            }),
        ];
        match routes.iter().find(|(prefix, _)| uri.starts_with(prefix)) {
            Some((_, body)) => ok(body()),
            None => (
                StatusCode::NOT_FOUND,
                status_json(
                    404,
                    "NotFound",
                    "the server could not find the requested resource",
                ),
            ),
        }
    }

    /// A client against this cluster, and the handle that gives the
    /// requests it saw.
    pub(crate) fn client(self) -> (KubeClient, tokio::task::JoinHandle<Vec<Seen>>) {
        mock_client(move |method, uri| self.respond(method, uri))
    }
}

/// `proposal` with one more field of a container it lists replaced.
pub(crate) fn and(
    mut proposal: Proposal,
    container: &str,
    resource: ResourceName,
    field: ResourceField,
    text: Option<&str>,
) -> Proposal {
    if let Some(c) = proposal.containers.iter_mut().find(|c| c.name == container) {
        c.resources
            .pair_mut(resource)
            .set(field, text.map(str::to_string));
    }
    proposal
}
