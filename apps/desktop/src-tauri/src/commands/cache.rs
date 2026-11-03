//! Open integration connections per (kubeconfig, context), reused while the
//! endpoint is unchanged (an in-cluster connection may hold a port-forward).

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use tokio::sync::Mutex;

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
