//! Per-context cluster settings (#662), kept by the backend in
//! `cluster-access.json` in the app config directory, never in the webview.
//!
//! This first part holds each context's environment label (detected from its
//! name or set by hand) and the variants detection reads. The read-only state
//! of the second part goes in the same file: every field defaults, so a file
//! written by either version reads in the other.
//!
//! Writes are atomic (a temp file renamed over the old one). A file that
//! cannot be read is set aside as `cluster-access.json.bad` and replaced by
//! defaults; the next answer to the webview says so once.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use cubelite_core::environment::{detect, validate_variants, Environment, Variants};
use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, Emitter};

/// The settings file's name in the app config directory.
pub const FILE_NAME: &str = "cluster-access.json";

/// Emitted to every window after a change, payload `()`.
pub const CLUSTER_SETTINGS_CHANGED: &str = "cluster-settings-changed";

/// The version written in the file.
const VERSION: u32 = 1;

/// The whole settings file.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(default)]
pub struct SettingsFile {
    /// The format version.
    pub version: u32,
    /// One record per context name ever seen.
    pub contexts: BTreeMap<String, ContextRecord>,
    /// The words that name each environment.
    pub variants: Variants,
}

impl Default for SettingsFile {
    fn default() -> Self {
        SettingsFile {
            version: VERSION,
            contexts: BTreeMap::new(),
            variants: Variants::default(),
        }
    }
}

/// What is kept for one context.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(default)]
pub struct ContextRecord {
    /// Where its environment label comes from.
    #[serde(deserialize_with = "lenient_setting")]
    pub environment: EnvironmentSetting,
}

/// A context's environment: detected from its name, or chosen by hand.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, Default, PartialEq, Eq)]
#[serde(tag = "source", rename_all = "lowercase")]
pub enum EnvironmentSetting {
    /// Read from the context name with the current variants.
    #[default]
    Detected,
    /// Chosen by hand; `None` is "Not set".
    Manual {
        /// The environment chosen, or none.
        #[serde(default, deserialize_with = "lenient_environment")]
        value: Option<Environment>,
    },
}

/// An environment this version does not know (written by a newer one) reads
/// as not set, never as an error that would discard the whole file.
fn lenient_environment<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Environment>, D::Error> {
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(serde_json::Value::String(text)) => Environment::parse(&text),
        _ => None,
    })
}

/// A setting this version cannot read (an unknown `source`) reads as detected.
fn lenient_setting<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<EnvironmentSetting, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(EnvironmentSetting::deserialize(value).unwrap_or_default())
}

/// How the settings file was found at start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadOutcome {
    /// No file yet: defaults, nothing written.
    Fresh,
    /// The file was read.
    Loaded,
    /// The file could not be read: set aside as `.bad`, defaults used.
    Recovered,
}

/// One context's environment as the webview sees it.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct ContextEnvironmentView {
    pub name: String,
    pub environment: Option<Environment>,
    /// `"detected"` or `"manual"`.
    pub source: &'static str,
    /// What detection reads in the name, whatever the source: the menu's
    /// "Detect from name (Production)" shows it before it is chosen.
    pub detected: Option<Environment>,
}

/// The answer of `cluster_settings` and `set_cluster_environment`.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct ClusterSettingsView {
    /// In the order of the names asked for.
    pub contexts: Vec<ContextEnvironmentView>,
    /// Every environment present, possibly with an empty list.
    pub variants: Variants,
    /// True once, on the first answer after the file was set aside.
    pub recovered: bool,
}

struct Inner {
    file: SettingsFile,
    /// `None`: kept in memory only (no config directory).
    path: Option<PathBuf>,
    recovered_pending: bool,
}

/// The managed state: the settings in memory and where they are saved.
pub struct ClusterAccessState {
    inner: Mutex<Inner>,
}

