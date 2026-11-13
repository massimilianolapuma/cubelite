//! What Kubernetes runs a container with, and a pod's figures as the
//! scheduler computes them.

use serde::{Deserialize, Serialize};

use super::types::{
    same_amount, Amounts, LimitRangeFacts, LimitRangeItemFacts, PerResource, PodFigures,
    ResourceName,
};

/// The request and the limit Kubernetes will use for one resource.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Effective {
    /// The effective request; `None` when nothing sets one.
    pub request: Option<f64>,
    /// The effective limit; `None` is no limit.
    pub limit: Option<f64>,
}

/// The effective values of one container.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EffectiveContainer {
    /// Container name.
    pub name: String,
    /// CPU, millicores.
    pub cpu: Effective,
    /// Memory, bytes.
    pub memory: Effective,
}

impl EffectiveContainer {
    /// The effective values of one resource.
    pub fn get(&self, resource: ResourceName) -> Effective {
        match resource {
            ResourceName::Cpu => self.cpu,
            ResourceName::Memory => self.memory,
        }
    }
}

/// What Kubernetes will run with: an unset request takes the limit, then the LimitRange
/// defaults (first LimitRange in name order that has one) fill what is still unset.
pub fn effective(
    name: &str,
    cpu: (Option<f64>, Option<f64>),
    memory: (Option<f64>, Option<f64>),
    limit_ranges: &[LimitRangeFacts],
) -> EffectiveContainer {
    let mut by_name: Vec<&LimitRangeFacts> = limit_ranges.iter().collect();
    by_name.sort_by(|a, b| a.name.cmp(&b.name));
    // The first default of the Container items, in name order.
    let first_default = |pick: fn(&LimitRangeItemFacts) -> &PerResource, resource| {
        by_name
            .iter()
            .flat_map(|lr| lr.items.iter())
            .filter(|item| item.kind == "Container")
            .find_map(|item| pick(item).get(resource))
    };
    let one = |(request, limit): (Option<f64>, Option<f64>), resource: ResourceName| {
        // The API server's own defaulting first: an unset request takes the
        // container's limit. Then the LimitRange admission fills the rest.
        let request = request.or(limit);
        Effective {
            request: request.or_else(|| first_default(|i| &i.default_request, resource)),
            limit: limit.or_else(|| first_default(|i| &i.default, resource)),
        }
    };
    EffectiveContainer {
        name: name.to_string(),
        cpu: one(cpu, ResourceName::Cpu),
        memory: one(memory, ResourceName::Memory),
    }
}

/// One figure of the pod, by the walk of the Kubernetes documentation
/// ("Sidecar containers", resource sharing within containers): the regular
/// containers and the sidecars add up; a plain init container runs with the
/// sidecars started before it; the pod takes the higher of the two. `value`
/// gives `None` for a container that does not set the figure: it counts 0
/// when `unset_is_zero`, and makes the result `None` otherwise.
fn walk(
    regular: &[EffectiveContainer],
    init: &[(EffectiveContainer, bool)],
    value: impl Fn(&EffectiveContainer) -> Option<f64>,
    unset_is_zero: bool,
) -> Option<f64> {
    let read = |c: &EffectiveContainer| match value(c) {
        Some(v) => Some(v),
        None if unset_is_zero => Some(0.0),
        None => None,
    };
    let mut running = 0.0;
    for c in regular {
        running += read(c)?;
    }
    let mut sidecars = 0.0;
    let mut init_peak: f64 = 0.0;
    for (c, sidecar) in init {
        let v = read(c)?;
        if *sidecar {
            sidecars += v;
            init_peak = init_peak.max(sidecars);
        } else {
            init_peak = init_peak.max(v + sidecars);
        }
    }
    Some((running + sidecars).max(init_peak))
}

