//! The system clipboard, for a copied Secret value (#661, spec §6.2).
//!
//! The value is written from Rust; it never crosses to the webview, and the
//! webview has no clipboard permission. With a time set, the clipboard is
//! cleared after it **only if it still holds what was copied**, compared by a
//! digest (the value itself is not kept). A new copy replaces the pending
//! clear; Never leaves the clipboard alone.
//!
//! A ConfigMap value (#668) is written plain ([`ClipboardState::copy_plain`]):
//! no mark, nothing kept off other devices, no clear. It also drops any
//! pending clear: the clipboard no longer holds the Secret value, and the new
//! content must not be touched, even when it is the same text.
//!
//! The time is kept twice: on the monotonic clock, and on the wall clock,
//! which also runs while the computer sleeps; the worker looks at least every
//! [`POLL`], so a clear due during a sleep runs soon after waking. A read or a
//! clear that fails is tried again a few times before the clear is given up.
//!
//! A pending clear also runs at once, on the same condition, at every exit the
//! backend sees: the app's exit event and the drop of its resources
//! ([`ClearAtExit`]), which the updater's Windows install path runs before its
//! own `process::exit`. Running it twice does nothing more.
//!
//! One clipboard instance lives in a worker thread owned by the app's managed
//! state: on Linux the content lives as long as its owner. Copies are written
//! in the order they were asked for ([`ClipboardState::ticket`]). The rule
//! ([`Keeper`]) takes any [`Board`], so it is tested on a stand-in.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use sha2::{Digest as _, Sha256};

#[cfg(target_os = "macos")]
mod macos;

/// The longest the worker waits before it looks at the wall clock again.
pub const POLL: Duration = Duration::from_secs(2);
/// The wait before a failed read or clear is tried again.
const RETRY: Duration = Duration::from_millis(500);
/// How many times a clear is tried before it is given up.
const ATTEMPTS: u32 = 5;
/// The pause between tries at exit.
const EXIT_RETRY: Duration = Duration::from_millis(50);
/// How long an exit waits for a pending clear.
pub const EXIT_WAIT: Duration = Duration::from_secs(2);

/// What a copy answers when a copy asked for later was written first.
pub const SUPERSEDED: &str = "Not copied: a later copy took its place";

/// What the clearing rule needs of a clipboard.
pub trait Board {
    /// Write `text`, with the platform's "do not keep" marks.
    fn write(&mut self, text: &str) -> Result<(), String>;
    /// Write `text` as any copy is written: no mark, nothing kept off other
    /// devices (a ConfigMap value, #668).
    fn write_plain(&mut self, text: &str) -> Result<(), String>;
    /// The text the clipboard holds now; `None` when it holds no text. An
    /// error is a read that failed, which says nothing about what it holds.
    fn read(&mut self) -> Result<Option<String>, String>;
    /// Empty the clipboard.
    fn clear(&mut self) -> Result<(), String>;
}

type Digest = [u8; 32];

fn digest(text: &str) -> Digest {
    Sha256::digest(text.as_bytes()).into()
}

/// A clear to run when due, if the clipboard still holds the text of `digest`.
struct Pending {
    digest: Digest,
    /// Due on the monotonic clock…
    due: Instant,
    /// …or on the wall clock, which also runs during a sleep.
    due_wall: SystemTime,
    /// After a failed try: when to try again.
    retry_at: Option<Instant>,
    failures: u32,
}

impl Pending {
    fn is_due(&self, now: Instant, wall: SystemTime) -> bool {
        match self.retry_at {
            Some(at) => now >= at,
            None => now >= self.due || wall >= self.due_wall,
        }
    }

    fn next(&self) -> Instant {
        self.retry_at.unwrap_or(self.due)
    }
}

/// The outcome of one try at a pending clear.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attempt {
    /// It held what was copied, and is empty now.
    Cleared,
    /// It holds something else: left as it is.
    NotOurs,
    /// The read or the clear failed.
    Failed,
}

/// The clearing rule, over one clipboard.
pub struct Keeper<B> {
    board: B,
    pending: Option<Pending>,
}

