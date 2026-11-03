//! Open integration connections per (kubeconfig, context), reused while the
//! endpoint is unchanged (an in-cluster connection may hold a port-forward),
//! and the port-forwards to in-cluster web UIs (Kibana, Grafana).

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use cubelite_core::integration::{self, ServiceRef, ServiceTunnel, TunnelError};
use tokio::sync::Mutex;

use super::elastic::kube;

/// Cache key: the same context name can exist in two kubeconfig files.
pub(crate) type ConnKey = (String, String);

pub(crate) struct ConnCache<E, C> {
    map: Mutex<HashMap<ConnKey, (E, Arc<C>)>>,
}

impl<E, C> Default for ConnCache<E, C> {
    fn default() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }
}

impl<E: Clone + PartialEq, C> ConnCache<E, C> {
    /// The cached connection for `key` and `endpoint`, or a new one from
    /// `connect`. The lock is never held while connecting (port-forward,
    /// kube API calls, keychain), so one slow cluster cannot block others.
    pub(crate) async fn get_or_connect<F, Fut>(
        &self,
        key: &ConnKey,
        endpoint: &E,
        connect: F,
    ) -> Result<Arc<C>, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<C, String>>,
    {
        let cached = self
            .map
            .lock()
            .await
            .get(key)
            .filter(|(e, _)| e == endpoint)
            .map(|(_, c)| c.clone());
        if let Some(conn) = cached {
            return Ok(conn);
        }
        let fresh = Arc::new(connect().await?);
        let mut map = self.map.lock().await;
        // Another call may have connected meanwhile: keep the first one.
        match map.get(key) {
            Some((e, existing)) if e == endpoint => Ok(existing.clone()),
            _ => {
                map.insert(key.clone(), (endpoint.clone(), fresh.clone()));
                Ok(fresh)
            }
        }
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
        self.map.lock().await.retain(|(_, c), _| c != context);
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