/// The pod's figures as the scheduler computes them. `init` is in spec order, with its sidecar flag.
pub fn pod_figures(
    regular: &[EffectiveContainer],
    init: &[(EffectiveContainer, bool)],
    overhead: &Amounts,
) -> PodFigures {
    let request = |r: ResourceName| {
        walk(regular, init, |c| c.get(r).request, true).unwrap_or(0.0) + overhead.get(r)
    };
    let limit = |r: ResourceName| {
        walk(regular, init, |c| c.get(r).limit, false).map(|v| v + overhead.get(r))
    };
    PodFigures {
        request: Amounts {
            cpu_millis: request(ResourceName::Cpu),
            memory_bytes: request(ResourceName::Memory),
        },
        cpu_limit: limit(ResourceName::Cpu),
        memory_limit: limit(ResourceName::Memory),
    }
}

/// The pod's sums as the LimitRange admission computes them for a `Pod`
/// item: the same walk, but a container without the value adds nothing,
/// and the pod has no value only when no container sets one. No overhead.
pub(crate) fn admission_sum(
    regular: &[EffectiveContainer],
    init: &[(EffectiveContainer, bool)],
    value: impl Fn(&EffectiveContainer) -> Option<f64> + Copy,
) -> Option<f64> {
    let any = regular
        .iter()
        .chain(init.iter().map(|(c, _)| c))
        .any(|c| value(c).is_some());
    if !any {
        return None;
    }
    walk(regular, init, value, true)
}

