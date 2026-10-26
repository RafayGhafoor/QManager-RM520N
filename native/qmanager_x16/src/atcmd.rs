//! The transport: one AT command in, the vendor broker's reply text out.
//!
//! This is a port of `at_raw()` from `zlt-x16/deploy-x16/atcli_smd11`, and it
//! keeps every rule in it, because each one came from an outage:
//!
//! * **Allowlist, not passthrough.** `atcmd_daemon` serves one request at a time
//!   and has no timeout of its own. A command the modem never answers leaves
//!   its client queued forever and every later client — including the vendor
//!   dialer's — blocks behind it. On 2026-10-26 that took the WAN down until the
//!   daemon was restarted. Anything not on the list answers `ERROR` without
//!   touching the daemon.
//! * **A timeout, and a blacklist.** 6 s default (`QM_AT_TIMEOUT`), and a
//!   command that timed out once is never retried for the life of the file
//!   (`QM_AT_BLACKLIST`), because a retry is another way to wedge the daemon.
//! * **The echo line is stripped, `OK`/`ERROR` passed through.** `/bin/atcmd`
//!   prints `atcmd_receive:` before the payload; `qcmd` needs the payload's
//!   own `OK`/`ERROR` markers intact.
//! * **A blank reply becomes `ERROR`.** An empty string has twice been read as
//!   "modem fine, no data".
//!
//! stderr is merged into the payload, exactly as the shell does
//! (`_out=$("$TIMEOUT" ... 2>&1)`): the vendor client reports failures there.
//!
//! The child process is bounded by `poll(2)` on its output pipe rather than by
//! a polling loop or a watchdog thread, so a fast reply costs no extra wakeup
//! and a hung one is killed at the deadline without a pid-reuse race (the
//! child is never reaped until we `wait()` for it).

use libc::{poll, pollfd, POLLIN};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::{FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// The vendor's client for `atcmd_daemon`. There is no modem tty on this box:
/// the modem is on-die and the daemon owns the bus, so this — never
/// `/dev/smd11` or `/dev/at_mdm0` — is the only correct peer here.
pub const DEFAULT_ATCMD: &str = "/bin/atcmd";
pub const DEFAULT_TIMEOUT_SECS: u64 = 6;
pub const BLACKLIST_FILE: &str = "/tmp/qmanager_at_blacklist";

/// The `ERROR` sentinel the shell shim prints for every refusal and failure.
/// `qcmd` classifies on the text, so this string is the contract.
pub const ERROR: &str = "ERROR";

/// Raised for a command that must never reach the daemon, before it is run.
///
/// This is modelled as its own type rather than a bare `false` so that the
/// dialect layer can tell "the allowlist refused this" from "the modem said no"
/// — the first is a porting gap, the second is a device condition, and mixing
/// them hid a deployment mistake once already (docs/30 §4b, "A mistake made and
/// caught here").
pub struct Refused(pub &'static str);

#[derive(Clone, Debug)]
pub struct Cfg {
    pub atcmd: PathBuf,
    pub timeout: Duration,
    pub blacklist: PathBuf,
}

impl Cfg {
    /// Environment names follow the shell shim exactly, so one device can be
    /// driven by either implementation with the same test harness.
    pub fn from_env() -> Cfg {
        let atcmd = std::env::var("ATC")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_ATCMD.to_string());
        let timeout = std::env::var("QM_AT_TIMEOUT")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_TIMEOUT_SECS);
        let blacklist = std::env::var("QM_AT_BLACKLIST")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| BLACKLIST_FILE.to_string());
        Cfg {
            atcmd: PathBuf::from(atcmd),
            timeout: Duration::from_secs(timeout),
            blacklist: PathBuf::from(blacklist),
        }
    }
}

/// Runs one command through the vendor broker.
pub struct Atcmd {
    cfg: Cfg,
}

impl Atcmd {
    pub fn new(cfg: Cfg) -> Atcmd {
        Atcmd { cfg }
    }

    /// The shell `at_raw()` contract: always returns text, never fails, and
    /// answers literally `ERROR` when it refuses or cannot get a reply.
    pub fn raw(&self, cmd: &str) -> String {
        match self.exchange(cmd) {
            Ok(text) => text,
            Err(Refused(reason)) => {
                crate::qlog::warn(&format!("AT refused [{}]: {}", reason, cmd));
                ERROR.to_string()
            }
        }
    }

    /// The same exchange, but a refusal is distinguishable from a modem error.
    pub fn exchange(&self, cmd: &str) -> Result<String, Refused> {
        if !crate::safety::is_safe(cmd) {
            return Err(Refused("not on the verified allowlist"));
        }
        if self.blacklisted(cmd) {
            return Err(Refused("blacklisted after an earlier timeout"));
        }

        let out = match run_with_deadline(&self.cfg.atcmd, cmd, self.cfg.timeout) {
            Run::Reply(text) => text,
            Run::TimedOut => {
                self.blacklist(cmd);
                return Err(Refused("timed out; recorded so it is never retried"));
            }
            Run::Failed => return Err(Refused("the vendor client could not be run")),
        };

        let cleaned = strip_echo(&out);
        if cleaned.trim_matches(|c: char| c.is_whitespace()).is_empty() {
            // Only the echo line, or only whitespace: the daemon swallowed the
            // answer. Say ERROR rather than an empty string.
            return Err(Refused("empty reply from the broker"));
        }
        Ok(cleaned)
    }

    fn blacklisted(&self, cmd: &str) -> bool {
        match std::fs::read_to_string(&self.cfg.blacklist) {
            Ok(text) => text.lines().any(|line| line == cmd),
            Err(_) => false,
        }
    }

