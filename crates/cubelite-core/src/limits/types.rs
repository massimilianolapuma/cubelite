//! The serialisable types of a change of requests and limits, and the
//! helpers every part of it shares: reading a quantity as an amount, writing
//! an amount as the desktop does, and a percentage that is always finite.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::manager::ManagerInfo;
use crate::metrics::{parse_cpu_millis, parse_memory_bytes, ContainerUsageInfo};
use crate::resources::{ContainerResourcesInfo, QuantityInfo, TemplateContainerInfo};

/// A resource a request or a limit is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceName {
    /// CPU, amounts in millicores.
    Cpu,
    /// Memory, amounts in bytes.
    Memory,
}

/// Which of the two values of a resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceField {
    /// `resources.requests`.
    Request,
    /// `resources.limits`.
    Limit,
}

impl ResourceName {
    /// Millicores for CPU, bytes for memory. None when unreadable or negative.
    pub fn parse(self, text: &str) -> Option<f64> {
        match self {
            ResourceName::Cpu => parse_cpu_millis(text),
            ResourceName::Memory => parse_memory_bytes(text).map(|b| b as f64),
        }
    }

    /// The word for the resource inside a sentence.
    pub(crate) fn word(self) -> &'static str {
        match self {
            ResourceName::Cpu => "CPU",
            ResourceName::Memory => "memory",
        }
    }
}

/// `Math.round` of JavaScript: halves go up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// Same output as `formatCpu` / `formatBytes` of apps/desktop/src/lib/units.ts for the same amount.
pub fn fmt_amount(resource: ResourceName, amount: f64) -> String {
    let amount = if amount.is_finite() { amount } else { 0.0 };
    match resource {
        ResourceName::Cpu => {
            let rounded = js_round(amount);
            if rounded < 1000.0 {
                return format!("{rounded}m");
            }
            let cores = js_round(amount / 10.0) / 100.0;
            if cores.fract() == 0.0 {
                format!("{cores}")
            } else {
                // `toFixed(2)` of a value that already has two decimals.
                format!("{cores:.2}")
            }
        }
        ResourceName::Memory => {
            const UNITS: [&str; 5] = ["B", "Ki", "Mi", "Gi", "Ti"];
            let mut value = amount;
            let mut unit = 0;
            while value >= 1024.0 && unit < UNITS.len() - 1 {
                value /= 1024.0;
                unit += 1;
            }
            let shown = if value >= 10.0 || value.fract() == 0.0 {
                format!("{}", js_round(value))
            } else {
                // `toFixed(1)`: a tie goes up, where Rust's `{:.1}` goes to even.
                let tenths = js_round(value * 10.0);
                format!("{:.1}", tenths / 10.0)
            };
            format!("{shown}{}", UNITS[unit])
        }
    }
}

/// Rounded percent of `total`; 0 when total <= 0; a value above 100 never reads 100 (it reads 101).
pub fn percent(part: f64, total: f64) -> f64 {
    if total <= 0.0 || !part.is_finite() || !total.is_finite() {
        return 0.0;
    }
    let exact = part * 100.0 / total;
    let rounded = exact.round();
    if exact > 100.0 && rounded <= 100.0 {
        101.0
    } else {
        rounded
    }
}

/// The request and the limit of one resource, as text; `None` is not set.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PairText {
    /// The request, as typed or as the cluster wrote it.
    #[serde(default)]
    pub request: Option<String>,
    /// The limit, as typed or as the cluster wrote it.
    #[serde(default)]
    pub limit: Option<String>,
}

impl PairText {
    /// The text of one of the two values.
    pub fn get(&self, field: ResourceField) -> Option<&str> {
        match field {
            ResourceField::Request => self.request.as_deref(),
            ResourceField::Limit => self.limit.as_deref(),
        }
    }

    /// Replaces one of the two values.
    pub fn set(&mut self, field: ResourceField, text: Option<String>) {
        match field {
            ResourceField::Request => self.request = text,
            ResourceField::Limit => self.limit = text,
        }
    }
}

/// The four values of a container, as text.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ResourceTexts {
    /// CPU request and limit.
    #[serde(default)]
    pub cpu: PairText,
    /// Memory request and limit.
    #[serde(default)]
    pub memory: PairText,
}

