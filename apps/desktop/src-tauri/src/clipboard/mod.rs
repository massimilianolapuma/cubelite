//! The system clipboard, for a copied Secret value (#661, spec §6.2).
//!
//! The value is written from Rust; it never crosses to the webview, and the
//! webview has no clipboard permission. With a time set, the clipboard is
//! cleared after it **only if it still holds what was copied**, compared by a
//! digest (the value itself is not kept). A new copy replaces the pending
//! clear; Never leaves the clipboard alone. A pending clear also runs at
//! once, on the same condition, when the app exits ([`ClipboardState::clear_pending_now`]).
//!
//! One clipboard instance lives in a worker thread owned by the app's managed
//! state: on Linux the content lives as long as its owner, and the timer is
//! the worker's own wait. The rule ([`Keeper`]) takes any [`Board`], so it is
//! tested on a stand-in.

use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest as _, Sha256};

#[cfg(target_os = "macos")]
mod macos;

/// What the clearing rule needs of a clipboard.
pub trait Board {
    /// Write `text`, with the platform's "do not keep" marks.
    fn write(&mut self, text: &str) -> Result<(), String>;
    /// The text the clipboard holds now, if it holds text.
    fn read(&mut self) -> Option<String>;
    /// Empty the clipboard.
    fn clear(&mut self) -> Result<(), String>;
}

type Digest = [u8; 32];

fn digest(text: &str) -> Digest {
    Sha256::digest(text.as_bytes()).into()
}

/// A clear to run at `due`, if the clipboard still holds the text of `digest`.
struct Pending {
    digest: Digest,
    due: Instant,
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
    ) -> Result<(), String> {
        self.board.write(text)?;
        self.pending = clear_after
            .and_then(|after| now.checked_add(after))
            .map(|due| Pending {
                digest: digest(text),
                due,
            });
        Ok(())
    }

    /// When the pending clear is due, if there is one.
    pub fn due(&self) -> Option<Instant> {
        self.pending.as_ref().map(|p| p.due)
    }

    /// Run the pending clear if its time has come.
    pub fn run_due(&mut self, now: Instant) {
        if self.pending.as_ref().is_some_and(|p| p.due <= now) {
            self.clear_now();
        }
    }

    /// Run the pending clear now, whatever its time (at exit): the clipboard
    /// is emptied only if it still holds what was copied.
    pub fn clear_now(&mut self) {
        let Some(pending) = self.pending.take() else {
            return;
        };
        let ours = self
            .board
            .read()
            .is_some_and(|text| digest(&text) == pending.digest);
        if ours {
            // Nothing to tell anyone: the clipboard keeps the value.
            let _ = self.board.clear();
        }
    }
}

/// A request to the worker.
enum Job {
    Copy {
        text: String,
        clear_after: Option<Duration>,
        done: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    ClearNow {
        done: mpsc::Sender<()>,
    },
}

/// The worker's loop: one clipboard, opened on the first copy, each pending
/// clear run when due. It ends when the state is dropped, running a pending
/// clear first.
fn serve<B: Board>(jobs: mpsc::Receiver<Job>, mut open: impl FnMut() -> Result<B, String>) {
    let mut keeper: Option<Keeper<B>> = None;
    loop {
        let job = match keeper.as_ref().and_then(Keeper::due) {
            Some(due) => match jobs.recv_timeout(due.saturating_duration_since(Instant::now())) {
                Ok(job) => job,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(k) = keeper.as_mut() {
                        k.run_due(Instant::now());
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
                text,
                clear_after,
                done,
            } => {
                if keeper.is_none() {
                    match open() {
                        Ok(board) => keeper = Some(Keeper::new(board)),
                        Err(e) => {
                            let _ = done.send(Err(e));
                            continue;
                        }
                    }
                }
                let result = match keeper.as_mut() {
                    Some(k) => k.copy(&text, clear_after, Instant::now()),
                    None => Err("The clipboard is not available".to_string()),
                };
                drop(text);
                let _ = done.send(result);
            }
            Job::ClearNow { done } => {
                if let Some(k) = keeper.as_mut() {
                    k.clear_now();
                }
                let _ = done.send(());
            }
        }
    }
    if let Some(k) = keeper.as_mut() {
        k.clear_now();
    }
}

/// The app's clipboard, in its managed state: the sender to the worker that
/// owns the one clipboard instance.
pub struct ClipboardState {
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
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
            jobs: Mutex::new(started.then_some(tx)),
        }
    }

    fn sender(&self) -> Option<mpsc::Sender<Job>> {
        self.jobs.lock().ok().and_then(|jobs| jobs.clone())
    }

    /// Write `text` to the clipboard; with `clear_after`, clear it after that
    /// time if it still holds `text`. Replaces any pending clear.
    pub async fn copy(&self, text: String, clear_after: Option<Duration>) -> Result<(), String> {
        let unavailable = || "The clipboard is not available".to_string();
        let jobs = self.sender().ok_or_else(unavailable)?;
        let (done, answer) = tokio::sync::oneshot::channel();
        jobs.send(Job::Copy {
            text,
            clear_after,
            done,
        })
        .map_err(|_| unavailable())?;
        answer.await.map_err(|_| unavailable())?
    }

    /// Run a pending clear at once (at exit), waiting for it up to `wait`.
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

