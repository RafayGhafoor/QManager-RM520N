//! The operator log, kept because losing it would hide failures.
//!
//! `qcmd` writes through `qlog.sh`: `[YYYY-MM-DD HH:MM:SS] LEVEL [qcmd:PID] msg`
//! appended to `/tmp/qmanager.log`, plus a duplicate through `logger(1)` to
//! syslog. This module writes the same file line and drops the syslog
//! duplicate — that duplicate is one `fork+exec` per line, and journald on this
//! firmware does not persist anyway (AGENTS.md §6). It is a behaviour change,
//! recorded in MEMO.md; the file line is what the guard/poller sections are read
//! from.
//!
//! Only WARN and ERROR are written: the shell's default `QLOG_LEVEL=INFO`
//! filters its DEBUG lines, which is where its per-call "Command received" and
//! `AT_CMD:` chatter lives. Writing those would put one line per AT command into
//! a tmpfs file on a 1-core box.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_FILE: &str = "/tmp/qmanager.log";
const MAX_SIZE_KB: u64 = 256;

fn log_path() -> PathBuf {
    let p = std::env::var("QLOG_FILE")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_FILE.to_string());
    PathBuf::from(p)
}

pub fn warn(message: &str) {
    write("WARN ", message);
}

pub fn error(message: &str) {
    write("ERROR", message);
}

fn write(level: &str, message: &str) {
    let path = log_path();
    rotate_if_needed(&path);
    let line = format!(
        "[{}] {} [qcmd:{}] {}\n",
        timestamp(),
        level,
        std::process::id(),
        message
    );
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// One-generation rotation at the same 256 KB cap the shell library uses, so a
/// command that fails every cycle cannot fill a tmpfs. The shell keeps two
/// generations and re-chmods to 0666 (its `mv` would otherwise leave a 0644
/// file that `www-data` cannot append to); both details are kept.
fn rotate_if_needed(path: &std::path::Path) {
    let size = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    if size < MAX_SIZE_KB * 1024 {
        return;
    }
    let rotated = PathBuf::from(format!("{}.1", path.display()));
    let _ = std::fs::rename(path, &rotated);
    if let Ok(f) = std::fs::File::create(path) {
        drop(f);
        let _ = std::fs::set_permissions(
            path,
            std::os::unix::fs::PermissionsExt::from_mode(0o666),
        );
    }
}

/// `date '+%Y-%m-%d %H:%M:%S'` in UTC-free terms: the shell prints *local*
/// time. Without a libc `localtime_r` round trip this prints UTC, which is off
/// by the device's offset. Recorded as a known difference in MEMO.md rather
/// than silently claimed as identical — the offset on this unit is not
/// measured, and a log line's absolute time is read together with `date` on the
/// device anyway.
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = civil_from_unix(secs);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
}

/// Howard Hinnant's `civil_from_days`, integer-only.
fn civil_from_unix(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (
        year,
        m,
        d,
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_is_a_plausible_date_string() {
        let s = timestamp();
        assert_eq!(s.len(), 19, "{}", s);
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], " ");
    }

    #[test]
    fn civil_from_unix_matches_a_known_instant() {
        // 2026-10-27T00:00:00Z
        assert_eq!(civil_from_unix(1_793_059_200), (2026, 10, 27, 0, 0, 0));
    }
}