impl ResourceTexts {
    /// The pair of one resource.
    pub fn pair(&self, resource: ResourceName) -> &PairText {
        match resource {
            ResourceName::Cpu => &self.cpu,
            ResourceName::Memory => &self.memory,
        }
    }

    /// The pair of one resource, to change it.
    pub fn pair_mut(&mut self, resource: ResourceName) -> &mut PairText {
        match resource {
            ResourceName::Cpu => &mut self.cpu,
            ResourceName::Memory => &mut self.memory,
        }
    }

    /// One of the four values.
    pub fn get(&self, resource: ResourceName, field: ResourceField) -> Option<&str> {
        self.pair(resource).get(field)
    }

    /// Whether every value equals the other's as an amount (see [`same_value`]).
    pub fn same_amounts(&self, other: &ResourceTexts) -> bool {
        FIELDS
            .iter()
            .all(|&(r, f)| same_value(r, self.get(r, f), other.get(r, f)))
    }
}

/// The four values in the order changes are listed: CPU before memory,
/// request before limit.
pub(crate) const FIELDS: [(ResourceName, ResourceField); 4] = [
    (ResourceName::Cpu, ResourceField::Request),
    (ResourceName::Cpu, ResourceField::Limit),
    (ResourceName::Memory, ResourceField::Request),
    (ResourceName::Memory, ResourceField::Limit),
];

impl From<&ContainerResourcesInfo> for ResourceTexts {
    fn from(r: &ContainerResourcesInfo) -> Self {
        let text = |q: &Option<QuantityInfo>| q.as_ref().map(|q| q.text.clone());
        ResourceTexts {
            cpu: PairText {
                request: text(&r.cpu.request),
                limit: text(&r.cpu.limit),
            },
            memory: PairText {
                request: text(&r.memory.request),
                limit: text(&r.memory.limit),
            },
        }
    }
}

/// Two amounts are the same when they differ by less than a billionth.
pub(crate) fn same_amount(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0)
}

/// Whether two values of a resource are the same: both unset, both parse to
/// the same amount, or neither parses and the texts are equal.
pub(crate) fn same_value(resource: ResourceName, a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => match (resource.parse(a), resource.parse(b)) {
            (Some(x), Some(y)) => same_amount(x, y),
            (None, None) => a == b,
            _ => false,
        },
        _ => false,
    }
}

/// A CPU amount and a memory amount.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Amounts {
    /// Millicores.
    pub cpu_millis: f64,
    /// Bytes.
    pub memory_bytes: f64,
}

impl Amounts {
    /// The amount of one resource.
    pub fn get(&self, resource: ResourceName) -> f64 {
        match resource {
            ResourceName::Cpu => self.cpu_millis,
            ResourceName::Memory => self.memory_bytes,
        }
    }
}

/// A pod's figures as the scheduler computes them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PodFigures {
    /// The pod's requests (an unset request counts 0).
    pub request: Amounts,
    /// The pod's CPU limit; `None` when a container has no CPU limit.
    pub cpu_limit: Option<f64>,
    /// The pod's memory limit; `None` when a container has no memory limit.
    pub memory_limit: Option<f64>,
    /// The pod's limits as a node adds them up (what `kubectl describe
    /// node` shows): the same walk, a container without a limit counting 0;
    /// 0 when no container sets one.
    pub set_limits: Amounts,
}

impl PodFigures {
    /// The pod's limit of one resource.
    pub fn limit(&self, resource: ResourceName) -> Option<f64> {
        match resource {
            ResourceName::Cpu => self.cpu_limit,
            ResourceName::Memory => self.memory_limit,
        }
    }
}

/// An optional amount per resource.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PerResource {
    /// Millicores (or, for a ratio, the plain number).
    pub cpu: Option<f64>,
    /// Bytes (or, for a ratio, the plain number).
    pub memory: Option<f64>,
}

impl PerResource {
    /// The value of one resource.
    pub fn get(&self, resource: ResourceName) -> Option<f64> {
        match resource {
            ResourceName::Cpu => self.cpu,
            ResourceName::Memory => self.memory,
        }
    }
}

/// One item of a LimitRange, its amounts parsed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LimitRangeItemFacts {
    /// `"Container"` or `"Pod"` (the item's `type`).
    pub kind: String,
    /// Minimum request (and limit).
    pub min: PerResource,
    /// Maximum limit (and request).
    pub max: PerResource,
    /// Default limit.
    pub default: PerResource,
    /// Default request.
    pub default_request: PerResource,
    /// Maximum limit / request ratio, a plain number.
    pub max_ratio: PerResource,
}