impl<B: Board> Keeper<B> {
    pub fn new(board: B) -> Self {
        Self {
            board,
            pending: None,
        }
    }

    /// Write `text` and, with `clear_after`, plan its clear; any clear
    /// pending before is replaced (with none, for Never). A failed write
    /// leaves the pending clear as it was.
    pub fn copy(
        &mut self,
        text: &str,
        clear_after: Option<Duration>,
        now: Instant,
        wall: SystemTime,
    ) -> Result<(), String> {
        self.board.write(text)?;
        self.pending = clear_after.and_then(|after| {
            Some(Pending {
                digest: digest(text),
                due: now.checked_add(after)?,
                due_wall: wall.checked_add(after)?,
                retry_at: None,
                failures: 0,
            })
        });
        Ok(())
    }

    /// Write `text` plain, with no clear of its own. The clipboard no longer
    /// holds what a pending clear was for, so that clear is dropped: it must
    /// not touch the new content, even the same text. A failed write leaves
    /// the pending clear as it was.
    pub fn copy_plain(&mut self, text: &str) -> Result<(), String> {
        self.board.write_plain(text)?;
        self.pending = None;
        Ok(())
    }

    /// Whether a clear is pending.
    pub fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// When the worker should look again: when the pending clear is due, or
    /// [`POLL`] from `now` if sooner (the wall clock may get there first).
    pub fn next_look(&self, now: Instant) -> Option<Instant> {
        let pending = self.pending.as_ref()?;
        let poll = now.checked_add(POLL).unwrap_or(now);
        Some(pending.next().min(poll))
    }

    /// Run the pending clear if its time has come by either clock. A failed
    /// try is tried again after [`RETRY`], up to [`ATTEMPTS`] tries.
    pub fn run_due(&mut self, now: Instant, wall: SystemTime) {
        if !self.pending.as_ref().is_some_and(|p| p.is_due(now, wall)) {
            return;
        }
        match self.attempt() {
            Attempt::Cleared | Attempt::NotOurs => self.pending = None,
            Attempt::Failed => {
                if let Some(p) = self.pending.as_mut() {
                    p.failures += 1;
                    p.retry_at = now.checked_add(RETRY);
                    if p.failures >= ATTEMPTS || p.retry_at.is_none() {
                        self.pending = None;
                    }
                }
            }
        }
    }

    /// Run the pending clear now, whatever its time (at exit), on the same
    /// condition; a failed try is tried again after `pause`, up to
    /// [`ATTEMPTS`] tries. Nothing pending: nothing done.
    pub fn clear_now(&mut self, mut pause: impl FnMut()) {
        for tried in 1..=ATTEMPTS {
            if self.pending.is_none() {
                return;
            }
            match self.attempt() {
                Attempt::Cleared | Attempt::NotOurs => break,
                Attempt::Failed if tried < ATTEMPTS => pause(),
                Attempt::Failed => {}
            }
        }
        self.pending = None;
    }

    /// One try: read, compare, clear. The pending clear is kept.
    fn attempt(&mut self) -> Attempt {
        let Some(want) = self.pending.as_ref().map(|p| p.digest) else {
            return Attempt::NotOurs;
        };
        match self.board.read() {
            Err(_) => Attempt::Failed,
            Ok(Some(text)) if digest(&text) == want => match self.board.clear() {
                Ok(()) => Attempt::Cleared,
                Err(_) => Attempt::Failed,
            },
            Ok(_) => Attempt::NotOurs,
        }
    }
}

/// How a copy is written.
enum How {
    /// With the "do not keep" marks and, with a time, its clear (a Secret).
    Concealed { clear_after: Option<Duration> },
    /// As any copy, no clear (a ConfigMap value).
    Plain,
}

