//! The write guard (#662): one place that decides, for every invoked
//! command, whether it may run on a read-only cluster.
//!
//! [`guarded`] wraps the handler built by `generate_handler!`. For each
//! invoke it reads the command name, classifies it from [`COMMANDS`], and for
//! a write reads its `context` argument (for `exec_send`, the context its
//! shell session was started on) and asks [`ClusterAccessState::write_allowed`],
//! which reads the settings file again when another instance changed it and
//! records a context it has never seen. A refused write never reaches the
//! command: the promise is rejected with a [`Refusal`] object whose `kind`
//! the webview matches.
//!
//! A command missing from [`COMMANDS`] is refused as a write with no context,
//! and a test fails while one is registered without being classified.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::{Invoke, InvokeBody};
use tauri::{Manager, Runtime};

use super::cluster_access::ClusterAccessState;

/// What a command does to the cluster.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Changes nothing in the cluster: always runs.
    Read,
    /// Changes the cluster named by its `context` argument.
    Write,
    /// Writes to the shell session named by its `sessionId` argument, so to
    /// the cluster that session was started on.
    WriteBySession,
}

/// Every command registered in `generate_handler!` (`src/lib.rs`), and what
/// it does. The writes are the list of the spec (§4.1).
pub const COMMANDS: &[(&str, Kind)] = &[
    // Integrations: detection, queries, tunnels, credentials kept locally.
    ("elastic_detect", Kind::Read),
    ("integrations_detect", Kind::Read),
    ("kibana_port_forward", Kind::Read),
    ("prometheus_detect", Kind::Read),
    ("prometheus_test", Kind::Read),
    ("prometheus_metrics", Kind::Read),
    ("prometheus_sparklines", Kind::Read),
    ("prometheus_cluster_usage", Kind::Read),
    ("prometheus_node_metrics", Kind::Read),
    ("prometheus_alerts", Kind::Read),
    ("prometheus_alert_expr", Kind::Read),
    ("prometheus_save_auth", Kind::Read),
    ("prometheus_auth_method", Kind::Read),
    ("prometheus_disconnect", Kind::Read),
    ("grafana_port_forward", Kind::Read),
    ("open_grafana_explore", Kind::Read),
    ("open_grafana_workload", Kind::Read),
    ("open_grafana_home", Kind::Read),
    ("elastic_test", Kind::Read),
    ("elastic_search", Kind::Read),
    ("elastic_close_cursor", Kind::Read),
    ("elastic_save_auth", Kind::Read),
    ("elastic_auth_method", Kind::Read),
    ("elastic_use_eck_credentials", Kind::Read),
    ("elastic_disconnect", Kind::Read),
    ("kibana_discover_url", Kind::Read),
    ("open_kibana_discover", Kind::Read),
    ("open_kibana_workload", Kind::Read),
    ("open_kibana_home", Kind::Read),
    // Lists, reads, reveal and copy of values.
    ("list_pods", Kind::Read),
    ("list_namespaces", Kind::Read),
    ("list_deployments", Kind::Read),
    ("list_services", Kind::Read),
    ("list_ingresses", Kind::Read),
    ("list_configmaps", Kind::Read),
    ("read_configmap_value", Kind::Read),
    ("copy_configmap_value", Kind::Read),
    ("list_secrets", Kind::Read),
    ("reveal_secret_value", Kind::Read),
    ("copy_secret_value", Kind::Read),
    ("export_secret_env", Kind::Read),
    ("list_events", Kind::Read),
    ("list_helm_releases", Kind::Read),
    ("list_pod_metrics", Kind::Read),
    ("cluster_capacity", Kind::Read),
    ("probe_cluster", Kind::Read),
    ("list_jobs", Kind::Read),
    ("list_cronjobs", Kind::Read),
    ("list_statefulsets", Kind::Read),
    ("list_daemonsets", Kind::Read),
    ("list_nodes", Kind::Read),
    ("list_pvcs", Kind::Read),
    ("get_resource_yaml", Kind::Read),
    ("discover_resource_kinds", Kind::Read),
    ("list_resource_table", Kind::Read),
    ("get_dynamic_resource_yaml", Kind::Read),
    // Changes to the cluster.
    ("apply_resource_yaml", Kind::Write),
    ("resource_facts", Kind::Read),
    ("evaluate_resources", Kind::Read),
    // A dry run included: it only serves an edit that cannot be applied.
    ("apply_resources", Kind::Write),
    ("clear_resources_override", Kind::Write),
    // A shell can change anything in a container; closing one never asks.
    ("start_exec", Kind::Write),
    ("exec_send", Kind::WriteBySession),
    ("stop_exec", Kind::Read),
    // Watches, logs, contexts.
    ("watch_resources", Kind::Read),
    ("unwatch_resources", Kind::Read),
    ("watch_kubeconfig", Kind::Read),
    ("unwatch_kubeconfig", Kind::Read),
    ("stream_logs", Kind::Read),
    ("stream_pod_log", Kind::Read),
    ("get_pod_containers", Kind::Read),
    ("stop_logs", Kind::Read),
    ("delete_pod", Kind::Write),
    ("restart_deployment", Kind::Write),
    ("scale_deployment", Kind::Write),
    ("list_contexts", Kind::Read),
    ("kubeconfig_sources", Kind::Read),
    ("get_current_context", Kind::Read),
    // Writes the local kubeconfig file, not the cluster.
    ("set_context", Kind::Read),
    // A port-forward changes nothing in the cluster.
    ("start_port_forward", Kind::Read),
    ("stop_port_forward", Kind::Read),
    ("export_log", Kind::Read),
    // The cluster settings themselves.
    ("cluster_settings", Kind::Read),
    ("set_cluster_environment", Kind::Read),
    ("set_environment_variants", Kind::Read),
    ("make_cluster_writable", Kind::Read),
    ("make_cluster_read_only", Kind::Read),
    ("set_cluster_access_preferences", Kind::Read),
];

