//! `qcmd` — the CLI contract, byte for byte where it is observable.
//!
//! The shell original (`<QManager>/scripts/usr/bin/qcmd`, 225 lines, deployed at
//! `/data/qmanager/bin/qcmd`) is the single AT entry point for ~87 CGIs, the
//! poller and the scanners, so everything a caller can see is preserved:
//!
//! | contract | kept |
//! |---|---|
//! | `qcmd "AT+…"` | payload + one trailing newline on stdout |
//! | `qcmd -j "AT+…"` | `{success, response|error, command}` on stdout, jq's layout |
//! | error text | `ERROR: modem_busy` / `ERROR: command_failed` on stderr |
//! | exit codes | 0 on success, 1 on every failure |
//! | no argument | `{"error":"no_command",...}` on stderr, exit 1 |
//! | lock | `/tmp/qmanager_at.lock`, 20 s normal / 45 s for `*QSCAN*`, `*QSCANFREQ*`, `*QFOTADL*` |
//! | classification | `*ERROR*` first, then `*OK*`, then non-empty passthrough, empty = failure |
//! | who runs it | root (poller) and `www-data` (CGIs) on the same lock file |
//!
//! Two deliberate differences, both recorded in MEMO.md:
//!
//! 1. the lock is a blocking `flock(2)` on a deadline, not `flock -x -n` in a
//!    `sleep` loop (`lock.rs`);
//! 2. failures are logged to `/tmp/qmanager.log` but not duplicated to syslog.
//!
//! TRANSPORT. Two modes, because a qcmd-only replacement and a full shim
//! replacement carry very different risk:
//!
//! * `shim` (default when a shim binary is present): run the existing
//!   `atcli_smd11` under the lock, exactly as today. This is the deployable-now
//!   variant — same dialect behaviour, a real lock, no shell startup.
//! * `native`: answer in-process through `dialect::run`. Arms that are not
//!   ported refuse rather than fabricate, so this mode is only complete when the
//!   inventory says so.
//!
//! Select with `QCMD_MODE=shim|native`; the fallback order is: explicit request,
//! then shim if its binary exists, then native.
//!
//! The lock is held across the AT exchange and released before printing, which
//! is the shell's scope (`( flock 9; "$AT_CLI" … ) 9<lock`).

use crate::atcmd;
use crate::dialect;
use crate::lock::{LockFile, LOCK_FILE};
use crate::qlog;
use std::io::Write;
use std::path::PathBuf;

/// Seconds to wait for the lock. These were 5/10 s until one slow poll cycle
/// made a CGI report `at_failed` while the same command worked from a shell:
/// waiting longer makes a request slow instead of empty, which is the correct
/// trade. Kept identical.
const LOCK_WAIT_SHORT_SECS: u64 = 20;
const LOCK_WAIT_LONG_SECS: u64 = 45;

/// Where the shell shim is deployed, in the order the deployments use.
const SHIM_CANDIDATES: &[&str] = &[
    "/usr/bin/atcli_smd11",
    "/data/qmanager/bin/atcli_smd11",
    "/usr/local/bin/atcli_smd11",
];

/// `is_long_command()`: a cell scan legitimately blocks for a minute.
fn is_long_command(cmd: &str) -> bool {
    cmd.contains("QSCAN") || cmd.contains("QSCANFREQ") || cmd.contains("QFOTADL")
}

