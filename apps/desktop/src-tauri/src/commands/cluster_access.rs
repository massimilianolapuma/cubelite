//! Per-context cluster settings (#662), kept by the backend in
//! `cluster-access.json` in the app config directory, never in the webview.
//!
//! Each context has an environment label (detected from its name or set by
//! hand) and an access: read-only or writable. The access is decided the
//! first time a context is seen (read-only when its label is in
//! `read_only_from_start`, writable otherwise) and never changes with the
//! label afterwards. A read-only context can be made writable for a while: the
//! end of that unlock is kept in memory only, by the wall clock, so it never
//! survives a restart and never outlasts a machine's sleep. Every field of the
//! file defaults, and fields this version does not know are kept as they
//! were, so a file written by either version reads, and survives a save, in
//! the other.
//!
//! Several instances of the app may run at once: before each change, before
//! each write check and before answering, the file is read again when it
//! changed on disk (its modification time or length), and the one change is
//! applied to what was read. A change holds an exclusive lock across
//! processes (`cluster-access.json.lock`) from that read to its write, so two
//! instances changing at once never overwrite each other; a lock that cannot
//! be taken is logged and the change goes ahead without it. Writes are
//! atomic: a temp file of a unique name, synced, renamed over the old one.
//! "Make read-only" holds for the session even when it cannot be saved; "make
//! writable" fails then. A file that cannot be read is set aside
//! as `cluster-access.json.bad` (a later one gets a timestamp, never
//! overwriting an earlier one) and replaced by defaults; the next answer says
//! so once. A file deleted or broken while the app runs leaves the settings in
//! memory as they were, so a read-only context stays read-only.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cubelite_core::environment::{detect, validate_variants, Environment, Variants};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

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
    /// Ask before a context is made writable.
    pub confirm_unlock: bool,
    /// The environments whose contexts start read-only at first sight.
    pub read_only_from_start: BTreeSet<Environment>,
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
            confirm_unlock: true,
            read_only_from_start: default_read_only_from_start(),
            extra: Map::new(),
        }
    }
}

/// Production only.
fn default_read_only_from_start() -> BTreeSet<Environment> {
    BTreeSet::from([Environment::Production])
}

/// A list of environments as read from the file: a value that is not a list
/// reads as the default, an item this version does not know is skipped.
fn lenient_environments(value: &Value) -> BTreeSet<Environment> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .filter_map(Environment::parse)
            .collect(),
        _ => default_read_only_from_start(),
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
        let confirm_unlock = map
            .remove("confirm_unlock")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let read_only_from_start = map
            .remove("read_only_from_start")
            .map_or_else(default_read_only_from_start, |v| lenient_environments(&v));
        Ok(SettingsFile {
            version,
            contexts,
            variants,
            confirm_unlock,
            read_only_from_start,
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
    /// The saved access; `None` until first sight decides it (a record of
    /// the first part, or a value this version cannot read).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<Access>,
    /// Fields this version does not know (a newer one's), written back as read.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ContextRecord {
    /// A record as read from the file: anything but an object reads as a new
    /// record, a setting this version cannot read (an unknown `source`) as
    /// detected, an access it cannot read as not decided yet.
    fn lenient(value: Value) -> Self {
        let Value::Object(mut map) = value else {
            return ContextRecord::default();
        };
        let environment = map
            .remove("environment")
            .and_then(|v| EnvironmentSetting::deserialize(v).ok())
            .unwrap_or_default();
        let access = map
            .remove("access")
            .and_then(|v| Access::deserialize(v).ok());
        ContextRecord {
            environment,
            access,
            extra: map,
        }
    }
}

/// A context's saved access. "Writable for a while" is not saved: it is a
/// read-only context with an unlock in memory.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// Every write command is refused.
    ReadOnly,
    /// No write command is refused.
    Writable,
}

impl Access {
    /// As the webview reads it.
    fn as_str(self) -> &'static str {
        match self {
            Access::ReadOnly => "read_only",
            Access::Writable => "writable",
        }
    }
}

/// The unlock durations offered, in minutes.
const DURATIONS: [u32; 3] = [5, 15, 60];

/// The refusal of any other duration.
const BAD_DURATION: &str = "5, 15 or 60 minutes, or always";

/// How long a context is made writable: JSON `5`, `15`, `60` or `"always"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockFor {
    /// For this many minutes (one of [`DURATIONS`]), in memory only.
    Minutes(u32),
    /// Until it is made read-only again, saved.
    Always,
}

impl<'de> Deserialize<'de> for UnlockFor {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let parsed = match &value {
            Value::Number(n) => n
                .as_u64()
                .and_then(|m| u32::try_from(m).ok())
                .filter(|m| DURATIONS.contains(m))
                .map(UnlockFor::Minutes),
            Value::String(text) if text == "always" => Some(UnlockFor::Always),
            _ => None,
        };
        parsed.ok_or_else(|| D::Error::custom(BAD_DURATION))
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
    /// The access in force now: `"read_only"` or `"writable"` (a running
    /// timed unlock included).
    pub access: &'static str,
    /// The end of a running timed unlock, in Unix milliseconds.
    pub writable_until: Option<u64>,
}

