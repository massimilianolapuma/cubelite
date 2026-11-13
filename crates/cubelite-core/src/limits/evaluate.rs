//! The check of a change of requests and limits (spec §4): pure, the same
//! for the editor and inside the apply.

use std::collections::BTreeMap;

use super::mark::active_override;
use super::pod_math::{admission_sum, effective, pod_figures, qos_class, EffectiveContainer};
use super::types::{
    fmt_amount, percent, same_amount, same_value, Amounts, BeforeAfter, Change, Evaluation, Fact,
    Finding, FindingCode, Level, LimitRangeFacts, NodeFacts, NodeProjection, OwnPodFacts,
    PodFigures, Proposal, ProposalKind, ResourceFacts, ResourceField, ResourceName, ResourceTexts,
    FIELDS,
};
use crate::resources::TemplateContainerInfo;

const RESOURCES: [ResourceName; 2] = [ResourceName::Cpu, ResourceName::Memory];

/// A finding with nothing attached yet.
fn finding(code: FindingCode, level: Level, message: String) -> Finding {
    Finding {
        code,
        level,
        message,
        container: None,
        resource: None,
        field: None,
        node: None,
    }
}

/// A finding about one field of one container.
fn on_field(
    code: FindingCode,
    level: Level,
    message: String,
    container: &str,
    resource: ResourceName,
    field: ResourceField,
) -> Finding {
    Finding {
        container: Some(container.to_string()),
        resource: Some(resource),
        field: Some(field),
        ..finding(code, level, message)
    }
}

/// A ratio as a short number: `4`, `2.5`, `1.33`.
fn fmt_ratio(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;
    let text = format!("{rounded:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// `a` is above `b`, beyond a rounding difference.
fn above(a: f64, b: f64) -> bool {
    a > b && !same_amount(a, b)
}

/// The template's containers with their effective values, the init
/// containers with their sidecar flag.
struct Template {
    regular: Vec<EffectiveContainer>,
    init: Vec<(EffectiveContainer, bool)>,
}

impl Template {
    /// The template with the values `texts` gives each container.
    fn new(
        facts: &ResourceFacts,
        texts: impl Fn(&TemplateContainerInfo) -> ResourceTexts,
        limit_ranges: &[LimitRangeFacts],
    ) -> Template {
        let one = |c: &TemplateContainerInfo| {
            let t = texts(c);
            let pair = |r: ResourceName| {
                let read = |f| t.get(r, f).and_then(|text| r.parse(text));
                (read(ResourceField::Request), read(ResourceField::Limit))
            };
            effective(
                &c.name,
                pair(ResourceName::Cpu),
                pair(ResourceName::Memory),
                limit_ranges,
            )
        };
        Template {
            regular: facts.workload.containers.iter().map(one).collect(),
            init: facts
                .workload
                .init_containers
                .iter()
                .map(|c| (one(c), c.sidecar))
                .collect(),
        }
    }

    /// The pod's figures, with the workload's overhead.
    fn figures(&self, facts: &ResourceFacts) -> PodFigures {
        pod_figures(&self.regular, &self.init, &facts.workload.overhead)
    }

    /// Every container, regular then init.
    fn all(&self) -> impl Iterator<Item = &EffectiveContainer> {
        self.regular.iter().chain(self.init.iter().map(|(c, _)| c))
    }
}

/// The containers that can be changed: the regular ones, then the native sidecars.
fn editable(facts: &ResourceFacts) -> Vec<TemplateContainerInfo> {
    facts
        .workload
        .containers
        .iter()
        .chain(facts.workload.init_containers.iter().filter(|c| c.sidecar))
        .cloned()
        .collect()
}

/// The findings, the changes and the node projection of `proposal` over `facts`.
pub fn evaluate(facts: &ResourceFacts, proposal: &Proposal) -> Evaluation {
    let mut out = Evaluation::default();
    let editable = editable(facts);

    // Resolve what is wanted, by container name.
    let wanted: BTreeMap<String, ResourceTexts> = match proposal.kind {
        ProposalKind::Restore => {
            match active_override(facts.workload.override_annotation.as_deref(), &editable) {
                Some(mark) => mark
                    .containers
                    .into_iter()
                    .map(|c| (c.name, c.original))
                    .collect(),
                None => {
                    out.findings.push(finding(
                        FindingCode::NoOverride,
                        Level::Blocked,
                        "There is no active override to restore.".to_string(),
                    ));
                    return out;
                }
            }
        }
        ProposalKind::Adjust => {
            let mut wanted = BTreeMap::new();
            for c in &proposal.containers {
                if editable.iter().any(|e| e.name == c.name) {
                    wanted
                        .entry(c.name.clone())
                        .or_insert_with(|| c.resources.clone());
                } else if !out
                    .findings
                    .iter()
                    .any(|f| f.container.as_deref() == Some(c.name.as_str()))
                {
                    out.findings.push(Finding {
                        container: Some(c.name.clone()),
                        ..finding(
                            FindingCode::UnknownContainer,
                            Level::Blocked,
                            format!("Container `{}` is not in this deployment.", c.name),
                        )
                    });
                }
            }
            wanted
        }
    };

    // The changes, in template order, and what each one is on its own.
    let mut unreadable = false;
    let mut zero_limits: Vec<(String, ResourceName)> = Vec::new();
    for c in &editable {
        let Some(want) = wanted.get(&c.name) else {
            continue;
        };
        let cluster = ResourceTexts::from(&c.resources);
        for (resource, field) in FIELDS {
            let before = cluster.get(resource, field);
            let after = want.get(resource, field);
            if same_value(resource, before, after) {
                continue;
            }
            out.changes.push(Change {
                container: c.name.clone(),
                sidecar: c.sidecar,
                resource,
                field,
                before: before.map(str::to_string),
                after: after.map(str::to_string),
            });
            let Some(text) = after else {
                if proposal.kind == ProposalKind::Adjust {
                    out.findings.push(on_field(
                        FindingCode::Cleared,
                        Level::Blocked,
                        "A request or a limit cannot be removed here.".to_string(),
                        &c.name,
                        resource,
                        field,
                    ));
                }
                continue;
            };
            let Some(amount) = resource.parse(text) else {
                unreadable = true;
                out.findings.push(on_field(
                    FindingCode::B1,
                    Level::Blocked,
                    format!("`{text}` is not a valid quantity."),
                    &c.name,
                    resource,
                    field,
                ));
                continue;
            };
            if resource == ResourceName::Memory {
                if let Some(number) = text.trim().strip_suffix('m') {
                    out.findings.push(on_field(
                        FindingCode::MilliMemory,
                        Level::Warning,
                        format!(
                            "`{text}` is {} bytes: the suffix m means thousandths. Did you mean `{number}Mi`?",
                            milli_bytes(number)
                        ),
                        &c.name,
                        resource,
                        field,
                    ));
                }
            }
            if field == ResourceField::Limit && amount == 0.0 {
                zero_limits.push((c.name.clone(), resource));
                out.findings.push(on_field(
                    FindingCode::B2,
                    Level::Blocked,
                    "A limit of zero: the container could not run.".to_string(),
                    &c.name,
                    resource,
                    field,
                ));
            }
        }
    }

    // An unreadable value leaves nothing to compute with.
    if !unreadable {
        let limit_ranges = facts.limit_ranges.known().map(Vec::as_slice).unwrap_or(&[]);
        let after = Template::new(
            facts,
            |c| {
                wanted
                    .get(&c.name)
                    .cloned()
                    .unwrap_or_else(|| ResourceTexts::from(&c.resources))
            },
            limit_ranges,
        );
        let before = Template::new(facts, |c| ResourceTexts::from(&c.resources), limit_ranges);
        let new = after.figures(facts);
        check_limit_under_request(&mut out, &after, &zero_limits);
        if let Some(limit_ranges) = facts.limit_ranges.known() {
            check_limit_ranges(&mut out, &after, limit_ranges);
        }
        check_quotas(&mut out, facts, &new);
        if let Some(nodes) = facts.nodes.known() {
            check_nodes(&mut out, facts, nodes, &after, &new);
            out.nodes = project_nodes(facts, nodes, &new);
        }
        // A container without a memory limit can take what its node has:
        // W2 and W3 count it 0, so say what they could not weigh.
        if !facts.pods.is_empty() {
            for c in after.all().filter(|c| c.memory.limit.is_none()) {
                out.findings.push(on_field(
                    FindingCode::W9,
                    Level::NotChecked,
                    format!(
                        "Not checked: how much memory `{}` can take on the nodes (it has no memory limit).",
                        c.name
                    ),
                    &c.name,
                    ResourceName::Memory,
                    ResourceField::Limit,
                ));
            }
        }
        check_usage(&mut out, facts);
        check_autoscalers_on_requests(&mut out, facts, &before.figures(facts), &new);
        let qos = |t: &Template| qos_class(&t.all().cloned().collect::<Vec<_>>());
        let (qos_before, qos_after) = (qos(&before), qos(&after));
        if qos_before != qos_after {
            out.findings.push(finding(
                FindingCode::NoteQos,
                Level::Note,
                format!("The pod's QoS class changes from {qos_before} to {qos_after}."),
            ));
        }
    }
    check_vpas(&mut out, facts);
    not_checked(&mut out, facts);
    if facts.pods.is_empty() {
        out.findings.push(finding(
            FindingCode::NoteNoPods,
            Level::Note,
            "No pod is running: the checks on current usage do not apply.".to_string(),
        ));
    }

    sort_findings(&mut out.findings);
    out
}

/// A node that can be counted: both its allocatable amounts are above 0
/// (a node that reports none, or one the parser could not read, is left out).
fn usable(node: &NodeFacts) -> bool {
    node.allocatable.cpu_millis > 0.0 && node.allocatable.memory_bytes > 0.0
}

/// The workload's pods on `node`.
fn own_pods_on<'a>(facts: &'a ResourceFacts, node: &str) -> Vec<&'a OwnPodFacts> {
    facts
        .pods
        .iter()
        .filter(|p| p.node.as_deref() == Some(node))
        .collect()
}

/// The sum of one figure over pods.
fn sum_of(pods: &[&OwnPodFacts], figure: impl Fn(&PodFigures) -> f64) -> f64 {
    pods.iter().map(|p| figure(&p.figures)).sum()
}

/// What the workload's pods on a node use of memory now, by their samples.
fn memory_in_use(pods: &[&OwnPodFacts]) -> f64 {
    pods.iter()
        .flat_map(|p| p.usage.iter())
        .map(|u| u.memory_bytes as f64)
        .sum()
}

/// How many pods of `need` fit in `room`, at most `cap`. A request of 0
/// never limits.
fn how_many_fit(room: Amounts, need: &Amounts, cap: i64) -> i64 {
    let mut count = cap;
    for resource in RESOURCES {
        let need = need.get(resource);
        if need > 0.0 {
            let fit = (room.get(resource).max(0.0) / need + 1e-9).floor();
            // `fit` is finite and at least 0; past `cap` it does not matter.
            let fit = if fit >= cap as f64 { cap } else { fit as i64 };
            count = count.min(fit);
        }
    }
    count
}

/// `room` holds one pod of `need`.
fn holds(room: Amounts, need: &Amounts) -> bool {
    RESOURCES.iter().all(|&r| {
        let need = need.get(r);
        need <= 0.0 || need <= room.get(r) || same_amount(need, room.get(r))
    })
}

fn minus(a: Amounts, b: Amounts) -> Amounts {
    Amounts {
        cpu_millis: a.cpu_millis - b.cpu_millis,
        memory_bytes: a.memory_bytes - b.memory_bytes,
    }
}

