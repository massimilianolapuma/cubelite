//! # cubelite-core
//!
//! Core Kubernetes context management library for CubeLite.
//!
//! ## Modules
//!
//! | Module | Purpose |
//! |---|---|
//! | [`kubeconfig`] | Load and manipulate kubeconfig files |
//! | [`context`]    | List and switch Kubernetes contexts |
//! | [`client`]     | Async `kube-rs` client wrapper |
//! | [`resources`]  | Lightweight resource info types |
//! | [`types`]      | Domain types mirroring the kubeconfig spec |
//! | [`error`]      | Error types: [`KubeconfigError`], [`ContextError`] |
//! | [`watcher`]    | Watch streaming for Kubernetes resources |
//!
//! ## Quick Start
//!
//! ```no_run
//! use cubelite_core::{context, KubeconfigError};
//!
//! // List all available contexts.
//! let names = context::list_contexts()?;
//! println!("{names:?}");
//!
//! // Switch to a specific context (persists to disk).
//! context::set_active_context("my-cluster")?;
//! # Ok::<(), cubelite_core::error::ContextError>(())
//! ```

pub mod client;
pub mod context;
pub mod dynamic;
pub mod elastic;
pub mod error;
pub mod exec;
pub mod helm;
pub mod integration;
pub mod kubeconfig;
pub mod logs;
pub mod metrics;
pub mod portforward;
pub mod prometheus;
pub mod resources;
pub mod types;
pub mod watcher;

#[cfg(test)]
mod test_support;

// Re-export the most commonly used items at the crate root.
pub use client::KubeClient;
pub use dynamic::{ResourceKindInfo, ResourceRef, ResourceTable, TableColumn, TableRow};
pub use error::{ContextError, KubeconfigError};
pub use helm::HelmReleaseInfo;
pub use kubeconfig::{discover_kubeconfig_files, is_kubeconfig_file, KubeConfig};
pub use logs::{LogLevel, LogLine};
pub use metrics::{ContainerUsageInfo, NodeCapacityInfo, PodMetricsInfo};
pub use resources::{
    ConfigMapInfo, ContainerDetail, CronJobInfo, DeploymentInfo, EventInfo, IngressInfo, JobInfo,
    NamespaceInfo, NodeInfo, PodInfo, PvcInfo, SecretInfo, ServiceInfo, StatefulSetInfo,
    WorkloadRef,
};
pub use types::{
    ClusterDetails, ContextDetails, ContextInfo, KubeConfigFile, KubeconfigSource, NamedCluster,
    NamedContext, NamedUser, UserDetails,
};
pub use watcher::{ResourceInfo, ResourceType, ResourceWatcher, WatchEvent};
