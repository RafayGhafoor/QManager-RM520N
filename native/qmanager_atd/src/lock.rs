//! `/tmp/qmanager_at.lock` — THE one AT lock on this deployment.
//!
//! O5A PORT: upstream used `/var/lock/qmanager.lock`. That is the wrong file
//! here: this deployment's shell `qcmd`, the poller, the scanners and every CGI
//! already serialise on `/tmp/qmanager_at.lock` (~40 callers). Two locks on one
//! AT port is exactly the corruption AGENTS.md hard rule 3 exists to prevent,
//! so the broker joins the existing lock rather than creating a second one.
//!
//! `/var/lock` happens to be writable on the O5A (probed), so this is a
//! serialisation requirement, not a filesystem one.
//!
//! Same semantics as qcmd's flock_wait: non-blocking tries on a 100 ms grain
//! until the budget runs out, then one final try.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::thread;
use std::time::{Duration, Instant};

pub const LOCK_FILE: &str = "/tmp/qmanager_at.lock";

pub struct LockFile {
    file: File,
}

pub struct Held<'a> {
    lock: &'a LockFile,
}

impl LockFile {
    pub fn open(path: &str) -> io::Result<LockFile> {
        if let Some(dir) = std::path::Path::new(path).parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            // 0666, not upstream's 0644: the shell qcmd creates this file 0666
            // so that a CGI running as www-data can take the same lock. A
            // narrower mode would break those callers if ownership ever
            // diverges from root.
            .mode(0o666)
            // /tmp is 1777: never follow a planted symlink.
            .custom_flags(crate::safefs::NOFOLLOW)
            .open(path)?;
        Ok(LockFile { file })
    }

    fn try_lock(&self) -> bool {
        unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
    }

    /// Waits up to `budget` for the exclusive lock.
    pub fn acquire(&self, budget: Duration) -> Option<Held<'_>> {
        let deadline = Instant::now() + budget;
        loop {
            if self.try_lock() {
                return Some(Held { lock: self });
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        if self.try_lock() {
            Some(Held { lock: self })
        } else {
            None
        }
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.lock.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_holder_waits_then_times_out() {
        let p = std::env::temp_dir().join(format!("qatd-lock-{}", std::process::id()));
        let p = p.to_str().unwrap();
        let a = LockFile::open(p).unwrap();
        let b = LockFile::open(p).unwrap();
        let held = a.acquire(Duration::from_millis(50)).unwrap();
        let t = Instant::now();
        assert!(b.acquire(Duration::from_millis(250)).is_none());
        assert!(t.elapsed() >= Duration::from_millis(250));
        drop(held);
        assert!(b.acquire(Duration::from_millis(50)).is_some());
        let _ = std::fs::remove_file(p);
    }
}
