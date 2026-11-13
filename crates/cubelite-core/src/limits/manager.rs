//! Who manages a workload, read from its labels and annotations (spec §5).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The tool that applies a workload, as far as its metadata tells.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagerKind {
    /// Argo CD (tracking annotation or instance label).
    ArgoCd,
    /// A Flux Kustomization.
    FluxKustomization,
    /// A Flux HelmRelease.
    FluxHelmRelease,
    /// A Helm release.
    Helm,
    /// Labels that GitOps tools use, but no tool recognised.
    PossiblyManaged,
    /// Nothing recognised.
    #[default]
    None,
}

/// Who manages a workload.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ManagerInfo {
    /// The kind of manager.
    pub kind: ManagerKind,
    /// The Helm release name; set for [`ManagerKind::Helm`] only.
    pub release: Option<String>,
}

const ARGO_TRACKING_ANNOTATION: &str = "argocd.argoproj.io/tracking-id";
const ARGO_INSTANCE_LABEL: &str = "argocd.argoproj.io/instance";
const FLUX_KUSTOMIZATION_LABEL: &str = "kustomize.toolkit.fluxcd.io/name";
const FLUX_HELM_RELEASE_LABEL: &str = "helm.toolkit.fluxcd.io/name";
const HELM_RELEASE_ANNOTATION: &str = "meta.helm.sh/release-name";
const INSTANCE_LABEL: &str = "app.kubernetes.io/instance";
const MANAGED_BY_LABEL: &str = "app.kubernetes.io/managed-by";

/// Who manages a workload: the first row of spec §5 that matches.
pub fn detect_manager(
    labels: &BTreeMap<String, String>,
    annotations: &BTreeMap<String, String>,
) -> ManagerInfo {
    let kind = |kind| ManagerInfo {
        kind,
        release: None,
    };
    if annotations.contains_key(ARGO_TRACKING_ANNOTATION)
        || labels.contains_key(ARGO_INSTANCE_LABEL)
    {
        return kind(ManagerKind::ArgoCd);
    }
    if labels.contains_key(FLUX_KUSTOMIZATION_LABEL) {
        return kind(ManagerKind::FluxKustomization);
    }
    if labels.contains_key(FLUX_HELM_RELEASE_LABEL) {
        return kind(ManagerKind::FluxHelmRelease);
    }
    if let Some(release) = annotations.get(HELM_RELEASE_ANNOTATION) {
        return ManagerInfo {
            kind: ManagerKind::Helm,
            release: Some(release.clone()),
        };
    }
    if labels.contains_key(INSTANCE_LABEL) || labels.contains_key(MANAGED_BY_LABEL) {
        return kind(ManagerKind::PossiblyManaged);
    }
    kind(ManagerKind::None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn none() -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    #[test]
    fn argo_cd_by_tracking_annotation_or_instance_label() {
        let by_annotation = detect_manager(
            &none(),
            &map(&[(ARGO_TRACKING_ANNOTATION, "shop:apps/Deployment:default/api")]),
        );
        assert_eq!(
            by_annotation,
            ManagerInfo {
                kind: ManagerKind::ArgoCd,
                release: None
            }
        );
        let by_label = detect_manager(&map(&[(ARGO_INSTANCE_LABEL, "shop")]), &none());
        assert_eq!(by_label.kind, ManagerKind::ArgoCd);
        // The Argo CD label is not the generic instance label.
        let generic = detect_manager(&map(&[(INSTANCE_LABEL, "shop")]), &none());
        assert_ne!(generic.kind, ManagerKind::ArgoCd);
    }

    #[test]
    fn flux_kustomization_and_helm_release_by_their_labels() {
        let k = detect_manager(&map(&[(FLUX_KUSTOMIZATION_LABEL, "apps")]), &none());
        assert_eq!(
            k,
            ManagerInfo {
                kind: ManagerKind::FluxKustomization,
                release: None
            }
        );
        let h = detect_manager(&map(&[(FLUX_HELM_RELEASE_LABEL, "orders")]), &none());
        assert_eq!(
            h,
            ManagerInfo {
                kind: ManagerKind::FluxHelmRelease,
                release: None
            }
        );
        // An annotation with a Flux key is not a label.
        let as_annotation = detect_manager(&none(), &map(&[(FLUX_KUSTOMIZATION_LABEL, "apps")]));
        assert_eq!(as_annotation.kind, ManagerKind::None);
    }

    #[test]
    fn flux_helm_release_wins_over_the_helm_annotation_it_also_carries() {
        let m = detect_manager(
            &map(&[
                (FLUX_HELM_RELEASE_LABEL, "orders"),
                (MANAGED_BY_LABEL, "Helm"),
            ]),
            &map(&[(HELM_RELEASE_ANNOTATION, "orders")]),
        );
        assert_eq!(
            m,
            ManagerInfo {
                kind: ManagerKind::FluxHelmRelease,
                release: None
            }
        );
        // And Argo CD wins over everything after it.
        let argo = detect_manager(
            &map(&[
                (ARGO_INSTANCE_LABEL, "shop"),
                (FLUX_KUSTOMIZATION_LABEL, "apps"),
            ]),
            &map(&[(HELM_RELEASE_ANNOTATION, "orders")]),
        );
        assert_eq!(argo.kind, ManagerKind::ArgoCd);
        let kustomization = detect_manager(
            &map(&[
                (FLUX_KUSTOMIZATION_LABEL, "apps"),
                (FLUX_HELM_RELEASE_LABEL, "orders"),
            ]),
            &none(),
        );
        assert_eq!(kustomization.kind, ManagerKind::FluxKustomization);
    }

    #[test]
    fn helm_needs_the_release_annotation_and_reports_the_release() {
        let helm = detect_manager(&none(), &map(&[(HELM_RELEASE_ANNOTATION, "orders")]));
        assert_eq!(
            helm,
            ManagerInfo {
                kind: ManagerKind::Helm,
                release: Some("orders".into())
            }
        );
        let label_only = detect_manager(&map(&[(MANAGED_BY_LABEL, "Helm")]), &none());
        assert_eq!(
            label_only,
            ManagerInfo {
                kind: ManagerKind::PossiblyManaged,
                release: None
            }
        );
    }

    #[test]
    fn possibly_managed_by_instance_or_managed_by_label_alone() {
        let instance = detect_manager(&map(&[(INSTANCE_LABEL, "shop")]), &none());
        assert_eq!(instance.kind, ManagerKind::PossiblyManaged);
        let managed_by = detect_manager(&map(&[(MANAGED_BY_LABEL, "kustomize")]), &none());
        assert_eq!(managed_by.kind, ManagerKind::PossiblyManaged);
        assert_eq!(managed_by.release, None);
    }

    #[test]
    fn nothing_recognised_is_none() {
        let m = detect_manager(&map(&[("app", "api")]), &map(&[("note", "x")]));
        assert_eq!(m, ManagerInfo::default());
        assert_eq!(m.kind, ManagerKind::None);
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            serde_json::json!({ "kind": "none", "release": null })
        );
        assert_eq!(
            serde_json::to_value(ManagerKind::ArgoCd).unwrap(),
            serde_json::json!("argo_cd")
        );
    }
}
