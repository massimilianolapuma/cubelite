//! Per-context cluster settings (#662), kept by the backend in
//! `cluster-access.json` in the app config directory, never in the webview.
//!
//! This first part holds each context's environment label (detected from its
//! name or set by hand) and the variants detection reads. The read-only state
//! of the second part goes in the same file: every field defaults, and fields
//! this version does not know are kept as they were, so a file written by
//! either version reads, and survives a save, in the other.
//!
//! Several instances of the app may run at once: before each change, and
//! before answering, the file is read again when it changed on disk (its
//! modification time or length), and the one change is applied to what was
//! read. Writes are atomic: a temp file of a unique name, synced, renamed over
//! the old one. A file that cannot be read is set aside as
//! `cluster-access.json.bad` (a later one gets a timestamp, never overwriting
//! an earlier one) and replaced by defaults; the next answer says so once.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use cubelite_core::environment::{detect, validate_variants, Environment, Variants};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};

/// The settings file's name in the app config directory.
pub const FILE_NAME: &str = "cluster-access.json";

/// Emitted to every window after a change, payload `()`.
pub const CLUSTER_SETTINGS_CHANGED: &str = "cluster-settings-changed";

/// The version written in a new file.
const VERSION: u32 = 1;

/// The whole settings file.
///
/// Read leniently: one bad context entry reads as detected, a bad variant
/// list or item is skipped, a version that is not a number reads as ours.
/// Only a file that is not JSON, not an object, or whose `contexts` is not a
/// map is unreadable as a whole.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct SettingsFile {
    /// The format version.
    pub version: u32,
    /// One record per context name ever seen.
    pub contexts: BTreeMap<String, ContextRecord>,
    /// The words that name each environment.
    pub variants: Variants,
    /// Fields this version does not know (a newer one's), written back as read.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for SettingsFile {
    fn default() -> Self {
        SettingsFile {
            version: VERSION,
            contexts: BTreeMap::new(),
            variants: Variants::default(),
            extra: Map::new(),
        }
    }
}

impl<'de> Deserialize<'de> for SettingsFile {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let Value::Object(mut map) = Value::deserialize(deserializer)? else {
            return Err(D::Error::custom("the settings are not an object"));
        };
        let version = map
            .remove("version")
            .map_or(VERSION, |v| lenient_version(&v));
        let contexts = match map.remove("contexts") {
            None | Some(Value::Null) => BTreeMap::new(),
            Some(Value::Object(entries)) => entries
                .into_iter()
                .map(|(name, record)| (name, ContextRecord::lenient(record)))
                .collect(),
            Some(_) => return Err(D::Error::custom("contexts is not a map")),
        };
        let variants = map
            .remove("variants")
            .and_then(|v| Variants::deserialize(v).ok())
            .unwrap_or_default();
        Ok(SettingsFile {
            version,
            contexts,
            variants,
            extra: map,
        })
    }
}

/// A version written as a number or as a numeric string; anything else is ours.
fn lenient_version(value: &Value) -> u32 {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(VERSION)
}

/// What is kept for one context.
#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct ContextRecord {
    /// Where its environment label comes from.
    pub environment: EnvironmentSetting,
    /// Fields this version does not know (a newer one's), written back as read.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ContextRecord {
    /// A record as read from the file: anything but an object reads as a new
    /// record, a setting this version cannot read (an unknown `source`) as
    /// detected.
    fn lenient(value: Value) -> Self {
        let Value::Object(mut map) = value else {
            return ContextRecord::default();
        };
        let environment = map
            .remove("environment")
            .and_then(|v| EnvironmentSetting::deserialize(v).ok())
            .unwrap_or_default();
        ContextRecord {
            environment,
            extra: map,
        }
    }
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
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(Value::String(text)) => Environment::parse(&text),
        _ => None,
    })
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

/// What tells that the file changed on disk: its modification time and length.
type Stamp = (Option<SystemTime>, u64);