    fn blacklist(&self, cmd: &str) {
        let append = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o666)
            .open(&self.cfg.blacklist);
        if let Ok(mut f) = append {
            let _ = writeln!(f, "{}", cmd);
        }
        crate::qlog::warn(&format!("AT timed out, blacklisted for this boot: {}", cmd));
    }
}

impl crate::dialect::At for Atcmd {
    fn raw(&mut self, cmd: &str) -> String {
        Atcmd::raw(self, cmd)
    }
}

enum Run {
    Reply(String),
    TimedOut,
    Failed,
}

/// Spawns the vendor client and reads its output until EOF or the deadline.
///
/// `poll(2)` waits on the child's output pipe with exactly the time left in the
/// budget, so a fast reply costs one syscall plus the read, and a hung broker is
/// killed on the deadline instead of after a rounded-up sleep. Both stdout and
/// stderr are redirected to the ONE pipe, matching the shell's `2>&1`.
fn run_with_deadline(atcmd: &Path, cmd: &str, timeout: Duration) -> Run {
    let mut fds = [0i32; 2];
    // pipe(2) + FD_CLOEXEC rather than pipe2(2): this crate is also built and
    // tested on the macOS host, where pipe2 does not exist.
    // SAFETY: `fds` is two valid i32s; pipe fills both or fails.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Run::Failed;
    }
    for fd in fds {
        // SAFETY: both descriptors are ours and live.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Run::Failed;
        }
    }
    // Own both ends immediately so every early return closes them.
    // SAFETY: both descriptors were created by the pipe2 above and are unowned.
    let read_end = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    // SAFETY: as above.
    let write_end = unsafe { OwnedFd::from_raw_fd(fds[1]) };

    // stderr needs its own descriptor pointed at the same pipe. O_CLOEXEC keeps
    // the child from keeping a stray copy open after exec; std dups this onto
    // fd 2 itself.
    let write_end_err = match dup_cloexec(&write_end) {
        Some(fd) => fd,
        None => return Run::Failed,
    };

    let spawned = Command::new(atcmd)
        .arg(cmd)
        // Never inherit a terminal: `atcmd_daemon` has no interactive AT mode,
        // so a command that waits for input must see EOF, not hang the bus.
        .stdin(Stdio::null())
        .stdout(Stdio::from(write_end))
        .stderr(Stdio::from(write_end_err))
        .spawn();

    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            crate::qlog::warn(&format!("cannot exec {}: {}", atcmd.display(), e));
            return Run::Failed;
        }
    };

    let mut file = std::fs::File::from(read_end);
    let deadline = std::time::Instant::now() + timeout;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut pfd = pollfd {
        fd: std::os::unix::io::AsRawFd::as_raw_fd(&file),
        events: POLLIN,
        revents: 0,
    };

    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        let ms = duration_to_ms(left);
        if ms == 0 {
            return kill_and_timeout(&mut child);
        }
        // SAFETY: one valid pollfd, nfds = 1.
        let rc = unsafe { poll(&mut pfd, 1, ms) };
        if rc < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            let _ = child.kill();
            let _ = child.wait();
            return Run::Failed;
        }
        if rc == 0 {
            return kill_and_timeout(&mut child);
        }
        match file.read(&mut chunk) {
            // EOF: the child closed its end, i.e. it exited.
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let _ = child.wait();
    Run::Reply(String::from_utf8_lossy(&buf).into_owned())
}

fn kill_and_timeout(child: &mut std::process::Child) -> Run {
    let _ = child.kill();
    let _ = child.wait();
    Run::TimedOut
}

fn duration_to_ms(d: Duration) -> i32 {
    let ms = d.as_millis();
    if ms == 0 {
        return 0;
    }
    if ms > i32::MAX as u128 {
        i32::MAX
    } else {
        ms as i32
    }
}

/// `dup(2)` plus `FD_CLOEXEC`, so the child cannot keep the pipe's write end
/// open past exec (which would delay EOF until the grandchild exits).
fn dup_cloexec(fd: &OwnedFd) -> Option<OwnedFd> {
    // SAFETY: `fd` is a live descriptor.
    let dup = unsafe { libc::dup(std::os::unix::io::AsRawFd::as_raw_fd(fd)) };
    if dup < 0 {
        return None;
    }
    // SAFETY: `dup` owns the new descriptor.
    let owned = unsafe { OwnedFd::from_raw_fd(dup) };
    // SAFETY: valid descriptor and a valid command.
    if unsafe { libc::fcntl(dup, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
        return None;
    }
    Some(owned)
}

/// Drops the `atcmd_receive:` line if it is line 1 — `sed '1{/^atcmd_receive:[[:space:]]*$/d;}'`.
pub fn strip_echo(text: &str) -> String {
    match text.split_once('\n') {
        Some((first, rest)) if is_echo_line(first) => rest.to_string(),
        _ => text.to_string(),
    }
}

fn is_echo_line(line: &str) -> bool {
    match line.strip_prefix("atcmd_receive:") {
        Some(tail) => tail.chars().all(|c| c.is_whitespace()),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_line_is_dropped() {
        assert_eq!(strip_echo("atcmd_receive:\n8617\n\nOK\r"), "8617\n\nOK\r");
        assert_eq!(strip_echo("atcmd_receive:  \r\nOK"), "OK");
    }

    #[test]
    fn a_second_line_that_looks_like_the_echo_is_kept() {
        // Only line 1 is filtered; the shell's sed address is `1{...}`.
        assert_eq!(
            strip_echo("OK\natcmd_receive:\nmore"),
            "OK\natcmd_receive:\nmore"
        );
    }

    #[test]
    fn payload_without_echo_is_untouched() {
        assert_eq!(strip_echo("+CSQ: 24,99\r\n\r\nOK\r"), "+CSQ: 24,99\r\n\r\nOK\r");
    }
}
