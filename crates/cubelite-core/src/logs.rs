//! Pod log streaming with lightweight level/timestamp parsing.
//!
//! [`stream_pod_logs`] follows a single pod's log and yields [`LogLine`]
//! items; callers aggregate multiple pods by merging streams. Lines are
//! requested with `timestamps=true` so each line carries an RFC 3339 prefix
//! that is split off into [`LogLine::time`].

use std::pin::Pin;

use futures::{AsyncBufReadExt, Stream, StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::{api::LogParams, Api, Client};
use serde::{Deserialize, Serialize};

/// Severity bucket for a log line (UI filter chips: INFO / WARN / ERROR).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    /// Informational output (default when no marker is found).
    Info,
    /// Warning markers (`WARN`, `WARNING`).
    Warn,
    /// Error markers (`ERROR`, `ERR:`, `FATAL`, `PANIC`).
    Error,
}

/// A single parsed log line from one pod.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    /// Pod name the line came from.
    pub pod: String,
    /// Namespace of the pod.
    pub namespace: String,
    /// RFC 3339 timestamp from the kubelet prefix, when present.
    pub time: Option<String>,
    /// Detected severity.
    pub level: LogLevel,
    /// Message with the timestamp prefix stripped.
    pub message: String,
}

/// Detect the severity of a raw message via common level markers.
fn detect_level(message: &str) -> LogLevel {
    let upper = message.to_uppercase();
    if ["ERROR", "ERR:", "FATAL", "PANIC"]
        .iter()
        .any(|m| upper.contains(m))
    {
        LogLevel::Error
    } else if upper.contains("WARN") {
        LogLevel::Warn
    } else {
        LogLevel::Info
    }
}

/// Parse a raw kubelet log line (with `timestamps=true` prefix) into a
/// [`LogLine`], splitting the RFC 3339 prefix when present.
pub fn parse_log_line(pod: &str, namespace: &str, raw: &str) -> LogLine {
    let (time, message) = match raw.split_once(' ') {
        Some((first, rest)) if k8s_openapi::chrono::DateTime::parse_from_rfc3339(first).is_ok() => {
            (Some(first.to_string()), rest)
        }
        _ => (None, raw),
    };

    LogLine {
        pod: pod.to_string(),
        namespace: namespace.to_string(),
        time,
        level: detect_level(message),
        message: message.to_string(),
    }
}

/// Follow one pod's logs as a stream of parsed [`LogLine`] items.
///
/// The stream opens the connection lazily; a failure to open yields a single
/// [`LogLevel::Error`] line describing the problem, then ends. Read errors
/// end the stream silently (the pod likely terminated).
pub fn stream_pod_logs(
    client: Client,
    namespace: String,
    pod: String,
    tail_lines: i64,
) -> Pin<Box<dyn Stream<Item = LogLine> + Send>> {
    Box::pin(
        futures::stream::once(async move {
            let api: Api<Pod> = Api::namespaced(client, &namespace);
            let params = LogParams {
                follow: true,
                timestamps: true,
                tail_lines: Some(tail_lines),
                ..Default::default()
            };

            match api.log_stream(&pod, &params).await {
                Ok(reader) => {
                    let ns = namespace.clone();
                    let pod_name = pod.clone();
                    reader
                        .lines()
                        .map_ok(move |raw| parse_log_line(&pod_name, &ns, &raw))
                        .filter_map(|res| async move { res.ok() })
                        .boxed()
                }
                Err(e) => futures::stream::once(async move {
                    LogLine {
                        pod: pod.clone(),
                        namespace: namespace.clone(),
                        time: None,
                        level: LogLevel::Error,
                        message: format!("failed to stream logs: {e}"),
                    }
                })
                .boxed(),
            }
        })
        .flatten(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_strips_rfc3339_prefix() {
        let line = parse_log_line(
            "api-0",
            "default",
            "2026-07-11T10:00:00.123456789Z listening on :8080",
        );
        assert_eq!(line.time.as_deref(), Some("2026-07-11T10:00:00.123456789Z"));
        assert_eq!(line.message, "listening on :8080");
        assert_eq!(line.level, LogLevel::Info);
        assert_eq!(line.pod, "api-0");
    }

    #[test]
    fn parse_without_timestamp_keeps_message() {
        let line = parse_log_line("api-0", "default", "plain output");
        assert!(line.time.is_none());
        assert_eq!(line.message, "plain output");
    }

    #[test]
    fn detects_levels_case_insensitively() {
        assert_eq!(detect_level("some ERROR happened"), LogLevel::Error);
        assert_eq!(detect_level("panic: index out of range"), LogLevel::Error);
        assert_eq!(detect_level("warning: deprecated flag"), LogLevel::Warn);
        assert_eq!(detect_level("all good"), LogLevel::Info);
    }

    #[test]
    fn log_level_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&LogLevel::Warn).expect("serialize"),
            "\"warn\""
        );
        let line = parse_log_line("p", "ns", "ERROR boom");
        let json = serde_json::to_value(&line).expect("serialize");
        assert_eq!(json["level"], "error");
        assert_eq!(json["pod"], "p");
    }
}