pub fn main(args: &[String]) -> i32 {
    let mut json_mode = false;
    let mut index = 0;
    if args.first().map(String::as_str) == Some("-j") {
        json_mode = true;
        index = 1;
    }
    let command = args.get(index).cloned().unwrap_or_default();

    if command.is_empty() {
        // Note: JSON on stderr even in -j mode, exactly like the shell, because
        // this check runs after -j parsing but before any output helper.
        eprintln!("{{\"error\":\"no_command\",\"detail\":\"Usage: qcmd [-j] \\\"AT+COMMAND\\\"\"}}");
        return 1;
    }

    let wait = if is_long_command(&command) {
        LOCK_WAIT_LONG_SECS
    } else {
        LOCK_WAIT_SHORT_SECS
    };

    let lock = match LockFile::open(LOCK_FILE) {
        Ok(l) => l,
        Err(e) => {
            // The shell's `9<"$LOCK_FILE"` would fail the subshell and leave an
            // empty result, which classifies as command_failed.
            qlog::error(&format!("Cannot open {}: {}", LOCK_FILE, e));
            return fail(json_mode, &command, "command_failed");
        }
    };
    let held = lock.acquire(std::time::Duration::from_secs(wait));
    if held.is_none() {
        qlog::error(&format!(
            "Lock acquisition failed for: {} (waited {} s)",
            command, wait
        ));
        return fail(json_mode, &command, "modem_busy");
    }

    let result = match transport(&command) {
        Ok(text) => text,
        Err(reason) => {
            qlog::error(&format!("Transport failed for {}: {}", command, reason));
            return fail(json_mode, &command, "command_failed");
        }
    };
    // The shell's command substitution strips trailing newlines; every consumer
    // sees the text without them, and one newline is added on output.
    let result = result.trim_end_matches('\n').to_string();
    drop(held);

    if result.contains("ERROR") {
        qlog::error(&format!("Command returned ERROR: {}", command));
        return fail(json_mode, &command, "command_failed");
    }
    if result.contains("OK") {
        return ok(json_mode, &command, &result);
    }
    if result.is_empty() {
        qlog::error(&format!("Empty response for: {}", command));
        return fail(json_mode, &command, "command_failed");
    }
    // Data without a trailing OK: pass it through, as the shell does.
    ok(json_mode, &command, &result)
}

enum Mode {
    Shim(PathBuf),
    Native,
}

fn mode() -> Result<Mode, String> {
    match std::env::var("QCMD_MODE").ok().as_deref() {
        Some("native") => return Ok(Mode::Native),
        Some("shim") => {}
        _ => {}
    }
    let explicit = std::env::var("QM_AT_CLI").ok().filter(|v| !v.is_empty());
    let candidates: Vec<String> = match explicit {
        Some(p) => vec![p],
        None => SHIM_CANDIDATES.iter().map(|s| s.to_string()).collect(),
    };
    for c in &candidates {
        let p = PathBuf::from(c);
        if is_executable(&p) {
            return Ok(Mode::Shim(p));
        }
    }
    if std::env::var("QCMD_MODE").ok().as_deref() == Some("shim") {
        return Err(format!(
            "{} not found or not executable",
            candidates.first().cloned().unwrap_or_default()
        ));
    }
    Ok(Mode::Native)
}

fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn transport(command: &str) -> Result<String, String> {
    match mode()? {
        Mode::Shim(path) => {
            let out = std::process::Command::new(&path)
                .arg(command)
                // qcmd discards the shim's stderr (`2>/dev/null`).
                .stderr(std::process::Stdio::null())
                .output()
                .map_err(|e| format!("cannot exec {}: {}", path.display(), e))?;
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        Mode::Native => {
            let cfg = atcmd::Cfg::from_env();
            let mut at = atcmd::Atcmd::new(cfg);
            let paths = dialect::Paths::from_env();
            Ok(dialect::run(&mut at, &paths, command))
        }
    }
}

fn ok(json_mode: bool, command: &str, result: &str) -> i32 {
    if json_mode {
        print!("{}", crate::json::success(result, command));
    } else {
        println!("{}", result);
    }
    flush();
    0
}

fn fail(json_mode: bool, command: &str, error: &str) -> i32 {
    if json_mode {
        print!("{}", crate::json::failure(error, command));
        flush();
    } else {
        eprintln!("ERROR: {}", error);
    }
    1
}

fn flush() {
    let _ = std::io::stdout().flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_commands_get_the_long_lock_wait() {
        for c in ["AT+QSCAN=1", "AT+QSCANFREQ", "AT+QFOTADL"] {
            assert!(is_long_command(c), "{}", c);
        }
        for c in ["AT+CSQ", "AT+QENG=\"servingcell\"", "AT+QNWPREFCFG"] {
            assert!(!is_long_command(c), "{}", c);
        }
    }

    #[test]
    fn shim_candidates_cover_both_deployed_paths() {
        // docs: upstream installs to /usr/bin, this deployment to
        // /data/qmanager/bin after the path rewrite.
        assert!(SHIM_CANDIDATES.contains(&"/usr/bin/atcli_smd11"));
        assert!(SHIM_CANDIDATES.contains(&"/data/qmanager/bin/atcli_smd11"));
    }
}
