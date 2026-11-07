//! Helpers shared by the integration tests.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::KubeClient;
use http::{Method, Request, Response, StatusCode};
use kube::client::Body;
use kube::Client;

/// Serves one canned HTTP response per connection and records the requests.
pub(crate) async fn mock_server(
    responses: Vec<(u16, String)>,
) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let handle = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in responses {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = vec![0u8; 16 * 1024];
            let mut read = 0;
            // Read headers and a JSON body (Content-Length) or none.
            loop {
                let n = socket.read(&mut buf[read..]).await.expect("read");
                read += n;
                let text = String::from_utf8_lossy(&buf[..read]).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if read >= end + 4 + len || n == 0 {
                        requests.push(text);
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.expect("write");
        }
        requests
    });
    (format!("http://{addr}"), handle)
}

/// An external Prometheus endpoint at `url`, without a cluster label.
pub(crate) fn prom_endpoint(url: &str) -> crate::prometheus::PromEndpoint {
    crate::prometheus::PromEndpoint {
        target: crate::prometheus::PromTarget::External { url: url.into() },
        cluster: None,
        grafana_url: None,
        grafana_datasource: None,
        grafana_service: None,
        skip_tls_verify: false,
        shared: false,
    }
}

/// A successful Prometheus API answer carrying `data`.
pub(crate) fn prom_success(data: serde_json::Value) -> (u16, String) {
    (
        200,
        serde_json::json!({ "status": "success", "data": data }).to_string(),
    )
}

/// A successful instant query answer.
pub(crate) fn prom_vector(result: serde_json::Value) -> (u16, String) {
    prom_success(serde_json::json!({ "resultType": "vector", "result": result }))
}

/// A successful range query answer.
pub(crate) fn prom_matrix(result: serde_json::Value) -> (u16, String) {
    prom_success(serde_json::json!({ "resultType": "matrix", "result": result }))
}

// --- A KubeClient against a mock apiserver (no network) ---

/// One request as the mock apiserver saw it.
pub(crate) struct Seen {
    pub method: Method,
    pub uri: String,
    pub content_type: Option<String>,
    /// The request's `Accept` header.
    pub accept: Option<String>,
    pub body: serde_json::Value,
}

/// A [`KubeClient`] backed by a mock apiserver that answers every
/// request with `respond(method, uri)`. The returned handle resolves to
/// the requests seen once the client is dropped.
pub(crate) fn mock_client(
    respond: impl Fn(&Method, &str) -> (StatusCode, serde_json::Value) + Send + 'static,
) -> (KubeClient, tokio::task::JoinHandle<Vec<Seen>>) {
    let (service, handle) = tower_test::mock::pair::<Request<Body>, Response<Body>>();
    let server = tokio::spawn(async move {
        let mut handle = std::pin::pin!(handle);
        let mut seen = Vec::new();
        while let Some((request, send)) = handle.next_request().await {
            let (parts, body) = request.into_parts();
            let bytes = body.collect_bytes().await.expect("request body");
            let (status, reply) = respond(&parts.method, &parts.uri.to_string());
            seen.push(Seen {
                method: parts.method,
                uri: parts.uri.to_string(),
                content_type: parts
                    .headers
                    .get(http::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string),
                accept: parts
                    .headers
                    .get(http::header::ACCEPT)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string),
                body: serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
            });
            let response = Response::builder()
                .status(status)
                .body(Body::from(serde_json::to_vec(&reply).expect("reply json")))
                .expect("response");
            send.send_response(response);
        }
        seen
    });
    (
        KubeClient::from_client(Client::new(service, "default")),
        server,
    )
}

pub(crate) async fn requests(
    client: KubeClient,
    server: tokio::task::JoinHandle<Vec<Seen>>,
) -> Vec<Seen> {
    drop(client);
    server.await.expect("mock apiserver")
}
