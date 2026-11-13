//! Writing a checked change of requests and limits (spec §6): the patch,
//! the apply with its dry run and override mark, the restore, and removing
//! the mark alone.

use k8s_openapi::api::apps::v1::Deployment;
use kube::api::{Api, Patch, PatchParams};
use serde_json::{json, Map, Value};

use super::evaluate::evaluate;
use super::facts::{api_message, api_status_is};
use super::mark::{active_override, next_mark, OverrideContainer};
use super::types::{
    Change, Evaluation, Level, Proposal, ProposalKind, ResourceFacts, ResourceField, ResourceName,
    ResourceTexts, SeenState,
};
use super::OVERRIDE_ANNOTATION;
use crate::resources::TemplateContainerInfo;
use crate::{KubeClient, KubeconfigError};

/// The field manager of every write of this feature.
const FIELD_MANAGER: &str = "cubelite";

const UNDERNEATH: &str =
    "The deployment's resources changed since you opened this. Reopen and try again.";
const NOTHING_TO_CHANGE: &str = "Nothing to change.";
const TOO_FAST: &str = "The deployment is changing too fast to update. Try again.";
const NOT_ALLOWED: &str = "You are not allowed to change this deployment.";

fn refused(reason: &str) -> KubeconfigError {
    KubeconfigError::ClientError {
        reason: reason.to_string(),
    }
}

/// The key of a resource inside `requests` and `limits`.
fn resource_key(resource: ResourceName) -> &'static str {
    match resource {
        ResourceName::Cpu => "cpu",
        ResourceName::Memory => "memory",
    }
}

/// The map of a field inside `resources`.
fn field_key(field: ResourceField) -> &'static str {
    match field {
        ResourceField::Request => "requests",
        ResourceField::Limit => "limits",
    }
}

/// The patch of a checked change. Pure. `mark`: the annotation value to write, None to remove it.
pub fn patch_body(resource_version: Option<&str>, changes: &[Change], mark: Option<&str>) -> Value {
    // One entry per container, in the order the changes first name it;
    // the strategic merge patch merges each by name.
    let mut regular: Vec<(String, Map<String, Value>)> = Vec::new();
    let mut sidecars: Vec<(String, Map<String, Value>)> = Vec::new();
    for c in changes {
        let list = if c.sidecar {
            &mut sidecars
        } else {
            &mut regular
        };
        let index = match list.iter().position(|(name, _)| name == &c.container) {
            Some(i) => i,
            None => {
                list.push((c.container.clone(), Map::new()));
                list.len() - 1
            }
        };
        let resources = &mut list[index].1;
        let field = resources
            .entry(field_key(c.field))
            .or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(field) = field {
            field.insert(
                resource_key(c.resource).to_string(),
                c.after.as_deref().map_or(Value::Null, |a| json!(a)),
            );
        }
    }
    let entries = |list: Vec<(String, Map<String, Value>)>| -> Value {
        list.into_iter()
            .map(|(name, resources)| json!({ "name": name, "resources": resources }))
            .collect()
    };

    let mut metadata = Map::new();
    if let Some(rv) = resource_version {
        metadata.insert("resourceVersion".into(), json!(rv));
    }
    metadata.insert(
        "annotations".into(),
        json!({ OVERRIDE_ANNOTATION: mark.map_or(Value::Null, |m| json!(m)) }),
    );
    let mut pod_spec = Map::new();
    if !regular.is_empty() {
        pod_spec.insert("containers".into(), entries(regular));
    }
    if !sidecars.is_empty() {
        pod_spec.insert("initContainers".into(), entries(sidecars));
    }
    let mut body = Map::new();
    body.insert("metadata".into(), Value::Object(metadata));
    if !pod_spec.is_empty() {
        body.insert(
            "spec".into(),
            json!({ "template": { "spec": Value::Object(pod_spec) } }),
        );
    }
    Value::Object(body)
}

/// A change underneath the editor: the annotation always, the resources of
/// every container (as amounts) when the generation moved.
fn changed_underneath(facts: &ResourceFacts, seen: &SeenState) -> bool {
    if facts.workload.override_annotation != seen.override_annotation {
        return true;
    }
    if facts.workload.generation == seen.generation {
        return false;
    }
    let now = &facts.seen.resources;
    now.len() != seen.resources.len()
        || now.iter().any(|(name, resources)| {
            seen.resources.get(name).is_none_or(|was| {
                !ResourceTexts::from(resources).same_amounts(&ResourceTexts::from(was))
            })
        })
}

/// The containers a change can touch: the regular ones, then the native
/// sidecars (the ones `evaluate` and the Deployment payload read a mark against).
fn editable(facts: &ResourceFacts) -> Vec<TemplateContainerInfo> {
    facts
        .workload
        .containers
        .iter()
        .chain(facts.workload.init_containers.iter().filter(|c| c.sidecar))
        .cloned()
        .collect()
}