/// A request to the worker.
enum Job {
    Copy {
        /// The order in which the copy was asked for.
        ticket: u64,
        text: String,
        how: How,
        done: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    ClearNow {
        done: mpsc::Sender<()>,
    },
}

/// The worker's loop: one clipboard, opened on the first copy; copies written
/// in the order they were asked for (an older one than the newest seen is
/// not written); each pending clear run when due. It ends when the state is
/// dropped, running a pending clear first.
fn serve<B: Board>(jobs: mpsc::Receiver<Job>, mut open: impl FnMut() -> Result<B, String>) {
    let mut keeper: Option<Keeper<B>> = None;
    let mut newest = 0;
    loop {
        let job = match keeper.as_ref().and_then(|k| k.next_look(Instant::now())) {
            Some(at) => match jobs.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(job) => job,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(k) = keeper.as_mut() {
                        k.run_due(Instant::now(), SystemTime::now());
                    }
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            },
            None => match jobs.recv() {
                Ok(job) => job,
                Err(_) => break,
            },
        };
        match job {
            Job::Copy {
                ticket,
                text,
                how,
                done,
            } => {
                if ticket < newest {
                    let _ = done.send(Err(SUPERSEDED.to_string()));
                    continue;
                }
                newest = ticket;
                if keeper.is_none() {
                    match open() {
                        Ok(board) => keeper = Some(Keeper::new(board)),
                        Err(e) => {
                            let _ = done.send(Err(e));
                            continue;
                        }
                    }
                }
                let result = match (keeper.as_mut(), how) {
                    (Some(k), How::Concealed { clear_after }) => {
                        k.copy(&text, clear_after, Instant::now(), SystemTime::now())
                    }
                    (Some(k), How::Plain) => k.copy_plain(&text),
                    (None, _) => Err("The clipboard is not available".to_string()),
                };
                drop(text);
                let _ = done.send(result);
            }
            Job::ClearNow { done } => {
                if let Some(k) = keeper.as_mut() {
                    k.clear_now(|| std::thread::sleep(EXIT_RETRY));
                }
                let _ = done.send(());
            }
        }
    }
    if let Some(k) = keeper.as_mut() {
        k.clear_now(|| std::thread::sleep(EXIT_RETRY));
    }
}

struct Shared {
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
    tickets: AtomicU64,
}

/// The app's clipboard, in its managed state: the sender to the worker that
/// owns the one clipboard instance. Clones share it.
#[derive(Clone)]
pub struct ClipboardState {
    shared: Arc<Shared>,
}

impl Default for ClipboardState {
    fn default() -> Self {
        Self::with(SystemBoard::open)
    }
}

impl ClipboardState {
    /// A state whose worker opens its clipboard with `open`, on the first copy.
    pub fn with<B: Board + 'static>(
        open: impl FnMut() -> Result<B, String> + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::channel();
        let started = std::thread::Builder::new()
            .name("clipboard".into())
            .spawn(move || serve(rx, open))
            .is_ok();
        Self {
            shared: Arc::new(Shared {
                jobs: Mutex::new(started.then_some(tx)),
                tickets: AtomicU64::new(1),
            }),
        }
    }

    fn sender(&self) -> Option<mpsc::Sender<Job>> {
        self.shared.jobs.lock().ok().and_then(|jobs| jobs.clone())
    }

    /// The place of a copy in the order copies were asked for: taken when the
    /// command starts, before it reads the value.
    pub fn ticket(&self) -> u64 {
        self.shared.tickets.fetch_add(1, Ordering::Relaxed)
    }

    /// Write `text` to the clipboard; with `clear_after`, clear it after that
    /// time if it still holds `text`. Replaces any pending clear. When a copy
    /// with a later `ticket` was written first, nothing is written and the
    /// answer is [`SUPERSEDED`].
    pub async fn copy(
        &self,
        ticket: u64,
        text: String,
        clear_after: Option<Duration>,
    ) -> Result<(), String> {
        self.send_copy(ticket, text, How::Concealed { clear_after })
            .await
    }

    /// Write `text` to the clipboard as any copy is written: no mark, no
    /// clear. Drops any pending clear (the clipboard no longer holds what it
    /// was for). Ordered with the other copies by `ticket`, as [`Self::copy`].
    pub async fn copy_plain(&self, ticket: u64, text: String) -> Result<(), String> {
        self.send_copy(ticket, text, How::Plain).await
    }

    async fn send_copy(&self, ticket: u64, text: String, how: How) -> Result<(), String> {
        let unavailable = || "The clipboard is not available".to_string();
        let jobs = self.sender().ok_or_else(unavailable)?;
        let (done, answer) = tokio::sync::oneshot::channel();
        jobs.send(Job::Copy {
            ticket,
            text,
            how,
            done,
        })
        .map_err(|_| unavailable())?;
        answer.await.map_err(|_| unavailable())?
    }

    /// Run a pending clear at once (at exit), waiting for it up to `wait`.
    /// With nothing pending, it does nothing.
    pub fn clear_pending_now(&self, wait: Duration) {
        let Some(jobs) = self.sender() else {
            return;
        };
        let (done, finished) = mpsc::channel();
        if jobs.send(Job::ClearNow { done }).is_ok() {
            let _ = finished.recv_timeout(wait);
        }
    }
}