    fn read(&mut self) -> Option<String> {
        self.clipboard.get_text().ok()
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
    use std::sync::{Arc, Mutex as StdMutex};

    /// A clipboard stand-in: what it holds, and how many clears it saw.
    #[derive(Clone, Default)]
    struct Fake {
        held: Arc<StdMutex<Option<String>>>,
        clears: Arc<StdMutex<u32>>,
    }

    impl Fake {
        fn holds(&self) -> Option<String> {
            self.held.lock().expect("lock").clone()
        }
        /// The user copies something else.
        fn user_copies(&self, text: &str) {
            *self.held.lock().expect("lock") = Some(text.to_string());
        }
        fn clears(&self) -> u32 {
            *self.clears.lock().expect("lock")
        }
    }

    impl Board for Fake {
        fn write(&mut self, text: &str) -> Result<(), String> {
            *self.held.lock().expect("lock") = Some(text.to_string());
            Ok(())
        }
        fn read(&mut self) -> Option<String> {
            self.holds()
        }
        fn clear(&mut self) -> Result<(), String> {
            *self.held.lock().expect("lock") = None;
            *self.clears.lock().expect("lock") += 1;
            Ok(())
        }
    }

    const S30: Option<Duration> = Some(Duration::from_secs(30));

    #[test]
    fn still_ours_after_the_time_it_is_cleared() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let t0 = Instant::now();
        keeper.copy("s3cr3t", S30, t0).expect("copy");
        assert_eq!(fake.holds().as_deref(), Some("s3cr3t"));
        keeper.run_due(t0 + Duration::from_secs(29));
        assert_eq!(fake.holds().as_deref(), Some("s3cr3t"));
        keeper.run_due(t0 + Duration::from_secs(30));
        assert_eq!(fake.holds(), None);
        assert_eq!(keeper.due(), None);
    }

    #[test]
    fn replaced_by_the_user_it_is_left_untouched() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let t0 = Instant::now();
        keeper.copy("s3cr3t", S30, t0).expect("copy");
        fake.user_copies("a note of mine");
        keeper.run_due(t0 + Duration::from_secs(30));
        assert_eq!(fake.holds().as_deref(), Some("a note of mine"));
        assert_eq!(fake.clears(), 0);
        assert_eq!(keeper.due(), None);
    }

    #[test]
    fn a_second_copy_replaces_the_pending_clear() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let t0 = Instant::now();
        keeper.copy("first", S30, t0).expect("copy");
        let t1 = t0 + Duration::from_secs(20);
        keeper.copy("second", S30, t1).expect("copy");
        assert_eq!(keeper.due(), Some(t1 + Duration::from_secs(30)));
        // The first one's time: nothing happens.
        keeper.run_due(t0 + Duration::from_secs(30));
        assert_eq!(fake.holds().as_deref(), Some("second"));
        keeper.run_due(t1 + Duration::from_secs(30));
        assert_eq!(fake.holds(), None);
        assert_eq!(fake.clears(), 1);
    }

    #[test]
    fn never_plans_no_clear_and_drops_the_one_pending() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let t0 = Instant::now();
        keeper.copy("first", S30, t0).expect("copy");
        keeper.copy("second", None, t0).expect("copy");
        assert_eq!(keeper.due(), None);
        keeper.run_due(t0 + Duration::from_secs(3600));
        keeper.clear_now();
        assert_eq!(fake.holds().as_deref(), Some("second"));
        assert_eq!(fake.clears(), 0);
    }

    #[test]
    fn a_pending_clear_runs_at_exit_on_the_same_condition() {
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let t0 = Instant::now();
        keeper.copy("s3cr3t", S30, t0).expect("copy");
        keeper.clear_now();
        assert_eq!(fake.holds(), None);

        keeper.copy("s3cr3t", S30, t0).expect("copy");
        fake.user_copies("mine");
        keeper.clear_now();
        assert_eq!(fake.holds().as_deref(), Some("mine"));
    }

    #[test]
    fn a_failed_write_keeps_the_pending_clear() {
        struct Broken(Fake);
        impl Board for Broken {
            fn write(&mut self, _: &str) -> Result<(), String> {
                Err("no".into())
            }
            fn read(&mut self) -> Option<String> {
                self.0.read()
            }
            fn clear(&mut self) -> Result<(), String> {
                self.0.clear()
            }
        }
        let fake = Fake::default();
        let mut keeper = Keeper::new(fake.clone());
        let t0 = Instant::now();
        keeper.copy("s3cr3t", S30, t0).expect("copy");
        let mut broken = Keeper {
            board: Broken(fake.clone()),
            pending: keeper.pending.take(),
        };
        assert!(broken.copy("other", S30, t0).is_err());
        broken.clear_now();
        assert_eq!(fake.holds(), None);
    }

    #[tokio::test]
    async fn the_worker_clears_after_the_time_and_at_exit() {
        let fake = Fake::default();
        let board = fake.clone();
        let state = ClipboardState::with(move || Ok(board.clone()));
        state
            .copy("s3cr3t".into(), Some(Duration::from_millis(50)))
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
        state
            .copy("s3cr3t".into(), Some(Duration::from_secs(3600)))
            .await
            .expect("copy");
        state.clear_pending_now(Duration::from_secs(2));
        assert_eq!(fake.holds(), None, "cleared at exit");

        // At exit, after the user copied something else: untouched.
        state
            .copy("s3cr3t".into(), Some(Duration::from_secs(3600)))
            .await
            .expect("copy");
        fake.user_copies("mine");
        state.clear_pending_now(Duration::from_secs(2));
        assert_eq!(fake.holds().as_deref(), Some("mine"));
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
            let err = state.copy("v".into(), None).await.expect_err("no board");
            assert!(err.contains("not available"), "{err}");
        }
        assert_eq!(*tries.lock().expect("lock"), 2);
        // Nothing pending: exit does not wait.
        state.clear_pending_now(Duration::from_secs(2));
    }

    #[test]
    fn the_digest_tells_values_apart_without_keeping_them() {
        assert_eq!(digest("a"), digest("a"));
        assert_ne!(digest("a"), digest("b"));
    }
}