/// What `command` does; `None` for a command not in [`COMMANDS`].
pub fn kind_of(command: &str) -> Option<Kind> {
    COMMANDS
        .iter()
        .find(|(name, _)| *name == command)
        .map(|(_, kind)| *kind)
}

/// The context of each live shell session, by session id. Kept apart from
/// `ExecState` (behind a tokio mutex) so the synchronous guard can read it.
#[derive(Default)]
pub struct ExecContexts(Mutex<HashMap<String, String>>);

impl ExecContexts {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, String>> {
        // A panic while holding the lock leaves plain data behind: keep it.
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Record the context session `id` was started on.
    pub fn insert(&self, id: String, context: String) {
        self.lock().insert(id, context);
    }

    /// Forget session `id`.
    pub fn remove(&self, id: &str) {
        self.lock().remove(id);
    }

    /// The context session `id` was started on, while it lives.
    pub fn get(&self, id: &str) -> Option<String> {
        self.lock().get(id).cloned()
    }
}

/// Why a write was refused, as the webview receives it: it matches `kind`,
/// never the text.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Refusal {
    /// The context is read-only.
    ReadOnly { context: String, message: String },
    /// The write named no context (or not as a string).
    NoContext { message: String },
}

impl Refusal {
    fn read_only(context: &str) -> Self {
        Refusal::ReadOnly {
            context: context.to_string(),
            message: format!("{context} is read-only. Make it writable from the cluster menu."),
        }
    }

    fn no_context() -> Self {
        Refusal::NoContext {
            message: "No cluster was named for this change.".to_string(),
        }
    }
}

/// The string argument `key` of an invoke, if there is one.
fn string_arg<'a>(args: Option<&'a Value>, key: &str) -> Option<&'a str> {
    args.and_then(|a| a.get(key)).and_then(Value::as_str)
}

/// Whether `command`, invoked with `args` (`None`: a body that is not JSON),
/// may run. A write needs a string `context` that is writable now; an
/// `exec_send` follows its session's context, and passes for a session that
/// is not live (the command then answers that it has ended). A command not
/// in [`COMMANDS`] is refused as a write with no context, whatever it names.
pub fn check(
    command: &str,
    args: Option<&Value>,
    access: &ClusterAccessState,
    exec: &ExecContexts,
) -> Result<(), Refusal> {
    let context = match kind_of(command) {
        // Not classified: refused whatever it names, so it fails closed.
        None => return Err(Refusal::no_context()),
        Some(Kind::Read) => return Ok(()),
        Some(Kind::Write) => string_arg(args, "context")
            .ok_or_else(Refusal::no_context)?
            .to_string(),
        Some(Kind::WriteBySession) => {
            let id = string_arg(args, "sessionId").ok_or_else(Refusal::no_context)?;
            match exec.get(id) {
                Some(context) => context,
                None => return Ok(()),
            }
        }
    };
    if access.write_allowed(&context) {
        Ok(())
    } else {
        Err(Refusal::read_only(&context))
    }
}

/// What a write is refused with before the cluster settings are loaded.
const NOT_LOADED: &str = "The cluster settings are not loaded yet.";