fn plus(a: Amounts, b: Amounts) -> Amounts {
    Amounts {
        cpu_millis: a.cpu_millis + b.cpu_millis,
        memory_bytes: a.memory_bytes + b.memory_bytes,
    }
}

/// W0, W1, W1r, W2, W3 and the CPU note: the nodes against the new pod.
fn check_nodes(
    out: &mut Evaluation,
    facts: &ResourceFacts,
    nodes: &[NodeFacts],
    after: &Template,
    new: &PodFigures,
) {
    let mut counted: Vec<&NodeFacts> = nodes.iter().filter(|n| usable(n)).collect();
    counted.sort_by(|a, b| a.name.cmp(&b.name));

    // W0: above every node, cordoned ones included.
    let mut pending = false;
    if !counted.is_empty() {
        for resource in RESOURCES {
            let largest = counted
                .iter()
                .map(|n| n.allocatable.get(resource))
                .fold(0.0, f64::max);
            let fmt = |v: f64| fmt_amount(resource, v);
            let request = new.request.get(resource);
            if above(request, largest) {
                pending = true;
                out.findings.push(Finding {
                    resource: Some(resource),
                    field: Some(ResourceField::Request),
                    ..finding(
                        FindingCode::W0,
                        Level::Warning,
                        format!(
                            "No node in this cluster can hold {} (largest: {}). The pods stay Pending unless a larger node is added.",
                            fmt(request),
                            fmt(largest)
                        ),
                    )
                });
                continue;
            }
            // A limit the change leaves as it is was there before: not this change's.
            let touched = |c: &EffectiveContainer| {
                out.changes.iter().any(|ch| {
                    ch.container == c.name
                        && ch.resource == resource
                        && ch.field == ResourceField::Limit
                })
            };
            let over: Vec<(String, f64)> = after
                .all()
                .filter(|c| touched(c))
                .filter_map(|c| {
                    let limit = c.get(resource).limit.filter(|&l| above(l, largest))?;
                    Some((c.name.clone(), limit))
                })
                .collect();
            for (name, limit) in over {
                out.findings.push(on_field(
                    FindingCode::W0,
                    Level::Warning,
                    format!(
                        "No node in this cluster has {} (largest: {}): the container can never use this limit.",
                        fmt(limit),
                        fmt(largest)
                    ),
                    &name,
                    resource,
                    ResourceField::Limit,
                ));
            }
        }
    }

    // W1, its note, and W1r: room by requests on the schedulable nodes.
    let replicas = i64::from(facts.workload.replicas);
    let schedulable: Vec<&&NodeFacts> = counted.iter().filter(|n| n.schedulable).collect();
    if !pending && replicas > 0 {
        let fit = schedulable
            .iter()
            .map(|n| {
                how_many_fit(
                    minus(n.allocatable, n.others_requests),
                    &new.request,
                    replicas,
                )
            })
            .fold(0i64, |sum, n| sum.saturating_add(n))
            .min(replicas);
        if fit < replicas {
            out.findings.push(finding(
                FindingCode::W1,
                Level::Warning,
                format!(
                    "Only {fit} of {replicas} replicas have room by their requests; the rest stay Pending unless nodes are added."
                ),
            ));
        } else {
            out.findings.push(finding(
                FindingCode::NoteFits,
                Level::Note,
                format!("Fits: {replicas} of {replicas} replicas have room by their requests."),
            ));
            let rollout = &facts.workload.rollout;
            if !rollout.recreate {
                let may_stop = usize::try_from(rollout.max_unavailable.max(0)).unwrap_or(0);
                let room_somewhere = schedulable.iter().any(|n| {
                    let own = own_pods_on(facts, &n.name);
                    let held = own
                        .iter()
                        .fold(Amounts::default(), |sum, p| plus(sum, p.figures.request));
                    let freed = own
                        .iter()
                        .take(may_stop)
                        .fold(Amounts::default(), |sum, p| plus(sum, p.figures.request));
                    let room = plus(minus(minus(n.allocatable, n.others_requests), held), freed);
                    holds(room, &new.request)
                });
                if !room_somewhere {
                    out.findings.push(finding(
                        FindingCode::W1r,
                        Level::Warning,
                        "The rollout may stall: no node has room for a new pod while the old ones still run.".to_string(),
                    ));
                }
            }
        }
    }

    // W2, W3 and the CPU note: the nodes the workload's pods are on now.
    // Limits add up as on the node: a container without one counts 0.
    let usage_known = facts.usage.known().is_some();
    for n in &counted {
        let own = own_pods_on(facts, &n.name);
        if own.is_empty() {
            continue;
        }
        let alloc = n.allocatable;
        let own_before = |r: ResourceName| sum_of(&own, |f| f.set_limits.get(r));
        let own_after = |r: ResourceName| own.len() as f64 * new.set_limits.get(r);
        {
            let before = n.others_memory_limits + own_before(ResourceName::Memory);
            let after = n.others_memory_limits + own_after(ResourceName::Memory);
            if above(after, alloc.memory_bytes) && above(after, before) {
                out.findings.push(on_node(
                    FindingCode::W2,
                    Level::Warning,
                    format!(
                        "Memory limits on {} add up to {}% of what the node has (was {}%). Under memory pressure the node evicts pods.",
                        n.name,
                        percent(after, alloc.memory_bytes),
                        percent(before, alloc.memory_bytes)
                    ),
                    &n.name,
                    ResourceName::Memory,
                ));
            }
            // W3 only when the change raises these pods' memory limits: a
            // node that is short already is not this change's doing.
            let raised = above(
                own_after(ResourceName::Memory),
                own_before(ResourceName::Memory),
            );
            match (usage_known && raised, n.memory_used) {
                (false, _) => {}
                (true, Some(used)) => {
                    let full = used - memory_in_use(&own) + own_after(ResourceName::Memory);
                    if above(full, alloc.memory_bytes) && above(full, used) {
                        out.findings.push(on_node(
                            FindingCode::W3,
                            Level::Warning,
                            format!(
                                "If these pods use their full limit, {} runs out of memory ({}% → {}%).",
                                n.name,
                                percent(used, alloc.memory_bytes),
                                percent(full, alloc.memory_bytes)
                            ),
                            &n.name,
                            ResourceName::Memory,
                        ));
                    }
                }
                (true, None) => out.findings.push(on_node(
                    FindingCode::W9,
                    Level::NotChecked,
                    format!(
                        "Not checked: memory in use on {} (no sample from metrics-server).",
                        n.name
                    ),
                    &n.name,
                    ResourceName::Memory,
                )),
            }
        }
        {
            let before = n.others_cpu_limits + own_before(ResourceName::Cpu);
            let after = n.others_cpu_limits + own_after(ResourceName::Cpu);
            if above(after, alloc.cpu_millis) && above(after, before) {
                out.findings.push(on_node(
                    FindingCode::NoteCpuLimits,
                    Level::Note,
                    format!(
                        "CPU limits on {} add up to {}% of its CPU (was {}%). CPU is shared: the pods slow down, they are not killed.",
                        n.name,
                        percent(after, alloc.cpu_millis),
                        percent(before, alloc.cpu_millis)
                    ),
                    &n.name,
                    ResourceName::Cpu,
                ));
            }
        }
    }
}

/// A finding about a node.
fn on_node(
    code: FindingCode,
    level: Level,
    message: String,
    node: &str,
    resource: ResourceName,
) -> Finding {
    Finding {
        node: Some(node.to_string()),
        resource: Some(resource),
        ..finding(code, level, message)
    }
}

/// One row per counted node: the nodes with the workload's pods first, by
/// name, then the others, by name.
fn project_nodes(
    facts: &ResourceFacts,
    nodes: &[NodeFacts],
    new: &PodFigures,
) -> Vec<NodeProjection> {
    let usage_known = facts.usage.known().is_some();
    let mut rows: Vec<(bool, NodeProjection)> = nodes
        .iter()
        .filter(|n| usable(n))
        .map(|n| {
            let own = own_pods_on(facts, &n.name);
            let count = own.len() as f64;
            let alloc = n.allocatable;
            let pair = |before: f64, after: f64, total: f64| BeforeAfter {
                before: percent(before, total),
                after: percent(after, total),
            };
            let requests = |r: ResourceName| {
                pair(
                    n.others_requests.get(r) + sum_of(&own, |f| f.request.get(r)),
                    n.others_requests.get(r) + count * new.request.get(r),
                    alloc.get(r),
                )
            };
            // Limits as the node adds them up: a container without one counts 0.
            let limits = |r: ResourceName, others: f64| {
                pair(
                    others + sum_of(&own, |f| f.set_limits.get(r)),
                    others + count * new.set_limits.get(r),
                    alloc.get(r),
                )
            };
            let memory_if_full = match (own.is_empty(), usage_known, n.memory_used) {
                (false, true, Some(used)) => Some(pair(
                    used,
                    used - memory_in_use(&own) + count * new.set_limits.memory_bytes,
                    alloc.memory_bytes,
                )),
                _ => None,
            };
            let row = NodeProjection {
                name: n.name.clone(),
                schedulable: n.schedulable,
                own_pods: i32::try_from(own.len()).unwrap_or(i32::MAX),
                cpu_requests: requests(ResourceName::Cpu),
                memory_requests: requests(ResourceName::Memory),
                cpu_limits: limits(ResourceName::Cpu, n.others_cpu_limits),
                memory_limits: limits(ResourceName::Memory, n.others_memory_limits),
                memory_if_full,
            };
            (own.is_empty(), row)
        })
        .collect();
    rows.sort_by(|a, b| (a.0, &a.1.name).cmp(&(b.0, &b.1.name)));
    rows.into_iter().map(|(_, row)| row).collect()
}

/// W4, W5 and the containers without a sample: a changed limit against
/// what the container uses now, on the pod where it uses the most.
fn check_usage(out: &mut Evaluation, facts: &ResourceFacts) {
    if facts.usage.known().is_none() || facts.pods.is_empty() {
        return;
    }
    let mut unsampled: Vec<String> = Vec::new();
    let mut found = Vec::new();
    for change in out
        .changes
        .iter()
        .filter(|c| c.field == ResourceField::Limit)
    {
        let Some(limit) = change
            .after
            .as_deref()
            .and_then(|t| change.resource.parse(t))
        else {
            continue;
        };
        let highest = facts
            .pods
            .iter()
            .flat_map(|p| p.usage.iter())
            .filter(|u| u.name == change.container)
            .map(|u| match change.resource {
                ResourceName::Cpu => u.cpu_millis,
                ResourceName::Memory => u.memory_bytes as f64,
            })
            .fold(None, |max: Option<f64>, v| {
                Some(max.map_or(v, |m| m.max(v)))
            });
        let Some(usage) = highest else {
            if !unsampled.contains(&change.container) {
                unsampled.push(change.container.clone());
            }
            continue;
        };
        if !above(usage, limit) {
            continue;
        }
        let fmt = |v: f64| fmt_amount(change.resource, v);
        let (code, message) = match change.resource {
            ResourceName::Memory => (
                FindingCode::W4,
                format!(
                    "The container would be OOMKilled as soon as it starts using what it uses now ({}).",
                    fmt(usage)
                ),
            ),
            ResourceName::Cpu => (
                FindingCode::W5,
                format!(
                    "The container would be throttled: it uses {} now and the new CPU limit is {}.",
                    fmt(usage),
                    fmt(limit)
                ),
            ),
        };
        found.push(on_field(
            code,
            Level::Warning,
            message,
            &change.container,
            change.resource,
            ResourceField::Limit,
        ));
    }
    out.findings.extend(found);
    for container in unsampled {
        out.findings.push(Finding {
            container: Some(container.clone()),
            ..finding(
                FindingCode::W9,
                Level::NotChecked,
                format!("Not checked: usage of `{container}` (no sample from metrics-server)."),
            )
        });
    }
}

