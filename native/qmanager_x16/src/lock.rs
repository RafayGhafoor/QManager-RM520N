//! `/tmp/qmanager_at.lock` — the one AT lock on this deployment, taken with a
//! real blocking `flock(2)` and a deadline.
//!
//! WHY NOT POLL. The shell `qcmd` polls `flock -x -n` because busybox `flock`
//! has no `-w`. That is not free: it execs busybox per attempt (7 ms measured
//! uncontended) and, before the `sleep 0.1` fix, quantised every contended
//! acquire up to a whole second (docs/30-cpu-profile-and-kernel-noise.md §4b,
//! 1552 ms -> 93 ms). This module does the same job with one syscall on the
//! fast path and a blocking wait on the slow path, so there is no grain at all.
//!
//! WHY A THREAD ON THE SLOW PATH ONLY. `flock(2)` has no timeout, and a signal
//! handler cannot interrupt it reliably (the `SIGALRM`-then-`flock` pattern has
//! a window where the alarm fires before the call blocks). So:
//!
//! 1. try `LOCK_EX | LOCK_NB` — the uncontended case, ~20 us, no thread;
//! 2. on `EWOULDBLOCK`, hand the same open file description to a thread that
//!    does a plain blocking `flock(2)` and report success over a channel with a
//!    deadline.
//!
//! If the deadline expires the waiter thread is still blocked in `flock`. That
//! is deliberate and safe: the caller prints `modem_busy` and exits, and
//! `exit(2)` closes the description, so the waiting thread disappears with the
//! process instead of leaking the lock.
//!
//! INTEROP IS THE REQUIREMENT. Remaining shell callers (`atcli_smd11` users,
//! the scanners, ~40 call sites) take this same file with `flock(1)`, which is
//! the same `flock(2)` lock, so both implementations exclude each other.
//!
//! OPEN MODE, not the reference implementation's. `/tmp` is mode 1777 with
//! `fs.protected_regular=1`: an unprivileged process (a CGI running as
//! `www-data`) cannot open a root-owned file in a sticky directory for
//! *writing*, but it can open it read-only, and `flock(LOCK_EX)` works on a
//! read-only descriptor. The shell `qcmd` opens the lock read-only (`9<`) for
//! exactly this reason. `native/qmanager_atd/src/lock.rs` opens read+write
//! instead; that is fine for root and would be denied for `www-data`.

use libc::{flock, LOCK_EX, LOCK_NB, LOCK_UN};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub const LOCK_FILE: &str = "/tmp/qmanager_at.lock";

/// `/tmp` is 1777, so never follow a planted symlink.
const O_NOFOLLOW: i32 = libc::O_NOFOLLOW;

pub struct LockFile {
    file: Arc<File>,
}

/// Exclusive ownership of the lock. Releasing is `Drop`, so an early return
/// from any caller path cannot leak it.
pub struct Held {
    file: Arc<File>,
}

impl LockFile {
    /// Opens (creating if absent) the lock file. Creation matches the shell
    /// `qcmd`: `: > file` then `chmod 666`, so a CGI and the root poller can
    /// share it. `chmod` runs only when we created the file, like the shell.
    pub fn open(path: &str) -> io::Result<LockFile> {
        if let Some(dir) = std::path::Path::new(path).parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(O_NOFOLLOW)
            .open(path)
        {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let created = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .mode(0o666)
                    .custom_flags(O_NOFOLLOW)
                    .open(path)?;
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666));
                created
            }
            // ELOOP from O_NOFOLLOW on a symlink, or EACCES: report, never
            // silently continue unlocked.
            Err(e) => return Err(e),
        };
        Ok(LockFile {
            file: Arc::new(file),
        })
    }

    fn try_lock(&self) -> bool {
        unsafe { flock(self.file.as_raw_fd(), LOCK_EX | LOCK_NB) == 0 }
    }

    /// Waits up to `budget` for the exclusive lock, in one blocking `flock(2)`.
    ///
    /// `None` means the deadline expired. The caller must then exit promptly:
    /// a waiter thread is left blocked in `flock` until the process dies.
    pub fn acquire(&self, budget: Duration) -> Option<Held> {
        if self.try_lock() {
            return Some(Held {
                file: Arc::clone(&self.file),
            });
        }
        let file = Arc::clone(&self.file);
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let rc = unsafe { flock(file.as_raw_fd(), LOCK_EX) };
            let _ = tx.send(rc == 0);
            // `file` stays alive in this thread: for `flock(2)` the lock lives
            // on the open file description, so the guard's unlock in the main
            // thread is what releases it, not this clone being dropped.
        });
        match rx.recv_timeout(budget) {
            Ok(true) => Some(Held {
                file: Arc::clone(&self.file),
            }),
            Ok(false) => None, // flock failed for a reason other than contention
            // Deadline expired. The waiter thread is abandoned on purpose: see
            // the module comment. The caller exits, which closes the fd.
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => None,
        }
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        unsafe {
            flock(self.file.as_raw_fd(), LOCK_UN);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn tmp_path(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!("qm16-lock-{}-{}", std::process::id(), tag))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn uncontended_acquire_is_immediate() {
        let p = tmp_path("fast");
        let l = LockFile::open(&p).unwrap();
        let t = Instant::now();
        let held = l.acquire(Duration::from_millis(500)).unwrap();
        assert!(t.elapsed() < Duration::from_millis(100), "{:?}", t.elapsed());
        drop(held);
        let _ = std::fs::remove_file(&p);
    }

    // A contended acquire must time out on the deadline, not on a poll grain.
    // The waiter thread stays blocked after this test returns; it holds its own
    // open file description on a path no other test uses, so it cannot affect
    // them, and the test process exits at the end of the run.
    #[test]
    fn contended_acquire_waits_the_whole_budget_then_gives_up() {
        let p = tmp_path("busy");
        let a = LockFile::open(&p).unwrap();
        let b = LockFile::open(&p).unwrap();
        let held = a.acquire(Duration::from_millis(50)).unwrap();

        let t = Instant::now();
        assert!(b.acquire(Duration::from_millis(250)).is_none());
        let waited = t.elapsed();
        assert!(waited >= Duration::from_millis(250), "{:?}", waited);
        // 100 ms was the old quantising grain; a blocking wait must not round up
        // to the next multiple of it.
        assert!(waited < Duration::from_millis(400), "{:?}", waited);

        drop(held);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn releasing_lets_another_holder_in() {
        let p = tmp_path("handoff");
        let a = LockFile::open(&p).unwrap();
        let b = LockFile::open(&p).unwrap();
        drop(a.acquire(Duration::from_millis(50)).unwrap());
        let t = Instant::now();
        let held = b.acquire(Duration::from_millis(500)).unwrap();
        assert!(t.elapsed() < Duration::from_millis(100), "{:?}", t.elapsed());
        drop(held);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn created_lock_file_is_world_writable() {
        let p = tmp_path("mode");
        let _ = std::fs::remove_file(&p);
        let _l = LockFile::open(&p).unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o666, "www-data must be able to take this lock");
        let _ = std::fs::remove_file(&p);
    }
}
