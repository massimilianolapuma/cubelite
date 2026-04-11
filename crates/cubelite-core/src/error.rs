use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("kubeconfig file not found: {path}")]
    FileNotFound { path: String },

    #[error("failed to parse kubeconfig: {source}")]
    ParseError {
        #[from]
        source: serde_yaml::Error,
    },

    #[error("context not found: {name}")]
    ContextNotFound { name: String },

    #[error("failed to merge kubeconfig files: {reason}")]
    MergeError { reason: String },

    #[error("I/O error: {source}")]
    Io {
        #[from]
        source: std::io::Error,
    },
}
