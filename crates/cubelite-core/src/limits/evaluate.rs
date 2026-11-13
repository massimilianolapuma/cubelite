//! The check of a change of requests and limits (spec §4): pure, the same
//! for the editor and inside the apply.

use std::collections::BTreeMap;

use super::mark::active_override;
use super::pod_math::{admission_sum, effective, pod_figures, EffectiveContainer};
use super::types::{
    fmt_amount, same_amount, same_value, Change, Evaluation, Finding, FindingCode, Level,
    LimitRangeFacts, PodFigures, Proposal, ProposalKind, ResourceFacts, ResourceField,
    ResourceName, ResourceTexts, FIELDS,
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
        let new = after.figures(facts);
        check_limit_under_request(&mut out, &after, &zero_limits);
        if let Some(limit_ranges) = facts.limit_ranges.known() {
            check_limit_ranges(&mut out, &after, limit_ranges);
        }
        check_quotas(&mut out, facts, &new);
    }

    sort_findings(&mut out.findings);
    out
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
            if above(need, room.free) {
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
        assert_eq!(e.findings, [refused.clone()]);
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
            order[..3],
            [
                (Level::Blocked, FindingCode::B3),
                (Level::Blocked, FindingCode::B5),
                (Level::Warning, FindingCode::MilliMemory)
            ]
        );
        assert!(e.findings[3..].iter().all(|x| x.level != Level::Blocked));
    }
}
