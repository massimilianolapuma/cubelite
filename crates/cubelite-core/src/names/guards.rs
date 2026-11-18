//! Every entry point that takes a namespace or an object name from the
//! desktop refuses a crafted one before any request (#671). Each test runs
//! the calls against a mock apiserver that answers anything, then checks
//! that it saw no request at all.

use futures::StreamExt;
use http::StatusCode;
use serde_json::json;

use crate::dynamic::ResourceRef;
use crate::limits::types::ProposalKind;
use crate::limits::{Proposal, SeenState};
use crate::test_support::{mock_client, requests, Seen};
use crate::watcher::{ResourceType, ResourceWatcher, WatchEvent};
use crate::{KubeClient, KubeconfigError};

/// Values that would reach another object if they went into a request path
/// as they are: the first one turns a pod's log request into a read of the
/// Secret `shop/api`.
const CRAFTED: [&str; 3] = ["shop/secrets/api?x=", "a%2Fb", ".."];

/// A mock apiserver that answers every request with a Secret, as the API
/// server would for the crafted path. Its one value is a sentinel, base64
/// encoded as the API server sends it.
fn apiserver() -> (KubeClient, tokio::task::JoinHandle<Vec<Seen>>) {
    let sentinel = serde_json::to_value(k8s_openapi::ByteString(b"SENTINEL-671".to_vec()))
        .expect("base64 sentinel");
    mock_client(move |_, _| {
        (
            StatusCode::OK,
            json!({
                "apiVersion": "v1",
                "kind": "Secret",
                "metadata": { "name": "api", "namespace": "shop", "resourceVersion": "1" },
                "data": { "k": sentinel },
                "items": [],
            }),
        )
    })
}

/// Asserts the mock apiserver saw nothing, naming what it saw otherwise.
async fn assert_no_request(client: KubeClient, server: tokio::task::JoinHandle<Vec<Seen>>) {
    let seen = requests(client, server).await;
    let uris: Vec<&str> = seen.iter().map(|s| s.uri.as_str()).collect();
    assert!(uris.is_empty(), "requests were sent: {uris:?}");
}