/// The answer of every cluster-settings command.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct ClusterSettingsView {
    /// In the order of the names asked for.
    pub contexts: Vec<ContextEnvironmentView>,
    /// Every environment present, possibly with an empty list.
    pub variants: Variants,
    /// True once, on the first answer after the file was set aside.
    pub recovered: bool,
    /// Ask before a context is made writable.
    pub confirm_unlock: bool,
    /// The environments whose contexts start read-only, in the app's order.
    pub read_only_from_start: Vec<Environment>,
    /// Why a change kept for this session could not be saved (only "make
    /// read-only" is kept so); absent when it was saved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_error: Option<String>,
}

/// Where the state reads the time: the wall clock, injected in tests.
type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

/// What tells that the file changed on disk: its modification time and length.
type Stamp = (Option<SystemTime>, u64);

fn stamp_of(path: &Path) -> Option<Stamp> {
    fs::metadata(path).ok().map(|meta| stamp_of_meta(&meta))
}

fn stamp_of_meta(meta: &fs::Metadata) -> Stamp {
    (meta.modified().ok(), meta.len())
}

struct Inner {
    file: SettingsFile,
    /// `None`: kept in memory only (no config directory).
    path: Option<PathBuf>,
    recovered_pending: bool,
    /// The file as last read or written; `None` when there was none.
    stamp: Option<Stamp>,
    /// The end of each running timed unlock, by the wall clock. Never saved.
    unlocks: HashMap<String, SystemTime>,
    /// The settings were read again from a file another instance wrote, and
    /// [`ClusterAccessState::tick`] has not told the webview yet.
    reloaded_from_disk: bool,
    /// Contexts made read-only whose save failed: read-only for the life of
    /// this process whatever the file says, until made writable here.
    session_read_only: HashSet<String>,
}