/// A LimitRange of the namespace.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LimitRangeFacts {
    /// Its name.
    pub name: String,
    /// Its items, in spec order.
    pub items: Vec<LimitRangeItemFacts>,
}

/// A part of the facts that may be missing, with the reason in the user's terms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Fact<T> {
    /// Read.
    Known {
        /// What was read.
        value: T,
    },
    /// Not read.
    Missing {
        /// Why, in the user's terms.
        reason: String,
    },
}

impl<T> Fact<T> {
    /// The value, when known.
    pub fn known(&self) -> Option<&T> {
        match self {
            Fact::Known { value } => Some(value),
            Fact::Missing { .. } => None,
        }
    }
}

/// How the Deployment rolls out, its counts already resolved.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RolloutFacts {
    /// Strategy `Recreate`: every old pod stops before a new one starts.
    pub recreate: bool,
    /// Pods above the replica count during a rolling update.
    pub max_surge: i32,
    /// Pods below the replica count during a rolling update.
    pub max_unavailable: i32,
}

/// The Deployment itself.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkloadFacts {
    /// Namespace.
    pub namespace: String,
    /// Name.
    pub name: String,
    /// `metadata.resourceVersion`.
    pub resource_version: Option<String>,
    /// `metadata.generation`.
    pub generation: i64,
    /// Wanted replicas.
    pub replicas: i32,
    /// The rollout strategy.
    pub rollout: RolloutFacts,
    /// Regular containers, spec order.
    pub containers: Vec<TemplateContainerInfo>,
    /// Every init container, spec order; `sidecar` set.
    pub init_containers: Vec<TemplateContainerInfo>,
    /// The pod overhead of the template (from a running pod), zero without one.
    pub overhead: Amounts,
    /// Who manages the Deployment.
    pub manager: ManagerInfo,
    /// The override annotation as read, whatever it holds.
    pub override_annotation: Option<String>,
}

/// What the editor saw, sent back with the apply (spec §6.1).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SeenState {
    /// `metadata.generation`.
    pub generation: i64,
    /// Every container of the template, init included, by name.
    pub resources: BTreeMap<String, ContainerResourcesInfo>,
    /// The override annotation.
    pub override_annotation: Option<String>,
}

/// One pod of the workload.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OwnPodFacts {
    /// Pod name.
    pub name: String,
    /// The node it runs on.
    pub node: Option<String>,
    /// Its figures, from its own spec.
    pub figures: PodFigures,
    /// Usage per container; empty when there is no sample.
    pub usage: Vec<ContainerUsageInfo>,
}

/// One node of the cluster.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NodeFacts {
    /// Node name.
    pub name: String,
    /// Ready and not cordoned.
    pub schedulable: bool,
    /// Allocatable CPU and memory.
    pub allocatable: Amounts,
    /// Requests of the pods on it that are not this workload's.
    pub others_requests: Amounts,
    /// CPU limits of those pods, their `set_limits` (a container without one adds 0).
    pub others_cpu_limits: f64,
    /// Memory limits of those pods, their `set_limits` (a container without one adds 0).
    pub others_memory_limits: f64,
    /// Memory in use, from metrics-server; `None` without a sample.
    pub memory_used: Option<f64>,
}

/// A ResourceQuota of the namespace, its amounts parsed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct QuotaFacts {
    /// Its name.
    pub name: String,
    /// It has `scopes` or a `scopeSelector`.
    pub scoped: bool,
    /// Hard limits, by key (only the six keys of spec B5).
    pub hard: BTreeMap<String, f64>,
    /// Usage, by key.
    pub used: BTreeMap<String, f64>,
}

/// A HorizontalPodAutoscaler that targets the Deployment.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HpaFacts {
    /// Its name.
    pub name: String,
    /// It scales on CPU utilisation.
    pub cpu_utilization: bool,
    /// It scales on memory utilisation.
    pub memory_utilization: bool,
}

/// A VerticalPodAutoscaler that targets the Deployment.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VpaFacts {
    /// Its name.
    pub name: String,
    /// `spec.updatePolicy.updateMode`.
    pub update_mode: String,
}

