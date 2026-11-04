//! Open integration connections per (kubeconfig, context), reused while the
//! endpoint is unchanged (an in-cluster connection may hold a port-forward),
//! and the port-forwards to in-cluster web UIs (Kibana, Grafana).

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use cubelite_core::integration::{self, ServiceRef, ServiceTunnel, TunnelError};
use tokio::sync::Mutex;

use super::elastic::kube;

/// Cache key: the same context name can exist in two kubeconfig files.
pub(crate) type ConnKey = (String, String);

pub(crate) struct ConnCache<E, C> {
    map: Mutex<HashMap<ConnKey, (E, Arc<C>)>>,
    /// Bumped by `forget`/`clear` (credentials saved, disconnect): a
    /// connection opened before is never cached (#528).
    generation: AtomicU64,
}

impl<E, C> Default for ConnCache<E, C> {
    fn default() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
        }
    }
}

impl<E: Clone + PartialEq, C> ConnCache<E, C> {
    /// The cached connection for `key` and `endpoint`, or a new one from
    /// `connect`. The lock is never held while connecting (port-forward,
    /// kube API calls, keychain), so one slow cluster cannot block others.
    /// A connection opened across a `forget`/`clear` (its credentials may
    /// be stale) is dropped and opened again, once.
    pub(crate) async fn get_or_connect<F, Fut>(
        &self,
        key: &ConnKey,
        endpoint: &E,
        connect: F,
    ) -> Result<Arc<C>, String>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<C, String>>,
    {
        for _ in 0..2 {
            let generation = {
                let map = self.map.lock().await;
                if let Some((_, conn)) = map.get(key).filter(|(e, _)| e == endpoint) {
                    return Ok(conn.clone());
                }
                self.generation.load(Ordering::SeqCst)
            };
            let fresh = Arc::new(connect().await?);
            let mut map = self.map.lock().await;
            if self.generation.load(Ordering::SeqCst) != generation {
                // Credentials saved or a disconnect meanwhile: start over.
                continue;
            }
            // Another call may have connected meanwhile: keep the first one.
            return match map.get(key) {
                Some((e, existing)) if e == endpoint => Ok(existing.clone()),
                _ => {
                    map.insert(key.clone(), (endpoint.clone(), fresh.clone()));
                    Ok(fresh)
                }
            };
        }
        Err("The integration settings changed while connecting; try again".to_string())
    }

    /// Drops `conn` (a dead port-forward or network change) so the next call
    /// reconnects, unless another call already replaced it.
    pub(crate) async fn invalidate(&self, key: &ConnKey, conn: &Arc<C>) {
        let mut map = self.map.lock().await;
        if map.get(key).is_some_and(|(_, c)| Arc::ptr_eq(c, conn)) {
            map.remove(key);
        }
    }

    /// Drops every cached connection of `context` (any kubeconfig).
    pub(crate) async fn forget(&self, context: &str) {
        let mut map = self.map.lock().await;
        self.generation.fetch_add(1, Ordering::SeqCst);
        map.retain(|(_, c), _| c != context);
    }

    /// Drops every cached connection (the default endpoint's credentials
    /// changed, #528).
    pub(crate) async fn clear(&self) {
        let mut map = self.map.lock().await;
        self.generation.fetch_add(1, Ordering::SeqCst);
        map.clear();
    }
}

/// Port-forwards to in-cluster web UIs (Kibana #505, Grafana #525), owned by
/// the backend: one per (kubeconfig, context, service), shared by every
/// window, reused while its pod is ready; stopped on drop.
#[derive(Default)]
pub(crate) struct ServiceForwards {
    map: Mutex<HashMap<(String, String, ServiceRef), ServiceTunnel>>,
}

impl ServiceForwards {
    /// Local port (on 127.0.0.1) of the forward to `service`, opened when
    /// there is none or its pod was replaced (rollout, eviction).
    pub(crate) async fn port(
        &self,
        kubeconfig_path: String,
        context: String,
        service: ServiceRef,
    ) -> Result<u16, String> {
        integration::check_target(&service.target())?;
        let client = kube(&kubeconfig_path, &context).await?.client();
        // Held while connecting: a double click or a second window waits for
        // the first forward instead of starting another one.
        let mut forwards = self.map.lock().await;
        let key = (kubeconfig_path, context, service.clone());
        if let Some(tunnel) = forwards.get(&key) {
            if tunnel.is_running()
                && integration::pod_ready(&client, &service.namespace, &tunnel.pod).await
            {
                return Ok(tunnel.local_port);
            }
            forwards.remove(&key);
        }
        let tunnel = integration::open_service_tunnel(
            &client,
            &service.namespace,
            &service.service,
            service.port,
        )
        .await
        .map_err(|e| match e {
            TunnelError::Config(t) | TunnelError::Connect(t) => t,
        })?;
        let port = tunnel.local_port;
        forwards.insert(key, tunnel);
        Ok(port)
    }

    /// Closes every forward of `context` (any kubeconfig).
    pub(crate) async fn forget(&self, context: &str) {
        self.map.lock().await.retain(|(_, c, _), _| c != context);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;
    use tokio::sync::Notify;

    fn key() -> ConnKey {
        ("/k".to_string(), "prod".to_string())
    }

    #[tokio::test]
    async fn a_connection_opened_across_a_clear_is_not_cached() {
        let cache = Arc::new(ConnCache::<String, u32>::default());
        let connects = Arc::new(AtomicU32::new(0));
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let task = {
            let (cache, connects, started, release) = (
                cache.clone(),
                connects.clone(),
                started.clone(),
                release.clone(),
            );
            tokio::spawn(async move {
                cache
                    .get_or_connect(&key(), &"e".to_string(), || {
                        let (connects, started, release) =
                            (connects.clone(), started.clone(), release.clone());
                        async move {
                            let n = connects.fetch_add(1, Ordering::SeqCst) + 1;
                            if n == 1 {
                                // The first connect is still in flight when
                                // the credentials change.
                                started.notify_one();
                                release.notified().await;
                            }
                            Ok(n)
                        }
                    })
                    .await
            })
        };
        started.notified().await;
        cache.clear().await;
        release.notify_one();
        let conn = task.await.expect("task").expect("connection");
        assert_eq!(
            *conn, 2,
            "the stale connection was dropped and opened again"
        );
        let cached = cache
            .get_or_connect(&key(), &"e".to_string(), || async { Ok(99) })
            .await
            .expect("cached");
        assert_eq!(*cached, 2);
    }

    #[tokio::test]
    async fn forget_also_drops_connections_in_flight() {
        let cache = ConnCache::<String, u32>::default();
        let cache = &cache;
        let conn = cache
            .get_or_connect(&key(), &"e".to_string(), || async {
                // A disconnect lands while connecting, every time.
                cache.forget("prod").await;
                Ok(1)
            })
            .await;
        assert!(conn.is_err());
        let fresh = cache
            .get_or_connect(&key(), &"e".to_string(), || async { Ok(2) })
            .await
            .expect("connection");
        assert_eq!(*fresh, 2);
    }
}