/// The annotation after an adjust: the active mark carried on, with each
/// changed container's values before and after this change.
fn adjusted_mark(facts: &ResourceFacts, changes: &[Change], at: &str) -> Option<String> {
    let editable = editable(facts);
    let active = active_override(facts.workload.override_annotation.as_deref(), &editable);
    let changed: Vec<OverrideContainer> = editable
        .iter()
        .filter(|c| changes.iter().any(|ch| ch.container == c.name))
        .map(|c| {
            let original = ResourceTexts::from(&c.resources);
            let mut applied = original.clone();
            for ch in changes.iter().filter(|ch| ch.container == c.name) {
                applied
                    .pair_mut(ch.resource)
                    .set(ch.field, ch.after.clone());
            }
            OverrideContainer {
                name: c.name.clone(),
                original,
                applied,
            }
        })
        .collect();
    next_mark(active.as_ref(), &changed, at)
}

/// Now, as RFC 3339 to the second, in UTC.
fn now() -> String {
    k8s_openapi::jiff::Timestamp::now()
        .strftime("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

/// A write the API refused, as the sentence to show.
fn write_error(error: &kube::Error) -> KubeconfigError {
    if api_status_is(error, 403, "Forbidden") {
        refused(NOT_ALLOWED)
    } else if api_status_is(error, 409, "Conflict") {
        refused(TOO_FAST)
    } else {
        KubeconfigError::ClientError {
            reason: api_message(error),
        }
    }
}

/// The outcome of one read, check and write.
enum Attempt {
    Applied(Evaluation),
    Conflict,
}

impl KubeClient {
    /// Reads the facts, refuses a change underneath `seen` and any blocked finding, then sends the patch.
    /// Returns the evaluation the change was applied with.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] whose reason is the sentence
    /// to show: a refusal of the check, a change underneath the editor, or
    /// what the API answered.
    pub async fn apply_resources(
        &self,
        namespace: &str,
        name: &str,
        proposal: &Proposal,
        seen: &SeenState,
        dry_run: bool,
    ) -> Result<Evaluation, KubeconfigError> {
        // A conflict means a write landed between the read and the patch:
        // read, check and write once more, from the read.
        for _ in 0..2 {
            match self
                .apply_once(namespace, name, proposal, seen, dry_run)
                .await?
            {
                Attempt::Applied(evaluation) => return Ok(evaluation),
                Attempt::Conflict => continue,
            }
        }
        Err(refused(TOO_FAST))
    }

    async fn apply_once(
        &self,
        namespace: &str,
        name: &str,
        proposal: &Proposal,
        seen: &SeenState,
        dry_run: bool,
    ) -> Result<Attempt, KubeconfigError> {
        let facts = self.resource_facts(namespace, name).await?;
        if changed_underneath(&facts, seen) {
            return Err(refused(UNDERNEATH));
        }
        let evaluation = evaluate(&facts, proposal);
        if let Some(blocked) = evaluation
            .findings
            .iter()
            .find(|f| f.level == Level::Blocked)
        {
            return Err(refused(&blocked.message));
        }
        if evaluation.changes.is_empty() {
            return Err(refused(NOTHING_TO_CHANGE));
        }
        let mark = match proposal.kind {
            ProposalKind::Adjust => adjusted_mark(&facts, &evaluation.changes, &now()),
            ProposalKind::Restore => None,
        };
        let body = patch_body(
            facts.workload.resource_version.as_deref(),
            &evaluation.changes,
            mark.as_deref(),
        );
        let params = PatchParams {
            field_manager: Some(FIELD_MANAGER.to_string()),
            dry_run,
            ..PatchParams::default()
        };
        let api: Api<Deployment> = Api::namespaced(self.client(), namespace);
        match api.patch(name, &params, &Patch::Strategic(&body)).await {
            Ok(_) => Ok(Attempt::Applied(evaluation)),
            Err(e) if api_status_is(&e, 409, "Conflict") => Ok(Attempt::Conflict),
            Err(e) => Err(write_error(&e)),
        }
    }

    /// Removes the override annotation and nothing else ("Keep these values").
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] whose reason is the sentence
    /// to show.
    pub async fn clear_resources_override(
        &self,
        namespace: &str,
        name: &str,
    ) -> Result<(), KubeconfigError> {
        let body = json!({ "metadata": { "annotations": { OVERRIDE_ANNOTATION: null } } });
        let params = PatchParams {
            field_manager: Some(FIELD_MANAGER.to_string()),
            ..PatchParams::default()
        };
        let api: Api<Deployment> = Api::namespaced(self.client(), namespace);
        api.patch(name, &params, &Patch::Merge(&body))
            .await
            .map(|_| ())
            .map_err(|e| write_error(&e))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use http::{Method, StatusCode};
    use serde_json::{json, Value};

    use super::*;
    use crate::limits::fixtures::{
        cluster, facts, forbidden_json, set, status_json, Cluster, DEPLOYMENT,
    };
    use crate::limits::mark::{active_override, next_mark, parse_mark, OverrideContainer};
    use crate::limits::types::{
        FindingCode, Level, PairText, ProposalKind, ResourceField::*, ResourceName::*,
        ResourceTexts,
    };
    use crate::limits::OVERRIDE_ANNOTATION;
    use crate::test_support::{mock_client, requests, Seen};

    const UNDERNEATH: &str =
        "The deployment's resources changed since you opened this. Reopen and try again.";

    fn change(
        container: &str,
        sidecar: bool,
        resource: crate::limits::ResourceName,
        field: crate::limits::ResourceField,
        before: Option<&str>,
        after: Option<&str>,
    ) -> Change {
        Change {
            container: container.into(),
            sidecar,
            resource,
            field,
            before: before.map(str::to_string),
            after: after.map(str::to_string),
        }
    }

    fn texts(
        cpu: (Option<&str>, Option<&str>),
        memory: (Option<&str>, Option<&str>),
    ) -> ResourceTexts {
        let s = |v: Option<&str>| v.map(str::to_string);
        ResourceTexts {
            cpu: PairText {
                request: s(cpu.0),
                limit: s(cpu.1),
            },
            memory: PairText {
                request: s(memory.0),
                limit: s(memory.1),
            },
        }
    }

    /// The baseline `api` container's values, with its memory limit.
    fn api(memory_limit: Option<&str>) -> ResourceTexts {
        texts((Some("250m"), Some("500m")), (Some("256Mi"), memory_limit))
    }

    // --- patch_body -------------------------------------------------------

    #[test]
    fn patch_body_writes_only_changed_fields_by_container_name() {
        let body = patch_body(
            Some("812"),
            &[
                change("api", false, Memory, Limit, Some("512Mi"), Some("768Mi")),
                change("envoy", true, Cpu, Request, Some("100m"), Some("200m")),
            ],
            Some("<json>"),
        );
        assert_eq!(
            body,
            json!({
                "metadata": {
                    "resourceVersion": "812",
                    "annotations": { "cubelite.app/resources-override": "<json>" },
                },
                "spec": { "template": { "spec": {
                    "containers": [
                        { "name": "api", "resources": { "limits": { "memory": "768Mi" } } }
                    ],
                    "initContainers": [
                        { "name": "envoy", "resources": { "requests": { "cpu": "200m" } } }
                    ],
                } } },
            })
        );
    }

    #[test]
    fn patch_body_groups_the_fields_of_a_container_in_one_entry() {
        let body = patch_body(
            Some("812"),
            &[
                change("api", false, Cpu, Request, Some("250m"), Some("300m")),
                change("api", false, Cpu, Limit, Some("500m"), Some("1")),
                change("api", false, Memory, Limit, Some("512Mi"), Some("1Gi")),
                change("envoy", false, Memory, Request, Some("64Mi"), Some("96Mi")),
            ],
            Some("<json>"),
        );
        assert_eq!(
            body["spec"]["template"]["spec"],
            json!({ "containers": [
                { "name": "api", "resources": {
                    "requests": { "cpu": "300m" },
                    "limits": { "cpu": "1", "memory": "1Gi" },
                } },
                { "name": "envoy", "resources": { "requests": { "memory": "96Mi" } } },
            ] })
        );
    }

    #[test]
    fn patch_body_puts_a_native_sidecar_under_init_containers() {
        let body = patch_body(
            Some("812"),
            &[change(
                "mesh",
                true,
                Memory,
                Limit,
                Some("64Mi"),
                Some("128Mi"),
            )],
            Some("<json>"),
        );
        assert_eq!(
            body["spec"]["template"]["spec"],
            json!({ "initContainers": [
                { "name": "mesh", "resources": { "limits": { "memory": "128Mi" } } }
            ] })
        );
    }

    #[test]
    fn patch_body_clears_with_null_and_removes_the_mark_with_null() {
        let body = patch_body(
            None,
            &[change("api", false, Memory, Limit, Some("512Mi"), None)],
            None,
        );
        assert_eq!(
            body,
            json!({
                "metadata": { "annotations": { "cubelite.app/resources-override": null } },
                "spec": { "template": { "spec": { "containers": [
                    { "name": "api", "resources": { "limits": { "memory": null } } }
                ] } } },
            })
        );
    }

    // --- apply_resources --------------------------------------------------

    /// What `apply_resources` answered, and the requests the cluster saw.
    async fn apply_on(
        client: KubeClient,
        server: tokio::task::JoinHandle<Vec<Seen>>,
        proposal: &Proposal,
        seen: &SeenState,
        dry_run: bool,
    ) -> (Result<Evaluation, String>, Vec<Seen>) {
        let result = client
            .apply_resources("default", "api", proposal, seen, dry_run)
            .await
            .map_err(|e| match e {
                KubeconfigError::ClientError { reason } => reason,
                other => panic!("unexpected error {other:?}"),
            });
        (result, requests(client, server).await)
    }

    async fn apply(
        cluster: Cluster,
        proposal: &Proposal,
        seen: &SeenState,
        dry_run: bool,
    ) -> (Result<Evaluation, String>, Vec<Seen>) {
        let (client, server) = cluster.client();
        apply_on(client, server, proposal, seen, dry_run).await
    }

    /// What the editor saw when it opened on `cluster`.
    async fn seen_of(cluster: &Cluster) -> SeenState {
        let (client, server) = cluster.clone().client();
        let f = client
            .resource_facts("default", "api")
            .await
            .expect("facts");
        requests(client, server).await;
        f.seen
    }

    fn patches(seen: &[Seen]) -> Vec<&Seen> {
        seen.iter().filter(|s| s.method == Method::PATCH).collect()
    }

    /// The only PATCH the cluster saw.
    fn the_patch(seen: &[Seen]) -> &Seen {
        let p = patches(seen);
        assert_eq!(p.len(), 1, "one PATCH");
        p[0]
    }

    /// The annotation a patch writes, as JSON text.
    fn written_mark(patch: &Seen) -> Option<String> {
        patch.body["metadata"]["annotations"][OVERRIDE_ANNOTATION]
            .as_str()
            .map(str::to_string)
    }

    /// The baseline with an active mark on `api`'s memory limit: `original`
    /// before the first change, 768Mi now.
    fn with_mark(original: Option<&str>) -> Cluster {
        let mark = next_mark(
            None,
            &[OverrideContainer {
                name: "api".into(),
                original: api(original),
                applied: api(Some("768Mi")),
            }],
            "2026-11-13T11:20:00Z",
        )
        .expect("a mark");
        let mut c = cluster();
        c.deployment["metadata"]["annotations"] = json!({ OVERRIDE_ANNOTATION: mark });
        c.deployment["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]
            ["memory"] = json!("768Mi");
        c
    }

    #[tokio::test]
    async fn apply_sends_one_strategic_patch_with_the_version_just_read() {
        let (result, seen) = apply(
            cluster(),
            &set("api", Memory, Limit, Some("768Mi")),
            &facts().seen,
            false,
        )
        .await;
        let evaluation = result.expect("applied");
        assert_eq!(evaluation.changes.len(), 1);
        let patch = the_patch(&seen);
        assert!(
            std::ptr::eq(patch, seen.last().expect("a request")),
            "the PATCH is last"
        );
        assert!(
            patch.uri.starts_with(&format!("{DEPLOYMENT}?")),
            "{}",
            patch.uri
        );
        assert!(patch.uri.contains("fieldManager=cubelite"), "{}", patch.uri);
        assert!(!patch.uri.contains("dryRun"), "{}", patch.uri);
        assert_eq!(
            patch.content_type.as_deref(),
            Some("application/strategic-merge-patch+json")
        );
        assert_eq!(patch.body["metadata"]["resourceVersion"], json!("812"));
        assert_eq!(
            patch.body["spec"]["template"]["spec"]["containers"],
            json!([{ "name": "api", "resources": { "limits": { "memory": "768Mi" } } }])
        );
        assert!(patch.body["spec"]["template"]["spec"]
            .get("initContainers")
            .is_none());
        let mark = parse_mark(written_mark(patch).as_deref()).expect("a mark");
        assert_eq!(mark.containers.len(), 1);
        assert_eq!(mark.containers[0].name, "api");
        assert_eq!(mark.containers[0].original, api(Some("512Mi")));
        assert_eq!(mark.containers[0].applied, api(Some("768Mi")));
        // RFC 3339, seconds, UTC.
        assert_eq!(mark.at.len(), "2026-11-13T11:20:00Z".len(), "{}", mark.at);
        assert!(mark.at.ends_with('Z'), "{}", mark.at);
        mark.at
            .parse::<k8s_openapi::jiff::Timestamp>()
            .expect("at is RFC 3339");
    }

    #[tokio::test]
    async fn the_written_mark_is_active_against_the_values_the_patch_sets() {
        let proposal = crate::limits::fixtures::and(
            set("api", Memory, Limit, Some("1024Mi")),
            "api",
            Cpu,
            Request,
            Some("0.3"),
        );
        let (result, seen) = apply(cluster(), &proposal, &facts().seen, false).await;
        result.expect("applied");
        let patch = the_patch(&seen);
        let mark = written_mark(patch);
        // The template as the cluster will hold it, in its canonical form.
        let mut after = facts().workload.containers;
        after[0] = crate::limits::fixtures::container(
            "api",
            false,
            (Some("300m"), Some("500m")),
            (Some("256Mi"), Some("1Gi")),
        );
        let active = active_override(mark.as_deref(), &after).expect("the mark is active");
        assert_eq!(active.containers[0].original, api(Some("512Mi")));
        // And stale against the values before the change.
        assert_eq!(
            active_override(mark.as_deref(), &facts().workload.containers),
            None
        );
    }

    #[tokio::test]
    async fn dry_run_sends_the_same_patch_with_dry_run_all() {
        let proposal = set("api", Memory, Limit, Some("768Mi"));
        let (real, real_seen) = apply(cluster(), &proposal, &facts().seen, false).await;
        let (dry, dry_seen) = apply(cluster(), &proposal, &facts().seen, true).await;
        assert_eq!(dry.expect("dry run"), real.expect("applied"));
        // Nothing but reads and one PATCH carrying dryRun=All.
        let patch = the_patch(&dry_seen);
        assert!(dry_seen
            .iter()
            .all(|s| s.method == Method::GET || std::ptr::eq(s, patch)));
        assert!(patch.uri.contains("dryRun=All"), "{}", patch.uri);
        assert!(patch.uri.contains("fieldManager=cubelite"), "{}", patch.uri);
        assert_eq!(
            patch.content_type.as_deref(),
            Some("application/strategic-merge-patch+json")
        );
        // The same body, but for the time in the mark.
        let without_at = |p: &Seen| {
            let mut body = p.body.clone();
            let mut mark: Value =
                serde_json::from_str(&written_mark(p).expect("a mark")).expect("mark json");
            mark["at"] = Value::Null;
            body["metadata"]["annotations"][OVERRIDE_ANNOTATION] = mark;
            body
        };
        assert_eq!(without_at(patch), without_at(the_patch(&real_seen)));
    }

    #[tokio::test]
    async fn a_blocked_change_is_refused_and_nothing_is_patched() {
        let (result, seen) = apply(
            cluster(),
            &set("api", Memory, Limit, Some("200Mi")),
            &facts().seen,
            false,
        )
        .await;
        assert_eq!(
            result.expect_err("refused"),
            "The limit (200Mi) is under the request (256Mi)."
        );
        assert!(patches(&seen).is_empty());
        // The dry run refuses the same way.
        let (result, seen) = apply(
            cluster(),
            &set("api", Memory, Limit, None),
            &facts().seen,
            true,
        )
        .await;
        assert_eq!(
            result.expect_err("refused"),
            "A request or a limit cannot be removed here."
        );
        assert!(patches(&seen).is_empty());
    }

    #[tokio::test]
    async fn the_check_runs_on_the_facts_read_now_not_on_what_the_caller_saw() {
        // A LimitRange created after the editor opened: the apply sees it.
        let mut c = cluster();
        c.limit_ranges = vec![json!({
            "metadata": { "name": "limits", "namespace": "default" },
            "spec": { "limits": [ { "type": "Container", "max": { "memory": "1Gi" } } ] },
        })];
        let (result, seen) = apply(
            c,
            &set("api", Memory, Limit, Some("2Gi")),
            &facts().seen,
            false,
        )
        .await;
        assert_eq!(
            result.expect_err("refused"),
            "LimitRange `limits`: memory limit 2Gi of `api` is above the maximum 1Gi."
        );
        assert!(patches(&seen).is_empty());
    }

    #[tokio::test]
    async fn a_warning_does_not_stop_the_apply_and_is_returned() {
        let (result, seen) = apply(
            cluster(),
            &set("api", Memory, Limit, Some("400Mi")),
            &facts().seen,
            false,
        )
        .await;
        let evaluation = result.expect("applied");
        let w4 = evaluation
            .findings
            .iter()
            .find(|f| f.code == FindingCode::W4)
            .expect("W4");
        assert_eq!(w4.level, Level::Warning);
        assert_eq!(
            w4.message,
            "The container would be OOMKilled as soon as it starts using what it uses now (498Mi)."
        );
        the_patch(&seen);
    }

    #[tokio::test]
    async fn a_quota_already_exceeded_that_the_change_does_not_worsen_does_not_stop_it() {
        // The three pods hold 960Mi of a 900Mi quota already; a lower
        // request helps, though they still do not fit.
        let mut c = cluster();
        c.quotas = vec![json!({
            "metadata": { "name": "team", "namespace": "default" },
            "spec": { "hard": { "requests.memory": "900Mi" } },
            "status": {
                "hard": { "requests.memory": "900Mi" },
                "used": { "requests.memory": "960Mi" },
            },
        })];
        let (result, seen) = apply(
            c.clone(),
            &set("api", Memory, Request, Some("250Mi")),
            &facts().seen,
            false,
        )
        .await;
        let evaluation = result.expect("applied");
        let b5 = evaluation
            .findings
            .iter()
            .find(|f| f.code == FindingCode::B5)
            .expect("B5");
        assert_eq!(b5.level, Level::Warning);
        assert!(
            b5.message
                .ends_with(" It was already so before this change."),
            "{}",
            b5.message
        );
        the_patch(&seen);
        // Raised, it is refused.
        let (result, seen) = apply(
            c,
            &set("api", Memory, Request, Some("300Mi")),
            &facts().seen,
            false,
        )
        .await;
        assert_eq!(
            result.expect_err("refused"),
            "Quota `team`: 3 replicas need 1.1Gi of requests.memory; 900Mi is free of 900Mi."
        );
        assert!(patches(&seen).is_empty());
    }

    #[tokio::test]
    async fn nothing_to_change_is_refused() {
        // 512Mi typed as 0.5Gi, 500m typed as 0.5: the same amounts.
        let proposal = crate::limits::fixtures::and(
            set("api", Memory, Limit, Some("0.5Gi")),
            "api",
            Cpu,
            Limit,
            Some("0.5"),
        );
        let (result, seen) = apply(cluster(), &proposal, &facts().seen, false).await;
        assert_eq!(result.expect_err("refused"), "Nothing to change.");
        assert!(patches(&seen).is_empty());
    }

    #[tokio::test]
    async fn resources_changed_underneath_are_refused() {
        let proposal = set("api", Memory, Limit, Some("768Mi"));
        // The editor opened at generation 6, with another memory limit.
        let mut seen = facts().seen;
        seen.generation = 6;
        seen.resources.insert(
            "api".into(),
            crate::limits::fixtures::resources(
                (Some("250m"), Some("500m")),
                (Some("256Mi"), Some("384Mi")),
            ),
        );
        let (result, requests_seen) = apply(cluster(), &proposal, &seen, false).await;
        assert_eq!(result.expect_err("refused"), UNDERNEATH);
        assert!(patches(&requests_seen).is_empty());

        // A container added since: refused too.
        let mut seen = facts().seen;
        seen.generation = 6;
        seen.resources.remove("envoy");
        let (result, _) = apply(cluster(), &proposal, &seen, true).await;
        assert_eq!(result.expect_err("refused"), UNDERNEATH);
    }

    #[tokio::test]
    async fn the_mark_changed_underneath_is_refused() {
        let proposal = set("api", Memory, Limit, Some("768Mi"));
        // The cluster has a mark the editor did not see, at the same generation.
        let c = with_mark(Some("512Mi"));
        let mut seen = seen_of(&c).await;
        seen.override_annotation = None;
        let (result, requests_seen) = apply(c, &proposal, &seen, false).await;
        assert_eq!(result.expect_err("refused"), UNDERNEATH);
        assert!(patches(&requests_seen).is_empty());
        // The editor saw a mark the cluster no longer has.
        let mut seen = facts().seen;
        seen.override_annotation = Some("{\"v\":1}".into());
        let (result, _) = apply(cluster(), &proposal, &seen, true).await;
        assert_eq!(result.expect_err("refused"), UNDERNEATH);
    }

    #[tokio::test]
    async fn a_generation_moved_by_a_scale_is_not_refused() {
        // Generation 6 when the editor opened, 7 now; the same resources,
        // one of them written in another unit.
        let mut seen = facts().seen;
        seen.generation = 6;
        seen.resources.insert(
            "api".into(),
            crate::limits::fixtures::resources(
                (Some("0.25"), Some("500m")),
                (Some("256Mi"), Some("0.5Gi")),
            ),
        );
        let (result, requests_seen) = apply(
            cluster(),
            &set("api", Memory, Limit, Some("768Mi")),
            &seen,
            false,
        )
        .await;
        result.expect("applied");
        the_patch(&requests_seen);
    }

    #[tokio::test]
    async fn the_resources_are_compared_only_when_the_generation_moved() {
        // The same generation: the spec has not changed since the editor
        // opened, whatever the resources it sent back.
        let mut seen = facts().seen;
        seen.resources.insert(
            "api".into(),
            crate::limits::fixtures::resources((None, None), (None, None)),
        );
        let (result, _) = apply(
            cluster(),
            &set("api", Memory, Limit, Some("768Mi")),
            &seen,
            false,
        )
        .await;
        result.expect("applied");
    }

    /// A cluster whose PATCHes are answered in turn by `answers` (the last
    /// one repeats), and whose Deployment GETs carry a resource version
    /// that moves at each read.
    fn conflicting(
        answers: Vec<(u16, Value)>,
    ) -> (
        KubeClient,
        tokio::task::JoinHandle<Vec<Seen>>,
        Arc<AtomicUsize>,
    ) {
        let base = cluster();
        let reads = Arc::new(AtomicUsize::new(0));
        let patched = AtomicUsize::new(0);
        let counted = reads.clone();
        let (client, server) = mock_client(move |method, uri| {
            if method == Method::PATCH {
                let n = patched.fetch_add(1, Ordering::SeqCst);
                let (status, body) = answers[n.min(answers.len() - 1)].clone();
                return (StatusCode::from_u16(status).expect("status"), body);
            }
            if uri.starts_with(DEPLOYMENT) {
                let n = counted.fetch_add(1, Ordering::SeqCst);
                let mut d = base.deployment.clone();
                d["metadata"]["resourceVersion"] = json!((812 + n).to_string());
                return (StatusCode::OK, d);
            }
            base.respond(method, uri)
        });
        (client, server, reads)
    }

    fn conflict() -> (u16, Value) {
        (
            409,
            status_json(
                409,
                "Conflict",
                "Operation cannot be fulfilled on deployments.apps \"api\": the object has been modified",
            ),
        )
    }

    #[tokio::test]
    async fn one_conflict_is_retried_from_the_read() {
        let (client, server, reads) = conflicting(vec![conflict(), (200, cluster().deployment)]);
        let (result, seen) = apply_on(
            client,
            server,
            &set("api", Memory, Limit, Some("768Mi")),
            &facts().seen,
            false,
        )
        .await;
        result.expect("applied on the second try");
        assert_eq!(reads.load(Ordering::SeqCst), 2, "the Deployment read twice");
        let p = patches(&seen);
        assert_eq!(p.len(), 2);
        // Each PATCH carries the version read just before it.
        assert_eq!(p[0].body["metadata"]["resourceVersion"], json!("812"));
        assert_eq!(p[1].body["metadata"]["resourceVersion"], json!("813"));
    }

    #[tokio::test]
    async fn a_second_conflict_gives_up_with_its_sentence() {
        let (client, server, reads) = conflicting(vec![conflict()]);
        let (result, seen) = apply_on(
            client,
            server,
            &set("api", Memory, Limit, Some("768Mi")),
            &facts().seen,
            false,
        )
        .await;
        assert_eq!(
            result.expect_err("gave up"),
            "The deployment is changing too fast to update. Try again."
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        assert_eq!(patches(&seen).len(), 2);
    }

    #[tokio::test]
    async fn forbidden_reads_as_not_allowed() {
        let c = cluster().on(
            Method::PATCH,
            DEPLOYMENT,
            403,
            forbidden_json(
                "deployments.apps \"api\" is forbidden: User \"viewer\" cannot patch resource \"deployments\"",
            ),
        );
        let (result, _) = apply(
            c,
            &set("api", Memory, Limit, Some("768Mi")),
            &facts().seen,
            true,
        )
        .await;
        assert_eq!(
            result.expect_err("forbidden"),
            "You are not allowed to change this deployment."
        );
    }

    #[tokio::test]
    async fn an_admission_rejection_shows_the_api_message() {
        let message =
            "admission webhook \"validate.kyverno.svc\" denied the request: denied by policy";
        let c = cluster().on(
            Method::PATCH,
            DEPLOYMENT,
            400,
            status_json(400, "BadRequest", message),
        );
        let (result, _) = apply(
            c,
            &set("api", Memory, Limit, Some("768Mi")),
            &facts().seen,
            true,
        )
        .await;
        assert_eq!(result.expect_err("rejected"), message);
    }

    #[tokio::test]
    async fn a_second_change_keeps_the_first_original_in_the_mark() {
        let c = with_mark(Some("512Mi"));
        let seen = seen_of(&c).await;
        let proposal = {
            let mut p = set("api", Memory, Limit, Some("1Gi"));
            // The cluster's values now: 768Mi.
            p.containers[0].resources = api(Some("1Gi"));
            p
        };
        let (result, requests_seen) = apply(c, &proposal, &seen, false).await;
        let evaluation = result.expect("applied");
        assert_eq!(
            evaluation.changes,
            [change(
                "api",
                false,
                Memory,
                Limit,
                Some("768Mi"),
                Some("1Gi")
            )]
        );
        let mark = parse_mark(written_mark(the_patch(&requests_seen)).as_deref()).expect("mark");
        assert_eq!(mark.containers.len(), 1);
        assert_eq!(mark.containers[0].original, api(Some("512Mi")));
        assert_eq!(mark.containers[0].applied, api(Some("1Gi")));
        assert_ne!(mark.at, "2026-11-13T11:20:00Z");
    }

    #[tokio::test]
    async fn changing_back_to_the_original_by_hand_removes_the_mark() {
        let c = with_mark(Some("512Mi"));
        let seen = seen_of(&c).await;
        let mut proposal = set("api", Memory, Limit, Some("512Mi"));
        proposal.containers[0].resources = api(Some("512Mi"));
        let (result, requests_seen) = apply(c, &proposal, &seen, false).await;
        result.expect("applied");
        let patch = the_patch(&requests_seen);
        assert_eq!(
            patch.body["metadata"]["annotations"],
            json!({ OVERRIDE_ANNOTATION: null })
        );
    }

    #[tokio::test]
    async fn a_foreign_or_stale_annotation_is_replaced_by_a_fresh_mark() {
        let mut c = cluster();
        c.deployment["metadata"]["annotations"] = json!({ OVERRIDE_ANNOTATION: "garbage" });
        let seen = seen_of(&c).await;
        let (result, requests_seen) =
            apply(c, &set("envoy", Memory, Limit, Some("256Mi")), &seen, false).await;
        result.expect("applied");
        let mark = parse_mark(written_mark(the_patch(&requests_seen)).as_deref()).expect("mark");
        let names: Vec<&str> = mark.containers.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["envoy"]);
        assert_eq!(
            mark.containers[0].original.memory.limit.as_deref(),
            Some("128Mi")
        );
        assert_eq!(
            mark.containers[0].applied.memory.limit.as_deref(),
            Some("256Mi")
        );
    }

    fn restore() -> Proposal {
        Proposal {
            kind: ProposalKind::Restore,
            containers: Vec::new(),
        }
    }

    #[tokio::test]
    async fn restore_puts_the_original_back_and_removes_the_mark() {
        let c = with_mark(Some("512Mi"));
        let seen = seen_of(&c).await;
        let (result, requests_seen) = apply(c, &restore(), &seen, false).await;
        result.expect("restored");
        let patch = the_patch(&requests_seen);
        assert_eq!(
            patch.body["spec"]["template"]["spec"]["containers"],
            json!([{ "name": "api", "resources": { "limits": { "memory": "512Mi" } } }])
        );
        assert_eq!(
            patch.body["metadata"]["annotations"],
            json!({ OVERRIDE_ANNOTATION: null })
        );
    }

    #[tokio::test]
    async fn restore_to_a_value_that_was_not_set_clears_it() {
        let c = with_mark(None);
        let seen = seen_of(&c).await;
        let (result, requests_seen) = apply(c, &restore(), &seen, true).await;
        let evaluation = result.expect("restored");
        assert_eq!(
            evaluation.changes,
            [change("api", false, Memory, Limit, Some("768Mi"), None)]
        );
        let patch = the_patch(&requests_seen);
        assert_eq!(
            patch.body["spec"]["template"]["spec"]["containers"],
            json!([{ "name": "api", "resources": { "limits": { "memory": null } } }])
        );
        assert!(patch.uri.contains("dryRun=All"));
    }

    #[tokio::test]
    async fn restore_without_an_active_mark_is_refused() {
        let (result, seen) = apply(cluster(), &restore(), &facts().seen, false).await;
        assert_eq!(
            result.expect_err("refused"),
            "There is no active override to restore."
        );
        assert!(patches(&seen).is_empty());
    }

    // --- clear_resources_override -----------------------------------------

    async fn clear(cluster: Cluster) -> (Result<(), String>, Vec<Seen>) {
        let (client, server) = cluster.client();
        let result = client
            .clear_resources_override("default", "api")
            .await
            .map_err(|e| match e {
                KubeconfigError::ClientError { reason } => reason,
                other => panic!("unexpected error {other:?}"),
            });
        (result, requests(client, server).await)
    }

    #[tokio::test]
    async fn clear_override_patches_the_annotation_only() {
        let (result, seen) = clear(with_mark(Some("512Mi"))).await;
        result.expect("cleared");
        assert_eq!(seen.len(), 1, "one request, no read");
        let patch = &seen[0];
        assert_eq!(patch.method, Method::PATCH);
        assert!(
            patch.uri.starts_with(&format!("{DEPLOYMENT}?")),
            "{}",
            patch.uri
        );
        assert!(patch.uri.contains("fieldManager=cubelite"), "{}", patch.uri);
        assert!(!patch.uri.contains("dryRun"), "{}", patch.uri);
        assert_eq!(
            patch.content_type.as_deref(),
            Some("application/merge-patch+json")
        );
        assert_eq!(
            patch.body,
            json!({ "metadata": { "annotations": { "cubelite.app/resources-override": null } } })
        );
    }

    #[tokio::test]
    async fn clear_override_maps_errors_as_the_apply_does() {
        let (result, _) = clear(cluster().on(
            Method::PATCH,
            DEPLOYMENT,
            403,
            forbidden_json("deployments.apps \"api\" is forbidden"),
        ))
        .await;
        assert_eq!(
            result.expect_err("forbidden"),
            "You are not allowed to change this deployment."
        );
        let (result, _) = clear(cluster().on(
            Method::PATCH,
            DEPLOYMENT,
            404,
            status_json(404, "NotFound", "deployments.apps \"api\" not found"),
        ))
        .await;
        assert_eq!(
            result.expect_err("gone"),
            "deployments.apps \"api\" not found"
        );
    }
}
