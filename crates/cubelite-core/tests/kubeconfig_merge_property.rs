//! Property test on the multi-file kubeconfig merge (#543, #548).
//!
//! Invariant: contexts and current-context are first-wins across files; a
//! context resolves to the cluster and user of the file that defines it,
//! falling back to the first file that defines that name. Checked on random
//! layouts of 2–4 files whose names come from a tiny pool, so clashes and
//! cross-file references are frequent, through both core paths: the context
//! list ([`KubeConfig::load_from_paths`]) and the client
//! ([`merged_kubeconfig`] + kube-rs `Config`).

use std::path::PathBuf;

use cubelite_core::client::merged_kubeconfig;
use cubelite_core::KubeConfig;
use kube::config::{Config, KubeConfigOptions};
use proptest::prelude::*;
use proptest::sample::subsequence;

const NAMES: [&str; 3] = ["a", "b", "c"];

#[derive(Debug, Clone)]
struct ContextSpec {
    name: &'static str,
    cluster: &'static str,
    user: &'static str,
}

#[derive(Debug, Clone)]
struct FileSpec {
    current: Option<&'static str>,
    contexts: Vec<ContextSpec>,
    clusters: Vec<&'static str>,
    users: Vec<&'static str>,
}

fn name() -> impl Strategy<Value = &'static str> {
    proptest::sample::select(NAMES.to_vec())
}

fn file_spec() -> impl Strategy<Value = FileSpec> {
    let contexts = subsequence(NAMES.to_vec(), 0..=NAMES.len()).prop_flat_map(|names| {
        let n = names.len();
        (
            Just(names),
            proptest::collection::vec((name(), name()), n..=n),
        )
            .prop_map(|(names, refs)| {
                names
                    .into_iter()
                    .zip(refs)
                    .map(|(name, (cluster, user))| ContextSpec {
                        name,
                        cluster,
                        user,
                    })
                    .collect::<Vec<_>>()
            })
    });
    (
        proptest::option::of(name()),
        contexts,
        subsequence(NAMES.to_vec(), 0..=NAMES.len()),
        subsequence(NAMES.to_vec(), 0..=NAMES.len()),
    )
        .prop_map(|(current, contexts, clusters, users)| FileSpec {
            current,
            contexts,
            clusters,
            users,
        })
}

fn server(file: usize, cluster: &str) -> String {
    format!("https://{cluster}.f{file}.example.com:6443")
}

fn token(file: usize, user: &str) -> String {
    format!("fake-token-{file}-{user}")
}

fn render(file: usize, spec: &FileSpec) -> String {
    let mut yaml = String::from("apiVersion: v1\nkind: Config\n");
    if let Some(current) = spec.current {
        yaml += &format!("current-context: ctx-{current}\n");
    }
    yaml += "contexts:\n";
    for c in &spec.contexts {
        yaml += &format!(
            "- name: ctx-{}\n  context:\n    cluster: {}\n    user: {}\n",
            c.name, c.cluster, c.user
        );
    }
    yaml += "clusters:\n";
    for c in &spec.clusters {
        yaml += &format!("- name: {c}\n  cluster:\n    server: {}\n", server(file, c));
    }
    yaml += "users:\n";
    for u in &spec.users {
        yaml += &format!("- name: {u}\n  user:\n    token: {}\n", token(file, u));
    }
    yaml
}

/// What the invariant says one context resolves to.
#[derive(Debug, PartialEq)]
struct Resolved {
    name: String,
    server: Option<String>,
    token: Option<String>,
}

/// The merge as the invariant states it, computed from the specs alone.
fn model(files: &[FileSpec]) -> (Option<String>, Vec<Resolved>) {
    let current = files
        .iter()
        .find_map(|f| f.current)
        .map(|c| format!("ctx-{c}"));
    let mut resolved: Vec<Resolved> = Vec::new();
    for (i, file) in files.iter().enumerate() {
        for c in &file.contexts {
            let name = format!("ctx-{}", c.name);
            if resolved.iter().any(|r| r.name == name) {
                continue;
            }
            let pick = |defines: &dyn Fn(&FileSpec) -> bool| {
                if defines(file) {
                    Some(i)
                } else {
                    files.iter().position(defines)
                }
            };
            resolved.push(Resolved {
                name,
                server: pick(&|f| f.clusters.contains(&c.cluster)).map(|j| server(j, c.cluster)),
                token: pick(&|f| f.users.contains(&c.user)).map(|j| token(j, c.user)),
            });
        }
    }
    (current, resolved)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
}

/// Server and token kube-rs would connect `context` with (`None`: the
/// merged current-context, as `KubeClient::new(_, None)` does); `None`
/// server when no client config can be built (the cluster is defined
/// nowhere).
fn client_view(
    rt: &tokio::runtime::Runtime,
    paths: &[PathBuf],
    requested: Option<&str>,
) -> Resolved {
    let merged = merged_kubeconfig(paths, requested).expect("merge");
    let context = requested
        .map(str::to_string)
        .or_else(|| merged.current_context.clone())
        .unwrap_or_default();
    let user = merged
        .contexts
        .iter()
        .find(|c| c.name == context)
        .and_then(|c| c.context.as_ref())
        .and_then(|c| c.user.clone());
    let auth = user
        .and_then(|u| merged.auth_infos.iter().find(|a| a.name == u).cloned())
        .and_then(|a| a.auth_info)
        .map(|a| serde_json::to_value(a).expect("auth json"));
    let options = KubeConfigOptions {
        context: requested.map(str::to_string),
        ..Default::default()
    };
    let config = rt.block_on(Config::from_custom_kubeconfig(merged, &options));
    Resolved {
        name: context,
        server: config
            .ok()
            .map(|c| c.cluster_url.to_string().trim_end_matches('/').to_string()),
        token: auth.and_then(|a| a["token"].as_str().map(str::to_string)),
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 256,
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn context_resolves_against_its_own_file_then_first_wins(
        files in proptest::collection::vec(file_spec(), 2..=4)
    ) {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths: Vec<PathBuf> = files
            .iter()
            .enumerate()
            .map(|(i, spec)| {
                let path = dir.path().join(format!("{i:02}.yaml"));
                std::fs::write(&path, render(i, spec)).expect("write");
                path
            })
            .collect();
        let (current, want) = model(&files);

        // Context list and status bar (no credentials there).
        let cfg = KubeConfig::load_from_paths(&paths).expect("load");
        prop_assert_eq!(cfg.current_context().map(str::to_string), current.clone());
        let listed: Vec<(String, Option<String>)> = cfg
            .list_contexts()
            .into_iter()
            .map(|info| (info.name, info.cluster_server))
            .collect();
        let servers: Vec<(String, Option<String>)> =
            want.iter().map(|w| (w.name.clone(), w.server.clone())).collect();
        prop_assert_eq!(listed, servers);

        // Client.
        let rt = runtime();
        let merged = merged_kubeconfig(&paths, None).expect("merge");
        prop_assert_eq!(&merged.current_context, &current);
        for w in &want {
            prop_assert_eq!(&client_view(&rt, &paths, Some(&w.name)), w);
        }
        // No explicit context: current-context through the same rule.
        if let Some(w) = want.iter().find(|w| Some(&w.name) == current.as_ref()) {
            prop_assert_eq!(&client_view(&rt, &paths, None), w);
        }
    }
}
