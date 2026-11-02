//! Line-based shell sessions in a pod over the Kubernetes exec API (#488).
//!
//! [`start_exec`] attaches to a command (by default `/bin/sh`) with stdin,
//! stdout and stderr and no TTY, like the native app's `PodExecView`: the
//! caller sends whole lines on [`ExecSession::input`] and receives output
//! split into lines on [`ExecSession::output`]. The output channel closes
//! when the remote command ends; a non-success exit adds a final
//! [`ExecChannel::Status`] line first.

use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use kube::api::AttachParams;
use kube::{Api, Client};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::error::KubeconfigError;

/// Where an output line came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecChannel {
    /// Standard output of the command.
    Stdout,
    /// Standard error of the command.
    Stderr,
    /// Session status reported by the API server (non-zero exit, errors).
    Status,
}

/// One line of output (without its trailing newline).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExecLine {
    /// Source channel.
    pub channel: ExecChannel,
    /// Line text, lossily decoded as UTF-8.
    pub text: String,
}

/// A running exec session.
pub struct ExecSession {
    /// Text written to the command's stdin as is (send `"ls\n"` for a line).
    pub input: mpsc::Sender<String>,
    /// Output lines; closed when the command ends.
    pub output: mpsc::Receiver<ExecLine>,
    /// Drives the session; aborting it ends the session.
    pub handle: JoinHandle<()>,
}

/// Starts `command` in `pod` (first container unless `container` is set).
///
/// # Errors
///
/// Returns [`KubeconfigError::ClientError`] when the exec connection cannot
/// be established (RBAC, missing pod or container, unreachable cluster).
pub async fn start_exec(
    client: Client,
    namespace: &str,
    pod: &str,
    container: Option<String>,
    command: Vec<String>,
) -> Result<ExecSession, KubeconfigError> {
    let client_error = |reason: String| KubeconfigError::ClientError { reason };
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let mut params = AttachParams::default()
        .stdin(true)
        .stdout(true)
        .stderr(true)
        .tty(false);
    if let Some(container) = container {
        params = params.container(container);
    }
    let mut process = api
        .exec(pod, command, &params)
        .await
        .map_err(|e| client_error(e.to_string()))?;
    let (Some(mut stdin), Some(stdout), Some(stderr), Some(status)) = (
        process.stdin(),
        process.stdout(),
        process.stderr(),
        process.take_status(),
    ) else {
        return Err(client_error("exec session has no stdio".to_string()));
    };

    let (input, mut input_rx) = mpsc::channel::<String>(64);
    let (output_tx, output) = mpsc::channel::<ExecLine>(1024);

    let handle = tokio::spawn(async move {
        let writer = tokio::spawn(async move {
            while let Some(text) = input_rx.recv().await {
                if stdin.write_all(text.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });
        tokio::join!(
            pump(stdout, ExecChannel::Stdout, output_tx.clone()),
            pump(stderr, ExecChannel::Stderr, output_tx.clone()),
        );
        if let Some(text) = status_line(status.await) {
            let _ = output_tx
                .send(ExecLine {
                    channel: ExecChannel::Status,
                    text,
                })
                .await;
        }
        writer.abort();
        drop(process);
    });

    Ok(ExecSession {
        input,
        output,
        handle,
    })
}

/// Forwards one output stream as lines until it ends or the receiver goes.
async fn pump<R: AsyncRead + Unpin>(
    mut reader: R,
    channel: ExecChannel,
    tx: mpsc::Sender<ExecLine>,
) {
    let mut lines = LineAssembler::default();
    let mut buf = vec![0u8; 8192];
    loop {
        let read = match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for text in lines.push(&buf[..read]) {
            if tx.send(ExecLine { channel, text }).await.is_err() {
                return;
            }
        }
    }
    if let Some(text) = lines.finish() {
        let _ = tx.send(ExecLine { channel, text }).await;
    }
}

/// Longest line kept before it is cut: output without newlines (a binary
/// file, `yes | tr -d '\\n'`) is emitted in pieces of this size instead of
/// growing the buffer without bound.
pub(crate) const MAX_LINE_BYTES: usize = 64 * 1024;

/// Splits a byte stream into lines across chunk boundaries (a UTF-8
/// sequence cut between chunks is decoded once complete). Lines longer than
/// [`MAX_LINE_BYTES`] are emitted in pieces.
#[derive(Debug, Default)]
pub(crate) struct LineAssembler {
    pending: Vec<u8>,
}

impl LineAssembler {
    /// Appends `bytes` and returns every line completed by them, without
    /// the `\n` (and a `\r` before it).
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                if self.pending.last() == Some(&b'\r') {
                    self.pending.pop();
                }
                lines.push(self.take());
            } else {
                self.pending.push(byte);
                if self.pending.len() >= MAX_LINE_BYTES {
                    lines.push(self.take());
                }
            }
        }
        lines
    }

    /// The trailing partial line, if any (the stream ended without `\n`).
    pub(crate) fn finish(&mut self) -> Option<String> {
        (!self.pending.is_empty()).then(|| self.take())
    }

    fn take(&mut self) -> String {
        let line = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&line).into_owned()
    }
}

