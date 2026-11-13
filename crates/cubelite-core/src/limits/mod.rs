//! Changing a Deployment's CPU and memory requests and limits, with a check
//! of what the cluster can hold (spec `2026-11-13-resource-limits-design`).
//!
//! | Module | Purpose |
//! |---|---|
//! | `types` | Every serialisable type; quantities as amounts, amounts as text |
//! | `manager` | Who manages a workload, from its labels and annotations |
//! | `mark` | The override annotation: parse, active or stale, next value |
//! | `pod_math` | Effective values, pod figures, QoS class |

pub mod manager;
pub mod mark;
pub mod pod_math;
pub mod types;

pub use manager::{detect_manager, ManagerInfo, ManagerKind};
pub use mark::{
    active_override, next_mark, parse_mark, OverrideContainer, OverrideInfo, OVERRIDE_ANNOTATION,
};
pub use pod_math::{effective, pod_figures, qos_class, Effective, EffectiveContainer};
pub use types::{
    fmt_amount, percent, Amounts, LimitRangeFacts, LimitRangeItemFacts, PairText, PerResource,
    PodFigures, ResourceField, ResourceName, ResourceTexts,
};
