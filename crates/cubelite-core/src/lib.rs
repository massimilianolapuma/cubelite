pub mod client;
pub mod error;
pub mod kubeconfig;
pub mod resources;

pub use client::KubeClient;
pub use error::ConfigError;
pub use kubeconfig::{list_contexts, set_active_context, KubeConfig};
pub use resources::{DeploymentInfo, NamespaceInfo, PodInfo};
