//! Helpers shared by the integration tests.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

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