/// "Guaranteed", "Burstable" or "BestEffort", over every container of the pod.
pub fn qos_class(containers: &[EffectiveContainer]) -> &'static str {
    let resources = [ResourceName::Cpu, ResourceName::Memory];
    let nothing_set = containers.iter().all(|c| {
        resources
            .iter()
            .all(|&r| c.get(r).request.is_none() && c.get(r).limit.is_none())
    });
    if nothing_set {
        return "BestEffort";
    }
    let guaranteed = containers.iter().all(|c| {
        resources
            .iter()
            .all(|&r| match (c.get(r).request, c.get(r).limit) {
                (Some(request), Some(limit)) => same_amount(request, limit),
                _ => false,
            })
    });
    if guaranteed {
        "Guaranteed"
    } else {
        "Burstable"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MI: f64 = 1024.0 * 1024.0;

    fn c(
        name: &str,
        cpu: (Option<f64>, Option<f64>),
        memory: (Option<f64>, Option<f64>),
    ) -> EffectiveContainer {
        effective(name, cpu, memory, &[])
    }

    /// A container with these requests and limits (millicores, Mi).
    fn set(name: &str, cpu: (f64, Option<f64>), memory: (f64, Option<f64>)) -> EffectiveContainer {
        c(
            name,
            (Some(cpu.0), cpu.1),
            (Some(memory.0 * MI), memory.1.map(|m| m * MI)),
        )
    }

    fn cpu_defaults(
        name: &str,
        default: Option<f64>,
        default_request: Option<f64>,
    ) -> LimitRangeFacts {
        LimitRangeFacts {
            name: name.into(),
            items: vec![LimitRangeItemFacts {
                kind: "Container".into(),
                default: PerResource {
                    cpu: default,
                    memory: None,
                },
                default_request: PerResource {
                    cpu: default_request,
                    memory: None,
                },
                ..Default::default()
            }],
        }
    }

    #[test]
    fn unset_request_takes_the_limit() {
        let e = c("api", (None, Some(500.0)), (None, Some(512.0 * MI)));
        assert_eq!(e.name, "api");
        assert_eq!(
            e.cpu,
            Effective {
                request: Some(500.0),
                limit: Some(500.0)
            }
        );
        assert_eq!(
            e.memory,
            Effective {
                request: Some(512.0 * MI),
                limit: Some(512.0 * MI)
            }
        );
        // Nothing set and no LimitRange: nothing.
        assert_eq!(c("x", (None, None), (None, None)).cpu, Effective::default());
    }

    #[test]
    fn limit_range_defaults_fill_what_is_still_unset() {
        let lr = [cpu_defaults("defaults", Some(200.0), Some(100.0))];
        let both = effective("api", (None, None), (None, None), &lr);
        assert_eq!(
            both.cpu,
            Effective {
                request: Some(100.0),
                limit: Some(200.0)
            }
        );
        // The LimitRange has nothing for memory.
        assert_eq!(both.memory, Effective::default());
        let limit_only = effective("api", (None, Some(500.0)), (None, None), &lr);
        assert_eq!(
            limit_only.cpu,
            Effective {
                request: Some(500.0),
                limit: Some(500.0)
            }
        );
        let request_only = effective("api", (Some(50.0), None), (None, None), &lr);
        assert_eq!(
            request_only.cpu,
            Effective {
                request: Some(50.0),
                limit: Some(200.0)
            }
        );
    }

    #[test]
    fn the_first_limit_range_by_name_that_has_a_default_wins() {
        // "b" is listed first but "a" comes first by name; "a" has no default
        // request, so that one comes from "b".
        let lr = [
            cpu_defaults("b", Some(300.0), Some(150.0)),
            cpu_defaults("a", Some(200.0), None),
        ];
        let e = effective("api", (None, None), (None, None), &lr);
        assert_eq!(
            e.cpu,
            Effective {
                request: Some(150.0),
                limit: Some(200.0)
            }
        );
        // A Pod item carries no defaults.
        let pod = LimitRangeFacts {
            name: "0".into(),
            items: vec![LimitRangeItemFacts {
                kind: "Pod".into(),
                default: PerResource {
                    cpu: Some(1.0),
                    memory: None,
                },
                ..Default::default()
            }],
        };
        assert_eq!(
            effective("api", (None, None), (None, None), &[pod]).cpu,
            Effective::default()
        );
    }

    #[test]
    fn regular_containers_add_up() {
        let api = set("api", (250.0, Some(500.0)), (256.0, Some(512.0)));
        let envoy = set("envoy", (100.0, Some(200.0)), (64.0, Some(128.0)));
        let p = pod_figures(&[api, envoy], &[], &Amounts::default());
        assert_eq!(
            p.request,
            Amounts {
                cpu_millis: 350.0,
                memory_bytes: 320.0 * MI
            }
        );
        assert_eq!(p.cpu_limit, Some(700.0));
        assert_eq!(p.memory_limit, Some(640.0 * MI));
    }

    #[test]
    fn a_container_without_a_limit_makes_the_pod_limit_none() {
        let api = set("api", (250.0, Some(500.0)), (256.0, Some(512.0)));
        let envoy = set("envoy", (100.0, None), (64.0, Some(128.0)));
        let p = pod_figures(&[api.clone(), envoy], &[], &Amounts::default());
        assert_eq!(p.cpu_limit, None);
        assert_eq!(p.memory_limit, Some(640.0 * MI));
        // The same from a plain init container without a limit.
        let init = set("migrate", (10.0, None), (16.0, Some(16.0)));
        let p = pod_figures(&[api], &[(init, false)], &Amounts::default());
        assert_eq!(p.cpu_limit, None);
        assert_eq!(p.memory_limit, Some(512.0 * MI));
    }

    #[test]
    fn an_unset_request_counts_zero() {
        let api = set("api", (250.0, Some(500.0)), (256.0, Some(512.0)));
        let bare = c("bare", (None, None), (None, None));
        let p = pod_figures(&[api, bare], &[], &Amounts::default());
        assert_eq!(
            p.request,
            Amounts {
                cpu_millis: 250.0,
                memory_bytes: 256.0 * MI
            }
        );
        assert_eq!(p.cpu_limit, None);
    }

    #[test]
    fn a_large_init_container_sets_the_request() {
        let api = set("api", (250.0, None), (256.0, None));
        let envoy = set("envoy", (100.0, None), (64.0, None));
        let migrate = set("migrate", (1000.0, None), (16.0, None));
        let p = pod_figures(&[api, envoy], &[(migrate, false)], &Amounts::default());
        assert_eq!(p.request.cpu_millis, 1000.0);
        // Memory: the regular containers are the larger.
        assert_eq!(p.request.memory_bytes, 320.0 * MI);
    }

    #[test]
    fn a_native_sidecar_adds_to_the_regular_containers_and_to_later_init_containers() {
        let regular = set("api", (200.0, Some(200.0)), (100.0, Some(100.0)));
        let sidecar = set("mesh", (100.0, Some(100.0)), (50.0, Some(50.0)));
        let plain = set("migrate", (300.0, Some(300.0)), (10.0, Some(10.0)));
        let p = pod_figures(
            &[regular.clone()],
            &[(sidecar.clone(), true), (plain.clone(), false)],
            &Amounts::default(),
        );
        // max(200 + 100, 300 + 100)
        assert_eq!(p.request.cpu_millis, 400.0);
        assert_eq!(p.cpu_limit, Some(400.0));
        // max(100 + 50, 10 + 50)
        assert_eq!(p.request.memory_bytes, 150.0 * MI);
        // A plain init container before the sidecar does not see it.
        let p = pod_figures(
            &[regular],
            &[(plain, false), (sidecar, true)],
            &Amounts::default(),
        );
        // max(200 + 100, 300)
        assert_eq!(p.request.cpu_millis, 300.0);
    }

    #[test]
    fn overhead_is_added_last() {
        let api = set("api", (250.0, Some(500.0)), (256.0, Some(512.0)));
        let migrate = set("migrate", (1000.0, Some(1000.0)), (16.0, Some(16.0)));
        let overhead = Amounts {
            cpu_millis: 250.0,
            memory_bytes: 120.0 * MI,
        };
        let p = pod_figures(&[api.clone()], &[(migrate, false)], &overhead);
        assert_eq!(
            p.request,
            Amounts {
                cpu_millis: 1250.0,
                memory_bytes: 376.0 * MI
            }
        );
        assert_eq!(p.cpu_limit, Some(1250.0));
        assert_eq!(p.memory_limit, Some(632.0 * MI));
        // No limit stays no limit.
        let open = set("open", (1.0, None), (1.0, None));
        assert_eq!(pod_figures(&[open], &[], &overhead).cpu_limit, None);
    }

    #[test]
    fn qos_classes() {
        let guaranteed = set("api", (500.0, Some(500.0)), (512.0, Some(512.0)));
        let from_limits = c("envoy", (None, Some(100.0)), (None, Some(64.0 * MI)));
        assert_eq!(
            qos_class(&[guaranteed.clone(), from_limits.clone()]),
            "Guaranteed"
        );
        let nothing = c("x", (None, None), (None, None));
        assert_eq!(qos_class(&[nothing.clone(), nothing.clone()]), "BestEffort");
        assert_eq!(qos_class(&[guaranteed.clone(), nothing]), "Burstable");
        let request_under_limit = set("api", (250.0, Some(500.0)), (512.0, Some(512.0)));
        assert_eq!(qos_class(&[request_under_limit]), "Burstable");
        let no_memory_limit = set("api", (500.0, Some(500.0)), (512.0, None));
        assert_eq!(qos_class(&[no_memory_limit]), "Burstable");
    }
    #[test]
    fn admission_sums_skip_a_container_without_the_value() {
        // The LimitRange admission sums what is set: envoy's missing CPU
        // limit adds nothing, where the scheduler's pod limit is none.
        let api = set("api", (250.0, Some(500.0)), (256.0, Some(512.0)));
        let envoy = set("envoy", (100.0, None), (64.0, Some(128.0)));
        let regular = [api, envoy];
        assert_eq!(admission_sum(&regular, &[], |c| c.cpu.limit), Some(500.0));
        assert_eq!(admission_sum(&regular, &[], |c| c.cpu.request), Some(350.0));
        // A sidecar and a plain init container walk as for the scheduler.
        let mesh = set("mesh", (50.0, Some(100.0)), (8.0, None));
        let migrate = set("migrate", (900.0, Some(900.0)), (8.0, None));
        let init = [(mesh, true), (migrate, false)];
        assert_eq!(
            admission_sum(&regular, &init, |c| c.cpu.limit),
            Some(1000.0)
        );
        // No container sets it: the pod has none.
        let bare = c("bare", (None, None), (None, None));
        assert_eq!(admission_sum(&[bare], &[], |c| c.cpu.limit), None);
    }
}
