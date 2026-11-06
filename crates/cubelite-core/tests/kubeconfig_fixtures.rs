//! Runs every case of the shared kubeconfig corpus (`testdata/kubeconfig`,
//! #548) through the core: [`KubeConfig::load_from_paths`] (context list,
//! servers, Preferences sources) and the client path
//! ([`merged_kubeconfig`] + kube-rs `Config`), and compares the result with
//! the case's `expected.json`. The schema is in
//! `testdata/kubeconfig/README.md`.
//!
//! A new case directory is picked up without code changes.

use std::fmt::Debug;
use std::path::{Path, PathBuf};

use cubelite_core::client::merged_kubeconfig;
use cubelite_core::KubeConfig;
use kube::config::{Config, KubeConfigOptions, Kubeconfig, KubeconfigError};
use serde::Deserialize;

/// An expectation the code does not meet yet: the exact field and the value
/// observed today (`{:?}` of the checked value).
struct KnownFailure {
    case: &'static str,
    field: &'static str,
    got: &'static str,
    issue: u32,
}

/// Such a mismatch is reported but does not fail the test. Any other value
/// of the field fails it, and so does a listed field that no longer shows
/// the value, so the entry is updated or removed with the fix.
const KNOWN_FAILURES: &[KnownFailure] = &[
    // The first file's `current-context: ""` wins over the next file's.
    KnownFailure {
        case: "empty-current-context",
        field: "current_context",
        got: r#"Some("")"#,
        issue: 552,
    },
    KnownFailure {
        case: "empty-current-context",
        field: "client.current_context",
        got: r#"Some("")"#,
        issue: 552,
    },
    KnownFailure {
        case: "empty-current-context",
        field: "client.current_context.server",
        got: "None",
        issue: 552,
    },
    KnownFailure {
        case: "kubectl-null-lists",
        field: "current_context",
        got: r#"Some("")"#,
        issue: 552,
    },
    KnownFailure {
        case: "kubectl-null-lists",
        field: "client.current_context",
        got: r#"Some("")"#,
        issue: 552,
    },
    KnownFailure {
        case: "kubectl-null-lists",
        field: "client.current_context.server",
        got: "None",
        issue: 552,
    },
];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Expected {
    #[allow(dead_code)]
    description: String,
    current_context: Option<String>,
    contexts: Vec<ExpectedContext>,
    sources: Vec<ExpectedSource>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedContext {
    name: String,
    cluster: Option<String>,
    server: Option<String>,
    user: Option<String>,
    namespace: String,
    auth: Auth,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedSource {
    file: String,
    contexts: usize,
    shadowed: Vec<String>,
    redefined_clusters: Vec<String>,
    redefined_users: Vec<String>,
}

/// The credential a context authenticates with. File paths are relative to
/// the case directory.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Auth {
    Token {
        token: String,
    },
    Exec {
        command: String,
        args: Vec<String>,
    },
    ClientCertFile {
        client_certificate: String,
        client_key: String,
    },
    ClientCertData {
        client_certificate_data: String,
    },
    None,
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

fn corpus_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/kubeconfig");
    std::fs::canonicalize(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
}

/// Every directory of the corpus; one without `expected.json` fails.
fn case_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(corpus_dir())
        .expect("read corpus")
        .map(|entry| entry.expect("dir entry").path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    dirs
}

/// Every `*.yaml` file under `dir`, as `/`-separated paths relative to `dir`,
/// in lexical order: the merge order of the case.
fn kubeconfig_files(dir: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, found: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).expect("read case dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                walk(root, &path, found);
            } else if path.extension().is_some_and(|ext| ext == "yaml") {
                let rel = path.strip_prefix(root).expect("under the case dir");
                let parts: Vec<_> = rel.iter().map(|p| p.to_string_lossy()).collect();
                found.push(parts.join("/"));
            }
        }
    }
    let mut found = Vec::new();
    walk(dir, dir, &mut found);
    found.sort();
    found
}

/// One mismatch: the field and the `{:?}` of the observed and expected values.
struct Mismatch {
    field: String,
    got: String,
    want: String,
}

/// Mismatches of one case.
struct Report {
    mismatches: Vec<Mismatch>,
}

impl Report {
    fn check<T: PartialEq + Debug>(&mut self, field: impl Into<String>, got: T, want: T) {
        if got != want {
            self.mismatches.push(Mismatch {
                field: field.into(),
                got: format!("{got:?}"),
                want: format!("{want:?}"),
            });
        }
    }
}

