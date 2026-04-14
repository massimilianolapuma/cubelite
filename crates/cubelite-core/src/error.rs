use thiserror::Error;

/// Errors that can occur while locating, loading, or parsing a kubeconfig file.
#[derive(Debug, Error)]
pub enum KubeconfigError {
    /// A required kubeconfig file path does not exist on disk.
    #[error("kubeconfig file not found: {path}")]
    FileNotFound { path: String },

    /// The YAML content of a kubeconfig file could not be deserialised.
    #[error("failed to parse kubeconfig: {source}")]
    ParseError {
        #[from]
        source: serde_yaml::Error,
    },

    /// Two or more kubeconfig files could not be merged.
    #[error("failed to merge kubeconfig files: {reason}")]
    MergeError { reason: String },

    /// A Kubernetes client could not be constructed from the config.
    #[error("kubernetes client error: {reason}")]
    ClientError { reason: String },

    /// An underlying I/O error occurred while reading or writing a kubeconfig.
    #[error("I/O error: {source}")]
    Io {
        #[from]
        source: std::io::Error,
    },

    /// An error was returned from a Kubernetes watch stream.
    #[error("watch error: {reason}")]
    WatchError { reason: String },
}

/// Errors that can occur during context selection or switching operations.
#[derive(Debug, Error)]
pub enum ContextError {
    /// The requested context name does not exist in the loaded kubeconfig(s).
    #[error("context '{name}' not found in kubeconfig")]
    NotFound { name: String },

    /// An error was propagated from a kubeconfig load or save operation.
    #[error(transparent)]
    Kubeconfig(#[from] KubeconfigError),
}
