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
pub mod error;
pub mod kubeconfig;
pub mod resources;
pub mod types;
pub mod watcher;

// Re-export the most commonly used items at the crate root.
pub use client::KubeClient;
pub use error::{ContextError, KubeconfigError};
pub use kubeconfig::KubeConfig;
pub use resources::{DeploymentInfo, NamespaceInfo, PodInfo};
pub use types::{
    ClusterDetails, ContextDetails, ContextInfo, KubeConfigFile, NamedCluster, NamedContext,
    NamedUser, UserDetails,
};
pub use watcher::{ResourceInfo, ResourceType, ResourceWatcher, WatchEvent};