/// W7: an HPA on utilisation of a resource whose pod request moves.
fn check_autoscalers_on_requests(
    out: &mut Evaluation,
    facts: &ResourceFacts,
    before: &PodFigures,
    new: &PodFigures,
) {
    let Some(hpas) = facts.hpas.known() else {
        return;
    };
    let mut by_name: Vec<_> = hpas.iter().collect();
    by_name.sort_by(|a, b| a.name.cmp(&b.name));
    for hpa in by_name {
        for resource in RESOURCES {
            let on = match resource {
                ResourceName::Cpu => hpa.cpu_utilization,
                ResourceName::Memory => hpa.memory_utilization,
            };
            if on && !same_amount(new.request.get(resource), before.request.get(resource)) {
                out.findings.push(Finding {
                    resource: Some(resource),
                    ..finding(
                        FindingCode::W7,
                        Level::Warning,
                        format!(
                            "HorizontalPodAutoscaler `{}` scales on {} utilisation, which is a share of the request: the replica count may move.",
                            hpa.name,
                            resource.word()
                        ),
                    )
                });
            }
        }
    }
}

/// W8: a VPA that rewrites the values.
fn check_vpas(out: &mut Evaluation, facts: &ResourceFacts) {
    let Some(vpas) = facts.vpas.known() else {
        return;
    };
    let mut by_name: Vec<_> = vpas.iter().collect();
    by_name.sort_by(|a, b| a.name.cmp(&b.name));
    for vpa in by_name.into_iter().filter(|v| v.update_mode != "Off") {
        out.findings.push(finding(
            FindingCode::W8,
            Level::Warning,
            format!(
                "VerticalPodAutoscaler `{}` (mode {}) will rewrite these values.",
                vpa.name, vpa.update_mode
            ),
        ));
    }
}

/// W9 for each part of the facts that could not be read, and for each
/// quota with scopes.
fn not_checked(out: &mut Evaluation, facts: &ResourceFacts) {
    let mut push = |what: &str, reason: &str| {
        out.findings.push(finding(
            FindingCode::W9,
            Level::NotChecked,
            format!("Not checked: {what} ({reason})."),
        ));
    };
    let reason = |missing: Option<&str>| missing.map(str::to_string);
    let parts = [
        ("room on the nodes", reason(missing_reason(&facts.nodes))),
        (
            "current usage against the new limits",
            // With no pod there is no usage to compare: the note says so.
            reason(missing_reason(&facts.usage)).filter(|_| !facts.pods.is_empty()),
        ),
        (
            "namespace limit ranges",
            reason(missing_reason(&facts.limit_ranges)),
        ),
        ("namespace quota", reason(missing_reason(&facts.quotas))),
        ("autoscalers", reason(missing_reason(&facts.hpas))),
        ("vertical autoscalers", reason(missing_reason(&facts.vpas))),
    ];
    for (what, reason) in parts {
        if let Some(reason) = reason {
            push(what, &reason);
        }
    }
    if let Some(quotas) = facts.quotas.known() {
        let mut scoped: Vec<_> = quotas.iter().filter(|q| q.scoped).collect();
        scoped.sort_by(|a, b| a.name.cmp(&b.name));
        for quota in scoped {
            out.findings.push(finding(
                FindingCode::W9,
                Level::NotChecked,
                format!("Not checked: quota `{}` (it has scopes).", quota.name),
            ));
        }
    }
}

/// The reason a fact is missing.
fn missing_reason<T>(fact: &Fact<T>) -> Option<&str> {
    match fact {
        Fact::Known { .. } => None,
        Fact::Missing { reason } => Some(reason),
    }
}

/// The amount in bytes of `number` thousandths of a byte, as a plain number.
fn milli_bytes(number: &str) -> String {
    match number.parse::<f64>() {
        Ok(n) if n.is_finite() => format!("{}", n / 1000.0),
        _ => number.to_string(),
    }
}

/// B3, for each resource a change touches: the effective limit under the
/// effective request.
fn check_limit_under_request(
    out: &mut Evaluation,
    after: &Template,
    zero_limits: &[(String, ResourceName)],
) {
    let mut touched: Vec<(String, ResourceName)> = Vec::new();
    for change in &out.changes {
        let key = (change.container.clone(), change.resource);
        if !touched.contains(&key) && !zero_limits.contains(&key) {
            touched.push(key);
        }
    }
    for (name, resource) in touched {
        let Some(c) = after.all().find(|c| c.name == name) else {
            continue;
        };
        let e = c.get(resource);
        if let (Some(request), Some(limit)) = (e.request, e.limit) {
            if above(request, limit) {
                out.findings.push(on_field(
                    FindingCode::B3,
                    Level::Blocked,
                    format!(
                        "The limit ({}) is under the request ({}).",
                        fmt_amount(resource, limit),
                        fmt_amount(resource, request)
                    ),
                    &name,
                    resource,
                    ResourceField::Limit,
                ));
            }
        }
    }
}