fn reason(result: Result<(), KubeconfigError>) -> String {
    match result {
        Err(KubeconfigError::ClientError { reason }) => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn namespace_refused(value: &str) -> String {
    format!("Invalid namespace \"{value}\"")
}

fn name_refused(value: &str) -> String {
    format!("Invalid name \"{value}\"")
}

/// The pairs to try: each crafted value as the namespace (with a good name)
/// and as the name (in a good namespace), with the message expected.
fn crafted_objects() -> Vec<(&'static str, &'static str, String)> {
    CRAFTED
        .iter()
        .flat_map(|v| {
            [
                (*v, "api", namespace_refused(v)),
                ("shop", *v, name_refused(v)),
            ]
        })
        .collect()
}

#[tokio::test]
async fn lists_refuse_a_crafted_namespace_without_a_request() {
    for ns in CRAFTED {
        let (client, server) = apiserver();
        let scope = Some(ns);
        let results = [
            client.list_pods(scope).await.map(drop),
            client.list_deployments(ns).await.map(drop),
            client.list_services(scope).await.map(drop),
            client.list_ingresses(scope).await.map(drop),
            client.list_configmaps(scope).await.map(drop),
            client.list_secrets(scope).await.map(drop),
            client.list_jobs(scope).await.map(drop),
            client.list_cronjobs(scope).await.map(drop),
            client.list_statefulsets(scope).await.map(drop),
            client.list_daemonsets(scope).await.map(drop),
            client.list_pvcs(scope).await.map(drop),
        ];
        assert_no_request(client, server).await;
        for result in results {
            assert_eq!(reason(result), namespace_refused(ns));
        }
    }
}

#[tokio::test]
async fn events_helm_and_metrics_refuse_a_crafted_namespace_without_a_request() {
    for ns in CRAFTED {
        let (client, server) = apiserver();
        let scope = Some(ns);
        let results = [
            client.list_events(scope).await.map(drop),
            client.list_helm_releases(scope).await.map(drop),
            client.list_pod_metrics(scope).await.map(drop),
        ];
        assert_no_request(client, server).await;
        for result in results {
            assert_eq!(reason(result), namespace_refused(ns));
        }
    }
}

#[tokio::test]
async fn yaml_refuses_a_crafted_namespace_or_name_without_a_request() {
    for (ns, name, expected) in crafted_objects() {
        let (client, server) = apiserver();
        let mut results = Vec::new();
        for kind in [
            ResourceType::Pod,
            ResourceType::Deployment,
            ResourceType::Service,
            ResourceType::ConfigMap,
            ResourceType::Secret,
            ResourceType::Ingress,
        ] {
            results.push(client.get_resource_yaml(kind, ns, name).await.map(drop));
        }
        assert_no_request(client, server).await;
        for result in results {
            assert_eq!(reason(result), expected);
        }
    }
}

#[tokio::test]
async fn apply_refuses_a_crafted_namespace_or_name_without_a_request() {
    for (ns, name, expected) in crafted_objects() {
        let (client, server) = apiserver();
        // The manifest names the crafted target, so only the check stops it.
        let yaml = format!("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: '{name}'\n  namespace: '{ns}'\ndata: {{}}\n");
        let result = client
            .apply_resource_yaml(ResourceType::ConfigMap, ns, name, &yaml)
            .await;
        assert_no_request(client, server).await;
        assert_eq!(reason(result), expected);
    }
}

#[tokio::test]
async fn scale_restart_and_delete_refuse_a_crafted_namespace_or_name_without_a_request() {
    for (ns, name, expected) in crafted_objects() {
        let (client, server) = apiserver();
        let results = [
            client.scale_deployment(ns, name, 3).await,
            client.restart_deployment(ns, name).await,
            client.delete_pod(ns, name).await,
            client.get_pod_containers(ns, name).await.map(drop),
        ];
        assert_no_request(client, server).await;
        for result in results {
            assert_eq!(reason(result), expected);
        }
    }
}

fn restore() -> Proposal {
    Proposal {
        kind: ProposalKind::Restore,
        containers: Vec::new(),
    }
}

#[tokio::test]
async fn resource_limits_refuse_a_crafted_namespace_or_name_without_a_request() {
    for (ns, name, expected) in crafted_objects() {
        let (client, server) = apiserver();
        let results = [
            client.resource_facts(ns, name).await.map(drop),
            client
                .apply_resources(ns, name, &restore(), &SeenState::default(), true)
                .await
                .map(drop),
            client.clear_resources_override(ns, name).await,
        ];
        assert_no_request(client, server).await;
        for result in results {
            assert_eq!(reason(result), expected);
        }
    }
}

#[tokio::test]
async fn logs_refuse_a_crafted_namespace_or_pod_without_a_request() {
    for (ns, pod, expected) in crafted_objects() {
        let (client, server) = apiserver();
        let lines: Vec<_> = crate::logs::stream_pod_logs_opts(
            client.client(),
            ns.to_string(),
            pod.to_string(),
            Default::default(),
        )
        .collect()
        .await;
        let short: Vec<_> =
            crate::logs::stream_pod_logs(client.client(), ns.into(), pod.into(), 50)
                .collect()
                .await;
        assert_no_request(client, server).await;
        for lines in [lines, short] {
            assert_eq!(lines.len(), 1, "{lines:?}");
            assert_eq!(lines[0].level, crate::LogLevel::Error);
            assert_eq!(lines[0].message, expected);
        }
    }
}

#[tokio::test]
async fn exec_refuses_a_crafted_namespace_or_pod_without_a_request() {
    for (ns, pod, expected) in crafted_objects() {
        let (client, server) = apiserver();
        let result =
            crate::exec::start_exec(client.client(), ns, pod, None, vec!["/bin/sh".into()]).await;
        if let Ok(session) = &result {
            session.handle.abort();
        }
        assert_no_request(client, server).await;
        assert_eq!(reason(result.map(drop)), expected);
    }
}

#[tokio::test]
async fn port_forward_refuses_a_crafted_namespace_or_pod_before_binding() {
    for (ns, pod, expected) in crafted_objects() {
        let (client, server) = apiserver();
        let result =
            crate::portforward::forward_pod_port(client.client(), ns.into(), pod.into(), 0, 80)
                .await;
        // A forward that started holds the client: stop it so the mock
        // apiserver can report.
        if let Ok((_, handle)) = &result {
            handle.abort();
        }
        assert_no_request(client, server).await;
        let err = result.map(drop).expect_err("refused");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        assert_eq!(err.to_string(), expected);
    }
}

#[tokio::test]
async fn watch_refuses_a_crafted_namespace_without_a_request() {
    for ns in CRAFTED {
        let (client, server) = apiserver();
        let watcher = ResourceWatcher::new(client.client());
        for kind in [
            ResourceType::Pod,
            ResourceType::Deployment,
            ResourceType::Service,
            ResourceType::Ingress,
            ResourceType::ConfigMap,
            ResourceType::Secret,
        ] {
            let mut stream = watcher.watch_resources(Some(ns), kind);
            let first =
                tokio::time::timeout(std::time::Duration::from_secs(2), stream.next()).await;
            match first {
                Ok(Some(WatchEvent::Error(message))) => {
                    assert_eq!(message, namespace_refused(ns));
                }
                other => panic!("expected a refusal for {ns}, got {other:?}"),
            }
            assert!(stream.next().await.is_none(), "the stream ends");
        }
        drop(watcher);
        assert_no_request(client, server).await;
    }
}

fn pods_ref() -> ResourceRef {
    ResourceRef {
        group: String::new(),
        version: "v1".into(),
        plural: "pods".into(),
        namespaced: true,
    }
}

#[tokio::test]
async fn kind_views_refuse_a_crafted_namespace_or_name_without_a_request() {
    for value in CRAFTED {
        let (client, server) = apiserver();
        let table = client.list_table(&pods_ref(), Some(value)).await.map(drop);
        let in_ns = client
            .get_dynamic_yaml(&pods_ref(), Some(value), "api")
            .await
            .map(drop);
        let named = client
            .get_dynamic_yaml(&pods_ref(), Some("shop"), value)
            .await
            .map(drop);
        assert_no_request(client, server).await;
        assert_eq!(reason(table), namespace_refused(value));
        assert_eq!(reason(in_ns), namespace_refused(value));
        assert_eq!(reason(named), name_refused(value));
    }
}

#[tokio::test]
async fn kind_views_keep_names_of_any_kind() {
    let (client, server) = mock_client(|_, _| {
        (
            StatusCode::OK,
            json!({ "kind": "ClusterRole", "metadata": { "name": "system:controller:job-controller" } }),
        )
    });
    let roles = ResourceRef {
        group: "rbac.authorization.k8s.io".into(),
        version: "v1".into(),
        plural: "clusterroles".into(),
        namespaced: false,
    };
    client
        .get_dynamic_yaml(&roles, None, "system:controller:job-controller")
        .await
        .expect("a ClusterRole's name passes");
    let seen = requests(client, server).await;
    assert_eq!(seen.len(), 1);
}

#[tokio::test]
async fn service_tunnels_refuse_a_crafted_namespace_or_name_without_a_request() {
    for (ns, name, expected) in crafted_objects() {
        let (client, server) = apiserver();
        let kube = client.client();
        let tunnel = crate::integration::open_service_tunnel(&kube, ns, name, 9200).await;
        let ready = crate::integration::pod_ready(&kube, ns, name).await;
        drop(kube);
        assert_no_request(client, server).await;
        assert_eq!(
            tunnel.map(drop),
            Err(crate::integration::TunnelError::Config(expected))
        );
        assert!(!ready);
    }
}

#[tokio::test]
async fn eck_credentials_refuse_a_crafted_namespace_or_service_without_a_request() {
    for (ns, service, expected) in [
        (
            CRAFTED[0],
            "quickstart-es-http",
            namespace_refused(CRAFTED[0]),
        ),
        ("shop", "a%2Fb-es-http", name_refused("a%2Fb-es-http")),
        ("shop", "..-es-http", name_refused("..-es-http")),
    ] {
        let (client, server) = apiserver();
        let result = crate::elastic::transport::eck_credentials(client.client(), ns, service).await;
        assert_no_request(client, server).await;
        assert_eq!(
            result.err(),
            Some(crate::elastic::ElasticError::Config(expected))
        );
    }
}

#[tokio::test]
async fn all_namespaces_stays_allowed() {
    let (client, server) = mock_client(|_, _| {
        (
            StatusCode::OK,
            json!({ "apiVersion": "v1", "kind": "List", "metadata": {}, "items": [] }),
        )
    });
    client.list_pods(None).await.expect("all namespaces");
    client.list_events(None).await.expect("all namespaces");
    client
        .list_helm_releases(None)
        .await
        .expect("all namespaces");
    let seen = requests(client, server).await;
    assert_eq!(seen.len(), 3);
    assert!(seen.iter().all(|s| !s.uri.contains("/namespaces/")));
}

/// Values from real clusters and fixtures reach the API as before.
#[tokio::test]
async fn real_namespaces_and_names_reach_the_api() {
    let (client, server) = mock_client(|_, _| {
        (
            StatusCode::OK,
            json!({ "apiVersion": "v1", "kind": "List", "metadata": {}, "items": [] }),
        )
    });
    client
        .list_secrets(Some("kube-system"))
        .await
        .expect("kube-system");
    // The mock's answer is not a Secret or a Pod: only the requests count.
    let _ = client
        .get_resource_yaml(ResourceType::Secret, "default", "sh.helm.release.v1.api.v7")
        .await;
    let _ = client
        .delete_pod("kube-system", "coredns-787d4945fb-lmn2q")
        .await;
    let seen: Vec<String> = requests(client, server)
        .await
        .into_iter()
        .map(|s| s.uri)
        .collect();
    assert_eq!(seen.len(), 3, "{seen:?}");
    assert!(seen[0].starts_with("/api/v1/namespaces/kube-system/secrets?"));
    assert!(seen[1].starts_with("/api/v1/namespaces/default/secrets/sh.helm.release.v1.api.v7"));
    assert!(seen[2].starts_with("/api/v1/namespaces/kube-system/pods/coredns-787d4945fb-lmn2q"));
}
