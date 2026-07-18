//! Local TCP port-forwarding to a pod via the Kubernetes port-forward API.
//!
//! [`forward_pod_port`] binds a local listener (`0` = OS-assigned port) and
//! relays every accepted connection through its own port-forward stream, so
//! one broken connection never takes down the session.

use k8s_openapi::api::core::v1::Pod;
use kube::{Api, Client};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// Binds the local listener for a forward session on 127.0.0.1.
///
/// `local_port == 0` lets the OS pick a free ephemeral port. A port
/// already in use surfaces as `AddrInUse` here, before any cluster I/O.
pub async fn bind_local(local_port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", local_port)).await
}

/// Starts forwarding `127.0.0.1:<local>` → `<pod>:<remote_port>`.
///
/// Returns the actually-bound local port and the accept-loop task handle.
/// Aborting the handle stops accepting new connections and drops the
/// listener; connections already established keep relaying until either
/// side closes.
pub async fn forward_pod_port(
    client: Client,
    namespace: String,
    pod: String,
    local_port: u16,
    remote_port: u16,
) -> std::io::Result<(u16, JoinHandle<()>)> {
    let listener = bind_local(local_port).await?;
    let bound = listener.local_addr()?.port();

    let handle = tokio::spawn(async move {
        let api: Api<Pod> = Api::namespaced(client, &namespace);
        loop {
            let Ok((mut conn, _)) = listener.accept().await else {
                break;
            };
            let api = api.clone();
            let pod = pod.clone();
            tokio::spawn(async move {
                let Ok(mut forwarder) = api.portforward(&pod, &[remote_port]).await else {
                    return;
                };
                let Some(mut upstream) = forwarder.take_stream(remote_port) else {
                    return;
                };
                let _ = tokio::io::copy_bidirectional(&mut conn, &mut upstream).await;
            });
        }
    });

    Ok((bound, handle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bind_local_zero_assigns_ephemeral_port() {
        let listener = bind_local(0).await.expect("bind should succeed");
        assert_ne!(listener.local_addr().unwrap().port(), 0);
    }

    #[tokio::test]
    async fn bind_local_taken_port_fails_with_addr_in_use() {
        let first = bind_local(0).await.expect("first bind should succeed");
        let port = first.local_addr().unwrap().port();

        let second = bind_local(port).await;

        assert_eq!(
            second.expect_err("second bind must fail").kind(),
            std::io::ErrorKind::AddrInUse
        );
    }
}
