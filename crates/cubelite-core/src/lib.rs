pub mod error;
pub mod kubeconfig;

pub use error::ConfigError;
pub use kubeconfig::{KubeConfig, list_contexts, set_active_context};