/// A resource of the app whose drop runs a pending clear: Tauri drops the
/// app's resources in `cleanup_before_exit`, which the updater calls on
/// Windows before it starts the installer and calls `process::exit`, with no
/// exit event.
pub struct ClearAtExit(pub ClipboardState);

impl tauri::Resource for ClearAtExit {}

impl Drop for ClearAtExit {
    fn drop(&mut self) {
        self.0.clear_pending_now(EXIT_WAIT);
    }
}

/// The system clipboard, through `arboard`; on macOS the write goes through
/// [`macos`] instead, to keep the value off Universal Clipboard.
struct SystemBoard {
    clipboard: arboard::Clipboard,
}

impl SystemBoard {
    fn open() -> Result<Self, String> {
        arboard::Clipboard::new()
            .map(|clipboard| Self { clipboard })
            .map_err(|e| format!("The clipboard is not available: {e}"))
    }
}

impl Board for SystemBoard {
    #[cfg(target_os = "macos")]
    fn write(&mut self, text: &str) -> Result<(), String> {
        macos::write_current_host_only(text)
    }

    #[cfg(not(target_os = "macos"))]
    fn write(&mut self, text: &str) -> Result<(), String> {
        let set = self.clipboard.set();
        // Windows: kept out of clipboard history, cloud sync and any other
        // monitor (the one flag covers the other two; arboard advises
        // against combining them).
        #[cfg(windows)]
        let set = {
            use arboard::SetExtWindows;
            set.exclude_from_monitoring()
        };
        // Linux: the password hint clipboard managers follow.
        #[cfg(all(unix, not(target_os = "macos")))]
        let set = {
            use arboard::SetExtLinux;
            set.exclude_from_history()
        };
        set.text(text)
            .map_err(|e| format!("Could not write the clipboard: {e}"))
    }

    /// An ordinary write on every platform, macOS included: no mark, and
    /// Universal Clipboard may carry it, as any copy.
    fn write_plain(&mut self, text: &str) -> Result<(), String> {
        self.clipboard
            .set_text(text)
            .map_err(|e| format!("Could not write the clipboard: {e}"))
    }

    fn read(&mut self) -> Result<Option<String>, String> {
        match self.clipboard.get_text() {
            Ok(text) => Ok(Some(text)),
            // Something else than text (or nothing): not what was copied.
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(e) => Err(format!("Could not read the clipboard: {e}")),
        }
    }

