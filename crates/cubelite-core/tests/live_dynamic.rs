//! Live checks of discovery, Table lists and dynamic YAML against a real
//! cluster (phase 1 of the resource-kinds design).
//!
//! Ignored by default. Run against minikube with kube-prometheus-stack:
//!
//! ```sh
//! CUBELITE_LIVE_CONTEXT=minikube cargo test -p cubelite-core --test live_dynamic -- --ignored --nocapture
//! ```

use cubelite_core::{KubeClient, ResourceKindInfo, ResourceRef};

async fn client() -> Option<KubeClient> {
    let context = std::env::var("CUBELITE_LIVE_CONTEXT").ok()?;
    let home = std::env::var("HOME").ok()?;
    let kubeconfig = std::env::var("KUBECONFIG").unwrap_or(format!("{home}/.kube/config"));
    Some(
        KubeClient::new(&kubeconfig, Some(&context))
            .await
            .expect("kube client"),
    )
}

fn find<'a>(kinds: &'a [ResourceKindInfo], group: &str, kind: &str) -> &'a ResourceKindInfo {
    kinds
        .iter()
        .find(|k| k.group == group && k.kind == kind)
        .unwrap_or_else(|| panic!("{group}/{kind} not discovered"))
}

fn as_ref(k: &ResourceKindInfo) -> ResourceRef {
    ResourceRef {
        group: k.group.clone(),
        version: k.version.clone(),
        plural: k.plural.clone(),
        namespaced: k.namespaced,
    }
}

#[tokio::test]
#[ignore = "needs a live cluster (CUBELITE_LIVE_CONTEXT)"]
async fn discovers_builtin_and_custom_kinds() {
    let Some(client) = client().await else { return };
    let kinds = client.discover_kinds().await.expect("discover");
    assert!(find(&kinds, "apps", "Deployment").namespaced);
    assert_eq!(
        find(&kinds, "autoscaling", "HorizontalPodAutoscaler").version,
        "v2"
    );
    assert!(!find(&kinds, "rbac.authorization.k8s.io", "ClusterRole").namespaced);
    find(&kinds, "monitoring.coreos.com", "ServiceMonitor");
    println!("{} kinds discovered", kinds.len());
}

#[tokio::test]
#[ignore = "needs a live cluster (CUBELITE_LIVE_CONTEXT)"]
async fn lists_tables_and_fetches_yaml() {
    let Some(client) = client().await else { return };
    let kinds = client.discover_kinds().await.expect("discover");

    let roles = as_ref(find(&kinds, "rbac.authorization.k8s.io", "ClusterRole"));
    let table = client.list_table(&roles, None).await.expect("clusterroles");
    assert!(!table.rows.is_empty());
    assert!(table.columns.iter().any(|c| c.name == "Name"));

    let pods = as_ref(find(&kinds, "", "Pod"));
    let table = client
        .list_table(&pods, Some("kube-system"))
        .await
        .expect("pods");
    assert!(!table.rows.is_empty());
    assert!(table
        .rows
        .iter()
        .all(|r| r.namespace.as_deref() == Some("kube-system")));
    println!(
        "pods columns: {:?}",
        table.columns.iter().map(|c| &c.name).collect::<Vec<_>>()
    );

    let first = client
        .list_table(&roles, None)
        .await
        .expect("clusterroles")
        .rows
        .remove(0);
    let yaml = client
        .get_dynamic_yaml(&roles, None, &first.name)
        .await
        .expect("yaml");
    assert!(yaml.contains("kind: ClusterRole"), "{yaml}");
}