/// The managed state: the settings in memory, where they are saved, and the
/// timed unlocks.
pub struct ClusterAccessState {
    inner: Mutex<Inner>,
    clock: Clock,
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
                unlocks: HashMap::new(),
                reloaded_from_disk: false,
                session_read_only: HashSet::new(),
            }),
            clock: Arc::new(SystemTime::now),
        }
    }

    /// The same state reading the time from `clock`.
    #[cfg(test)]
    pub(crate) fn with_clock(
        mut self,
        clock: impl Fn() -> SystemTime + Send + Sync + 'static,
    ) -> Self {
        self.clock = Arc::new(clock);
        self
    }

    fn now(&self) -> SystemTime {
        (self.clock)()
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

    /// The view for `names`, recording every name not seen before (first
    /// sight, one save for all of them).
    ///
    /// A failed save is logged, not returned: the labels are still answered,
    /// and the records are written with the next change.
    pub fn settings(&self, names: &[String]) -> ClusterSettingsView {
        let now = self.now();
        let mut inner = self.lock();
        inner.refresh();
        if names.iter().any(|name| unseen(&inner.file, name)) {
            let (next, saved) = inner.change(|file| {
                for name in names {
                    first_sight(file, name);
                }
            });
            if let Err(e) = saved {
                eprintln!("cluster settings: could not save: {e}");
            }
            inner.file = next;
        }
        let recovered = std::mem::take(&mut inner.recovered_pending);
        inner.view(names, recovered, now)
    }

    /// Set the environment of `context`; answers the view for that context.
    /// A context not seen before gets its access from the label it had
    /// before this change: a label change never changes access.
    pub fn set_environment(
        &self,
        context: &str,
        setting: EnvironmentSetting,
    ) -> Result<ClusterSettingsView, String> {
        let now = self.now();
        let mut inner = self.lock();
        let (next, saved) = inner.change(|file| {
            first_sight(file, context);
            // Only the environment: the rest of the record is kept.
            file.contexts
                .entry(context.to_string())
                .or_default()
                .environment = setting;
        });
        saved.map_err(|e| e.to_string())?;
        inner.file = next;
        Ok(inner.view(&[context.to_string()], false, now))
    }

    /// Whether a write to `context` may run now. Reads the file again when
    /// it changed on disk, records a context not seen before (first sight,
    /// saved), then: saved writable → yes; saved read-only → only while a
    /// timed unlock runs. An ended unlock is left for [`Self::tick`] to
    /// remove, so the end is always told to the webview.
    pub fn write_allowed(&self, context: &str) -> bool {
        let now = self.now();
        let mut inner = self.lock();
        inner.refresh();
        if unseen(&inner.file, context) {
            let (next, saved) = inner.change(|file| {
                first_sight(file, context);
            });
            if let Err(e) = saved {
                // Kept in memory: the decision holds for this run.
                eprintln!("cluster settings: could not save: {e}");
            }
            inner.file = next;
        }
        inner.effective(context, now).0 == Access::Writable
    }

    /// Make `context` writable: `Always` saves it writable; a number of
    /// minutes saves it read-only and unlocks it in memory until now plus
    /// that time (choosing again restarts the time from now). Nothing
    /// changes when the file cannot be saved: the safe side.
    pub fn make_writable(
        &self,
        context: &str,
        how: UnlockFor,
    ) -> Result<ClusterSettingsView, String> {
        let until = match how {
            UnlockFor::Always => None,
            UnlockFor::Minutes(m) if DURATIONS.contains(&m) => {
                Some(Duration::from_secs(u64::from(m) * 60))
            }
            UnlockFor::Minutes(_) => return Err(BAD_DURATION.to_string()),
        };
        let now = self.now();
        let mut inner = self.lock();
        let saved = match until {
            None => Access::Writable,
            Some(_) => Access::ReadOnly,
        };
        // Read-only for this session only: the file may already say what
        // is asked, but nothing is unlocked until a save succeeds.
        let force = inner.session_read_only.contains(context);
        let (next, result) = inner.change_with(force, |file| set_access(file, context, saved));
        result.map_err(|e| e.to_string())?;
        inner.file = next;
        match until {
            None => {
                inner.unlocks.remove(context);
                inner.session_read_only.remove(context);
            }
            Some(duration) => {
                // An end past what the clock can hold is no unlock at all.
                let end = now.checked_add(duration).unwrap_or(now);
                inner.unlocks.insert(context.to_string(), end);
            }
        }
        Ok(inner.view(&[context.to_string()], false, now))
    }

    /// Make `context` read-only (saved), ending any timed unlock.
    ///
    /// When the file cannot be saved the context is still read-only, for the
    /// life of this process, even if another instance saves it writable
    /// meanwhile: the answer then carries the reason in `save_error`, so the
    /// webview can say it was not saved.
    pub fn make_read_only(&self, context: &str) -> Result<ClusterSettingsView, String> {
        let now = self.now();
        let mut inner = self.lock();
        let (next, saved) = inner.change(|file| set_access(file, context, Access::ReadOnly));
        inner.unlocks.remove(context);
        let save_error = match saved {
            Ok(()) => {
                inner.file = next;
                inner.session_read_only.remove(context);
                None
            }
            // Memory keeps what is on disk, so the next "make read-only"
            // tries the save again.
            Err(e) => {
                eprintln!("cluster settings: could not save {context} read-only: {e}");
                inner.session_read_only.insert(context.to_string());
                Some(e.to_string())
            }
        };
        let mut view = inner.view(&[context.to_string()], false, now);
        view.save_error = save_error;
        Ok(view)
    }

    /// Change the access preferences; `None` keeps a value. Answers the view
    /// with no contexts.
    pub fn set_access_preferences(
        &self,
        confirm_unlock: Option<bool>,
        read_only_from_start: Option<Vec<Environment>>,
    ) -> Result<ClusterSettingsView, String> {
        let now = self.now();
        let mut inner = self.lock();
        let (next, saved) = inner.change(|file| {
            if let Some(confirm) = confirm_unlock {
                file.confirm_unlock = confirm;
            }
            if let Some(environments) = read_only_from_start {
                file.read_only_from_start = environments.into_iter().collect();
            }
        });
        saved.map_err(|e| e.to_string())?;
        inner.file = next;
        Ok(inner.view(&[], false, now))
    }

    /// Called every second: ends the timed unlocks whose time has come and
    /// notices a file another instance changed, whether this tick read it or
    /// an earlier read did (a write check, an answer). True when either
    /// happened, so the webview is told.
    pub fn tick(&self) -> bool {
        let now = self.now();
        let mut inner = self.lock();
        let running = inner.unlocks.len();
        inner.unlocks.retain(|_, end| *end > now);
        let ended = inner.unlocks.len() != running;
        inner.refresh();
        let reloaded = std::mem::take(&mut inner.reloaded_from_disk);
        ended || reloaded
    }

    /// Replace the variants after validating them; answers what was saved.
    pub fn set_variants(&self, variants: &Variants) -> Result<Variants, String> {
        let valid = validate_variants(variants).map_err(|e| e.to_string())?;
        let mut inner = self.lock();
        let (next, saved) = inner.change(|file| file.variants = valid.clone());
        saved.map_err(|e| e.to_string())?;
        inner.file = next;
        Ok(valid)
    }
}

impl Inner {
    /// Read the file again if it changed on disk since it was last read or
    /// written. A file that vanished leaves the settings in memory as they
    /// are; one that became unreadable is set aside, memory kept. Either
    /// change is noted for the next [`ClusterAccessState::tick`].
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
                self.reloaded_from_disk = true;
            }
            Ok(None) => self.stamp = None,
            Err(reason) => {
                set_aside(&path, &reason);
                self.recovered_pending = true;
                self.stamp = None;
                self.reloaded_from_disk = true;
            }
        }
    }

    /// One change: `edit` applied to the settings as they are on disk now,
    /// then saved, the whole under the lock across instances (when it can be
    /// taken), so a change another instance saves meanwhile is never
    /// overwritten. Nothing is written when `edit` changes nothing, unless
    /// `force`. Answers the settings changed and how the save went; memory
    /// is left to the caller, which keeps the change or not.
    fn change_with(
        &mut self,
        force: bool,
        edit: impl FnOnce(&mut SettingsFile),
    ) -> (SettingsFile, io::Result<()>) {
        let _held = self.path.as_deref().and_then(lock_across_instances);
        self.refresh();
        let mut next = self.file.clone();
        edit(&mut next);
        let saved = if next == self.file && !force {
            Ok(())
        } else {
            self.save(&next)
        };
        (next, saved)
    }

    /// [`Self::change_with`], writing only a change.
    fn change(&mut self, edit: impl FnOnce(&mut SettingsFile)) -> (SettingsFile, io::Result<()>) {
        self.change_with(false, edit)
    }

    fn save(&mut self, file: &SettingsFile) -> io::Result<()> {
        if let Some(path) = &self.path {
            self.stamp = Some(save(path, file)?);
        }
        Ok(())
    }

    /// The access of `name` in force at `now`, and the end of its unlock
    /// while one runs. A context without a decided access reads as first
    /// sight would decide it; one made read-only but not saved is read-only.
    fn effective(&self, name: &str, now: SystemTime) -> (Access, Option<SystemTime>) {
        let saved = if self.session_read_only.contains(name) {
            Access::ReadOnly
        } else {
            self.file
                .contexts
                .get(name)
                .and_then(|r| r.access)
                .unwrap_or_else(|| initial_access(&self.file, name))
        };
        match (saved, self.unlocks.get(name)) {
            (Access::ReadOnly, Some(end)) if *end > now => (Access::Writable, Some(*end)),
            (Access::ReadOnly, _) => (Access::ReadOnly, None),
            (Access::Writable, _) => (Access::Writable, None),
        }
    }

    fn view(&self, names: &[String], recovered: bool, now: SystemTime) -> ClusterSettingsView {
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
                    view_of(name, setting, variants, self.effective(name, now))
                })
                .collect(),
            variants: complete(variants),
            recovered,
            confirm_unlock: self.file.confirm_unlock,
            read_only_from_start: self.file.read_only_from_start.iter().copied().collect(),
            save_error: None,
        }
    }
}