fn stamp_of(path: &Path) -> Option<Stamp> {
    fs::metadata(path)
        .ok()
        .map(|meta| (meta.modified().ok(), meta.len()))
}

struct Inner {
    file: SettingsFile,
    /// `None`: kept in memory only (no config directory).
    path: Option<PathBuf>,
    recovered_pending: bool,
    /// The file as last read or written; `None` when there was none.
    stamp: Option<Stamp>,
}

/// The managed state: the settings in memory and where they are saved.
pub struct ClusterAccessState {
    inner: Mutex<Inner>,
}

impl ClusterAccessState {
    /// Read the settings from `path`, setting an unreadable file aside.
    pub fn load(path: PathBuf) -> (Self, LoadOutcome) {
        match read_file(&path) {
            Ok(None) => (
                Self::with(SettingsFile::default(), Some(path), false),
                LoadOutcome::Fresh,
            ),
            Ok(Some((file, stamp))) => {
                let state = Self::with(file, Some(path), false);
                state.lock().stamp = stamp;
                (state, LoadOutcome::Loaded)
            }
            Err(reason) => {
                set_aside(&path, &reason);
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
                stamp: None,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while holding the lock leaves plain data behind: keep it.
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The saved settings as they are on disk now: read again when another
    /// instance changed the file since this one last read or wrote it. The
    /// write guard of the read-only state reads through this.
    pub fn with_fresh<R>(&self, read: impl FnOnce(&SettingsFile) -> R) -> R {
        let mut inner = self.lock();
        inner.refresh();
        read(&inner.file)
    }

    /// The view for `names`, recording every name not seen before.
    ///
    /// A failed save is logged, not returned: the labels are still answered,
    /// and the records are written with the next change.
    pub fn settings(&self, names: &[String]) -> ClusterSettingsView {
        let mut inner = self.lock();
        inner.refresh();
        let mut next = inner.file.clone();
        let mut added = false;
        for name in names {
            if !next.contexts.contains_key(name) {
                next.contexts.insert(name.clone(), ContextRecord::default());
                added = true;
            }
        }
        if added {
            if let Err(e) = inner.save(&next) {
                eprintln!("cluster settings: could not save: {e}");
            }
            inner.file = next;
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
        inner.refresh();
        let mut next = inner.file.clone();
        // Only the environment: the rest of the record is kept.
        next.contexts
            .entry(context.to_string())
            .or_default()
            .environment = setting;
        inner.save(&next).map_err(|e| e.to_string())?;
        inner.file = next;
        Ok(inner.view(&[context.to_string()], false))
    }

    /// Replace the variants after validating them; answers what was saved.
    pub fn set_variants(&self, variants: &Variants) -> Result<Variants, String> {
        let valid = validate_variants(variants).map_err(|e| e.to_string())?;
        let mut inner = self.lock();
        inner.refresh();
        let mut next = inner.file.clone();
        next.variants = valid.clone();
        inner.save(&next).map_err(|e| e.to_string())?;
        inner.file = next;
        Ok(valid)
    }
}

impl Inner {
    /// Read the file again if it changed on disk since it was last read or
    /// written. A file that vanished leaves the settings in memory as they
    /// are; one that became unreadable is set aside, memory kept.
    fn refresh(&mut self) {
        let Some(path) = self.path.clone() else {
            return;
        };
        let now = stamp_of(&path);
        if now.is_none() || now == self.stamp {
            return;
        }
        match read_file(&path) {
            Ok(Some((file, stamp))) => {
                self.file = file;
                self.stamp = stamp;
            }
            Ok(None) => self.stamp = None,
            Err(reason) => {
                set_aside(&path, &reason);
                self.recovered_pending = true;
                self.stamp = None;
            }
        }
    }

    fn save(&mut self, file: &SettingsFile) -> io::Result<()> {
        if let Some(path) = &self.path {
            save(path, file)?;
            self.stamp = stamp_of(path);
        }
        Ok(())
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

/// The file at `path` and its stamp; `None` when there is no file.
fn read_file(path: &Path) -> Result<Option<(SettingsFile, Option<Stamp>)>, String> {
    let stamp = stamp_of(path);
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<SettingsFile>(&bytes)
            .map(|file| Some((file, stamp)))
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Move an unreadable file out of the way, never over an earlier one.
fn set_aside(path: &Path, reason: &str) {
    let bad = bad_path(path);
    eprintln!(
        "cluster settings: {} could not be read ({reason}); set aside as {}",
        path.display(),
        bad.display()
    );
    if let Err(e) = fs::rename(path, &bad) {
        eprintln!("cluster settings: could not set the file aside: {e}");
    }
}

/// `cluster-access.json.bad` when free, else the same with a timestamp (and a
/// counter if that is taken too).
fn bad_path(path: &Path) -> PathBuf {
    let first = path.with_file_name(format!("{FILE_NAME}.bad"));
    if !first.exists() {
        return first;
    }
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (0..u32::MAX)
        .map(|n| match n {
            0 => path.with_file_name(format!("{FILE_NAME}.bad.{secs}")),
            n => path.with_file_name(format!("{FILE_NAME}.bad.{secs}-{n}")),
        })
        .find(|candidate| !candidate.exists())
        .unwrap_or(first)
}

/// Distinguishes the temp files of one process's saves.
static SAVES: AtomicU64 = AtomicU64::new(0);

/// Write `file` to `path` atomically: a temp file of a name no other save
/// uses (process id and a counter), synced to disk, renamed over the old one.
fn save(path: &Path, file: &SettingsFile) -> io::Result<()> {
    let text = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
    let n = SAVES.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!("{FILE_NAME}.{}.{n}.tmp", std::process::id()));
    let written = (|| {
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        out.write_all(&text)?;
        out.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
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
    fn two_instances_keep_each_others_changes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (a, _) = ClusterAccessState::load(file_in(&dir));
        let (b, _) = ClusterAccessState::load(file_in(&dir));
        a.settings(&names(&["minikube"]));
        a.set_environment("minikube", manual(Some(Development)))
            .expect("a sets");
        // B, started before A's change, records a context of its own.
        let view = b.settings(&names(&["new-ctx", "minikube"]));
        assert_eq!(
            one(&view, "minikube"),
            (Some(Development), "manual"),
            "B reads A's change"
        );
        let mut variants = Variants::default();
        variants.0.insert(Production, names(&["prod", "live"]));
        b.set_variants(&variants).expect("b saves");
        a.set_environment("other", manual(None)).expect("a again");

        let (reloaded, _) = ClusterAccessState::load(file_in(&dir));
        let file = reloaded.lock().file.clone();
        assert_eq!(
            file.contexts.get("minikube").map(|r| r.environment),
            Some(manual(Some(Development)))
        );
        assert!(file.contexts.contains_key("new-ctx"));
        assert!(file.contexts.contains_key("other"));
        assert_eq!(file.variants.of(Production), names(&["prod", "live"]));
    }

    #[test]
    fn with_fresh_reads_another_instances_change() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (a, _) = ClusterAccessState::load(file_in(&dir));
        let (b, _) = ClusterAccessState::load(file_in(&dir));
        a.set_environment("aks-prod-01-emm", manual(None))
            .expect("a sets");
        let seen = b.with_fresh(|file| file.contexts.get("aks-prod-01-emm").map(|r| r.environment));
        assert_eq!(seen, Some(manual(None)));
    }

    #[test]
    fn unknown_fields_survive_a_save() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        fs::write(
            &path,
            r#"{"version":1,"confirm_unlock":false,"read_only_from_start":["production"],
               "contexts":{"aks-prod-01-emm":{"access":"read_only","environment":{"source":"detected"}}}}"#,
        )
        .expect("write");
        let (state, _) = ClusterAccessState::load(path.clone());
        state.settings(&names(&["new-ctx"]));
        state
            .set_environment("aks-prod-01-emm", manual(Some(Production)))
            .expect("set");
        let on_disk: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("read")).expect("json");
        assert_eq!(on_disk["confirm_unlock"], serde_json::json!(false));
        assert_eq!(
            on_disk["read_only_from_start"],
            serde_json::json!(["production"])
        );
        assert_eq!(
            on_disk["contexts"]["aks-prod-01-emm"]["access"],
            serde_json::json!("read_only")
        );
        assert_eq!(
            on_disk["contexts"]["aks-prod-01-emm"]["environment"],
            serde_json::json!({"source": "manual", "value": "production"})
        );
        assert!(on_disk["contexts"]["new-ctx"].is_object());
    }

    #[test]
    fn a_leftover_temp_name_does_not_block_a_save() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Another writer's temp file (or one left by a crash) under the old fixed name.
        fs::create_dir(dir.path().join(format!("{FILE_NAME}.tmp"))).expect("dir");
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        state
            .set_environment("minikube", manual(Some(Development)))
            .expect("saved beside it");
        let leftovers = fs::read_dir(dir.path())
            .expect("read dir")
            .filter(|e| {
                let name = e.as_ref().expect("entry").file_name();
                let name = name.to_string_lossy();
                name.ends_with(".tmp") && name != format!("{FILE_NAME}.tmp")
            })
            .count();
        assert_eq!(leftovers, 0, "no temp file of ours left");
    }

    #[test]
    fn second_recovery_keeps_the_first_bad_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        fs::write(&path, b"first").expect("write");
        ClusterAccessState::load(path.clone());
        fs::write(&path, b"second").expect("write");
        ClusterAccessState::load(path.clone());
        let mut kept: Vec<Vec<u8>> = fs::read_dir(dir.path())
            .expect("read dir")
            .map(|e| e.expect("entry").path())
            .filter(|p| p.to_string_lossy().contains(".bad"))
            .map(|p| fs::read(p).expect("read bad"))
            .collect();
        kept.sort();
        assert_eq!(kept, vec![b"first".to_vec(), b"second".to_vec()]);
        assert_eq!(
            fs::read(dir.path().join(format!("{FILE_NAME}.bad"))).expect("first"),
            b"first"
        );
    }

    #[test]
    fn bad_entries_are_read_one_by_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        fs::write(
            &path,
            r#"{"version":"2","contexts":{"a":null,"b":{"environment":{"source":"manual","value":"test"}},"c":7},
               "variants":{"production":["prod",1,"live"],"test":"qa"}}"#,
        )
        .expect("write");
        let (state, outcome) = ClusterAccessState::load(path);
        assert_eq!(outcome, LoadOutcome::Loaded);
        let file = state.lock().file.clone();
        assert_eq!(file.version, 2);
        assert_eq!(
            file.contexts.get("a").map(|r| r.environment),
            Some(EnvironmentSetting::Detected)
        );
        assert_eq!(
            file.contexts.get("b").map(|r| r.environment),
            Some(manual(Some(Environment::Test)))
        );
        assert_eq!(
            file.contexts.get("c").map(|r| r.environment),
            Some(EnvironmentSetting::Detected)
        );
        assert_eq!(file.variants.of(Production), names(&["prod", "live"]));
        assert!(file.variants.of(Environment::Test).is_empty());
    }

    #[test]
    fn a_version_that_is_not_a_number_reads_as_ours() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        fs::write(&path, r#"{"version":"next","contexts":{}}"#).expect("write");
        let (state, outcome) = ClusterAccessState::load(path);
        assert_eq!(outcome, LoadOutcome::Loaded);
        assert_eq!(state.lock().file.version, 1);
    }

    #[test]
    fn contexts_that_are_not_a_map_set_the_file_aside() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        fs::write(&path, r#"{"contexts":["a","b"]}"#).expect("write");
        let (_, outcome) = ClusterAccessState::load(path);
        assert_eq!(outcome, LoadOutcome::Recovered);
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