#[tokio::test]
async fn every_case_matches_its_expectations() {
    let cases = case_dirs();
    assert!(
        cases.len() >= 10,
        "corpus not found or incomplete: {cases:?}"
    );

    let mut failures = Vec::new();
    let mut known_hits = vec![false; KNOWN_FAILURES.len()];
    for dir in &cases {
        let case = dir.file_name().expect("name").to_string_lossy().to_string();
        let report = run_case(dir).await;
        for m in report.mismatches {
            let line = format!("{case}: {}: got {}, want {}", m.field, m.got, m.want);
            let known = KNOWN_FAILURES
                .iter()
                .position(|k| k.case == case && k.field == m.field && k.got == m.got);
            match known {
                Some(i) => {
                    eprintln!("known failure (#{}) {line}", KNOWN_FAILURES[i].issue);
                    known_hits[i] = true;
                }
                None => failures.push(line),
            }
        }
    }
    for (k, hit) in KNOWN_FAILURES.iter().zip(known_hits) {
        if !hit {
            failures.push(format!(
                "{}: {}: listed as known failure #{} with {} but no longer shows it; \
                 update KNOWN_FAILURES",
                k.case, k.field, k.issue, k.got
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}\n", failures.join("\n"));
}

async fn run_case(dir: &Path) -> Report {
    let mut report = Report {
        mismatches: Vec::new(),
    };
    let Ok(text) = std::fs::read_to_string(dir.join("expected.json")) else {
        report.check("expected.json", "missing", "present");
        return report;
    };
    let expected: Expected = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("{}: expected.json: {e}", dir.display()));

    let files = kubeconfig_files(dir);
    let listed: Vec<String> = expected.sources.iter().map(|s| s.file.clone()).collect();
    report.check("files", &files, &listed);
    let paths: Vec<PathBuf> = files.iter().map(|f| dir.join(f)).collect();

    check_loaded_config(&mut report, &paths, &expected);
    check_client_path(&mut report, dir, &paths, &expected).await;
    report
}

/// What the context list and Preferences show: [`KubeConfig`].
fn check_loaded_config(report: &mut Report, paths: &[PathBuf], expected: &Expected) {
    let cfg = match KubeConfig::load_from_paths(paths) {
        Ok(cfg) => cfg,
        Err(e) => {
            report.check("load", format!("error: {e}"), "ok".to_string());
            return;
        }
    };
    report.check(
        "current_context",
        cfg.current_context(),
        expected.current_context.as_deref(),
    );
    let names: Vec<&str> = expected.contexts.iter().map(|c| c.name.as_str()).collect();
    report.check(
        "contexts",
        cfg.context_names(),
        names.iter().map(|n| n.to_string()).collect(),
    );

    for want in &expected.contexts {
        let field = |f: &str| format!("contexts[{}].{f}", want.name);
        let Some(info) = cfg.get_context(&want.name) else {
            report.check(field("present"), false, true);
            continue;
        };
        report.check(field("server"), info.cluster_server, want.server.clone());
        report.check(field("namespace"), info.namespace.as_str(), &want.namespace);
        let details = cfg
            .raw()
            .contexts
            .iter()
            .find(|c| c.name == want.name)
            .and_then(|c| c.context.as_ref());
        let non_empty = |s: Option<&String>| s.filter(|s| !s.is_empty()).cloned();
        report.check(
            field("cluster"),
            non_empty(details.map(|d| &d.cluster)),
            want.cluster.clone(),
        );
        report.check(
            field("user"),
            non_empty(details.map(|d| &d.user)),
            want.user.clone(),
        );
    }

    let sources = cfg.sources();
    report.check("sources.len", sources.len(), expected.sources.len());
    for (got, want) in sources.iter().zip(&expected.sources) {
        let field = |f: &str| format!("sources[{}].{f}", want.file);
        report.check(field("contexts"), got.contexts, want.contexts);
        report.check(field("shadowed"), &got.shadowed, &want.shadowed);
        report.check(
            field("redefined_clusters"),
            &got.redefined_clusters,
            &want.redefined_clusters,
        );
        report.check(
            field("redefined_users"),
            &got.redefined_users,
            &want.redefined_users,
        );
    }
}

/// What a client connects with: the merged kube-rs document and the
/// `Config` built from it (server, namespace, credentials).
async fn check_client_path(
    report: &mut Report,
    dir: &Path,
    paths: &[PathBuf],
    expected: &Expected,
) {
    match merged_kubeconfig(paths, None) {
        Ok(merged) => report.check(
            "client.current_context",
            merged.current_context.as_deref(),
            expected.current_context.as_deref(),
        ),
        Err(e) => {
            report.check("client.merge", format!("error: {e}"), "ok".to_string());
            return;
        }
    }

    for want in &expected.contexts {
        let field = |f: &str| format!("contexts[{}].{f}", want.name);
        let merged = match merged_kubeconfig(paths, Some(&want.name)) {
            Ok(merged) => merged,
            Err(e) => {
                report.check(
                    field("client.merge"),
                    format!("error: {e}"),
                    "ok".to_string(),
                );
                continue;
            }
        };
        let options = KubeConfigOptions {
            context: Some(want.name.clone()),
            ..Default::default()
        };
        let auth_info = match Config::from_custom_kubeconfig(merged.clone(), &options).await {
            Ok(config) => {
                let server = config.cluster_url.to_string();
                report.check(
                    field("client.server"),
                    Some(server.trim_end_matches('/')),
                    want.server.as_deref().map(|s| s.trim_end_matches('/')),
                );
                report.check(
                    field("client.namespace"),
                    config.default_namespace.as_str(),
                    &want.namespace,
                );
                serde_json::to_value(&config.auth_info).expect("auth json")
            }
            Err(e) => {
                // Only a cluster defined nowhere may stop the client config.
                let missing_cluster = matches!(
                    &e,
                    KubeconfigError::LoadClusterOfContext(name)
                        if Some(name) == want.cluster.as_ref()
                );
                report.check(
                    field("client.server"),
                    if missing_cluster && want.server.is_none() {
                        "no cluster".to_string()
                    } else {
                        format!("no config: {e}")
                    },
                    match &want.server {
                        Some(server) => server.clone(),
                        None => "no cluster".to_string(),
                    },
                );
                merged_user(&merged, &want.name)
            }
        };
        report.check(
            field("auth"),
            auth_of(dir, &auth_info),
            Ok(want.auth.clone()),
        );
    }

    // `context: None` follows current-context through the same rule.
    if let Some(current) = expected
        .current_context
        .as_ref()
        .and_then(|name| expected.contexts.iter().find(|c| &c.name == name))
    {
        if let Ok(merged) = merged_kubeconfig(paths, None) {
            let server = Config::from_custom_kubeconfig(merged, &KubeConfigOptions::default())
                .await
                .map(|c| c.cluster_url.to_string().trim_end_matches('/').to_string())
                .ok();
            report.check(
                "client.current_context.server",
                server,
                current
                    .server
                    .as_deref()
                    .map(|s| s.trim_end_matches('/').to_string()),
            );
        }
    }
}

/// The user entry kube-rs picks for `context` in `merged`, as JSON (used
/// when no `Config` can be built).
fn merged_user(merged: &Kubeconfig, context: &str) -> serde_json::Value {
    let user = merged
        .contexts
        .iter()
        .find(|c| c.name == context)
        .and_then(|c| c.context.as_ref())
        .and_then(|c| c.user.clone());
    let auth_info = user.and_then(|name| {
        merged
            .auth_infos
            .iter()
            .find(|u| u.name == name)
            .and_then(|u| u.auth_info.as_ref())
    });
    auth_info
        .map(|a| serde_json::to_value(a).expect("auth json"))
        .unwrap_or(serde_json::Value::Null)
}

/// The single credential of a kube-rs `AuthInfo` (as JSON). Client
/// certificate files must exist and are reported relative to `dir`.
fn auth_of(dir: &Path, auth: &serde_json::Value) -> Result<Auth, String> {
    let text = |key: &str| auth.get(key).and_then(|v| v.as_str()).map(str::to_string);
    let relative = |key: &str| -> Result<Option<String>, String> {
        let Some(path) = text(key) else {
            return Ok(None);
        };
        let path = PathBuf::from(path);
        if !path.is_file() {
            return Err(format!("{key} {} is not a file", path.display()));
        }
        Ok(Some(match path.strip_prefix(dir) {
            Ok(rel) => rel
                .iter()
                .map(|p| p.to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
            Err(_) => path.display().to_string(),
        }))
    };

    let mut found = Vec::new();
    if let Some(exec) = auth.get("exec").filter(|v| !v.is_null()) {
        let args = exec
            .get("args")
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        found.push(Auth::Exec {
            command: exec
                .get("command")
                .and_then(|c| c.as_str())
                .unwrap_or_default()
                .to_string(),
            args,
        });
    }
    if let Some(token) = text("token") {
        found.push(Auth::Token { token });
    }
    if let Some(data) = text("client-certificate-data") {
        found.push(Auth::ClientCertData {
            client_certificate_data: data,
        });
    }
    if let Some(client_certificate) = relative("client-certificate")? {
        found.push(Auth::ClientCertFile {
            client_certificate,
            client_key: relative("client-key")?.unwrap_or_default(),
        });
    }
    match found.len() {
        0 => Ok(Auth::None),
        1 => Ok(found.remove(0)),
        _ => Err(format!("more than one credential: {found:?}")),
    }
}