/// Status line for a finished session: the server's message for a failure
/// (non-zero exit, command not found), nothing for success or no status.
pub(crate) fn status_line(status: Option<Status>) -> Option<String> {
    let status = status?;
    if status.status.as_deref() != Some("Failure") {
        return None;
    }
    status
        .message
        .filter(|m| !m.is_empty())
        .or(status.reason)
        .or_else(|| Some("command failed".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_assembler_joins_chunks_and_strips_line_endings() {
        let mut lines = LineAssembler::default();
        assert_eq!(lines.push(b"hel"), Vec::<String>::new());
        assert_eq!(lines.push(b"lo\nwor"), vec!["hello"]);
        assert_eq!(lines.push(b"ld\r\n\nlast"), vec!["world", ""]);
        assert_eq!(lines.finish(), Some("last".to_string()));
        assert_eq!(lines.finish(), None);
    }

    #[test]
    fn line_assembler_decodes_utf8_split_across_chunks() {
        let mut lines = LineAssembler::default();
        let bytes = "café\n".as_bytes();
        assert!(lines.push(&bytes[..4]).is_empty());
        assert_eq!(lines.push(&bytes[4..]), vec!["café"]);
    }

    #[test]
    fn line_assembler_cuts_lines_at_the_cap() {
        let mut lines = LineAssembler::default();
        let long = vec![b'x'; MAX_LINE_BYTES * 2 + 10];
        let out = lines.push(&long);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|l| l.len() == MAX_LINE_BYTES));
        assert_eq!(lines.push(b"\n"), vec!["x".repeat(10)]);
    }

    #[test]
    fn status_line_reports_failures_only() {
        let failure = Status {
            status: Some("Failure".to_string()),
            message: Some("command terminated with non-zero exit code: exit status 2".to_string()),
            reason: Some("NonZeroExitCode".to_string()),
            ..Default::default()
        };
        assert_eq!(
            status_line(Some(failure)).as_deref(),
            Some("command terminated with non-zero exit code: exit status 2")
        );
        let reason_only = Status {
            status: Some("Failure".to_string()),
            reason: Some("InternalError".to_string()),
            ..Default::default()
        };
        assert_eq!(
            status_line(Some(reason_only)).as_deref(),
            Some("InternalError")
        );
        let bare = Status {
            status: Some("Failure".to_string()),
            ..Default::default()
        };
        assert_eq!(status_line(Some(bare)).as_deref(), Some("command failed"));
        let success = Status {
            status: Some("Success".to_string()),
            ..Default::default()
        };
        assert_eq!(status_line(Some(success)), None);
        assert_eq!(status_line(None), None);
    }

    #[test]
    fn exec_line_serialises_with_lowercase_channel() {
        let line = ExecLine {
            channel: ExecChannel::Stderr,
            text: "oops".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&line).expect("json"),
            serde_json::json!({ "channel": "stderr", "text": "oops" })
        );
    }
}
