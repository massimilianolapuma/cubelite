//! The serialisable types of a change of requests and limits, and the
//! helpers every part of it shares: reading a quantity as an amount, writing
//! an amount as the desktop does, and a percentage that is always finite.

use serde::{Deserialize, Serialize};

use crate::metrics::{parse_cpu_millis, parse_memory_bytes};
use crate::resources::{ContainerResourcesInfo, QuantityInfo};

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
    let exact = part / total * 100.0;
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