impl ClusterAccessState {
    /// Read the settings from `path`, setting an unreadable file aside.
    pub fn load(path: PathBuf) -> (Self, LoadOutcome) {
        let read = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<SettingsFile>(&bytes).map_err(|e| e.to_string()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return (
                    Self::with(SettingsFile::default(), Some(path), false),
                    LoadOutcome::Fresh,
                );
            }
            Err(e) => Err(e.to_string()),
        };
        match read {
            Ok(file) => (Self::with(file, Some(path), false), LoadOutcome::Loaded),
            Err(reason) => {
                let bad = path.with_file_name(format!("{FILE_NAME}.bad"));
                eprintln!(
                    "cluster settings: {} could not be read ({reason}); set aside as {}",
                    path.display(),
                    bad.display()
                );
                if let Err(e) = fs::rename(&path, &bad) {
                    eprintln!("cluster settings: could not set the file aside: {e}");
                }
                (
                    Self::with(SettingsFile::default(), Some(path), true),
                    LoadOutcome::Recovered,
                )
            }
        }
    }

    /// Settings that are never saved, when there is no config directory.
    pub fn in_memory() -> Self {
        Self::with(SettingsFile::default(), None, false)
    }

    fn with(file: SettingsFile, path: Option<PathBuf>, recovered_pending: bool) -> Self {
        ClusterAccessState {
            inner: Mutex::new(Inner {
                file,
                path,
                recovered_pending,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while holding the lock leaves plain data behind: keep it.
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The view for `names`, recording every name not seen before.
    ///
    /// A failed save is logged, not returned: the labels are still answered,
    /// and the records are written with the next change.
    pub fn settings(&self, names: &[String]) -> ClusterSettingsView {
        let mut inner = self.lock();
        let mut added = false;
        for name in names {
            if !inner.file.contexts.contains_key(name) {
                inner
                    .file
                    .contexts
                    .insert(name.clone(), ContextRecord::default());
                added = true;
            }
        }
        if added {
            if let Err(e) = inner.save(&inner.file) {
                eprintln!("cluster settings: could not save: {e}");
            }
        }
        let recovered = std::mem::take(&mut inner.recovered_pending);
        inner.view(names, recovered)
    }

    /// Set the environment of `context`; answers the view for that context.
    pub fn set_environment(
        &self,
        context: &str,
        setting: EnvironmentSetting,
    ) -> Result<ClusterSettingsView, String> {
        let mut inner = self.lock();
        let mut next = inner.file.clone();
        next.contexts.insert(
            context.to_string(),
            ContextRecord {
                environment: setting,
            },
        );
        inner.save(&next).map_err(|e| e.to_string())?;
        inner.file = next;
        Ok(inner.view(&[context.to_string()], false))
    }

    /// Replace the variants after validating them; answers what was saved.
    pub fn set_variants(&self, variants: &Variants) -> Result<Variants, String> {
        let valid = validate_variants(variants).map_err(|e| e.to_string())?;
        let mut inner = self.lock();
        let mut next = inner.file.clone();
        next.variants = valid.clone();
        inner.save(&next).map_err(|e| e.to_string())?;
        inner.file = next;
        Ok(valid)
    }
}

impl Inner {
    fn save(&self, file: &SettingsFile) -> io::Result<()> {
        match &self.path {
            Some(path) => save(path, file),
            None => Ok(()),
        }
    }

    fn view(&self, names: &[String], recovered: bool) -> ClusterSettingsView {
        let variants = &self.file.variants;
        ClusterSettingsView {
            contexts: names
                .iter()
                .map(|name| {
                    let setting = self
                        .file
                        .contexts
                        .get(name)
                        .map(|r| r.environment)
                        .unwrap_or_default();
                    view_of(name, setting, variants)
                })
                .collect(),
            variants: complete(variants),
            recovered,
        }
    }
}

/// Write `file` to `path` atomically: a temp file in the same directory,
/// renamed over the old one.
fn save(path: &Path, file: &SettingsFile) -> io::Result<()> {
    let text = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
    let tmp = path.with_file_name(format!("{FILE_NAME}.tmp"));
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

/// The environment of the context `name` under `setting`.
fn view_of(name: &str, setting: EnvironmentSetting, variants: &Variants) -> ContextEnvironmentView {
    let detected = detect(name, variants);
    let (environment, source) = match setting {
        EnvironmentSetting::Detected => (detected, "detected"),
        EnvironmentSetting::Manual { value } => (value, "manual"),
    };
    ContextEnvironmentView {
        name: name.to_string(),
        environment,
        source,
        detected,
    }
}

/// `variants` with every environment present.
fn complete(variants: &Variants) -> Variants {
    Variants(
        Environment::ALL
            .into_iter()
            .map(|env| (env, variants.of(env).to_vec()))
            .collect(),
    )
}

fn changed(app: &AppHandle) {
    // A closed window cannot be told; nothing else to do.
    let _ = app.emit(CLUSTER_SETTINGS_CHANGED, ());
}

/// The environment of each context in `contexts`, recording the ones seen for
/// the first time, and the variants.
#[tauri::command]
pub async fn cluster_settings(
    state: tauri::State<'_, ClusterAccessState>,
    contexts: Vec<String>,
) -> Result<ClusterSettingsView, String> {
    Ok(state.settings(&contexts))
}

/// Set a context's environment by hand, or back to detection.
#[tauri::command]
pub async fn set_cluster_environment(
    app: AppHandle,
    state: tauri::State<'_, ClusterAccessState>,
    context: String,
    setting: EnvironmentSetting,
) -> Result<ClusterSettingsView, String> {
    let view = state.set_environment(&context, setting)?;
    changed(&app);
    Ok(view)
}

/// Replace the environment variants; the error text says which word is wrong.
#[tauri::command]
pub async fn set_environment_variants(
    app: AppHandle,
    state: tauri::State<'_, ClusterAccessState>,
    variants: Variants,
) -> Result<Variants, String> {
    let saved = state.set_variants(&variants)?;
    changed(&app);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use Environment::{Development, Production};

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|n| (*n).to_string()).collect()
    }

    fn file_in(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join(FILE_NAME)
    }

    fn one(view: &ClusterSettingsView, name: &str) -> (Option<Environment>, &'static str) {
        let found = view
            .contexts
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("{name} in view"));
        (found.environment, found.source)
    }

    fn manual(value: Option<Environment>) -> EnvironmentSetting {
        EnvironmentSetting::Manual { value }
    }

    #[test]
    fn fresh_dir_starts_with_defaults_and_writes_nothing_until_needed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        let (state, outcome) = ClusterAccessState::load(path.clone());
        assert_eq!(outcome, LoadOutcome::Fresh);
        let view = state.settings(&[]);
        assert_eq!(view.variants, Variants::default());
        assert!(!view.recovered);
        assert!(!path.exists(), "nothing to record, nothing written");
        state.settings(&names(&["minikube"]));
        assert!(path.exists(), "a new context is recorded");
    }

    #[test]
    fn first_sight_records_detected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        let (state, _) = ClusterAccessState::load(path.clone());
        let view = state.settings(&names(&["aks-prod-01-emm", "minikube"]));
        assert_eq!(
            one(&view, "aks-prod-01-emm"),
            (Some(Production), "detected")
        );
        assert_eq!(one(&view, "minikube"), (None, "detected"));
        assert_eq!(view.contexts[0].name, "aks-prod-01-emm", "order asked");

        let (again, outcome) = ClusterAccessState::load(path);
        assert_eq!(outcome, LoadOutcome::Loaded);
        let recorded = &again.lock().file.contexts;
        assert_eq!(
            recorded.get("aks-prod-01-emm").map(|r| r.environment),
            Some(EnvironmentSetting::Detected)
        );
        assert!(recorded.contains_key("minikube"));
    }

    #[test]
    fn manual_survives_variant_change() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        state.settings(&names(&["minikube", "kub3-dev"]));
        state
            .set_environment("minikube", manual(Some(Development)))
            .expect("set");
        let mut variants = Variants::default();
        variants.0.insert(Development, names(&["svil", "sviluppo"]));
        state.set_variants(&variants).expect("variants");

        let view = state.settings(&names(&["minikube", "kub3-dev"]));
        assert_eq!(one(&view, "minikube"), (Some(Development), "manual"));
        assert_eq!(one(&view, "kub3-dev"), (None, "detected"));

        let (reloaded, _) = ClusterAccessState::load(file_in(&dir));
        let view = reloaded.settings(&names(&["minikube"]));
        assert_eq!(one(&view, "minikube"), (Some(Development), "manual"));
        assert_eq!(view.variants.of(Development), names(&["svil", "sviluppo"]));
    }

    #[test]
    fn detect_from_name_returns_to_detection() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        let view = state
            .set_environment("aks-prod-01-emm", manual(Some(Development)))
            .expect("manual");
        assert_eq!(one(&view, "aks-prod-01-emm"), (Some(Development), "manual"));
        assert_eq!(view.contexts.len(), 1, "the one context");
        let view = state
            .set_environment("aks-prod-01-emm", EnvironmentSetting::Detected)
            .expect("detected");
        assert_eq!(
            one(&view, "aks-prod-01-emm"),
            (Some(Production), "detected")
        );
    }

    #[test]
    fn manual_none_is_not_set() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        let view = state
            .set_environment("aks-prod-01-emm", manual(None))
            .expect("not set");
        assert_eq!(one(&view, "aks-prod-01-emm"), (None, "manual"));
        let view = state.settings(&names(&["aks-prod-01-emm"]));
        assert_eq!(one(&view, "aks-prod-01-emm"), (None, "manual"));
    }

    #[test]
    fn case_differing_names_are_separate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        state.settings(&names(&["Prod", "prod"]));
        state
            .set_environment("Prod", manual(Some(Development)))
            .expect("set");
        let view = state.settings(&names(&["Prod", "prod"]));
        assert_eq!(view.contexts.len(), 2);
        assert_eq!(one(&view, "Prod"), (Some(Development), "manual"));
        assert_eq!(one(&view, "prod"), (Some(Production), "detected"));
        assert_eq!(state.lock().file.contexts.len(), 2);
    }

    #[test]
    fn round_trip_and_atomic_write() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        let (state, _) = ClusterAccessState::load(path.clone());
        state.settings(&names(&["aks-test-01-emm"]));
        state
            .set_environment("minikube", manual(Some(Development)))
            .expect("set");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .map(|e| e.expect("entry").file_name())
            .collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from(FILE_NAME)]);
        let text = fs::read_to_string(&path).expect("read");
        let parsed: SettingsFile = serde_json::from_str(&text).expect("parses");
        assert_eq!(parsed, state.lock().file);
        assert_eq!(parsed.version, 1);
    }

    #[test]
    fn unreadable_file_is_set_aside() {
        for bytes in [&b"{\"contexts\": "[..], &b""[..]] {
            let dir = tempfile::tempdir().expect("tempdir");
            let path = file_in(&dir);
            fs::write(&path, bytes).expect("write");
            let (state, outcome) = ClusterAccessState::load(path.clone());
            assert_eq!(outcome, LoadOutcome::Recovered);
            let bad = dir.path().join("cluster-access.json.bad");
            assert_eq!(fs::read(&bad).expect("bad kept"), bytes);
            assert!(!path.exists(), "moved aside");
            assert_eq!(state.lock().file, SettingsFile::default());
            assert!(state.settings(&[]).recovered, "first answer says so");
            assert!(!state.settings(&[]).recovered, "only once");
        }
    }

    #[test]
    fn unknown_environment_reads_as_not_set() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        fs::write(
            &path,
            r#"{"version":1,"contexts":{"a":{"environment":{"source":"manual","value":"qa-env"}}}}"#,
        )
        .expect("write");
        let (state, outcome) = ClusterAccessState::load(path);
        assert_eq!(outcome, LoadOutcome::Loaded);
        assert_eq!(
            state.lock().file.contexts.get("a").map(|r| r.environment),
            Some(manual(None))
        );
        assert_eq!(
            state.lock().file.variants,
            Variants::default(),
            "missing → default"
        );
    }

    #[test]
    fn unknown_source_reads_as_detected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        fs::write(
            &path,
            r#"{"contexts":{"a":{"environment":{"source":"guessed"}}},"variants":{"production":["live"],"sandbox":["sbx"]}}"#,
        )
        .expect("write");
        let (state, outcome) = ClusterAccessState::load(path);
        assert_eq!(outcome, LoadOutcome::Loaded);
        assert_eq!(
            state.lock().file.contexts.get("a").map(|r| r.environment),
            Some(EnvironmentSetting::Detected)
        );
        let view = state.settings(&names(&["eu-live"]));
        assert_eq!(one(&view, "eu-live"), (Some(Production), "detected"));
        assert_eq!(view.variants.0.len(), 4, "every environment in the view");
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        fs::write(
            &path,
            r#"{"version":2,"confirm_unlock":false,"contexts":{"a":{"access":"read_only","environment":{"source":"detected"}}}}"#,
        )
        .expect("write");
        let (state, outcome) = ClusterAccessState::load(path);
        assert_eq!(outcome, LoadOutcome::Loaded);
        assert!(state.lock().file.contexts.contains_key("a"));
    }

    #[test]
    fn variants_validation_error_text() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        let (state, _) = ClusterAccessState::load(path.clone());
        let mut variants = Variants::default();
        variants
            .0
            .insert(Environment::Test, names(&["test", "PROD"]));
        variants.0.insert(Production, names(&["prod"]));
        assert_eq!(
            state.set_variants(&variants),
            Err("\"prod\" is already in Test".to_string())
        );
        assert_eq!(state.lock().file.variants, Variants::default(), "unchanged");
        assert!(!path.exists(), "nothing saved");

        let mut variants = Variants::default();
        variants
            .0
            .insert(Production, names(&[" Prod ", "", "LIVE"]));
        let saved = state.set_variants(&variants).expect("normalised");
        assert_eq!(saved.of(Production), names(&["prod", "live"]));
        assert_eq!(saved.0.len(), 4);
    }

    #[test]
    fn view_keeps_the_order_asked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        let view = state.settings(&names(&["b", "a", "c"]));
        let order: Vec<_> = view.contexts.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(order, ["b", "a", "c"]);
    }

    #[test]
    fn in_memory_never_saves() {
        let state = ClusterAccessState::in_memory();
        let view = state.settings(&names(&["aks-prod-01-emm"]));
        assert_eq!(
            one(&view, "aks-prod-01-emm"),
            (Some(Production), "detected")
        );
        state
            .set_environment("aks-prod-01-emm", manual(None))
            .expect("kept in memory");
    }

    #[test]
    fn setting_serialises_as_the_webview_sends_it() {
        let detected: EnvironmentSetting =
            serde_json::from_str(r#"{"source":"detected"}"#).expect("detected");
        assert_eq!(detected, EnvironmentSetting::Detected);
        let manual_test: EnvironmentSetting =
            serde_json::from_str(r#"{"source":"manual","value":"test"}"#).expect("manual");
        assert_eq!(manual_test, manual(Some(Environment::Test)));
        let not_set: EnvironmentSetting =
            serde_json::from_str(r#"{"source":"manual","value":null}"#).expect("null");
        assert_eq!(not_set, manual(None));
        let view = ContextEnvironmentView {
            name: "a".to_string(),
            environment: Some(Production),
            source: "manual",
            detected: None,
        };
        assert_eq!(
            serde_json::to_string(&view).expect("json"),
            r#"{"name":"a","environment":"production","source":"manual","detected":null}"#
        );
    }

    #[test]
    fn view_says_what_detection_reads_even_when_set_by_hand() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        let view = state
            .set_environment("aks-prod-01-emm", manual(Some(Development)))
            .expect("manual");
        assert_eq!(view.contexts[0].detected, Some(Production));
        let view = state.settings(&names(&["minikube", "aks-prod-01-emm"]));
        assert_eq!(view.contexts[0].detected, None);
        assert_eq!(view.contexts[1].detected, Some(Production));
    }
}