/// Save `access` for `context`.
fn set_access(file: &mut SettingsFile, context: &str, access: Access) {
    file.contexts.entry(context.to_string()).or_default().access = Some(access);
}

/// The lock that keeps two instances' changes apart: an exclusive advisory
/// lock on `cluster-access.json.lock` beside the file, held from the read
/// to the write and let go when the handle drops. When it cannot be taken
/// (a directory that cannot be written, a file system without locks) the
/// change goes ahead without it, logged: a lock must never stop a change.
///
/// `File::lock` is newer (Rust 1.89) than the `msrv` in `.clippy.toml`
/// (1.82). This crate does not take the workspace's `rust-version` and is
/// built with the stable toolchain only; std's lock spares a locking crate.
#[allow(clippy::incompatible_msrv)]
fn lock_across_instances(path: &Path) -> Option<fs::File> {
    let lock = path.with_file_name(format!("{FILE_NAME}.lock"));
    let taken = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock)
        .and_then(|handle| handle.lock().map(|()| handle));
    match taken {
        Ok(handle) => Some(handle),
        Err(e) => {
            eprintln!(
                "cluster settings: could not lock {} ({e}); changing without it",
                lock.display()
            );
            None
        }
    }
}

/// The label `name` has under `setting`.
fn label_of(name: &str, setting: EnvironmentSetting, variants: &Variants) -> Option<Environment> {
    match setting {
        EnvironmentSetting::Detected => detect(name, variants),
        EnvironmentSetting::Manual { value } => value,
    }
}

/// The access first sight gives `name`: read-only when its current label is
/// in `read_only_from_start`, writable otherwise.
fn initial_access(file: &SettingsFile, name: &str) -> Access {
    let setting = file
        .contexts
        .get(name)
        .map(|r| r.environment)
        .unwrap_or_default();
    match label_of(name, setting, &file.variants) {
        Some(env) if file.read_only_from_start.contains(&env) => Access::ReadOnly,
        _ => Access::Writable,
    }
}

/// Whether `name` has no access decided yet (first sight would record it).
fn unseen(file: &SettingsFile, name: &str) -> bool {
    file.contexts.get(name).is_none_or(|r| r.access.is_none())
}

/// Record `name` with its first-sight access when it has none yet (no
/// record, a record of the first part, or an access this version cannot
/// read). True when `file` changed.
fn first_sight(file: &mut SettingsFile, name: &str) -> bool {
    if !unseen(file, name) {
        return false;
    }
    let access = initial_access(file, name);
    file.contexts.entry(name.to_string()).or_default().access = Some(access);
    true
}