/// B4: the LimitRange admission's rules, over every container of the
/// template and over the pod.
fn check_limit_ranges(out: &mut Evaluation, after: &Template, limit_ranges: &[LimitRangeFacts]) {
    let mut by_name: Vec<&LimitRangeFacts> = limit_ranges.iter().collect();
    by_name.sort_by(|a, b| a.name.cmp(&b.name));
    for lr in by_name {
        let mut push = |what: String,
                        container: Option<&str>,
                        resource: ResourceName,
                        field: ResourceField| {
            out.findings.push(Finding {
                container: container.map(str::to_string),
                resource: Some(resource),
                field: Some(field),
                ..finding(
                    FindingCode::B4,
                    Level::Blocked,
                    format!("LimitRange `{}`: {what}.", lr.name),
                )
            });
        };
        for item in &lr.items {
            for resource in RESOURCES {
                let word = resource.word();
                let fmt = |v: f64| fmt_amount(resource, v);
                match item.kind.as_str() {
                    "Container" => {
                        for c in after.all() {
                            let e = c.get(resource);
                            let name = c.name.as_str();
                            if let Some(min) = item.min.get(resource) {
                                match e.request {
                                    None => push(
                                        format!("needs a {word} request on every container; `{name}` has none"),
                                        Some(name),
                                        resource,
                                        ResourceField::Request,
                                    ),
                                    Some(v) if above(min, v) => push(
                                        format!("{word} request {} of `{name}` is under the minimum {}", fmt(v), fmt(min)),
                                        Some(name),
                                        resource,
                                        ResourceField::Request,
                                    ),
                                    Some(_) => {}
                                }
                            }
                            if let Some(max) = item.max.get(resource) {
                                match e.limit {
                                    None => push(
                                        format!("needs a {word} limit on every container; `{name}` has none"),
                                        Some(name),
                                        resource,
                                        ResourceField::Limit,
                                    ),
                                    Some(v) if above(v, max) => push(
                                        format!("{word} limit {} of `{name}` is above the maximum {}", fmt(v), fmt(max)),
                                        Some(name),
                                        resource,
                                        ResourceField::Limit,
                                    ),
                                    Some(_) => {}
                                }
                            }
                            if let Some(ratio) = item.max_ratio.get(resource) {
                                match (e.request, e.limit) {
                                    (Some(request), Some(limit)) if request > 0.0 => {
                                        if above(limit / request, ratio) {
                                            push(
                                                format!(
                                                    "{word} limit of `{name}` is {} times its request; the maximum ratio is {}",
                                                    fmt_ratio(limit / request),
                                                    fmt_ratio(ratio)
                                                ),
                                                Some(name),
                                                resource,
                                                ResourceField::Limit,
                                            );
                                        }
                                    }
                                    _ => push(
                                        format!(
                                            "`{name}` needs both a {word} request and a {word} limit; the maximum ratio is {}",
                                            fmt_ratio(ratio)
                                        ),
                                        Some(name),
                                        resource,
                                        ResourceField::Limit,
                                    ),
                                }
                            }
                        }
                    }
                    "Pod" => {
                        let requests =
                            admission_sum(&after.regular, &after.init, |c| c.get(resource).request);
                        let limits =
                            admission_sum(&after.regular, &after.init, |c| c.get(resource).limit);
                        if let Some(min) = item.min.get(resource) {
                            match requests {
                                None => push(
                                    format!("the pod has no {word} request; the pod minimum is {}", fmt(min)),
                                    None,
                                    resource,
                                    ResourceField::Request,
                                ),
                                Some(v) if above(min, v) => push(
                                    format!("the pod's {word} requests ({}) are under the pod minimum {}", fmt(v), fmt(min)),
                                    None,
                                    resource,
                                    ResourceField::Request,
                                ),
                                Some(_) => {}
                            }
                        }
                        if let Some(max) = item.max.get(resource) {
                            match limits {
                                None => push(
                                    format!(
                                        "the pod has no {word} limit; the pod maximum is {}",
                                        fmt(max)
                                    ),
                                    None,
                                    resource,
                                    ResourceField::Limit,
                                ),
                                Some(v) if above(v, max) => push(
                                    format!(
                                        "the pod's {word} limits ({}) are above the pod maximum {}",
                                        fmt(v),
                                        fmt(max)
                                    ),
                                    None,
                                    resource,
                                    ResourceField::Limit,
                                ),
                                Some(_) => {}
                            }
                        }
                        if let Some(ratio) = item.max_ratio.get(resource) {
                            match (requests, limits) {
                                (Some(request), Some(limit)) if request > 0.0 => {
                                    if above(limit / request, ratio) {
                                        push(
                                            format!(
                                                "the pod's {word} limits are {} times its requests; the maximum ratio is {}",
                                                fmt_ratio(limit / request),
                                                fmt_ratio(ratio)
                                            ),
                                            None,
                                            resource,
                                            ResourceField::Limit,
                                        );
                                    }
                                }
                                _ => push(
                                    format!(
                                        "the pod needs both a {word} request and a {word} limit; the maximum ratio is {}",
                                        fmt_ratio(ratio)
                                    ),
                                    None,
                                    resource,
                                    ResourceField::Limit,
                                ),
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

/// The quota keys spec B5 reads, and which figure of the pod each counts.
const QUOTA_KEYS: [(&str, ResourceName, ResourceField); 6] = [
    ("requests.cpu", ResourceName::Cpu, ResourceField::Request),
    (
        "requests.memory",
        ResourceName::Memory,
        ResourceField::Request,
    ),
    ("limits.cpu", ResourceName::Cpu, ResourceField::Limit),
    ("limits.memory", ResourceName::Memory, ResourceField::Limit),
    ("cpu", ResourceName::Cpu, ResourceField::Request),
    ("memory", ResourceName::Memory, ResourceField::Request),
];

/// The figure of a pod a quota key counts; `None` for a limit the pod does not have.
fn quota_figure(figures: &PodFigures, resource: ResourceName, field: ResourceField) -> Option<f64> {
    match field {
        ResourceField::Request => Some(figures.request.get(resource)),
        ResourceField::Limit => figures.limit(resource),
    }
}

/// What a quota key leaves for this workload's pods: its hard limit less
/// what is used by everything else.
struct QuotaRoom {
    free: f64,
    hard: f64,
}

fn quota_room(
    facts: &ResourceFacts,
    quota: &super::types::QuotaFacts,
    key: &str,
    resource: ResourceName,
    field: ResourceField,
) -> Option<QuotaRoom> {
    let hard = *quota.hard.get(key)?;
    let used = quota.used.get(key).copied().unwrap_or(0.0);
    let own_now: f64 = facts
        .pods
        .iter()
        .map(|p| quota_figure(&p.figures, resource, field).unwrap_or(0.0))
        .sum();
    Some(QuotaRoom {
        free: hard - (used - own_now),
        hard,
    })
}

/// B5: with every replica on the new values, an unscoped quota is exceeded.
fn check_quotas(out: &mut Evaluation, facts: &ResourceFacts, new: &PodFigures) {
    let Some(quotas) = facts.quotas.known() else {
        return;
    };
    let mut by_name: Vec<_> = quotas.iter().filter(|q| !q.scoped).collect();
    by_name.sort_by(|a, b| a.name.cmp(&b.name));
    let replicas = f64::from(facts.workload.replicas.max(0));
    for quota in by_name {
        let mut rollout_warned = false;
        for (key, resource, field) in QUOTA_KEYS {
            let Some(room) = quota_room(facts, quota, key, resource, field) else {
                continue;
            };
            let Some(per_pod) = quota_figure(new, resource, field) else {
                out.findings.push(Finding {
                    resource: Some(resource),
                    ..finding(
                        FindingCode::B5,
                        Level::Blocked,
                        format!(
                            "Quota `{}` needs a {} limit on every container.",
                            quota.name,
                            resource.word()
                        ),
                    )
                });
                continue;
            };
            let need = replicas * per_pod;
            if !above(need, room.free) {
                if !rollout_warned && rollout_stalls(facts, &room, per_pod, resource, field) {
                    rollout_warned = true;
                    out.findings.push(Finding {
                        resource: Some(resource),
                        ..finding(
                            FindingCode::W6,
                            Level::Warning,
                            format!(
                                "The rollout may stall until old pods are gone: quota `{}` has no room for old and new pods together.",
                                quota.name
                            ),
                        )
                    });
                }
            } else {
                out.findings.push(Finding {
                    resource: Some(resource),
                    ..finding(
                        FindingCode::B5,
                        Level::Blocked,
                        format!(
                            "Quota `{}`: {} replicas need {} of {key}; {} is free of {}.",
                            quota.name,
                            facts.workload.replicas,
                            fmt_amount(resource, need),
                            fmt_amount(resource, room.free.max(0.0)),
                            fmt_amount(resource, room.hard)
                        ),
                    )
                });
            }
        }
    }
}

/// W6: during a rolling update, with up to `max_unavailable` old pods
/// stopped, old and new pods together pass what the quota leaves.
fn rollout_stalls(
    facts: &ResourceFacts,
    room: &QuotaRoom,
    per_pod: f64,
    resource: ResourceName,
    field: ResourceField,
) -> bool {
    let rollout = &facts.workload.rollout;
    if rollout.recreate || facts.pods.is_empty() {
        return false;
    }
    let old = facts
        .pods
        .iter()
        .map(|p| quota_figure(&p.figures, resource, field).unwrap_or(0.0))
        .fold(0.0, f64::max);
    let replicas = i64::from(facts.workload.replicas.max(0));
    let unavailable = i64::from(rollout.max_unavailable.max(0));
    (0..replicas).any(|k| {
        let old_pods = (replicas - unavailable - k).max(0) as f64;
        let new_pods = (k + 1) as f64;
        above(old_pods * old + new_pods * per_pod, room.free)
    })
}

/// Worst first: by level, then by code as declared, then by node, then by container.
fn sort_findings(findings: &mut [Finding]) {
    findings.sort_by(|a, b| {
        (a.level, a.code, &a.node, &a.container).cmp(&(b.level, b.code, &b.node, &b.container))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::fixtures::{and, container, facts, set, set_on, GI, MI};
    use crate::limits::mark::{next_mark, OverrideContainer};
    use crate::limits::types::{
        Change, Fact, Finding, FindingCode, Level, LimitRangeFacts, LimitRangeItemFacts,
        PerResource, ProposalKind, QuotaFacts, ResourceField::*, ResourceName::*, ResourceTexts,
    };

    /// The finding of `code`, the test failing when there is none or more than one.
    fn only(e: &Evaluation, code: FindingCode) -> Finding {
        let found: Vec<_> = e.findings.iter().filter(|f| f.code == code).collect();
        assert_eq!(found.len(), 1, "one {code:?} in {:#?}", e.findings);
        found[0].clone()
    }

    fn codes(e: &Evaluation) -> Vec<FindingCode> {
        e.findings.iter().map(|f| f.code).collect()
    }

    fn blocked(e: &Evaluation) -> Vec<&Finding> {
        e.findings
            .iter()
            .filter(|f| f.level == Level::Blocked)
            .collect()
    }

    /// A finding about a container's field.
    fn about(
        code: FindingCode,
        level: Level,
        message: &str,
        container: &str,
        resource: crate::limits::types::ResourceName,
        field: Option<crate::limits::types::ResourceField>,
    ) -> Finding {
        Finding {
            code,
            level,
            message: message.into(),
            container: Some(container.into()),
            resource: Some(resource),
            field,
            node: None,
        }
    }

    fn limit_range(name: &str, item: LimitRangeItemFacts) -> Fact<Vec<LimitRangeFacts>> {
        Fact::Known {
            value: vec![LimitRangeFacts {
                name: name.into(),
                items: vec![item],
            }],
        }
    }

    fn quota(name: &str, hard: &[(&str, f64)], used: &[(&str, f64)]) -> Fact<Vec<QuotaFacts>> {
        let map = |kv: &[(&str, f64)]| kv.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        Fact::Known {
            value: vec![QuotaFacts {
                name: name.into(),
                scoped: false,
                hard: map(hard),
                used: map(used),
            }],
        }
    }

    /// An annotation the app would have written for `api`.
    fn api_mark(original: ResourceTexts, applied: ResourceTexts) -> String {
        next_mark(
            None,
            &[OverrideContainer {
                name: "api".into(),
                original,
                applied,
            }],
            "2026-11-13T11:20:00Z",
        )
        .expect("a mark")
    }

    fn restore() -> Proposal {
        Proposal {
            kind: ProposalKind::Restore,
            containers: Vec::new(),
        }
    }

    #[test]
    fn raising_a_limit_is_one_change_and_no_blocked_finding() {
        let e = evaluate(&facts(), &set("api", Memory, Limit, Some("768Mi")));
        assert_eq!(
            e.changes,
            [Change {
                container: "api".into(),
                sidecar: false,
                resource: Memory,
                field: Limit,
                before: Some("512Mi".into()),
                after: Some("768Mi".into())
            }]
        );
        assert!(e.findings.iter().all(|f| f.level != Level::Blocked));
    }

    #[test]
    fn the_same_amount_in_another_unit_is_no_change() {
        let p = and(
            set("api", Memory, Limit, Some("0.5Gi")),
            "api",
            Cpu,
            Limit,
            Some("0.5"),
        );
        let p = and(p, "api", Memory, Request, Some("268435456"));
        let e = evaluate(&facts(), &p);
        assert_eq!(e.changes, []);
        assert!(blocked(&e).is_empty());
        // And a real change next to them is the only one listed.
        let e = evaluate(&facts(), &and(p, "api", Cpu, Request, Some("300m")));
        assert_eq!(e.changes.len(), 1);
        assert_eq!(e.changes[0].after.as_deref(), Some("300m"));
    }

    #[test]
    fn changes_are_in_template_order_cpu_first_request_first() {
        let mut f = facts();
        f.workload.init_containers = vec![container(
            "mesh",
            true,
            (Some("50m"), Some("100m")),
            (None, None),
        )];
        let p = Proposal {
            kind: ProposalKind::Adjust,
            containers: vec![
                set_on(&f, "mesh", Cpu, Limit, Some("200m"))
                    .containers
                    .remove(0),
                and(
                    set_on(&f, "api", Memory, Limit, Some("768Mi")),
                    "api",
                    Cpu,
                    Request,
                    Some("300m"),
                )
                .containers
                .remove(0),
            ],
        };
        let e = evaluate(&f, &p);
        let order: Vec<_> = e
            .changes
            .iter()
            .map(|c| (c.container.as_str(), c.sidecar, c.resource, c.field))
            .collect();
        assert_eq!(
            order,
            [
                ("api", false, Cpu, Request),
                ("api", false, Memory, Limit),
                ("mesh", true, Cpu, Limit)
            ]
        );
    }

    #[test]
    fn b1_an_unreadable_or_negative_quantity() {
        for text in ["abc", "-1"] {
            let e = evaluate(&facts(), &set("api", Memory, Limit, Some(text)));
            assert_eq!(
                only(&e, FindingCode::B1),
                about(
                    FindingCode::B1,
                    Level::Blocked,
                    &format!("`{text}` is not a valid quantity."),
                    "api",
                    Memory,
                    Some(Limit)
                )
            );
            // The change is still listed, as typed.
            assert_eq!(e.changes[0].after.as_deref(), Some(text));
        }
        // An unreadable value stops the checks on amounts: no B5 from it.
        let mut f = facts();
        f.quotas = quota("team", &[("limits.memory", 1.0 * GI)], &[]);
        let e = evaluate(&f, &set("api", Memory, Limit, Some("abc")));
        assert_eq!(codes(&e), [FindingCode::B1]);
    }

    #[test]
    fn b2_a_limit_of_zero() {
        let e = evaluate(&facts(), &set("api", Memory, Limit, Some("0Mi")));
        assert_eq!(
            only(&e, FindingCode::B2),
            about(
                FindingCode::B2,
                Level::Blocked,
                "A limit of zero: the container could not run.",
                "api",
                Memory,
                Some(Limit)
            )
        );
        // A limit of zero is not also reported as under its request.
        assert!(!codes(&e).contains(&FindingCode::B3));
        // A request of zero is allowed.
        let e = evaluate(&facts(), &set("api", Cpu, Request, Some("0")));
        assert!(blocked(&e).is_empty());
    }

    #[test]
    fn b3_a_limit_under_its_request() {
        let e = evaluate(&facts(), &set("api", Memory, Limit, Some("200Mi")));
        assert_eq!(
            only(&e, FindingCode::B3),
            about(
                FindingCode::B3,
                Level::Blocked,
                "The limit (200Mi) is under the request (256Mi).",
                "api",
                Memory,
                Some(Limit)
            )
        );
        // A request raised above its limit, the same.
        let e = evaluate(&facts(), &set("api", Cpu, Request, Some("600m")));
        assert_eq!(
            only(&e, FindingCode::B3).message,
            "The limit (500m) is under the request (600m)."
        );
    }

    #[test]
    fn b3_uses_the_effective_values() {
        let mut f = facts();
        f.limit_ranges = limit_range(
            "defaults",
            LimitRangeItemFacts {
                kind: "Container".into(),
                default: PerResource {
                    cpu: Some(200.0),
                    memory: None,
                },
                ..Default::default()
            },
        );
        let e = evaluate(&f, &set_on(&f, "envoy", Cpu, Request, Some("300m")));
        assert_eq!(
            only(&e, FindingCode::B3),
            about(
                FindingCode::B3,
                Level::Blocked,
                "The limit (200m) is under the request (300m).",
                "envoy",
                Cpu,
                Some(Limit)
            )
        );
    }

    #[test]
    fn cleared_blocks_an_adjust_and_not_a_restore() {
        let e = evaluate(&facts(), &set("api", Memory, Limit, None));
        assert_eq!(
            only(&e, FindingCode::Cleared),
            about(
                FindingCode::Cleared,
                Level::Blocked,
                "A request or a limit cannot be removed here.",
                "api",
                Memory,
                Some(Limit)
            )
        );
        assert_eq!(e.changes[0].after, None);
        // A restore to a value that was not set clears it, unblocked.
        let mut f = facts();
        let cluster = crate::limits::fixtures::cluster_texts(&f, "api");
        let mut original = cluster.clone();
        original.memory.limit = None;
        f.workload.override_annotation = Some(api_mark(original, cluster));
        let e = evaluate(&f, &restore());
        assert!(!codes(&e).contains(&FindingCode::Cleared));
        assert!(blocked(&e).is_empty());
    }

    #[test]
    fn unknown_container_and_plain_init_container_are_refused() {
        let mut f = facts();
        f.workload.init_containers = vec![
            container("migrate", false, (Some("10m"), None), (None, None)),
            container("mesh", true, (Some("50m"), None), (None, None)),
        ];
        for name in ["worker", "migrate"] {
            let p = Proposal {
                kind: ProposalKind::Adjust,
                containers: vec![crate::limits::types::ContainerProposal {
                    name: name.into(),
                    resources: ResourceTexts::default(),
                }],
            };
            let e = evaluate(&f, &p);
            assert_eq!(
                only(&e, FindingCode::UnknownContainer),
                Finding {
                    code: FindingCode::UnknownContainer,
                    level: Level::Blocked,
                    message: format!("Container `{name}` is not in this deployment."),
                    container: Some(name.into()),
                    resource: None,
                    field: None,
                    node: None,
                }
            );
            assert_eq!(e.changes, []);
        }
        // A native sidecar can be changed.
        let e = evaluate(&f, &set_on(&f, "mesh", Cpu, Request, Some("100m")));
        assert!(blocked(&e).is_empty());
        assert!(e.changes[0].sidecar);
    }

    #[test]
    fn b4_container_max_min_and_ratio() {
        let mut f = facts();
        f.limit_ranges = limit_range(
            "limits",
            LimitRangeItemFacts {
                kind: "Container".into(),
                max: PerResource {
                    cpu: None,
                    memory: Some(1.0 * GI),
                },
                ..Default::default()
            },
        );
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("2Gi")));
        assert_eq!(
            only(&e, FindingCode::B4),
            about(
                FindingCode::B4,
                Level::Blocked,
                "LimitRange `limits`: memory limit 2Gi of `api` is above the maximum 1Gi.",
                "api",
                Memory,
                Some(Limit)
            )
        );

        f.limit_ranges = limit_range(
            "limits",
            LimitRangeItemFacts {
                kind: "Container".into(),
                min: PerResource {
                    cpu: Some(100.0),
                    memory: None,
                },
                ..Default::default()
            },
        );
        let e = evaluate(&f, &set_on(&f, "api", Cpu, Request, Some("50m")));
        assert_eq!(
            only(&e, FindingCode::B4),
            about(
                FindingCode::B4,
                Level::Blocked,
                "LimitRange `limits`: CPU request 50m of `api` is under the minimum 100m.",
                "api",
                Cpu,
                Some(Request)
            )
        );

        f.limit_ranges = limit_range(
            "limits",
            LimitRangeItemFacts {
                kind: "Container".into(),
                max_ratio: PerResource {
                    cpu: None,
                    memory: Some(2.0),
                },
                ..Default::default()
            },
        );
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("1Gi")));
        assert_eq!(
            only(&e, FindingCode::B4),
            about(
                FindingCode::B4,
                Level::Blocked,
                "LimitRange `limits`: memory limit of `api` is 4 times its request; the maximum ratio is 2.",
                "api",
                Memory,
                Some(Limit)
            )
        );
        // Exactly the ratio is allowed (envoy is at 2 already).
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("512Mi")));
        assert!(!codes(&e).contains(&FindingCode::B4));
    }

    #[test]
    fn b4_a_missing_value_the_limit_range_needs() {
        // The admission refuses a container without a limit when there is a
        // maximum, and without a request when there is a minimum or a ratio.
        let mut f = facts();
        f.limit_ranges = limit_range(
            "limits",
            LimitRangeItemFacts {
                kind: "Container".into(),
                max: PerResource {
                    cpu: Some(2000.0),
                    memory: None,
                },
                ..Default::default()
            },
        );
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert_eq!(
            only(&e, FindingCode::B4),
            about(
                FindingCode::B4,
                Level::Blocked,
                "LimitRange `limits`: needs a CPU limit on every container; `envoy` has none.",
                "envoy",
                Cpu,
                Some(Limit)
            )
        );
        f.limit_ranges = limit_range(
            "limits",
            LimitRangeItemFacts {
                kind: "Container".into(),
                min: PerResource {
                    cpu: None,
                    memory: Some(1.0),
                },
                ..Default::default()
            },
        );
        f.workload.containers[1] = container("envoy", false, (Some("100m"), None), (None, None));
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert_eq!(
            only(&e, FindingCode::B4).message,
            "LimitRange `limits`: needs a memory request on every container; `envoy` has none."
        );
        f.limit_ranges = limit_range(
            "limits",
            LimitRangeItemFacts {
                kind: "Container".into(),
                max_ratio: PerResource {
                    cpu: Some(4.0),
                    memory: None,
                },
                ..Default::default()
            },
        );
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert_eq!(
            only(&e, FindingCode::B4),
            about(
                FindingCode::B4,
                Level::Blocked,
                "LimitRange `limits`: `envoy` needs both a CPU request and a CPU limit; the maximum ratio is 4.",
                "envoy",
                Cpu,
                Some(Limit)
            )
        );
    }

    #[test]
    fn b4_pod_max() {
        let mut f = facts();
        f.limit_ranges = limit_range(
            "pod-limits",
            LimitRangeItemFacts {
                kind: "Pod".into(),
                max: PerResource {
                    cpu: None,
                    memory: Some(1.0 * GI),
                },
                ..Default::default()
            },
        );
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("1Gi")));
        assert_eq!(
            only(&e, FindingCode::B4),
            Finding {
                code: FindingCode::B4,
                level: Level::Blocked,
                message: "LimitRange `pod-limits`: the pod's memory limits (1.1Gi) are above the pod maximum 1Gi.".into(),
                container: None,
                resource: Some(Memory),
                field: Some(Limit),
                node: None,
            }
        );
        // The admission sums the limits that are set: envoy's missing CPU
        // limit adds nothing, and 500m is above a pod maximum of 400m.
        f.limit_ranges = limit_range(
            "pod-limits",
            LimitRangeItemFacts {
                kind: "Pod".into(),
                max: PerResource {
                    cpu: Some(400.0),
                    memory: None,
                },
                ..Default::default()
            },
        );
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert_eq!(
            only(&e, FindingCode::B4).message,
            "LimitRange `pod-limits`: the pod's CPU limits (500m) are above the pod maximum 400m."
        );
        // And a pod minimum on requests.
        f.limit_ranges = limit_range(
            "pod-limits",
            LimitRangeItemFacts {
                kind: "Pod".into(),
                min: PerResource {
                    cpu: Some(300.0),
                    memory: None,
                },
                ..Default::default()
            },
        );
        let e = evaluate(&f, &set_on(&f, "api", Cpu, Request, Some("150m")));
        assert_eq!(
            only(&e, FindingCode::B4).message,
            "LimitRange `pod-limits`: the pod's CPU requests (250m) are under the pod minimum 300m."
        );
    }

    #[test]
    fn b4_not_run_without_limit_ranges_is_left_to_w9() {
        let mut f = facts();
        f.limit_ranges = Fact::Missing {
            reason: "not allowed to read LimitRange".into(),
        };
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("2Gi")));
        assert!(!codes(&e).contains(&FindingCode::B4));
        assert!(blocked(&e).is_empty());
        let w9 = only(&e, FindingCode::W9);
        assert_eq!(
            (w9.level, w9.message.as_str()),
            (
                Level::NotChecked,
                "Not checked: namespace limit ranges (not allowed to read LimitRange)."
            )
        );
    }

    #[test]
    fn b5_all_replicas_on_the_new_values_exceed_the_quota() {
        let mut f = facts();
        f.quotas = quota(
            "team",
            &[("requests.memory", 2.0 * GI)],
            &[("requests.memory", 1.0 * GI)],
        );
        let p = and(
            set_on(&f, "api", Memory, Request, Some("1Gi")),
            "api",
            Memory,
            Limit,
            Some("1Gi"),
        );
        let e = evaluate(&f, &p);
        assert_eq!(
            only(&e, FindingCode::B5),
            Finding {
                code: FindingCode::B5,
                level: Level::Blocked,
                message:
                    "Quota `team`: 3 replicas need 3.2Gi of requests.memory; 1.9Gi is free of 2Gi."
                        .into(),
                container: None,
                resource: Some(Memory),
                field: None,
                node: None,
            }
        );
        // Room for it: no B5.
        let p = set_on(&f, "api", Memory, Request, Some("300Mi"));
        assert!(!codes(&evaluate(&f, &p)).contains(&FindingCode::B5));
    }

    #[test]
    fn b5_bare_cpu_and_memory_keys_count_requests() {
        let mut f = facts();
        f.quotas = quota("team", &[("cpu", 2000.0)], &[("cpu", 1050.0)]);
        let p = and(
            set_on(&f, "api", Cpu, Request, Some("800m")),
            "api",
            Cpu,
            Limit,
            Some("800m"),
        );
        assert_eq!(
            only(&evaluate(&f, &p), FindingCode::B5).message,
            "Quota `team`: 3 replicas need 2.70 of cpu; 2 is free of 2."
        );
        f.quotas = quota("team", &[("memory", 1.0 * GI)], &[("memory", 960.0 * MI)]);
        let e = evaluate(&f, &set_on(&f, "api", Memory, Request, Some("300Mi")));
        assert_eq!(
            only(&e, FindingCode::B5).message,
            "Quota `team`: 3 replicas need 1.1Gi of memory; 1Gi is free of 1Gi."
        );
        assert_eq!(only(&e, FindingCode::B5).resource, Some(Memory));
    }

    #[test]
    fn b5_a_limits_quota_needs_a_limit_on_every_container() {
        let mut f = facts();
        f.quotas = quota("team", &[("limits.cpu", 10000.0)], &[]);
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert_eq!(
            only(&e, FindingCode::B5),
            Finding {
                code: FindingCode::B5,
                level: Level::Blocked,
                message: "Quota `team` needs a CPU limit on every container.".into(),
                container: None,
                resource: Some(Cpu),
                field: None,
                node: None,
            }
        );
        // With a CPU limit on envoy it fits.
        let p = set_on(&f, "envoy", Cpu, Limit, Some("200m"));
        assert!(!codes(&evaluate(&f, &p)).contains(&FindingCode::B5));
    }

    #[test]
    fn restore_without_an_active_mark_is_refused() {
        let refused = Finding {
            code: FindingCode::NoOverride,
            level: Level::Blocked,
            message: "There is no active override to restore.".into(),
            container: None,
            resource: None,
            field: None,
            node: None,
        };
        let e = evaluate(&facts(), &restore());
        assert_eq!(e.findings, std::slice::from_ref(&refused));
        assert_eq!(e.changes, []);
        // A stale mark (the cluster moved on to 1Gi) is no mark.
        let mut f = facts();
        let cluster = crate::limits::fixtures::cluster_texts(&f, "api");
        let mut applied = cluster.clone();
        applied.memory.limit = Some("1Gi".into());
        f.workload.override_annotation = Some(api_mark(cluster, applied));
        let e = evaluate(&f, &restore());
        assert_eq!(e.findings, [refused]);
        assert_eq!(e.nodes, []);
    }

    #[test]
    fn restore_proposes_the_original_values_and_may_clear() {
        let mut f = facts();
        let cluster = crate::limits::fixtures::cluster_texts(&f, "api");
        let mut original = cluster.clone();
        original.memory.limit = None;
        original.cpu.limit = Some("250m".into());
        f.workload.override_annotation = Some(api_mark(original, cluster));
        // Whatever the proposal lists is ignored.
        let mut p = set("envoy", Cpu, Request, Some("1"));
        p.kind = ProposalKind::Restore;
        let e = evaluate(&f, &p);
        assert_eq!(
            e.changes,
            [
                Change {
                    container: "api".into(),
                    sidecar: false,
                    resource: Cpu,
                    field: Limit,
                    before: Some("500m".into()),
                    after: Some("250m".into())
                },
                Change {
                    container: "api".into(),
                    sidecar: false,
                    resource: Memory,
                    field: Limit,
                    before: Some("512Mi".into()),
                    after: None
                }
            ]
        );
        assert!(blocked(&e).is_empty());
    }

    #[test]
    fn memory_typed_with_m_is_called_out() {
        let e = evaluate(&facts(), &set("api", Memory, Limit, Some("512m")));
        assert_eq!(
            only(&e, FindingCode::MilliMemory),
            about(
                FindingCode::MilliMemory,
                Level::Warning,
                "`512m` is 0.512 bytes: the suffix m means thousandths. Did you mean `512Mi`?",
                "api",
                Memory,
                Some(Limit)
            )
        );
        // CPU in m is what it should be.
        let e = evaluate(&facts(), &set("api", Cpu, Limit, Some("600m")));
        assert!(!codes(&e).contains(&FindingCode::MilliMemory));
    }

    #[test]
    fn blocked_findings_come_first() {
        let mut f = facts();
        f.quotas = quota("team", &[("limits.cpu", 10000.0)], &[]);
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("512m")));
        let order: Vec<_> = e.findings.iter().map(|x| (x.level, x.code)).collect();
        assert_eq!(
            order[..4],
            [
                (Level::Blocked, FindingCode::B3),
                (Level::Blocked, FindingCode::B5),
                (Level::Warning, FindingCode::W4),
                (Level::Warning, FindingCode::MilliMemory)
            ]
        );
        assert!(e.findings[4..].iter().all(|x| x.level != Level::Blocked));
    }
    // ---------------------------------------------------------------
    // Warnings, notes, "not checked" and the node projection (Task 4)
    // ---------------------------------------------------------------

    use crate::limits::fixtures::{node, pod};
    use crate::limits::types::{
        Amounts, BeforeAfter, HpaFacts, NodeFacts, NodeProjection, OwnPodFacts, PodFigures,
        VpaFacts,
    };

    /// A finding with nothing but its code, level and message.
    fn plain(code: FindingCode, level: Level, message: &str) -> Finding {
        Finding {
            code,
            level,
            message: message.into(),
            container: None,
            resource: None,
            field: None,
            node: None,
        }
    }

    /// A finding about a node.
    fn on_node(
        code: FindingCode,
        level: Level,
        message: &str,
        node: &str,
        resource: crate::limits::types::ResourceName,
    ) -> Finding {
        Finding {
            node: Some(node.into()),
            resource: Some(resource),
            ..plain(code, level, message)
        }
    }

    fn has(e: &Evaluation, code: FindingCode) -> bool {
        e.findings.iter().any(|f| f.code == code)
    }

    fn nodes_mut(f: &mut ResourceFacts) -> &mut Vec<NodeFacts> {
        match &mut f.nodes {
            Fact::Known { value } => value,
            Fact::Missing { .. } => panic!("nodes are missing"),
        }
    }

    fn request_and_limit(
        container: &str,
        resource: crate::limits::types::ResourceName,
        text: &str,
    ) -> Proposal {
        and(
            set(container, resource, Request, Some(text)),
            container,
            resource,
            Limit,
            Some(text),
        )
    }

    #[test]
    fn w0_request_above_every_node() {
        let e = evaluate(&facts(), &request_and_limit("api", Memory, "24Gi"));
        let w0 = Finding {
            resource: Some(Memory),
            field: Some(Request),
            ..plain(
                FindingCode::W0,
                Level::Warning,
                "No node in this cluster can hold 24Gi (largest: 16Gi). The pods stay Pending unless a larger node is added.",
            )
        };
        assert_eq!(only(&e, FindingCode::W0), w0);
        let first_warning = e.findings.iter().find(|f| f.level == Level::Warning);
        assert_eq!(first_warning, Some(&w0));
        assert!(!has(&e, FindingCode::W1));
        assert!(!has(&e, FindingCode::W1r));
        assert!(!has(&e, FindingCode::NoteFits));
    }

    #[test]
    fn w0_limit_alone_has_its_own_sentence() {
        let e = evaluate(&facts(), &set("api", Memory, Limit, Some("24Gi")));
        assert_eq!(
            only(&e, FindingCode::W0),
            about(
                FindingCode::W0,
                Level::Warning,
                "No node in this cluster has 24Gi (largest: 16Gi): the container can never use this limit.",
                "api",
                Memory,
                Some(Limit)
            )
        );
        // The pods still schedule by their requests: the room check runs.
        assert!(has(&e, FindingCode::NoteFits));
    }

    #[test]
    fn w0_counts_cordoned_nodes() {
        let mut f = facts();
        let mut big = node("aks-big", (0.0, 0.0), 0.0, 0.0, 0.0);
        big.schedulable = false;
        big.allocatable.memory_bytes = 32.0 * GI;
        nodes_mut(&mut f).push(big);
        let p = and(
            set_on(&f, "api", Memory, Request, Some("24Gi")),
            "api",
            Memory,
            Limit,
            Some("24Gi"),
        );
        let e = evaluate(&f, &p);
        assert!(!has(&e, FindingCode::W0));
        // The cordoned node takes no pod: none has room.
        assert_eq!(
            only(&e, FindingCode::W1).message,
            "Only 0 of 3 replicas have room by their requests; the rest stay Pending unless nodes are added."
        );
    }

    #[test]
    fn w1_fewer_replicas_fit_than_wanted() {
        let e = evaluate(&facts(), &request_and_limit("api", Cpu, "1500m"));
        assert_eq!(
            only(&e, FindingCode::W1),
            plain(
                FindingCode::W1,
                Level::Warning,
                "Only 2 of 3 replicas have room by their requests; the rest stay Pending unless nodes are added."
            )
        );
        assert!(!has(&e, FindingCode::NoteFits));
        assert!(!has(&e, FindingCode::W1r));
    }

    #[test]
    fn note_fits_when_every_replica_has_room() {
        let e = evaluate(&facts(), &set("api", Memory, Limit, Some("768Mi")));
        assert_eq!(
            only(&e, FindingCode::NoteFits),
            plain(
                FindingCode::NoteFits,
                Level::Note,
                "Fits: 3 of 3 replicas have room by their requests."
            )
        );
        assert!(!has(&e, FindingCode::W1));
    }

    /// One node of 4000m with nothing else on it, three own pods of 1000m.
    fn tight() -> ResourceFacts {
        let mut f = facts();
        f.workload.containers[0] = container(
            "api",
            false,
            (Some("900m"), Some("900m")),
            (Some("256Mi"), Some("512Mi")),
        );
        f.nodes = Fact::Known {
            value: vec![node("solo", (0.0, 0.0), 0.0, 0.0, 4.0 * GI)],
        };
        f.pods = ["api-1", "api-2", "api-3"]
            .iter()
            .map(|name| {
                let mut p = pod(name, "solo");
                p.figures.request.cpu_millis = 1000.0;
                p
            })
            .collect();
        f
    }

    #[test]
    fn w1r_the_end_state_fits_and_the_rollout_does_not() {
        let f = tight();
        let p = |f: &ResourceFacts| {
            and(
                set_on(f, "api", Cpu, Request, Some("1200m")),
                "api",
                Cpu,
                Limit,
                Some("1200m"),
            )
        };
        let e = evaluate(&f, &p(&f));
        assert_eq!(
            only(&e, FindingCode::W1r),
            plain(
                FindingCode::W1r,
                Level::Warning,
                "The rollout may stall: no node has room for a new pod while the old ones still run."
            )
        );
        assert!(has(&e, FindingCode::NoteFits));
        // One old pod may stop first: room for the new one.
        let mut one_down = tight();
        one_down.workload.rollout.max_unavailable = 1;
        assert!(!has(&evaluate(&one_down, &p(&one_down)), FindingCode::W1r));
        // Recreate stops every old pod first.
        let mut recreate = tight();
        recreate.workload.rollout.recreate = true;
        assert!(!has(&evaluate(&recreate, &p(&recreate)), FindingCode::W1r));
    }

    /// The baseline with aks-pool-1's other pods holding 15Gi of memory limits.
    fn crowded() -> ResourceFacts {
        let mut f = facts();
        nodes_mut(&mut f)[0].others_memory_limits = 15.0 * GI;
        f
    }

    #[test]
    fn w2_memory_limits_above_the_node() {
        let f = crowded();
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert_eq!(
            only(&e, FindingCode::W2),
            on_node(
                FindingCode::W2,
                Level::Warning,
                "Memory limits on aks-pool-1 add up to 110% of what the node has (was 105%). Under memory pressure the node evicts pods.",
                "aks-pool-1",
                Memory
            )
        );
    }

    #[test]
    fn w2_silent_when_the_change_does_not_make_it_worse() {
        let f = crowded();
        // Over the node already, and the change does not add to it.
        let e = evaluate(&f, &set_on(&f, "api", Cpu, Request, Some("300m")));
        assert!(!has(&e, FindingCode::W2));
        // Lowered: still over, but less.
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("400Mi")));
        assert!(!has(&e, FindingCode::W2));
    }

    #[test]
    fn w3_full_limits_run_the_node_out_of_memory() {
        let mut f = facts();
        nodes_mut(&mut f)[0].memory_used = Some(15.0 * GI);
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("1Gi")));
        assert_eq!(
            only(&e, FindingCode::W3),
            on_node(
                FindingCode::W3,
                Level::Warning,
                "If these pods use their full limit, aks-pool-1 runs out of memory (94% → 105%).",
                "aks-pool-1",
                Memory
            )
        );
        // The same node, a change that leaves the full limits under it.
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("640Mi")));
        assert!(!has(&e, FindingCode::W3));
        // Without a sample of the node's memory there is nothing to project:
        // that is said, for that node.
        nodes_mut(&mut f)[0].memory_used = None;
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("1Gi")));
        assert!(!has(&e, FindingCode::W3));
        assert_eq!(
            only(&e, FindingCode::W9),
            on_node(
                FindingCode::W9,
                Level::NotChecked,
                "Not checked: memory in use on aks-pool-1 (no sample from metrics-server).",
                "aks-pool-1",
                Memory
            )
        );
    }

    #[test]
    fn w3_silent_when_the_change_does_not_raise_the_pods_limits() {
        // A busy node: with the pods at their full limits it is over already.
        let mut f = facts();
        nodes_mut(&mut f)[0].memory_used = Some(15.9 * GI);
        let e = evaluate(&f, &set_on(&f, "api", Cpu, Request, Some("300m")));
        assert!(!has(&e, FindingCode::W3), "a CPU-only change");
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("500Mi")));
        assert!(!has(&e, FindingCode::W3), "a memory limit lowered");
        // Neither needs the node's sample: no "not checked" for it either.
        nodes_mut(&mut f)[0].memory_used = None;
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("500Mi")));
        assert!(!has(&e, FindingCode::W9), "{:#?}", e.findings);
        // Raised, it is reported.
        nodes_mut(&mut f)[0].memory_used = Some(15.9 * GI);
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("600Mi")));
        assert!(has(&e, FindingCode::W3));
    }

    #[test]
    fn a_container_without_a_limit_does_not_switch_the_node_checks_off() {
        // envoy has no memory limit: the pod's memory limit is none, and
        // the node still adds up the limits that are set.
        let mut f = facts();
        f.workload.containers[1] =
            container("envoy", false, (Some("100m"), None), (Some("64Mi"), None));
        for p in &mut f.pods {
            p.figures.memory_limit = None;
            p.figures.set_limits.memory_bytes = 512.0 * MI;
        }
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("8Gi")));
        // 11Gi + 3 x 512Mi = 12.5Gi before, 11Gi + 3 x 8Gi = 35Gi after.
        assert_eq!(
            only(&e, FindingCode::W2).message,
            "Memory limits on aks-pool-1 add up to 219% of what the node has (was 78%). Under memory pressure the node evicts pods."
        );
        assert!(has(&e, FindingCode::W3));
        assert_eq!(
            only(&e, FindingCode::W9),
            about(
                FindingCode::W9,
                Level::NotChecked,
                "Not checked: how much memory `envoy` can take on the nodes (it has no memory limit).",
                "envoy",
                Memory,
                Some(Limit)
            )
        );
        assert_eq!(
            e.nodes[0].memory_limits,
            BeforeAfter {
                before: 78.0,
                after: 219.0
            }
        );
        // No pod: nothing runs on the nodes, nothing to say.
        f.pods = Vec::new();
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("8Gi")));
        assert!(!has(&e, FindingCode::W9), "{:#?}", e.findings);
        // The CPU note and the projection the same: envoy has no CPU limit
        // in the baseline, and api's 500m counts.
        let e = evaluate(&facts(), &set("api", Cpu, Limit, Some("1")));
        assert_eq!(
            only(&e, FindingCode::NoteCpuLimits).message,
            "CPU limits on aks-pool-1 add up to 125% of its CPU (was 88%). CPU is shared: the pods slow down, they are not killed."
        );
        assert_eq!(
            e.nodes[0].cpu_limits,
            BeforeAfter {
                before: 88.0,
                after: 125.0
            }
        );
    }

    #[test]
    fn w0_limit_sentence_only_for_a_limit_the_change_touches() {
        let mut f = facts();
        f.workload.containers[1] = container(
            "envoy",
            false,
            (Some("100m"), None),
            (Some("64Mi"), Some("64Gi")),
        );
        for p in &mut f.pods {
            p.figures.memory_limit = Some(64.5 * GI);
            p.figures.set_limits.memory_bytes = 64.5 * GI;
        }
        let e = evaluate(&f, &set_on(&f, "api", Cpu, Limit, Some("600m")));
        assert!(!has(&e, FindingCode::W0), "{:#?}", e.findings);
        // The limit typed in this change is reported.
        let e = evaluate(&f, &set_on(&f, "envoy", Memory, Limit, Some("65Gi")));
        assert_eq!(
            only(&e, FindingCode::W0).container.as_deref(),
            Some("envoy")
        );
    }

    #[test]
    fn w4_memory_limit_under_current_usage() {
        let e = evaluate(&facts(), &set("api", Memory, Limit, Some("400Mi")));
        assert_eq!(
            only(&e, FindingCode::W4),
            about(
                FindingCode::W4,
                Level::Warning,
                "The container would be OOMKilled as soon as it starts using what it uses now (498Mi).",
                "api",
                Memory,
                Some(Limit)
            )
        );
        // The highest usage over the pods counts.
        let mut f = facts();
        f.pods[1].usage[0].memory_bytes = 600 * 1024 * 1024;
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("512Mi")));
        // 512Mi is the cluster's value: no change, nothing to report.
        assert!(!has(&e, FindingCode::W4));
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("550Mi")));
        assert!(only(&e, FindingCode::W4).message.ends_with("(600Mi)."));
    }

    #[test]
    fn w5_cpu_limit_under_current_usage() {
        let e = evaluate(&facts(), &set("api", Cpu, Limit, Some("300m")));
        assert_eq!(
            only(&e, FindingCode::W5),
            about(
                FindingCode::W5,
                Level::Warning,
                "The container would be throttled: it uses 412m now and the new CPU limit is 300m.",
                "api",
                Cpu,
                Some(Limit)
            )
        );
        let e = evaluate(&facts(), &set("api", Cpu, Limit, Some("450m")));
        assert!(!has(&e, FindingCode::W5));
    }

    fn rollout_quota(f: &mut ResourceFacts) {
        f.quotas = quota(
            "team",
            &[("requests.memory", 1300.0 * MI)],
            &[("requests.memory", 960.0 * MI)],
        );
    }

    #[test]
    fn w6_quota_fits_at_the_end_and_not_during_the_rollout() {
        let mut f = facts();
        rollout_quota(&mut f);
        let e = evaluate(&f, &set_on(&f, "api", Memory, Request, Some("336Mi")));
        assert_eq!(
            only(&e, FindingCode::W6),
            Finding {
                resource: Some(Memory),
                ..plain(
                    FindingCode::W6,
                    Level::Warning,
                    "The rollout may stall until old pods are gone: quota `team` has no room for old and new pods together."
                )
            }
        );
        assert!(!has(&e, FindingCode::B5));
        // One old pod may stop first: old and new fit together.
        let mut one_down = f.clone();
        one_down.workload.rollout.max_unavailable = 1;
        let e = evaluate(
            &one_down,
            &set_on(&one_down, "api", Memory, Request, Some("336Mi")),
        );
        assert!(!has(&e, FindingCode::W6));
        // Recreate never has both.
        let mut recreate = f.clone();
        recreate.workload.rollout.recreate = true;
        let e = evaluate(
            &recreate,
            &set_on(&recreate, "api", Memory, Request, Some("336Mi")),
        );
        assert!(!has(&e, FindingCode::W6));
        // A quota B5 already refuses is not warned about again.
        let p = and(
            set_on(&f, "api", Memory, Request, Some("512Mi")),
            "api",
            Memory,
            Limit,
            Some("512Mi"),
        );
        let e = evaluate(&f, &p);
        assert!(has(&e, FindingCode::B5) && !has(&e, FindingCode::W6));
    }

    fn hpa(f: &mut ResourceFacts, cpu: bool, memory: bool) {
        f.hpas = Fact::Known {
            value: vec![HpaFacts {
                name: "api".into(),
                cpu_utilization: cpu,
                memory_utilization: memory,
            }],
        };
    }

    #[test]
    fn w7_hpa_on_cpu_and_a_cpu_request_change() {
        let mut f = facts();
        hpa(&mut f, true, false);
        let e = evaluate(&f, &set_on(&f, "api", Cpu, Request, Some("300m")));
        assert_eq!(
            only(&e, FindingCode::W7),
            Finding {
                resource: Some(Cpu),
                ..plain(
                    FindingCode::W7,
                    Level::Warning,
                    "HorizontalPodAutoscaler `api` scales on CPU utilisation, which is a share of the request: the replica count may move."
                )
            }
        );
        // A memory-only change leaves the CPU request where it is.
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert!(!has(&e, FindingCode::W7));
        // And an HPA on memory with a memory request change.
        hpa(&mut f, false, true);
        let e = evaluate(&f, &set_on(&f, "api", Memory, Request, Some("300Mi")));
        assert_eq!(
            only(&e, FindingCode::W7).message,
            "HorizontalPodAutoscaler `api` scales on memory utilisation, which is a share of the request: the replica count may move."
        );
    }

    #[test]
    fn w7_an_unset_request_that_follows_its_limit_counts() {
        let mut f = facts();
        hpa(&mut f, true, false);
        f.workload.containers[0] = container(
            "api",
            false,
            (None, Some("500m")),
            (Some("256Mi"), Some("512Mi")),
        );
        let e = evaluate(&f, &set_on(&f, "api", Cpu, Limit, Some("600m")));
        assert_eq!(only(&e, FindingCode::W7).resource, Some(Cpu));
    }

    #[test]
    fn w8_vpa_unless_off() {
        let mut f = facts();
        let vpa = |mode: &str| Fact::Known {
            value: vec![VpaFacts {
                name: "api-vpa".into(),
                update_mode: mode.into(),
            }],
        };
        f.vpas = vpa("Auto");
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert_eq!(
            only(&e, FindingCode::W8),
            plain(
                FindingCode::W8,
                Level::Warning,
                "VerticalPodAutoscaler `api-vpa` (mode Auto) will rewrite these values."
            )
        );
        f.vpas = vpa("Off");
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert!(!has(&e, FindingCode::W8));
    }

    fn missing<T>(reason: &str) -> Fact<T> {
        Fact::Missing {
            reason: reason.into(),
        }
    }

    #[test]
    fn w9_one_finding_per_missing_fact_with_its_reason() {
        let mut f = facts();
        f.quotas = missing("not allowed to read ResourceQuota");
        let e = evaluate(&f, &request_and_limit("api", Memory, "1Gi"));
        assert_eq!(
            only(&e, FindingCode::W9),
            plain(
                FindingCode::W9,
                Level::NotChecked,
                "Not checked: namespace quota (not allowed to read ResourceQuota)."
            )
        );
        assert!(!has(&e, FindingCode::B5) && !has(&e, FindingCode::W6));

        let mut f = facts();
        f.nodes = missing("not allowed to list nodes");
        f.usage = missing("metrics-server is not installed or did not answer");
        f.limit_ranges = missing("not allowed to read LimitRange");
        f.quotas = missing("not allowed to read ResourceQuota");
        f.hpas = missing("not allowed to read HorizontalPodAutoscaler");
        f.vpas = missing("not allowed to read VerticalPodAutoscaler");
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        let not_checked: Vec<_> = e
            .findings
            .iter()
            .filter(|x| x.level == Level::NotChecked)
            .map(|x| x.message.as_str())
            .collect();
        assert_eq!(
            not_checked,
            [
                "Not checked: room on the nodes (not allowed to list nodes).",
                "Not checked: current usage against the new limits (metrics-server is not installed or did not answer).",
                "Not checked: namespace limit ranges (not allowed to read LimitRange).",
                "Not checked: namespace quota (not allowed to read ResourceQuota).",
                "Not checked: autoscalers (not allowed to read HorizontalPodAutoscaler).",
                "Not checked: vertical autoscalers (not allowed to read VerticalPodAutoscaler).",
            ]
        );
        assert!(e
            .findings
            .iter()
            .filter(|x| x.level == Level::NotChecked)
            .all(|x| x.code == FindingCode::W9));
    }

    #[test]
    fn w9_nodes_missing_stops_w0_to_w3() {
        let mut f = crowded();
        nodes_mut(&mut f)[0].memory_used = Some(15.0 * GI);
        f.nodes = missing("not allowed to list nodes");
        let e = evaluate(&f, &request_and_limit("api", Memory, "24Gi"));
        for code in [
            FindingCode::W0,
            FindingCode::W1,
            FindingCode::W1r,
            FindingCode::W2,
            FindingCode::W3,
            FindingCode::NoteFits,
            FindingCode::NoteCpuLimits,
        ] {
            assert!(!has(&e, code), "{code:?} in {:#?}", e.findings);
        }
        assert_eq!(
            only(&e, FindingCode::W9).message,
            "Not checked: room on the nodes (not allowed to list nodes)."
        );
        assert_eq!(e.nodes, []);
    }

    #[test]
    fn w9_usage_missing_stops_w3_w4_w5() {
        let mut f = facts();
        nodes_mut(&mut f)[0].memory_used = Some(15.0 * GI);
        f.usage = missing("metrics-server is not installed or did not answer");
        let p = and(
            set_on(&f, "api", Memory, Limit, Some("1Gi")),
            "api",
            Cpu,
            Limit,
            Some("300m"),
        );
        let e = evaluate(&f, &p);
        let p = set_on(&f, "api", Memory, Limit, Some("400Mi"));
        let e2 = evaluate(&f, &p);
        for code in [FindingCode::W3, FindingCode::W4, FindingCode::W5] {
            assert!(!has(&e, code) && !has(&e2, code), "{code:?}");
        }
        assert_eq!(
            only(&e, FindingCode::W9).message,
            "Not checked: current usage against the new limits (metrics-server is not installed or did not answer)."
        );
        assert!(e.nodes.iter().all(|n| n.memory_if_full.is_none()));
    }

    #[test]
    fn w9_scoped_quota() {
        let mut f = facts();
        f.quotas = Fact::Known {
            value: vec![QuotaFacts {
                name: "team".into(),
                scoped: true,
                hard: [("requests.memory".to_string(), 1.0 * MI)].into(),
                used: Default::default(),
            }],
        };
        let e = evaluate(&f, &set_on(&f, "api", Memory, Request, Some("300Mi")));
        assert_eq!(
            only(&e, FindingCode::W9),
            plain(
                FindingCode::W9,
                Level::NotChecked,
                "Not checked: quota `team` (it has scopes)."
            )
        );
        assert!(!has(&e, FindingCode::B5) && !has(&e, FindingCode::W6));
    }

    #[test]
    fn w9_a_container_without_a_sample() {
        let mut f = facts();
        for p in &mut f.pods {
            p.usage.retain(|u| u.name == "api");
        }
        let e = evaluate(&f, &set_on(&f, "envoy", Memory, Limit, Some("256Mi")));
        assert_eq!(
            only(&e, FindingCode::W9),
            Finding {
                container: Some("envoy".into()),
                ..plain(
                    FindingCode::W9,
                    Level::NotChecked,
                    "Not checked: usage of `envoy` (no sample from metrics-server)."
                )
            }
        );
        // api has its samples; a request change needs none.
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert!(!has(&e, FindingCode::W9));
        let e = evaluate(&f, &set_on(&f, "envoy", Memory, Request, Some("100Mi")));
        assert!(!has(&e, FindingCode::W9));
    }

    #[test]
    fn no_pods_says_so_once_and_skips_the_usage_checks() {
        let mut f = facts();
        f.pods = Vec::new();
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("400Mi")));
        assert_eq!(
            only(&e, FindingCode::NoteNoPods),
            plain(
                FindingCode::NoteNoPods,
                Level::Note,
                "No pod is running: the checks on current usage do not apply."
            )
        );
        assert!(!has(&e, FindingCode::W4) && !has(&e, FindingCode::W9));
        // The room check still runs with the wanted replicas.
        assert!(has(&e, FindingCode::NoteFits));
        // Usage not read says nothing either: there is nothing to compare.
        f.usage = missing("metrics-server is not installed or did not answer");
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("400Mi")));
        assert!(!has(&e, FindingCode::W9));
    }

    #[test]
    fn zero_replicas_runs_no_room_check() {
        let mut f = facts();
        f.workload.replicas = 0;
        let e = evaluate(&f, &request_and_limit("api", Cpu, "1500m"));
        for code in [FindingCode::W1, FindingCode::W1r, FindingCode::NoteFits] {
            assert!(!has(&e, code), "{code:?}");
        }
    }

    #[test]
    fn note_cpu_limits_and_note_qos() {
        // envoy gets a CPU limit: the pod has 700m of limits instead of
        // api's 500m, and three of them on aks-pool-1 with 2000m of other
        // limits pass its 4000m.
        let e = evaluate(&facts(), &set("envoy", Cpu, Limit, Some("200m")));
        assert_eq!(
            only(&e, FindingCode::NoteCpuLimits),
            on_node(
                FindingCode::NoteCpuLimits,
                Level::Note,
                "CPU limits on aks-pool-1 add up to 103% of its CPU (was 88%). CPU is shared: the pods slow down, they are not killed.",
                "aks-pool-1",
                Cpu
            )
        );
        // Less from the others: under the node, no note.
        let mut f = facts();
        nodes_mut(&mut f)[0].others_cpu_limits = 0.0;
        assert!(!has(
            &evaluate(&f, &set_on(&f, "envoy", Cpu, Limit, Some("200m"))),
            FindingCode::NoteCpuLimits
        ));
        // Over the node already, and a change that does not add to it.
        let mut f = facts();
        f.workload.containers[1] = container(
            "envoy",
            false,
            (Some("100m"), Some("200m")),
            (Some("64Mi"), Some("128Mi")),
        );
        for p in &mut f.pods {
            p.figures.cpu_limit = Some(700.0);
            p.figures.set_limits.cpu_millis = 700.0;
        }
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert!(!has(&e, FindingCode::NoteCpuLimits));

        let mut f = facts();
        f.workload.containers = vec![
            container(
                "api",
                false,
                (Some("500m"), Some("500m")),
                (Some("512Mi"), Some("512Mi")),
            ),
            container(
                "envoy",
                false,
                (Some("100m"), Some("100m")),
                (Some("128Mi"), Some("128Mi")),
            ),
        ];
        let e = evaluate(&f, &set_on(&f, "api", Memory, Request, Some("256Mi")));
        assert_eq!(
            only(&e, FindingCode::NoteQos),
            plain(
                FindingCode::NoteQos,
                Level::Note,
                "The pod's QoS class changes from Guaranteed to Burstable."
            )
        );
        let e = evaluate(&f, &request_and_limit_on(&f, "api", Memory, "768Mi"));
        assert!(!has(&e, FindingCode::NoteQos));
    }

    fn request_and_limit_on(
        f: &ResourceFacts,
        container: &str,
        resource: crate::limits::types::ResourceName,
        text: &str,
    ) -> Proposal {
        and(
            set_on(f, container, resource, Request, Some(text)),
            container,
            resource,
            Limit,
            Some(text),
        )
    }

    fn all_finite(n: &NodeProjection) -> bool {
        let pairs = [
            Some(n.cpu_requests),
            Some(n.memory_requests),
            Some(n.cpu_limits),
            Some(n.memory_limits),
            n.memory_if_full,
        ];
        pairs
            .iter()
            .flatten()
            .all(|p| p.before.is_finite() && p.after.is_finite())
    }

    #[test]
    fn a_node_without_allocatable_is_left_out_and_nothing_is_nan() {
        let mut f = crowded();
        let mut empty = node("aks-empty", (0.0, 0.0), 0.0, 0.0, 0.0);
        empty.allocatable = Amounts::default();
        let mut unreadable = node("aks-odd", (0.0, 0.0), 0.0, 0.0, 0.0);
        unreadable.allocatable.cpu_millis = f64::NAN;
        nodes_mut(&mut f).extend([empty, unreadable]);
        f.pods[2].node = Some("aks-empty".into());
        let e = evaluate(&f, &request_and_limit_on(&f, "api", Memory, "24Gi"));
        let names: Vec<_> = e.nodes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["aks-pool-1", "aks-pool-2"]);
        assert!(e.nodes.iter().all(all_finite));
        assert!(e.findings.iter().all(
            |x| x.node.as_deref() != Some("aks-empty") && x.node.as_deref() != Some("aks-odd")
        ));
        // The largest node is a real one.
        assert!(only(&e, FindingCode::W0)
            .message
            .contains("(largest: 16Gi)"));
        let json = serde_json::to_string(&e).expect("serialises");
        assert!(!json.contains("null,\"after\"") && !json.contains("NaN"));
        let back: Evaluation = serde_json::from_str(&json).expect("round-trips");
        assert_eq!(back, e);
        // No node that can be counted: no W0 against a largest of nothing.
        let mut f = facts();
        let mut empty = node("aks-empty", (0.0, 0.0), 0.0, 0.0, 0.0);
        empty.allocatable = Amounts::default();
        f.nodes = Fact::Known { value: vec![empty] };
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert!(!has(&e, FindingCode::W0));
        assert_eq!(e.nodes, []);
    }

    #[test]
    fn before_figures_come_from_the_pods_not_the_template() {
        let mut f = crowded();
        // api-1 still runs an older template with a 320Mi memory limit.
        f.pods[0].figures = PodFigures {
            memory_limit: Some(320.0 * MI),
            set_limits: Amounts {
                cpu_millis: 500.0,
                memory_bytes: 320.0 * MI,
            },
            ..f.pods[0].figures.clone()
        };
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        assert_eq!(
            only(&e, FindingCode::W2).message,
            "Memory limits on aks-pool-1 add up to 110% of what the node has (was 104%). Under memory pressure the node evicts pods."
        );
    }

    #[test]
    fn node_projection_lists_hosting_nodes_first_with_before_and_after() {
        let ba = |before: f64, after: f64| BeforeAfter { before, after };
        let e = evaluate(&facts(), &set("api", Memory, Limit, Some("768Mi")));
        assert_eq!(
            e.nodes,
            [
                NodeProjection {
                    name: "aks-pool-1".into(),
                    schedulable: true,
                    own_pods: 3,
                    cpu_requests: ba(51.0, 51.0),
                    memory_requests: ba(56.0, 56.0),
                    // 2000m of others and api's 500m in each pod; envoy has none and adds 0.
                    cpu_limits: ba(88.0, 88.0),
                    memory_limits: ba(80.0, 85.0),
                    memory_if_full: Some(ba(81.0, 88.0)),
                },
                NodeProjection {
                    name: "aks-pool-2".into(),
                    schedulable: true,
                    own_pods: 0,
                    cpu_requests: ba(50.0, 50.0),
                    memory_requests: ba(50.0, 50.0),
                    cpu_limits: ba(50.0, 50.0),
                    memory_limits: ba(50.0, 50.0),
                    memory_if_full: None,
                },
            ]
        );
        // A hosting node comes before the others whatever its name.
        let mut f = facts();
        for p in &mut f.pods {
            p.node = Some("aks-pool-2".into());
        }
        let mut cordoned = node("aks-pool-0", (0.0, 0.0), 0.0, 0.0, 0.0);
        cordoned.schedulable = false;
        nodes_mut(&mut f).push(cordoned);
        let e = evaluate(&f, &set_on(&f, "api", Memory, Limit, Some("768Mi")));
        let rows: Vec<_> = e
            .nodes
            .iter()
            .map(|n| (n.name.as_str(), n.own_pods, n.schedulable))
            .collect();
        assert_eq!(
            rows,
            [
                ("aks-pool-2", 3, true),
                ("aks-pool-0", 0, false),
                ("aks-pool-1", 0, true)
            ]
        );
    }

    #[test]
    fn warnings_are_sorted_w0_first_then_by_code() {
        let mut f = crowded();
        f.vpas = Fact::Known {
            value: vec![VpaFacts {
                name: "api-vpa".into(),
                update_mode: "Auto".into(),
            }],
        };
        hpa(&mut f, false, true);
        f.hpas = missing("not allowed to read HorizontalPodAutoscaler");
        let p = and(
            request_and_limit_on(&f, "api", Memory, "24Gi"),
            "api",
            Cpu,
            Limit,
            Some("300m"),
        );
        let e = evaluate(&f, &p);
        let order: Vec<_> = e.findings.iter().map(|x| (x.level, x.code)).collect();
        assert_eq!(
            order,
            [
                (Level::Warning, FindingCode::W0),
                (Level::Warning, FindingCode::W2),
                (Level::Warning, FindingCode::W3),
                (Level::Warning, FindingCode::W5),
                (Level::Warning, FindingCode::W8),
                (Level::NotChecked, FindingCode::W9),
            ]
        );
    }

    #[test]
    fn own_pod_facts_are_what_the_figures_say() {
        // A guard on the fixture the pinned numbers rest on.
        let f = facts();
        let p: &OwnPodFacts = &f.pods[0];
        assert_eq!(
            p.figures.request,
            Amounts {
                cpu_millis: 350.0,
                memory_bytes: 320.0 * MI
            }
        );
        assert_eq!(p.figures.memory_limit, Some(640.0 * MI));
        assert_eq!(p.figures.cpu_limit, None);
    }
}
