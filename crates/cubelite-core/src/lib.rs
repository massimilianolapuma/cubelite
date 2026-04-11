pub mod client;
pub mod error;
pub mod kubeconfig;
pub mod resources;

pub use client::KubeClient;
pub use error::ConfigError;
pub use kubeconfig::{KubeConfig, list_contexts, set_active_context};
pub use resources::{DeploymentInfo, NamespaceInfo, PodInfo};