    fn clear(&mut self) -> Result<(), String> {
        self.clipboard
            .clear()
            .map_err(|e| format!("Could not clear the clipboard: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// A clipboard stand-in: what it holds, the clears it saw, and how many
    /// of the next reads and clears fail.
    #[derive(Clone, Default)]
    struct Fake {
        held: Arc<StdMutex<Option<String>>>,
        /// Whether the last write carried the "do not keep" marks.
        marked: Arc<StdMutex<Option<bool>>>,
        clears: Arc<StdMutex<u32>>,
        failing_reads: Arc<StdMutex<u32>>,
        failing_clears: Arc<StdMutex<u32>>,
    }

    impl Fake {
        fn holds(&self) -> Option<String> {
            self.held.lock().expect("lock").clone()
        }
        /// The user copies something else.
        fn user_copies(&self, text: &str) {
            *self.held.lock().expect("lock") = Some(text.to_string());
        }
        /// The user copies an image: no text.
        fn user_copies_an_image(&self) {
            *self.held.lock().expect("lock") = None;
        }
        fn last_write_marked(&self) -> Option<bool> {
            *self.marked.lock().expect("lock")
        }
        fn clears(&self) -> u32 {
            *self.clears.lock().expect("lock")
        }
        fn fail_reads(&self, n: u32) {
            *self.failing_reads.lock().expect("lock") = n;
        }
        fn fail_clears(&self, n: u32) {
            *self.failing_clears.lock().expect("lock") = n;
        }
    }

    /// Takes one from a counter of failures to come; true when one was due.
    fn take(counter: &StdMutex<u32>) -> bool {
        let mut n = counter.lock().expect("lock");
        let fail = *n > 0;
        *n = n.saturating_sub(1);
        fail
    }

    impl Board for Fake {
        fn write(&mut self, text: &str) -> Result<(), String> {
            *self.held.lock().expect("lock") = Some(text.to_string());
            *self.marked.lock().expect("lock") = Some(true);
            Ok(())
        }
        fn write_plain(&mut self, text: &str) -> Result<(), String> {
            *self.held.lock().expect("lock") = Some(text.to_string());
            *self.marked.lock().expect("lock") = Some(false);
            Ok(())
        }
        fn read(&mut self) -> Result<Option<String>, String> {
            if take(&self.failing_reads) {
                return Err("busy".into());
            }
            Ok(self.holds())
        }
        fn clear(&mut self) -> Result<(), String> {
            if take(&self.failing_clears) {
                return Err("busy".into());
            }
            *self.held.lock().expect("lock") = None;
            *self.clears.lock().expect("lock") += 1;
            Ok(())
        }
    }

    const S30: Option<Duration> = Some(Duration::from_secs(30));
    const SEC: Duration = Duration::from_secs(1);

    fn clocks() -> (Instant, SystemTime) {
        (Instant::now(), SystemTime::now())
    }

    #[test]
    fn still_ours_after_the_time_it_is_cleared() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let (t0, w0) = clocks();
        keeper.copy("s3cr3t", S30, t0, w0).expect("copy");
        assert_eq!(fake.holds().as_deref(), Some("s3cr3t"));
        keeper.run_due(t0 + 29 * SEC, w0 + 29 * SEC);
        assert_eq!(fake.holds().as_deref(), Some("s3cr3t"));
        keeper.run_due(t0 + 30 * SEC, w0 + 30 * SEC);
        assert_eq!(fake.holds(), None);
        assert!(!keeper.is_pending());
    }

    #[test]
    fn after_a_sleep_the_wall_clock_makes_it_due() {
        // The monotonic clock stood still during the sleep; the wall clock did not.
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let (t0, w0) = clocks();
        keeper.copy("s3cr3t", S30, t0, w0).expect("copy");
        keeper.run_due(t0 + SEC, w0 + 31 * SEC);
        assert_eq!(fake.holds(), None);
    }

    #[test]
    fn the_worker_looks_again_at_least_every_poll() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake);
        let (t0, w0) = clocks();
        assert_eq!(keeper.next_look(t0), None);
        keeper
            .copy("v", Some(Duration::from_secs(300)), t0, w0)
            .expect("copy");
        assert_eq!(keeper.next_look(t0), Some(t0 + POLL));
        keeper.copy("v", Some(SEC), t0, w0).expect("copy");
        assert_eq!(keeper.next_look(t0), Some(t0 + SEC));
    }