/// Everything a change of requests and limits is checked against.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResourceFacts {
    /// The Deployment.
    pub workload: WorkloadFacts,
    /// What the editor saw.
    pub seen: SeenState,
    /// Its pods that are not finished.
    pub pods: Vec<OwnPodFacts>,
    /// Known when metrics-server answered.
    pub usage: Fact<()>,
    /// The nodes of the cluster.
    pub nodes: Fact<Vec<NodeFacts>>,
    /// The LimitRanges of the namespace.
    pub limit_ranges: Fact<Vec<LimitRangeFacts>>,
    /// The ResourceQuotas of the namespace.
    pub quotas: Fact<Vec<QuotaFacts>>,
    /// The HorizontalPodAutoscalers that target the Deployment.
    pub hpas: Fact<Vec<HpaFacts>>,
    /// The VerticalPodAutoscalers that target the Deployment.
    pub vpas: Fact<Vec<VpaFacts>>,
}

/// What a proposal asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalKind {
    /// New values for the listed containers.
    Adjust,
    /// The original values of the active override mark.
    Restore,
}

/// The four values wanted for one container.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ContainerProposal {
    /// Container name.
    pub name: String,
    /// The four values wanted.
    pub resources: ResourceTexts,
}

/// A change the user asks for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Proposal {
    /// Adjust or restore.
    pub kind: ProposalKind,
    /// The containers and their wanted values; ignored for a restore.
    pub containers: Vec<ContainerProposal>,
}

/// How serious a finding is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    /// The cluster would refuse it: cannot be applied.
    Blocked,
    /// Risky: shown with numbers, the user decides.
    Warning,
    /// A check that could not run.
    NotChecked,
    /// Shown, asks for nothing.
    Note,
}

/// Which rule a finding comes from (spec §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingCode {
    /// Not a valid quantity.
    B1,
    /// A limit of zero.
    B2,
    /// A limit under its request.
    B3,
    /// A LimitRange violated.
    B4,
    /// A ResourceQuota exceeded.
    B5,
    /// A value removed by an adjust.
    Cleared,
    /// A container that cannot be changed here.
    UnknownContainer,
    /// A restore with no active mark.
    NoOverride,
    /// Above every node.
    W0,
    /// Fewer replicas have room than wanted.
    W1,
    /// The rollout may stall on room.
    W1r,
    /// Memory limits above a node.
    W2,
    /// Full limits run a node out of memory.
    W3,
    /// A memory limit under current usage.
    W4,
    /// A CPU limit under current usage.
    W5,
    /// The rollout may stall on a quota.
    W6,
    /// A HorizontalPodAutoscaler on utilisation.
    W7,
    /// A VerticalPodAutoscaler that rewrites the values.
    W8,
    /// Memory typed with the suffix `m`.
    MilliMemory,
    /// Not checked.
    W9,
    /// Every replica has room.
    NoteFits,
    /// CPU limits above a node's CPU.
    NoteCpuLimits,
    /// The QoS class changes.
    NoteQos,
    /// No pod is running.
    NoteNoPods,
}

/// One finding of the check, with its sentence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    /// The rule.
    pub code: FindingCode,
    /// How serious it is.
    pub level: Level,
    /// The sentence, with the numbers.
    pub message: String,
    /// The container it is about.
    pub container: Option<String>,
    /// The resource it is about.
    pub resource: Option<ResourceName>,
    /// The field it is about.
    pub field: Option<ResourceField>,
    /// The node it is about.
    pub node: Option<String>,
}

/// One field the proposal changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Change {
    /// Container name.
    pub container: String,
    /// The container is a native sidecar (it goes under `initContainers`).
    pub sidecar: bool,
    /// CPU or memory.
    pub resource: ResourceName,
    /// Request or limit.
    pub field: ResourceField,
    /// The cluster's text.
    pub before: Option<String>,
    /// The wanted text; `None` removes the value.
    pub after: Option<String>,
}

/// A percent of a node's allocatable, before and after the change.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct BeforeAfter {
    /// Before the change.
    pub before: f64,
    /// After the change.
    pub after: f64,
}