/// `time` in Unix milliseconds.
fn unix_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
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
/// Answers the stamp of the file written, taken from the temp file before
/// the rename (which keeps it): a stamp read from `path` after the rename
/// could be another instance's, renamed in between.
fn save(path: &Path, file: &SettingsFile) -> io::Result<Stamp> {
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
        let stamp = stamp_of_meta(&out.metadata()?);
        fs::rename(&tmp, path)?;
        Ok(stamp)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

/// The context `name` under `setting`, with its access in force.
fn view_of(
    name: &str,
    setting: EnvironmentSetting,
    variants: &Variants,
    (access, until): (Access, Option<SystemTime>),
) -> ContextEnvironmentView {
    let source = match setting {
        EnvironmentSetting::Detected => "detected",
        EnvironmentSetting::Manual { .. } => "manual",
    };
    ContextEnvironmentView {
        name: name.to_string(),
        environment: label_of(name, setting, variants),
        source,
        detected: detect(name, variants),
        access: access.as_str(),
        writable_until: until.map(unix_ms),
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

/// Make a context writable for 5, 15 or 60 minutes, or `"always"`.
#[tauri::command]
pub async fn make_cluster_writable(
    app: AppHandle,
    state: tauri::State<'_, ClusterAccessState>,
    context: String,
    duration: UnlockFor,
) -> Result<ClusterSettingsView, String> {
    let view = state.make_writable(&context, duration)?;
    changed(&app);
    Ok(view)
}

/// Make a context read-only, ending any timed unlock.
#[tauri::command]
pub async fn make_cluster_read_only(
    app: AppHandle,
    state: tauri::State<'_, ClusterAccessState>,
    context: String,
) -> Result<ClusterSettingsView, String> {
    let view = state.make_read_only(&context)?;
    changed(&app);
    Ok(view)
}

/// Change the confirmation before an unlock and the environments that start
/// read-only; a value left out is kept.
#[tauri::command]
pub async fn set_cluster_access_preferences(
    app: AppHandle,
    state: tauri::State<'_, ClusterAccessState>,
    confirm_unlock: Option<bool>,
    read_only_from_start: Option<Vec<Environment>>,
) -> Result<ClusterSettingsView, String> {
    let view = state.set_access_preferences(confirm_unlock, read_only_from_start)?;
    changed(&app);
    Ok(view)
}

/// Once a second for the life of the app: ends the timed unlocks by the wall
/// clock (a tick late after a sleep ends them at once) and notices changes
/// another instance made to the file; tells every window when either
/// happened.
pub async fn run_ticker(app: AppHandle) {
    let mut every = tokio::time::interval(Duration::from_secs(1));
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        every.tick().await;
        let Some(state) = app.try_state::<ClusterAccessState>() else {
            continue;
        };
        if state.tick() {
            changed(&app);
        }
    }
}

/// A clock a test sets by hand.
#[cfg(test)]
#[derive(Clone)]
pub(crate) struct TestClock(Arc<Mutex<SystemTime>>);

#[cfg(test)]
impl TestClock {
    /// A clock at `unix_secs`.
    pub(crate) fn at(unix_secs: u64) -> Self {
        TestClock(Arc::new(Mutex::new(
            UNIX_EPOCH + Duration::from_secs(unix_secs),
        )))
    }

    pub(crate) fn now(&self) -> SystemTime {
        *self.0.lock().expect("clock")
    }

    pub(crate) fn set(&self, time: SystemTime) {
        *self.0.lock().expect("clock") = time;
    }

    /// What the state calls to read the time.
    pub(crate) fn reader(&self) -> impl Fn() -> SystemTime + Send + Sync + 'static {
        let clock = self.clone();
        move || clock.now()
    }
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
        let mut leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .map(|e| e.expect("entry").file_name())
            .collect();
        leftovers.sort();
        // The file and the lock kept beside it, no temp file.
        assert_eq!(
            leftovers,
            vec![
                std::ffi::OsString::from(FILE_NAME),
                std::ffi::OsString::from(format!("{FILE_NAME}.lock"))
            ]
        );
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
            access: "read_only",
            writable_until: None,
        };
        assert_eq!(
            serde_json::to_string(&view).expect("json"),
            r#"{"name":"a","environment":"production","source":"manual","detected":null,"access":"read_only","writable_until":null}"#
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

    // Access (#662, part 2).

    const PROD: &str = "aks-prod-01-emm";

    /// The effective access of `name` in `view` and the end of its unlock.
    fn access(view: &ClusterSettingsView, name: &str) -> (&'static str, Option<u64>) {
        let found = view
            .contexts
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("{name} in view"));
        (found.access, found.writable_until)
    }

    /// The access saved on disk for `name`.
    fn saved_access(path: &Path, name: &str) -> Value {
        let on_disk: Value = serde_json::from_slice(&fs::read(path).expect("read")).expect("json");
        on_disk["contexts"][name]["access"].clone()
    }

    fn ms(time: SystemTime) -> u64 {
        u64::try_from(
            time.duration_since(UNIX_EPOCH)
                .expect("after epoch")
                .as_millis(),
        )
        .expect("fits")
    }

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn first_sight_production_read_only_others_writable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        let (state, _) = ClusterAccessState::load(path.clone());
        let view = state.settings(&names(&[PROD, "aks-test-01-emm", "minikube"]));
        assert_eq!(access(&view, PROD), ("read_only", None));
        assert_eq!(access(&view, "aks-test-01-emm"), ("writable", None));
        assert_eq!(access(&view, "minikube"), ("writable", None));
        assert_eq!(saved_access(&path, PROD), serde_json::json!("read_only"));
        assert_eq!(
            saved_access(&path, "aks-test-01-emm"),
            serde_json::json!("writable")
        );
        assert_eq!(
            saved_access(&path, "minikube"),
            serde_json::json!("writable")
        );
    }

    #[test]
    fn pr1_record_without_access_is_first_sight() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        fs::write(
            &path,
            r#"{"version":1,"contexts":{"aks-prod-01-emm":{"environment":{"source":"detected"}}}}"#,
        )
        .expect("write");
        let (state, outcome) = ClusterAccessState::load(path.clone());
        assert_eq!(outcome, LoadOutcome::Loaded);
        let view = state.settings(&names(&[PROD]));
        assert_eq!(access(&view, PROD), ("read_only", None));
        assert_eq!(saved_access(&path, PROD), serde_json::json!("read_only"));
    }

    #[test]
    fn unknown_access_value_is_first_sight_again() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        fs::write(
            &path,
            r#"{"contexts":{"aks-prod-01-emm":{"access":"sealed"},"minikube":{"access":7}}}"#,
        )
        .expect("write");
        let (state, outcome) = ClusterAccessState::load(path);
        assert_eq!(outcome, LoadOutcome::Loaded);
        let view = state.settings(&names(&[PROD, "minikube"]));
        assert_eq!(access(&view, PROD), ("read_only", None));
        assert_eq!(access(&view, "minikube"), ("writable", None));
    }

    #[test]
    fn vanished_context_keeps_its_record() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        state.settings(&names(&["minikube"]));
        state.make_read_only("minikube").expect("read-only");
        state.settings(&names(&["aks-test-01-emm"]));
        let view = state.settings(&names(&["minikube"]));
        assert_eq!(access(&view, "minikube"), ("read_only", None));
    }

    #[test]
    fn label_change_never_changes_access() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        state.settings(&names(&[PROD, "kub3-dev"]));
        let view = state
            .set_environment(PROD, manual(Some(Environment::Test)))
            .expect("test");
        assert_eq!(access(&view, PROD), ("read_only", None));
        let view = state
            .set_environment("kub3-dev", manual(Some(Production)))
            .expect("production");
        assert_eq!(access(&view, "kub3-dev"), ("writable", None));
        let view = state.settings(&names(&[PROD, "kub3-dev"]));
        assert_eq!(access(&view, PROD), ("read_only", None));
        assert_eq!(access(&view, "kub3-dev"), ("writable", None));
    }

    #[test]
    fn first_label_set_by_hand_on_an_unseen_context_keeps_first_sight() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        // Never listed: first sight reads the detected label, before the change.
        let view = state
            .set_environment(PROD, manual(Some(Environment::Test)))
            .expect("test");
        assert_eq!(access(&view, PROD), ("read_only", None));
    }

    #[test]
    fn read_only_from_start_applies_to_new_contexts_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        state.settings(&names(&["aks-test-01-emm"]));
        let view = state
            .set_access_preferences(None, Some(vec![Environment::Test]))
            .expect("preferences");
        assert!(view.contexts.is_empty(), "no contexts in the answer");
        assert_eq!(view.read_only_from_start, vec![Environment::Test]);
        let view = state.settings(&names(&["aks-test-01-emm", "qa-02", PROD]));
        assert_eq!(access(&view, "aks-test-01-emm"), ("writable", None));
        assert_eq!(access(&view, "qa-02"), ("read_only", None));
        assert_eq!(
            access(&view, PROD),
            ("writable", None),
            "no longer in the set"
        );
    }

    #[test]
    fn timed_unlock_ends_by_clock() {
        let dir = tempfile::tempdir().expect("tempdir");
        let clock = TestClock::at(1_800_000_000);
        let t = clock.now();
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        let state = state.with_clock(clock.reader());
        state.settings(&names(&[PROD]));
        assert!(!state.write_allowed(PROD));

        let view = state
            .make_writable(PROD, UnlockFor::Minutes(5))
            .expect("unlock");
        assert_eq!(access(&view, PROD), ("writable", Some(ms(t + 5 * MINUTE))));

        clock.set(t + 5 * MINUTE - Duration::from_secs(1));
        assert!(state.write_allowed(PROD), "before the end");
        assert!(!state.tick(), "nothing ended yet");
        clock.set(t + 5 * MINUTE);
        assert!(!state.write_allowed(PROD), "at the end");
        assert!(state.tick(), "the end is told");
        assert!(!state.tick(), "only once");
        let view = state.settings(&names(&[PROD]));
        assert_eq!(access(&view, PROD), ("read_only", None));
    }

    #[test]
    fn view_shows_an_ended_unlock_as_read_only_before_the_tick() {
        let dir = tempfile::tempdir().expect("tempdir");
        let clock = TestClock::at(1_800_000_000);
        let t = clock.now();
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        let state = state.with_clock(clock.reader());
        state
            .make_writable(PROD, UnlockFor::Minutes(5))
            .expect("unlock");
        clock.set(t + 6 * MINUTE);
        let view = state.settings(&names(&[PROD]));
        assert_eq!(access(&view, PROD), ("read_only", None));
    }

    #[test]
    fn duration_again_restarts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let clock = TestClock::at(1_800_000_000);
        let t = clock.now();
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        let state = state.with_clock(clock.reader());
        state
            .make_writable(PROD, UnlockFor::Minutes(15))
            .expect("15");
        clock.set(t + 10 * MINUTE);
        let view = state.make_writable(PROD, UnlockFor::Minutes(5)).expect("5");
        assert_eq!(access(&view, PROD), ("writable", Some(ms(t + 15 * MINUTE))));
        clock.set(t + 15 * MINUTE - Duration::from_secs(1));
        assert!(state.write_allowed(PROD));
        clock.set(t + 15 * MINUTE);
        assert!(!state.write_allowed(PROD));
    }

    #[test]
    fn timed_unlock_is_not_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        let (state, _) = ClusterAccessState::load(path.clone());
        state.settings(&names(&[PROD]));
        state
            .make_writable(PROD, UnlockFor::Minutes(15))
            .expect("unlock");
        assert!(state.write_allowed(PROD));
        assert_eq!(saved_access(&path, PROD), serde_json::json!("read_only"));
        let (fresh, _) = ClusterAccessState::load(path);
        assert!(!fresh.write_allowed(PROD));
        let view = fresh.settings(&names(&[PROD]));
        assert_eq!(access(&view, PROD), ("read_only", None));
    }

    #[test]
    fn always_is_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        let (state, _) = ClusterAccessState::load(path.clone());
        state.settings(&names(&[PROD]));
        state
            .make_writable(PROD, UnlockFor::Minutes(5))
            .expect("timed");
        let view = state
            .make_writable(PROD, UnlockFor::Always)
            .expect("always");
        assert_eq!(access(&view, PROD), ("writable", None), "the timer is gone");
        assert_eq!(saved_access(&path, PROD), serde_json::json!("writable"));
        let (fresh, _) = ClusterAccessState::load(path.clone());
        assert!(fresh.write_allowed(PROD));
        // The timer is gone, not just hidden: read-only again from another
        // instance means read-only here too.
        fresh.make_read_only(PROD).expect("other instance locks");
        assert!(!state.write_allowed(PROD));
    }

    #[test]
    fn make_read_only_drops_unlock() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        let (state, _) = ClusterAccessState::load(path.clone());
        state
            .make_writable(PROD, UnlockFor::Minutes(60))
            .expect("unlock");
        let view = state.make_read_only(PROD).expect("read-only");
        assert_eq!(access(&view, PROD), ("read_only", None));
        assert!(!state.write_allowed(PROD));

        state
            .make_writable("minikube", UnlockFor::Always)
            .expect("always");
        state.make_read_only("minikube").expect("read-only");
        assert!(!state.write_allowed("minikube"));
        assert_eq!(
            saved_access(&path, "minikube"),
            serde_json::json!("read_only")
        );
    }

    #[test]
    fn bad_duration_refused() {
        // Review Focus 3.
        for bad in [
            serde_json::json!(0),
            serde_json::json!(7),
            serde_json::json!(-5),
            serde_json::json!(5.5),
            serde_json::json!("forever"),
            serde_json::json!("5"),
            serde_json::json!(null),
            serde_json::json!({}),
        ] {
            let err = serde_json::from_value::<UnlockFor>(bad.clone())
                .expect_err(&format!("{bad} refused"));
            assert_eq!(err.to_string(), "5, 15 or 60 minutes, or always");
        }
        for (good, want) in [
            (serde_json::json!(5), UnlockFor::Minutes(5)),
            (serde_json::json!(15), UnlockFor::Minutes(15)),
            (serde_json::json!(60), UnlockFor::Minutes(60)),
            (serde_json::json!("always"), UnlockFor::Always),
        ] {
            assert_eq!(
                serde_json::from_value::<UnlockFor>(good).expect("accepted"),
                want
            );
        }
    }

    #[test]
    fn preferences_round_trip_and_lenient() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = file_in(&dir);
        let (state, _) = ClusterAccessState::load(path.clone());
        let view = state.settings(&[]);
        assert!(view.confirm_unlock);
        assert_eq!(view.read_only_from_start, vec![Production]);

        let view = state
            .set_access_preferences(
                Some(false),
                Some(vec![Production, Environment::Staging, Production]),
            )
            .expect("set");
        assert!(!view.confirm_unlock);
        assert_eq!(
            view.read_only_from_start,
            vec![Environment::Staging, Production]
        );
        let view = state
            .set_access_preferences(None, None)
            .expect("nothing changes");
        assert!(!view.confirm_unlock, "None keeps the value");

        let (reloaded, _) = ClusterAccessState::load(path.clone());
        let view = reloaded.settings(&[]);
        assert!(!view.confirm_unlock);
        assert_eq!(
            view.read_only_from_start,
            vec![Environment::Staging, Production]
        );

        fs::write(
            &path,
            r#"{"confirm_unlock":"yes","read_only_from_start":["production","nope",3]}"#,
        )
        .expect("write");
        let (lenient, outcome) = ClusterAccessState::load(path.clone());
        assert_eq!(outcome, LoadOutcome::Loaded);
        let view = lenient.settings(&[]);
        assert!(view.confirm_unlock, "a bad value reads as the default");
        assert_eq!(view.read_only_from_start, vec![Production]);

        fs::write(&path, r#"{"read_only_from_start":"production"}"#).expect("write");
        let (lenient, _) = ClusterAccessState::load(path);
        assert_eq!(
            lenient.settings(&[]).read_only_from_start,
            vec![Production],
            "not a list reads as the default"
        );
    }

    #[test]
    fn other_instance_change_seen_at_next_write() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (a, _) = ClusterAccessState::load(file_in(&dir));
        let (b, _) = ClusterAccessState::load(file_in(&dir));
        a.settings(&names(&["x"]));
        assert!(a.write_allowed("x"));
        assert!(!a.tick(), "its own save is not a change");
        b.make_read_only("x").expect("b locks");
        assert!(!a.write_allowed("x"), "A reads B's change");
        let (c, _) = ClusterAccessState::load(file_in(&dir));
        c.make_writable("x", UnlockFor::Always).expect("c unlocks");
        assert!(a.tick(), "A notices the file changed");
        assert!(!a.tick(), "once");
    }

    #[test]
    fn a_change_read_by_a_write_check_is_still_told() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (a, _) = ClusterAccessState::load(file_in(&dir));
        let (b, _) = ClusterAccessState::load(file_in(&dir));
        a.settings(&names(&["x"]));
        assert!(!a.tick(), "its own save is not a change");
        b.make_read_only("x").expect("b locks");
        // A guarded write reads B's change before the ticker does.
        assert!(!a.write_allowed("x"), "A reads B's change");
        assert!(a.tick(), "the webview is still told");
        assert!(!a.tick(), "once");
    }

    #[test]
    fn two_instances_changing_at_once_lose_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (a, _) = ClusterAccessState::load(file_in(&dir));
        let (b, _) = ClusterAccessState::load(file_in(&dir));
        const EACH: usize = 60;
        std::thread::scope(|scope| {
            for (state, prefix) in [(&a, "a"), (&b, "b")] {
                scope.spawn(move || {
                    for i in 0..EACH {
                        let name = format!("{prefix}-{i}");
                        match i % 3 {
                            0 => {
                                state.make_read_only(&name).expect("read-only");
                            }
                            1 => {
                                state
                                    .make_writable(&name, UnlockFor::Always)
                                    .expect("writable");
                            }
                            _ => {
                                state
                                    .set_environment(&name, manual(Some(Development)))
                                    .expect("environment");
                            }
                        }
                    }
                });
            }
        });
        let (reloaded, _) = ClusterAccessState::load(file_in(&dir));
        let file = reloaded.lock().file.clone();
        let lost: Vec<_> = ["a", "b"]
            .iter()
            .flat_map(|prefix| (0..EACH).map(move |i| format!("{prefix}-{i}")))
            .filter(|name| !file.contexts.contains_key(name))
            .collect();
        assert!(lost.is_empty(), "changes lost: {lost:?}");
    }

    /// A state whose file cannot be saved any more: its directory is gone.
    fn unsaveable(dir: &tempfile::TempDir) -> (ClusterAccessState, PathBuf) {
        let sub = dir.path().join("config");
        fs::create_dir(&sub).expect("dir");
        let path = sub.join(FILE_NAME);
        let (state, _) = ClusterAccessState::load(path.clone());
        state.settings(&names(&["minikube"]));
        assert!(state.write_allowed("minikube"));
        fs::remove_dir_all(&sub).expect("remove");
        (state, path)
    }

    #[test]
    fn make_read_only_holds_when_the_file_cannot_be_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = unsaveable(&dir);
        let view = state
            .make_read_only("minikube")
            .expect("applied for this session");
        assert_eq!(access(&view, "minikube"), ("read_only", None));
        let json = serde_json::to_value(&view).expect("json");
        assert!(
            json["save_error"].as_str().is_some_and(|e| !e.is_empty()),
            "the failure is told: {json}"
        );
        assert!(!state.write_allowed("minikube"));
    }

    #[test]
    fn make_writable_fails_when_the_file_cannot_be_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = unsaveable(&dir);
        state.make_read_only("minikube").expect("for this session");
        assert!(state.make_writable("minikube", UnlockFor::Always).is_err());
        assert!(!state.write_allowed("minikube"), "still read-only");
    }

    #[test]
    fn make_read_only_again_saves_once_it_can() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, path) = unsaveable(&dir);
        state.make_read_only("minikube").expect("for this session");
        fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        let view = state.make_read_only("minikube").expect("saved now");
        assert_eq!(view.save_error, None);
        assert_eq!(
            saved_access(&path, "minikube"),
            serde_json::json!("read_only")
        );
    }

    #[test]
    fn read_only_for_this_session_outlasts_another_instances_save() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, path) = unsaveable(&dir);
        state.make_read_only("minikube").expect("for this session");
        // The directory comes back and another instance saves a file in
        // which minikube is still writable.
        fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        let (other, _) = ClusterAccessState::load(path.clone());
        other
            .make_writable("minikube", UnlockFor::Always)
            .expect("other saves");
        assert!(
            !state.write_allowed("minikube"),
            "read-only for this session"
        );
        let view = state.settings(&names(&["minikube"]));
        assert_eq!(access(&view, "minikube"), ("read_only", None));
        // Made writable here, it is writable again.
        state
            .make_writable("minikube", UnlockFor::Always)
            .expect("saved now");
        assert!(state.write_allowed("minikube"));
    }

    #[test]
    fn view_serialises_access() {
        let view = ContextEnvironmentView {
            name: "a".to_string(),
            environment: None,
            source: "detected",
            detected: None,
            access: "writable",
            writable_until: Some(1_800_000_300_000),
        };
        assert_eq!(
            serde_json::to_string(&view).expect("json"),
            r#"{"name":"a","environment":null,"source":"detected","detected":null,"access":"writable","writable_until":1800000300000}"#
        );
        let dir = tempfile::tempdir().expect("tempdir");
        let (state, _) = ClusterAccessState::load(file_in(&dir));
        let json = serde_json::to_value(state.settings(&[])).expect("json");
        assert_eq!(json["confirm_unlock"], serde_json::json!(true));
        assert_eq!(
            json["read_only_from_start"],
            serde_json::json!(["production"])
        );
    }

    #[test]
    fn in_memory_access_works_without_a_file() {
        let state = ClusterAccessState::in_memory();
        assert!(!state.write_allowed(PROD));
        state
            .make_writable(PROD, UnlockFor::Always)
            .expect("kept in memory");
        assert!(state.write_allowed(PROD));
    }
}