/// `inner` (the handler of `generate_handler!`) behind the write guard: a
/// refused invoke is rejected with its [`Refusal`] and never reaches the
/// command.
pub fn guarded<R: Runtime>(
    inner: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke: Invoke<R>| {
        let verdict = {
            let message = &invoke.message;
            let command = message.command();
            if kind_of(command) == Some(Kind::Read) {
                Ok(())
            } else {
                let args = match message.payload() {
                    InvokeBody::Json(value) => Some(value),
                    InvokeBody::Raw(_) => None,
                };
                let webview = message.webview_ref();
                match (
                    webview.try_state::<ClusterAccessState>(),
                    webview.try_state::<ExecContexts>(),
                ) {
                    (Some(access), Some(exec)) => {
                        check(command, args, &access, &exec).map_err(Some)
                    }
                    // Fails closed: no write before the settings are there.
                    _ => Err(None),
                }
            }
        };
        match verdict {
            Ok(()) => inner(invoke),
            Err(Some(refusal)) => {
                invoke.resolver.reject(refusal);
                true
            }
            Err(None) => {
                invoke.resolver.reject(NOT_LOADED);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::cluster_access::{TestClock, UnlockFor, FILE_NAME};
    use serde_json::json;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    const PROD: &str = "aks-prod-01-emm";

    const WRITES: [&str; 7] = [
        "apply_resource_yaml",
        "delete_pod",
        "restart_deployment",
        "scale_deployment",
        "apply_resources",
        "clear_resources_override",
        "start_exec",
    ];

    struct Fixture {
        _dir: tempfile::TempDir,
        path: PathBuf,
        clock: TestClock,
        access: ClusterAccessState,
        exec: ExecContexts,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(FILE_NAME);
        let clock = TestClock::at(1_800_000_000);
        let (access, _) = ClusterAccessState::load(path.clone());
        let access = access.with_clock(clock.reader());
        Fixture {
            _dir: dir,
            path,
            clock,
            access,
            exec: ExecContexts::default(),
        }
    }

    impl Fixture {
        fn check(&self, command: &str, args: Option<&Value>) -> Result<(), Refusal> {
            check(command, args, &self.access, &self.exec)
        }
    }

    fn read_only(context: &str) -> Refusal {
        Refusal::ReadOnly {
            context: context.to_string(),
            message: format!("{context} is read-only. Make it writable from the cluster menu."),
        }
    }

    fn no_context() -> Refusal {
        Refusal::NoContext {
            message: "No cluster was named for this change.".to_string(),
        }
    }

    #[test]
    fn each_write_refused_when_read_only() {
        let f = fixture();
        for command in WRITES {
            let refused = f
                .check(command, Some(&json!({ "context": PROD })))
                .expect_err(command);
            assert_eq!(refused, read_only(PROD), "{command}");
            assert_eq!(
                serde_json::to_value(&refused).expect("json"),
                json!({
                    "kind": "read_only",
                    "context": "aks-prod-01-emm",
                    "message": "aks-prod-01-emm is read-only. Make it writable from the cluster menu."
                }),
                "{command}"
            );
        }
        assert_eq!(
            serde_json::to_value(no_context()).expect("json"),
            json!({ "kind": "no_context", "message": "No cluster was named for this change." })
        );
    }

    #[test]
    fn each_write_allowed_when_writable() {
        let f = fixture();
        for command in WRITES {
            assert_eq!(
                f.check(command, Some(&json!({ "context": "minikube" }))),
                Ok(()),
                "{command}"
            );
        }
    }

    #[test]
    fn reads_and_forwards_pass_on_read_only() {
        let f = fixture();
        for command in [
            "list_pods",
            "start_port_forward",
            "kibana_port_forward",
            "grafana_port_forward",
            "reveal_secret_value",
            "stop_exec",
            "set_context",
            "make_cluster_writable",
            "cluster_settings",
        ] {
            assert_eq!(
                f.check(
                    command,
                    Some(&json!({ "context": PROD, "sessionId": "s1" }))
                ),
                Ok(()),
                "{command}"
            );
        }
        assert_eq!(
            f.check("list_pods", None),
            Ok(()),
            "a read needs no context"
        );
    }

    #[test]
    fn bad_context_refused() {
        // Review Focus 1.
        let f = fixture();
        for args in [
            json!({}),
            json!({ "context": null }),
            json!({ "context": 5 }),
            json!({ "context": {} }),
            json!({ "context": ["minikube"] }),
            json!("minikube"),
            json!(null),
        ] {
            assert_eq!(
                f.check("scale_deployment", Some(&args)),
                Err(no_context()),
                "{args}"
            );
        }
        assert_eq!(
            f.check("scale_deployment", None),
            Err(no_context()),
            "raw body"
        );
    }

    #[test]
    fn unseen_context_goes_through_first_sight() {
        let f = fixture();
        assert_eq!(
            f.check("delete_pod", Some(&json!({ "context": "aks-prod-02" }))),
            Err(read_only("aks-prod-02"))
        );
        let on_disk: Value =
            serde_json::from_slice(&fs::read(&f.path).expect("recorded")).expect("json");
        assert_eq!(
            on_disk["contexts"]["aks-prod-02"]["access"],
            json!("read_only")
        );
    }

    #[test]
    fn timed_unlock_allows_until_its_end() {
        let f = fixture();
        let t = f.clock.now();
        let args = json!({ "context": PROD });
        f.access
            .make_writable(PROD, UnlockFor::Minutes(5))
            .expect("unlock");
        f.clock.set(t + Duration::from_secs(5 * 60 - 1));
        assert_eq!(f.check("scale_deployment", Some(&args)), Ok(()));
        f.clock.set(t + Duration::from_secs(5 * 60));
        assert_eq!(
            f.check("scale_deployment", Some(&args)),
            Err(read_only(PROD))
        );
    }

    #[test]
    fn exec_send_follows_its_session() {
        let f = fixture();
        f.exec.insert("s1".to_string(), "minikube".to_string());
        let send = json!({ "sessionId": "s1", "data": "ls\n" });
        assert_eq!(f.check("exec_send", Some(&send)), Ok(()));
        f.access.make_read_only("minikube").expect("lock");
        assert_eq!(
            f.check("exec_send", Some(&send)),
            Err(read_only("minikube"))
        );
        assert_eq!(
            f.check("stop_exec", Some(&json!({ "sessionId": "s1" }))),
            Ok(())
        );
    }

    #[test]
    fn exec_send_unknown_session_passes() {
        // Review Focus 5: the command answers "The shell session has ended."
        let f = fixture();
        f.access.make_read_only("minikube").expect("lock");
        assert_eq!(
            f.check(
                "exec_send",
                Some(&json!({ "sessionId": "gone", "data": "ls\n" }))
            ),
            Ok(())
        );
    }

    #[test]
    fn exec_send_without_a_session_id_refused() {
        let f = fixture();
        for args in [json!({}), json!({ "sessionId": 3 }), json!(null)] {
            assert_eq!(
                f.check("exec_send", Some(&args)),
                Err(no_context()),
                "{args}"
            );
        }
        assert_eq!(f.check("exec_send", None), Err(no_context()));
    }

    #[test]
    fn exec_contexts_insert_get_remove() {
        let exec = ExecContexts::default();
        assert_eq!(exec.get("s1"), None);
        exec.insert("s1".to_string(), "minikube".to_string());
        assert_eq!(exec.get("s1").as_deref(), Some("minikube"));
        exec.remove("s1");
        assert_eq!(exec.get("s1"), None);
    }

    #[test]
    fn file_removed_or_broken_keeps_read_only() {
        // Review Focus 2. `minikube` is read-only by hand: defaults would
        // make it writable, so only memory kept can refuse it.
        let f = fixture();
        f.access.make_read_only("minikube").expect("lock by hand");
        let refused = |why: &str| {
            for context in [PROD, "minikube"] {
                assert_eq!(
                    f.check("restart_deployment", Some(&json!({ "context": context }))),
                    Err(read_only(context)),
                    "{context}, {why}"
                );
            }
        };
        refused("file in place");
        assert!(f.path.exists());
        fs::remove_file(&f.path).expect("remove");
        refused("file removed");
        fs::write(&f.path, b"{ not json").expect("garbage");
        refused("file broken");
        fs::write(&f.path, b"[]").expect("not an object");
        refused("file not an object");
    }

    #[test]
    fn unclassified_command_fails_closed() {
        let f = fixture();
        assert_eq!(
            f.check("no_such_command", Some(&json!({ "context": "minikube" }))),
            Err(no_context())
        );
    }

    /// The identifiers inside `generate_handler![…]` in `src/lib.rs`.
    fn registered_commands() -> BTreeSet<String> {
        let source = include_str!("../lib.rs");
        let start = source
            .find("generate_handler![")
            .expect("generate_handler! in lib.rs")
            + "generate_handler![".len();
        let len = source[start..].find(']').expect("closing bracket");
        source[start..start + len]
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| name.rsplit("::").next().unwrap_or(name).to_string())
            .collect()
    }

    #[test]
    fn table_matches_generate_handler() {
        let registered = registered_commands();
        assert!(registered.len() > 80, "parsed {registered:?}");
        let table: BTreeSet<String> = COMMANDS.iter().map(|(n, _)| (*n).to_string()).collect();
        assert_eq!(table.len(), COMMANDS.len(), "a command twice in COMMANDS");
        for name in &registered {
            assert!(
                table.contains(name),
                "{name} is registered in generate_handler! but not classified in write_guard::COMMANDS"
            );
        }
        for name in &table {
            assert!(
                registered.contains(name),
                "{name} is in write_guard::COMMANDS but not registered in generate_handler!"
            );
        }
    }

    #[test]
    fn table_writes_are_the_spec_list() {
        let writes: BTreeSet<&str> = COMMANDS
            .iter()
            .filter(|(_, kind)| *kind == Kind::Write)
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(writes, WRITES.into_iter().collect());
        let by_session: Vec<&str> = COMMANDS
            .iter()
            .filter(|(_, kind)| *kind == Kind::WriteBySession)
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(by_session, ["exec_send"]);
    }
}

/// The guard around a real handler, through the mock runtime: what the
/// webview receives.
#[cfg(test)]
mod invoke_tests {
    use super::*;
    use crate::commands::cluster_access::FILE_NAME;
    use serde_json::json;
    use tauri::ipc::{CallbackFn, InvokeResponseBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::WebviewWindowBuilder;

    #[tauri::command]
    fn scale_deployment(context: Option<String>) -> String {
        format!("scaled {}", context.unwrap_or_default())
    }

    #[tauri::command]
    fn list_pods() -> String {
        "listed".to_string()
    }

    fn request(cmd: &str, body: InvokeBody) -> InvokeRequest {
        InvokeRequest {
            cmd: cmd.to_string(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().expect("url"),
            body,
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        }
    }

    fn answer(response: Result<InvokeResponseBody, Value>) -> Result<Value, Value> {
        response.map(|body| match body {
            InvokeResponseBody::Json(text) => serde_json::from_str(&text).expect("json"),
            InvokeResponseBody::Raw(bytes) => json!(bytes),
        })
    }

    #[test]
    fn guarded_handler_refuses_before_the_command_runs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (access, _) = ClusterAccessState::load(dir.path().join(FILE_NAME));
        let app = mock_builder()
            .manage(access)
            .manage(ExecContexts::default())
            .invoke_handler(guarded(tauri::generate_handler![
                scale_deployment,
                list_pods
            ]))
            .build(mock_context(noop_assets()))
            .expect("app");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview");
        let call =
            |cmd: &str, body: InvokeBody| answer(get_ipc_response(&webview, request(cmd, body)));

        assert_eq!(
            call(
                "scale_deployment",
                json!({ "context": "aks-prod-01-emm" }).into()
            ),
            Err(json!({
                "kind": "read_only",
                "context": "aks-prod-01-emm",
                "message": "aks-prod-01-emm is read-only. Make it writable from the cluster menu."
            }))
        );
        assert_eq!(
            call("scale_deployment", json!({ "context": "minikube" }).into()),
            Ok(json!("scaled minikube"))
        );
        assert_eq!(
            call("scale_deployment", json!({}).into()),
            Err(
                json!({ "kind": "no_context", "message": "No cluster was named for this change." })
            )
        );
        assert_eq!(
            call(
                "scale_deployment",
                InvokeBody::Raw(b"{\"context\":\"minikube\"}".to_vec())
            ),
            Err(
                json!({ "kind": "no_context", "message": "No cluster was named for this change." })
            ),
            "a body that is not JSON"
        );
        assert_eq!(
            call("list_pods", json!({ "context": "aks-prod-01-emm" }).into()),
            Ok(json!("listed"))
        );
    }

    #[test]
    fn guarded_handler_refuses_writes_before_the_settings_are_loaded() {
        let app = mock_builder()
            .manage(ExecContexts::default())
            .invoke_handler(guarded(tauri::generate_handler![
                scale_deployment,
                list_pods
            ]))
            .build(mock_context(noop_assets()))
            .expect("app");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview");
        let call =
            |cmd: &str, body: InvokeBody| answer(get_ipc_response(&webview, request(cmd, body)));
        assert_eq!(
            call("scale_deployment", json!({ "context": "minikube" }).into()),
            Err(json!(NOT_LOADED))
        );
        assert_eq!(call("list_pods", json!({}).into()), Ok(json!("listed")));
    }
}
