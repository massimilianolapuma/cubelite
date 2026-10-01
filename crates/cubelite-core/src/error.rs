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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kubeconfig_error_messages_name_the_cause() {
        let not_found = KubeconfigError::FileNotFound {
            path: "/tmp/missing".into(),
        };
        assert_eq!(
            not_found.to_string(),
            "kubeconfig file not found: /tmp/missing"
        );

        let merge = KubeconfigError::MergeError {
            reason: "duplicate context".into(),
        };
        assert_eq!(
            merge.to_string(),
            "failed to merge kubeconfig files: duplicate context"
        );

        let client = KubeconfigError::ClientError {
            reason: "no server".into(),
        };
        assert_eq!(client.to_string(), "kubernetes client error: no server");

        let watch = KubeconfigError::WatchError {
            reason: "stream closed".into(),
        };
        assert_eq!(watch.to_string(), "watch error: stream closed");
    }

    #[test]
    fn io_error_converts_into_kubeconfig_error() {
        let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let err: KubeconfigError = io.into();
        assert!(matches!(err, KubeconfigError::Io { .. }));
        assert_eq!(err.to_string(), "I/O error: denied");
    }

    #[test]
    fn yaml_error_converts_into_parse_error() {
        let yaml_err = serde_yaml::from_str::<serde_yaml::Value>("key: [unclosed")
            .expect_err("malformed YAML must fail to parse");
        let err: KubeconfigError = yaml_err.into();
        assert!(matches!(err, KubeconfigError::ParseError { .. }));
        assert!(err.to_string().starts_with("failed to parse kubeconfig: "));
    }

    #[test]
    fn context_error_not_found_quotes_the_name() {
        let err = ContextError::NotFound {
            name: "prod".into(),
        };
        assert_eq!(err.to_string(), "context 'prod' not found in kubeconfig");
    }

    #[test]
    fn context_error_is_transparent_over_kubeconfig_error() {
        let inner = KubeconfigError::FileNotFound { path: "/x".into() };
        let expected = inner.to_string();
        let err: ContextError = inner.into();
        assert!(matches!(err, ContextError::Kubeconfig(_)));
        assert_eq!(err.to_string(), expected);
    }
}
