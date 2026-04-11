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

    #[error("context '{name}' not found in kubeconfig")]
    ContextNotFound { name: String },

    #[error("failed to merge or load kubeconfig: {reason}")]
    MergeError { reason: String },

    #[error("kubernetes client error: {reason}")]
    ClientError { reason: String },

    #[error("I/O error: {source}")]
    Io {
        #[from]
        source: std::io::Error,
    },
}
