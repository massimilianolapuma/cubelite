//! The baseline facts every table test of the check starts from.
//!
//! Deployment `default/api`, generation 7, 3 replicas, rolling update with
//! surge 1 and unavailable 0, no manager, no annotation; containers `api`
//! (CPU 250m / 500m, memory 256Mi / 512Mi) and `envoy` (CPU 100m / none,
//! memory 64Mi / 128Mi); pods `api-1` to `api-3` on `aks-pool-1`; nodes
//! `aks-pool-1` and `aks-pool-2`; usage known; no LimitRange, quota, HPA or
//! VPA.

use std::collections::BTreeMap;

use super::types::{
    Amounts, ContainerProposal, Fact, NodeFacts, OwnPodFacts, PodFigures, Proposal, ProposalKind,
    ResourceFacts, ResourceField, ResourceName, ResourceTexts, RolloutFacts, SeenState,
    WorkloadFacts,
};
use crate::metrics::ContainerUsageInfo;
use crate::resources::{
    ContainerResourcesInfo, QuantityInfo, ResourcePairInfo, TemplateContainerInfo,
};

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