    #[test]
    fn replaced_by_the_user_it_is_left_untouched() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let (t0, w0) = clocks();
        keeper.copy("s3cr3t", S30, t0, w0).expect("copy");
        fake.user_copies("a note of mine");
        keeper.run_due(t0 + 30 * SEC, w0 + 30 * SEC);
        assert_eq!(fake.holds().as_deref(), Some("a note of mine"));
        assert_eq!(fake.clears(), 0);
        assert!(!keeper.is_pending());

        // Replaced by something that is not text: not ours either.
        keeper.copy("s3cr3t", S30, t0, w0).expect("copy");
        fake.user_copies_an_image();
        keeper.run_due(t0 + 30 * SEC, w0 + 30 * SEC);
        assert_eq!(fake.clears(), 0);
        assert!(!keeper.is_pending());
    }

    #[test]
    fn a_failed_read_or_clear_is_tried_again_after_a_short_wait() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let (t0, w0) = clocks();
        keeper.copy("s3cr3t", S30, t0, w0).expect("copy");
        let due = t0 + 30 * SEC;
        let wall = w0 + 30 * SEC;
        fake.fail_reads(1);
        fake.fail_clears(1);
        keeper.run_due(due, wall);
        assert!(keeper.is_pending(), "a failed read keeps the clear");
        assert_eq!(keeper.next_look(due), Some(due + RETRY));
        // Not before its retry, even though the wall clock is past.
        keeper.run_due(due + RETRY / 2, wall + RETRY / 2);
        assert_eq!(fake.holds().as_deref(), Some("s3cr3t"));
        keeper.run_due(due + RETRY, wall + RETRY);
        assert!(keeper.is_pending(), "a failed clear keeps the clear");
        keeper.run_due(due + 2 * RETRY, wall + 2 * RETRY);
        assert_eq!(fake.holds(), None);
        assert!(!keeper.is_pending());
    }

    #[test]
    fn a_clear_that_keeps_failing_is_given_up() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let (t0, w0) = clocks();
        keeper.copy("s3cr3t", S30, t0, w0).expect("copy");
        fake.fail_reads(ATTEMPTS);
        let mut at = t0 + 30 * SEC;
        for _ in 0..ATTEMPTS {
            assert!(keeper.is_pending());
            keeper.run_due(at, w0 + 30 * SEC);
            at += RETRY;
        }
        assert!(!keeper.is_pending());
        assert_eq!(fake.holds().as_deref(), Some("s3cr3t"));
    }

    #[test]
    fn a_second_copy_replaces_the_pending_clear() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let (t0, w0) = clocks();
        keeper.copy("first", S30, t0, w0).expect("copy");
        let (t1, w1) = (t0 + 20 * SEC, w0 + 20 * SEC);
        keeper.copy("second", S30, t1, w1).expect("copy");
        // The first one's time: nothing happens.
        keeper.run_due(t0 + 30 * SEC, w0 + 30 * SEC);
        assert_eq!(fake.holds().as_deref(), Some("second"));
        keeper.run_due(t1 + 30 * SEC, w1 + 30 * SEC);
        assert_eq!(fake.holds(), None);
        assert_eq!(fake.clears(), 1);
    }

    #[test]
    fn never_plans_no_clear_and_drops_the_one_pending() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let (t0, w0) = clocks();
        keeper.copy("first", S30, t0, w0).expect("copy");
        keeper.copy("second", None, t0, w0).expect("copy");
        assert!(!keeper.is_pending());
        keeper.run_due(t0 + 3600 * SEC, w0 + 3600 * SEC);
        keeper.clear_now(|| {});
        assert_eq!(fake.holds().as_deref(), Some("second"));
        assert_eq!(fake.clears(), 0);
    }

    #[test]
    fn a_pending_clear_runs_at_exit_on_the_same_condition_and_retries() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let (t0, w0) = clocks();
        keeper.copy("s3cr3t", S30, t0, w0).expect("copy");
        fake.fail_reads(2);
        let mut pauses = 0;
        keeper.clear_now(|| pauses += 1);
        assert_eq!(pauses, 2);
        assert_eq!(fake.holds(), None);

        keeper.copy("s3cr3t", S30, t0, w0).expect("copy");
        fake.user_copies("mine");
        keeper.clear_now(|| {});
        assert_eq!(fake.holds().as_deref(), Some("mine"));
        // Twice: nothing more.
        keeper.clear_now(|| panic!("nothing to retry"));
        assert_eq!(fake.clears(), 1);
    }

    #[test]
    fn a_failed_write_keeps_the_pending_clear() {
        struct Broken(Fake);
        impl Board for Broken {
            fn write(&mut self, _: &str) -> Result<(), String> {
                Err("no".into())
            }
            fn write_plain(&mut self, _: &str) -> Result<(), String> {
                Err("no".into())
            }
            fn read(&mut self) -> Result<Option<String>, String> {
                self.0.read()
            }
            fn clear(&mut self) -> Result<(), String> {
                self.0.clear()
            }
        }
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let (t0, w0) = clocks();
        keeper.copy("s3cr3t", S30, t0, w0).expect("copy");
        let mut broken = Keeper {
            board: Broken(fake.clone()),
            pending: keeper.pending.take(),
        };
        assert!(broken.copy("other", S30, t0, w0).is_err());
        broken.clear_now(|| {});
        assert_eq!(fake.holds(), None);
    }

    /// A state over a stand-in, and the stand-in.
    fn state() -> (ClipboardState, Fake) {
        let fake = Fake::default();
        let board = fake.clone();
        (ClipboardState::with(move || Ok(board.clone())), fake)
    }

    #[tokio::test]
    async fn the_worker_clears_after_the_time_and_at_exit() {
        let (state, fake) = state();
        let t = state.ticket();
        state
            .copy(t, "s3cr3t".into(), Some(Duration::from_millis(50)))
            .await
            .expect("copy");
        assert_eq!(fake.holds().as_deref(), Some("s3cr3t"));
        for _ in 0..100 {
            if fake.holds().is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(fake.holds(), None, "cleared after its time");

        // At exit: a clear an hour away runs at once.
        let t = state.ticket();
        state
            .copy(t, "s3cr3t".into(), Some(Duration::from_secs(3600)))
            .await
            .expect("copy");
        state.clear_pending_now(EXIT_WAIT);
        assert_eq!(fake.holds(), None, "cleared at exit");

        // At exit, after the user copied something else: untouched.
        let t = state.ticket();
        state
            .copy(t, "s3cr3t".into(), Some(Duration::from_secs(3600)))
            .await
            .expect("copy");
        fake.user_copies("mine");
        state.clear_pending_now(EXIT_WAIT);
        assert_eq!(fake.holds().as_deref(), Some("mine"));
    }

    #[tokio::test]
    async fn dropping_the_exit_resource_runs_the_pending_clear_once() {
        let (state, fake) = state();
        let t = state.ticket();
        state
            .copy(t, "s3cr3t".into(), Some(Duration::from_secs(3600)))
            .await
            .expect("copy");
        let mut table = tauri::ResourceTable::default();
        table.add(ClearAtExit(state.clone()));
        // cleanup_before_exit empties the app's table (its clear is not
        // public): dropping the table drops the resource the same way.
        drop(table);
        assert_eq!(fake.holds(), None, "cleared when the resource is dropped");
        assert_eq!(fake.clears(), 1);
        // The exit event after it: nothing more.
        state.clear_pending_now(EXIT_WAIT);
        drop(ClearAtExit(state.clone()));
        assert_eq!(fake.clears(), 1);
    }

    #[tokio::test]
    async fn an_older_copy_arriving_after_a_newer_one_is_not_written() {
        let (state, fake) = state();
        let older = state.ticket();
        let newer = state.ticket();
        assert!(newer > older);
        state
            .copy(newer, "newer".into(), Some(Duration::from_secs(3600)))
            .await
            .expect("newer");
        let err = state
            .copy(older, "older".into(), None)
            .await
            .expect_err("older");
        assert_eq!(err, SUPERSEDED);
        assert_eq!(fake.holds().as_deref(), Some("newer"));
        // The newer copy's clear is still pending.
        state.clear_pending_now(EXIT_WAIT);
        assert_eq!(fake.holds(), None);
    }

    #[tokio::test]
    async fn a_clipboard_that_cannot_open_is_an_error_and_is_tried_again() {
        let tries = Arc::new(StdMutex::new(0));
        let counted = tries.clone();
        let state = ClipboardState::with(move || {
            *counted.lock().expect("lock") += 1;
            Err::<Fake, _>("The clipboard is not available: no display".to_string())
        });
        for _ in 0..2 {
            let t = state.ticket();
            let err = state.copy(t, "v".into(), None).await.expect_err("no board");
            assert!(err.contains("not available"), "{err}");
        }
        assert_eq!(*tries.lock().expect("lock"), 2);
        // Nothing pending: exit does not wait.
        state.clear_pending_now(EXIT_WAIT);
    }

    #[test]
    fn a_plain_copy_has_no_mark_and_drops_the_pending_secret_clear() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let (t0, w0) = clocks();
        keeper.copy("s3cr3t", S30, t0, w0).expect("copy");
        assert_eq!(fake.last_write_marked(), Some(true));
        // The ConfigMap value happens to be the same text: a clear that
        // compares digests would wipe it.
        keeper.copy_plain("s3cr3t").expect("plain copy");
        assert_eq!(fake.last_write_marked(), Some(false));
        assert!(!keeper.is_pending());
        keeper.run_due(t0 + 30 * SEC, w0 + 30 * SEC);
        keeper.clear_now(|| {});
        assert_eq!(fake.holds().as_deref(), Some("s3cr3t"));
        assert_eq!(fake.clears(), 0);
    }

    #[test]
    fn a_failed_plain_write_keeps_the_pending_clear() {
        struct Broken(Fake);
        impl Board for Broken {
            fn write(&mut self, text: &str) -> Result<(), String> {
                self.0.write(text)
            }
            fn write_plain(&mut self, _: &str) -> Result<(), String> {
                Err("no".into())
            }
            fn read(&mut self) -> Result<Option<String>, String> {
                self.0.read()
            }
            fn clear(&mut self) -> Result<(), String> {
                self.0.clear()
            }
        }
        let fake = Fake::default();
        let mut keeper = Keeper::new(Broken(fake.clone()));
        let (t0, w0) = clocks();
        keeper.copy("s3cr3t", S30, t0, w0).expect("copy");
        assert!(keeper.copy_plain("note").is_err());
        // The clipboard still holds the Secret value: its clear stays.
        assert!(keeper.is_pending());
        keeper.clear_now(|| {});
        assert_eq!(fake.holds(), None);
    }

    #[tokio::test]
    async fn the_worker_writes_a_plain_copy_in_order_and_drops_the_pending_clear() {
        let (state, fake) = state();
        let t = state.ticket();
        state
            .copy(t, "s3cr3t".into(), Some(Duration::from_secs(3600)))
            .await
            .expect("copy");
        let t = state.ticket();
        state
            .copy_plain(t, "server:\n  port: 8080\n".into())
            .await
            .expect("plain copy");
        assert_eq!(fake.last_write_marked(), Some(false));
        // At exit: nothing pending, the plain copy stays.
        state.clear_pending_now(EXIT_WAIT);
        assert_eq!(fake.holds().as_deref(), Some("server:\n  port: 8080\n"));
        assert_eq!(fake.clears(), 0);

        // Copies keep one order, plain or concealed.
        let older = state.ticket();
        let newer = state.ticket();
        state
            .copy(newer, "newer".into(), None)
            .await
            .expect("newer");
        let err = state
            .copy_plain(older, "older".into())
            .await
            .expect_err("older");
        assert_eq!(err, SUPERSEDED);
        assert_eq!(fake.holds().as_deref(), Some("newer"));
    }

    #[test]
    fn the_digest_tells_values_apart_without_keeping_them() {
        assert_eq!(digest("a"), digest("a"));
        assert_ne!(digest("a"), digest("b"));
    }
}