/// One node, before and after the change.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NodeProjection {
    /// Node name.
    pub name: String,
    /// Ready and not cordoned.
    pub schedulable: bool,
    /// Pods of the workload on it now.
    pub own_pods: i32,
    /// CPU requests, percent of allocatable.
    pub cpu_requests: BeforeAfter,
    /// Memory requests, percent of allocatable.
    pub memory_requests: BeforeAfter,
    /// CPU limits, percent of allocatable.
    pub cpu_limits: BeforeAfter,
    /// Memory limits, percent of allocatable.
    pub memory_limits: BeforeAfter,
    /// Memory in use now, and if the workload's pods used their full limit.
    pub memory_if_full: Option<BeforeAfter>,
}

/// The outcome of the check.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Evaluation {
    /// Findings, worst first.
    pub findings: Vec<Finding>,
    /// What changes, in template order.
    pub changes: Vec<Change>,
    /// The nodes, hosting ones first.
    pub nodes: Vec<NodeProjection>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_compare_amounts() {
        assert_eq!(
            ResourceName::Memory.parse("1024Mi"),
            ResourceName::Memory.parse("1Gi")
        );
        assert_ne!(
            ResourceName::Memory.parse("1G"),
            ResourceName::Memory.parse("1Gi")
        );
        assert_eq!(
            ResourceName::Cpu.parse("0.5"),
            ResourceName::Cpu.parse("500m")
        );
        assert_eq!(ResourceName::Cpu.parse("-1"), None);
        assert_eq!(ResourceName::Memory.parse("abc"), None);
        assert_eq!(ResourceName::Cpu.parse("250m"), Some(250.0));
        assert_eq!(ResourceName::Memory.parse("1Ki"), Some(1024.0));
    }

    #[test]
    fn same_value_compares_amounts_then_texts() {
        use ResourceName::*;
        assert!(same_value(Memory, Some("1024Mi"), Some("1Gi")));
        assert!(!same_value(Memory, Some("1G"), Some("1Gi")));
        assert!(same_value(Cpu, None, None));
        assert!(!same_value(Cpu, Some("1"), None));
        assert!(same_value(Cpu, Some("abc"), Some("abc")));
        assert!(!same_value(Cpu, Some("abc"), Some("1")));
    }

    #[test]
    fn fmt_amount_matches_the_desktop_formatters() {
        use ResourceName::*;
        // The cases of apps/desktop/src/lib/units.test.ts.
        assert_eq!(fmt_amount(Cpu, 250.0), "250m");
        assert_eq!(fmt_amount(Cpu, 1.4), "1m");
        assert_eq!(fmt_amount(Cpu, 1000.0), "1");
        assert_eq!(fmt_amount(Cpu, 1250.0), "1.25");
        assert_eq!(fmt_amount(Cpu, 999.4), "999m");
        assert_eq!(fmt_amount(Cpu, 15999.7), "16");
        assert_eq!(fmt_amount(Memory, 512.0), "512B");
        assert_eq!(fmt_amount(Memory, 2048.0), "2Ki");
        assert_eq!(fmt_amount(Memory, 96.0 * 1024.0 * 1024.0), "96Mi");
        // The plan's cases.
        assert_eq!(fmt_amount(Cpu, 412.0), "412m");
        assert_eq!(fmt_amount(Cpu, 1500.0), "1.50");
        assert_eq!(fmt_amount(Cpu, 2000.0), "2");
        assert_eq!(fmt_amount(Cpu, 999.6), "1");
        assert_eq!(fmt_amount(Memory, 805306368.0), "768Mi");
        assert_eq!(fmt_amount(Memory, 1610612736.0), "1.5Gi");
        assert_eq!(fmt_amount(Memory, 17179869184.0), "16Gi");
        assert_eq!(fmt_amount(Memory, 25834815488.0), "24Gi");
        // `toFixed(1)` rounds a tie up: 1.25Gi is "1.3Gi", not "1.2Gi".
        assert_eq!(fmt_amount(Memory, 1.25 * 1024.0 * 1024.0 * 1024.0), "1.3Gi");
        assert_eq!(fmt_amount(Memory, f64::NAN), "0B");
    }

    #[test]
    fn percent_is_finite_and_never_rounds_an_excess_down_to_100() {
        assert_eq!(percent(1.0, 0.0), 0.0);
        assert_eq!(percent(100.29, 100.0), 101.0);
        assert_eq!(percent(80.47, 100.0), 80.0);
        assert_eq!(percent(f64::NAN, 100.0), 0.0);
        assert_eq!(percent(1.0, f64::NAN), 0.0);
        assert_eq!(percent(50.0, -1.0), 0.0);
    }
}
