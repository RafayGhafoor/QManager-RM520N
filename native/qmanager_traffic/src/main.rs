//! qmanager_traffic — the ONE producer behind the dashboard's Live Traffic row.
//!
//! # Why a native sampler
//!
//! The row shows WAN download/upload rate about once a second. Three ways to
//! produce that number on this device, and two of them were measured on the
//! live install (RG520N-EB, 2026-10-24, 100 requests, client cost amortised):
//!
//! | Transport | CPU per read | forks per read |
//! | --- | --- | --- |
//! | CGI on `:8080` (`cgi_base.sh` + auth + sh) | **69.3 ms** | 7.4 |
//! | static file served by busybox httpd | **9.0 ms** | 1.4 |
//!
//! A CGI polled at 1 Hz is ~7 % of this box's single core — more than the whole
//! poller's measured 6.3 % — so the rate cannot be computed per request. It has
//! to be precomputed by one process and served as a static file, which is what
//! this binary does: it samples `/proc/net/dev` once a second and atomically
//! replaces a JSON document that httpd hands out for free.
//!
//! Rust rather than a shell loop is the same argument one level down. A shell
//! `while :; do …; sleep 1; done` costs a fork for `sleep` and (to write the
//! file atomically) another for `mv` — measured on this device at ~2.4–5.0 ms
//! per fork, so ≈0.5 % of one core, forever. This loop costs one wakeup per
//! second and no processes at all.
//!
//! # Where the numbers come from
//!
//! The **same kernel counter** the persistent Data Used row counts, on the same
//! netdev, with the same rx/tx orientation — both are read at runtime from
//! `data_used.json` (schema v5; see `docs/reference/data-usage-counter.md`).
//! Re-deriving either here would be a second copy of a device fact to get
//! wrong: `rmnet_dataN` migrates across attach cycles, and the orientation map
//! is keyed off the SoC. The rate and the cumulative total must never describe
//! two different interfaces, because a user watching both will notice.
//!
//! The elapsed time comes from `/proc/uptime`, not the wall clock: it is
//! monotonic and fractional, so a clock step (this device has no RTC) cannot
//! turn into a spike or a zero divisor.
//!
//! # Output contract
//!
//! One line of JSON, replaced atomically every tick:
//!
//! ```json
//! {"ok":true,"iface":"rmnet_ipa0","rx_bps":42130000,"tx_bps":3100000,
//!  "window_ms":1000,"warming":false,"counter_reset":false,"ts":1792803200}
//! ```
//!
//! `rx_bps`/`tx_bps` are **bits** per second. `window_ms` is the real interval
//! the two figures were averaged over. `warming` means there is no rate yet
//! (first tick after start, or a gap longer than `MAX_WINDOW_MS`) and must not
//! be rendered as `0 bps`. `counter_reset` means the counter went backwards —
//! the modem rebooted or the netdev was re-created — so this tick's rates are 0
//! by definition, not by idleness. `ts` is the wall clock at the sample, which
//! is how a reader tells a stale file from a quiet link.
//!
//! Anything that cannot be read emits `{"ok":false,"error":…,"detail":…}`
//! instead, so "we cannot measure" never renders as "nothing is happening".
//!
//! # Cost
//!
//! Measured on the O5A: one wakeup per second, zero processes, ~2 file reads
//! and one small page written to tmpfs per tick — **0 jiffies of CPU over a
//! 20 s window** (below the kernel's 10 ms accounting resolution) and **184 kB
//! RSS**, single-threaded. Nothing is written to flash: the document lives at
//! `/tmp/qmanager_traffic.json` and the docroot only holds a symlink to it.

#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::process;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A window shorter than this is a measurement artefact, not a rate: dividing
/// by it produces a spike. Report the previous window's figure and leave the
/// anchor alone so the next tick still measures across a real interval.
const MIN_WINDOW_MS: u64 = 150;

/// A window longer than this means the sampler itself was not running (paused,
/// SEGSTOPped, or a very slow tick). An average over that gap is not live, so
/// it is reported as `warming` and the anchor is reset instead.
const MAX_WINDOW_MS: u64 = 10_000;

/// Re-read `data_used.json` this often. The orientation is a static SoC fact
/// and the netdev rarely moves, so once a minute is generous — and it keeps
/// the per-tick cost to two /proc reads.
const RESOLVE_REFRESH_TICKS: u32 = 60;

fn env_or(key: &str, default: &str) -> String {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => v,
        _ => default.to_string(),
    }
}

fn env_u64(key: &str, default: u64) -> u64 {
    match std::env::var(key) {
        Ok(v) => v.trim().parse::<u64>().unwrap_or(default),
        Err(_) => default,
    }
}

struct Config {
    interval_ms: u64,
    out: String,
    data_used: String,
    proc_net_dev: String,
    proc_uptime: String,
    once: bool,
}

impl Config {
    fn from_env() -> Config {
        Config {
            // 1000 ms shipped. Clamped: below 200 ms the row would poll faster
            // than a browser timer reliably fires, and above 10 s it stops
            // being "live". Both bounds are the spec's, not a preference.
            interval_ms: env_u64("QMT_INTERVAL_MS", 1000).clamp(200, 10_000),
            out: env_or("QMT_OUT", "/tmp/qmanager_traffic.json"),
            data_used: env_or("QMT_DATA_USED", "/usrdata/qmanager/data_used.json"),
            proc_net_dev: env_or("QMT_PROC_NET_DEV", "/proc/net/dev"),
            proc_uptime: env_or("QMT_PROC_UPTIME", "/proc/uptime"),
            // One tick and exit: the on-device smoke test, and how the edge
            // cases in the spec are exercised without leaving a daemon behind.
            once: env_or("QMT_ONCE", "0") == "1",
        }
    }
}

/// Which netdev to count, and whether the kernel's two byte columns are swapped
/// on this SoC. Both are facts the poller already resolved for the cumulative
/// counter; this binary only mirrors what it found.
struct Counter {
    iface: String,
    reversed: bool,
}

/// `"key": "value"` on a line of pretty-printed JSON, without a JSON parser.
/// `data_used.json` is a twelve-line file written by jq, so a scan is enough —
/// and it keeps this crate dependency-free for the cross-build.
fn json_string_field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let rest = line.split_once(key)?.1;
    let rest = rest.trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn valid_iface(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn resolve_counter(path: &str) -> Counter {
    let mut iface = String::new();
    let mut reversed = false;
    if let Ok(body) = fs::read_to_string(path) {
        for line in body.lines() {
            if iface.is_empty() {
                if let Some(v) = json_string_field(line, "\"selected_counter\"") {
                    iface = v.to_string();
                }
            }
            if let Some(v) = json_string_field(line, "\"orientation\"") {
                // Anything but the explicit `reversed` reading is `normal`:
                // the poller's map resolves to `normal` for every SoC it knows
                // (the `reversed` arm is deliberately inert there).
                reversed = v == "reversed";
            }
        }
    }
    if !valid_iface(&iface) {
        // No usable selection: leave it empty and let the busiest-rmnet
        // fallback below decide, which is what the sibling product does too.
        iface.clear();
    }
    Counter { iface, reversed }
}

struct Reading {
    rx: u64,
    tx: u64,
    iface: String,
}

/// One pass over `/proc/net/dev`, already oriented into (download, upload).
///
/// The fallback exists because the aggregate netdev is a firmware fact, not a
/// contract: if a build names it differently, show WAN traffic from the busiest
/// `rmnet*` device rather than an error. `rmnet_ipa0` is what this build uses
/// (measured 2026-10-24: rx 1,746,504,408 / tx 795,652,779).
fn read_counters(path: &str, counter: &Counter) -> Result<Reading, String> {
    let body = fs::read_to_string(path).map_err(|e| format!("{}: {}", path, e))?;
    let mut fallback: Option<Reading> = None;
    for line in body.lines() {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let mut fields = rest.split_whitespace();
        let Some(rx) = fields.next().and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        // rx is field 1 after the colon; tx is field 9, i.e. the eighth after it.
        let Some(tx) = fields.nth(7).and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        let (dl, ul) = if counter.reversed { (tx, rx) } else { (rx, tx) };
        if !counter.iface.is_empty() && name == counter.iface {
            return Ok(Reading {
                rx: dl,
                tx: ul,
                iface: name.to_string(),
            });
        }
        if name.starts_with("rmnet") {
            let better = match &fallback {
                Some(b) => dl > b.rx,
                None => true,
            };
            if better {
                fallback = Some(Reading {
                    rx: dl,
                    tx: ul,
                    iface: name.to_string(),
                });
            }
        }
    }
    fallback.ok_or_else(|| format!("no rmnet byte counter in {}", path))
}

fn read_uptime_ms(path: &str) -> Result<u64, String> {
    let body = fs::read_to_string(path).map_err(|e| format!("{}: {}", path, e))?;
    let first = body.split_whitespace().next().ok_or("empty uptime")?;
    let secs: f64 = first.parse().map_err(|_| format!("uptime {:?} not numeric", first))?;
    if !secs.is_finite() || secs < 0.0 {
        return Err(format!("uptime {:?} out of range", first));
    }
    Ok((secs * 1000.0) as u64)
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Replace `path` with `body` in one step.
///
/// The temp name carries our pid and is opened `create_new` (O_CREAT|O_EXCL),
/// which refuses a symlink planted at that path; `rename` then replaces the
/// destination without following a symlink there either. /tmp is mode 1777, so
/// both of those properties matter on this device.
fn write_atomic(path: &str, body: &str) -> io::Result<()> {
    let tmp = format!("{}.{}.tmp", path, process::id());
    match write_tmp(&tmp, body) {
        Ok(()) => {}
        // A leftover from a previous run with the same pid: unlink (never
        // follows) and retry once under the same exclusive rule.
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(&tmp);
            write_tmp(&tmp, body)?;
        }
        Err(e) => return Err(e),
    }
    fs::rename(&tmp, path)
}

fn write_tmp(tmp: &str, body: &str) -> io::Result<()> {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .open(tmp)?;
    f.write_all(body.as_bytes())?;
    // tmpfs, so this is a memcpy, not a disk flush. It also guarantees a reader
    // can never observe a short document through the rename.
    f.sync_all()
}

/// Log only when the state actually changes. A daemon that prints every tick
/// would write to the journal (or qlog) once per second — a worse cost than the
/// sampling itself.
struct StateLog {
    last: String,
}

impl StateLog {
    fn new() -> StateLog {
        StateLog {
            last: String::new(),
        }
    }
    fn warn(&mut self, msg: &str) {
        if self.last == msg {
            return;
        }
        eprintln!("qmanager_traffic: {}", msg);
        self.last = msg.to_string();
    }
    fn info(&mut self, msg: &str) {
        if self.last == msg {
            return;
        }
        println!("qmanager_traffic: {}", msg);
        self.last = msg.to_string();
    }
}

struct Sample {
    prev_uptime_ms: Option<u64>,
    prev_rx: u64,
    prev_tx: u64,
    last_rx_bps: u64,
    last_tx_bps: u64,
    last_window_ms: u64,
}

impl Sample {
    fn new() -> Sample {
        Sample {
            prev_uptime_ms: None,
            prev_rx: 0,
            prev_tx: 0,
            last_rx_bps: 0,
            last_tx_bps: 0,
            last_window_ms: 0,
        }
    }
}

fn json_escape(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            '"' => Some("\\\"".to_string()),
            '\\' => Some("\\\\".to_string()),
            c if (c as u32) < 0x20 => None,
            c => Some(c.to_string()),
        })
        .collect()
}

fn main() {
    let cfg = Config::from_env();
    let mut log = StateLog::new();
    let mut counter = resolve_counter(&cfg.data_used);
    let mut sample = Sample::new();
    let mut ticks: u32 = 0;

    log.info(&format!(
        "starting: interval={}ms out={} counter={} orientation={}",
        cfg.interval_ms,
        cfg.out,
        if counter.iface.is_empty() {
            "auto (busiest rmnet)"
        } else {
            counter.iface.as_str()
        },
        if counter.reversed { "reversed" } else { "normal" }
    ));

    let interval = Duration::from_millis(cfg.interval_ms);
    let mut next = Instant::now();

    loop {
        next += interval;

        if ticks % RESOLVE_REFRESH_TICKS == 0 {
            counter = resolve_counter(&cfg.data_used);
        }
        ticks = ticks.wrapping_add(1);

        match tick(&cfg, &counter, &mut sample, &mut log) {
            Ok(()) => {}
            Err(e) => {
                // Emitting the failure (rather than nothing) is what lets the
                // row say "unavailable" instead of freezing on the last rate.
                let body = format!(
                    "{{\"ok\":false,\"error\":\"counter_unavailable\",\"detail\":\"{}\",\"ts\":{}}}\n",
                    json_escape(&e),
                    now_epoch()
                );
                if let Err(we) = write_atomic(&cfg.out, &body) {
                    log.warn(&format!("write {} failed: {}", cfg.out, we));
                }
                sample.prev_uptime_ms = None;
                log.warn(&format!("counter unreadable: {}", e));
            }
        }

        if cfg.once {
            return;
        }

        // Sleep to the deadline instead of for the interval, so the cadence does
        // not drift by the tick's own duration. A missed deadline resets the
        // schedule rather than firing a burst of catch-up samples.
        let now = Instant::now();
        if next > now {
            thread::sleep(next - now);
        } else {
            next = now;
        }
    }
}

fn tick(
    cfg: &Config,
    counter: &Counter,
    sample: &mut Sample,
    log: &mut StateLog,
) -> Result<(), String> {
    let reading = read_counters(&cfg.proc_net_dev, counter)?;
    let uptime_ms = read_uptime_ms(&cfg.proc_uptime)?;

    let mut rx_bps = 0u64;
    let mut tx_bps = 0u64;
    let mut window_ms = 0u64;
    let mut warming = true;
    let mut counter_reset = false;
    // Whether this tick may move the anchor. A too-soon tick must NOT: it hands
    // back the previous window's figure precisely so the next tick still
    // measures across a real interval instead of restarting a sub-150 ms one.
    let mut rebase = true;

    if let Some(prev_uptime) = sample.prev_uptime_ms {
        if uptime_ms > prev_uptime {
            let dt = uptime_ms - prev_uptime;
            if dt < MIN_WINDOW_MS {
                // Too soon to divide: hand back the previous window's figure
                // and keep the anchor where it was.
                rx_bps = sample.last_rx_bps;
                tx_bps = sample.last_tx_bps;
                window_ms = sample.last_window_ms;
                warming = false;
                rebase = false;
            } else if dt <= MAX_WINDOW_MS
                && reading.rx >= sample.prev_rx
                && reading.tx >= sample.prev_tx
            {
                // bits/s = bytes × 8 × 1000 / window_ms
                rx_bps = (reading.rx - sample.prev_rx).saturating_mul(8000) / dt;
                tx_bps = (reading.tx - sample.prev_tx).saturating_mul(8000) / dt;
                window_ms = dt;
                warming = false;
            } else if reading.rx < sample.prev_rx || reading.tx < sample.prev_tx {
                // The counter went backwards: modem reboot or a re-created
                // netdev. A negative rate is not a reading.
                counter_reset = true;
                warming = false;
                window_ms = dt;
                log.info(&format!(
                    "counter reset on {} (rx {} -> {}, tx {} -> {})",
                    reading.iface, sample.prev_rx, reading.rx, sample.prev_tx, reading.tx
                ));
            }
            // else: a gap longer than MAX_WINDOW_MS — stay `warming` and rebase.
        }
    } else {
        log.info(&format!("warming on {}", reading.iface));
    }

    if rebase {
        sample.prev_uptime_ms = Some(uptime_ms);
        sample.prev_rx = reading.rx;
        sample.prev_tx = reading.tx;
    }
    if !warming {
        sample.last_rx_bps = rx_bps;
        sample.last_tx_bps = tx_bps;
        sample.last_window_ms = window_ms;
    }

    let body = format!(
        "{{\"ok\":true,\"iface\":\"{}\",\"rx_bps\":{},\"tx_bps\":{},\"window_ms\":{},\"warming\":{},\"counter_reset\":{},\"ts\":{}}}\n",
        json_escape(&reading.iface),
        rx_bps,
        tx_bps,
        window_ms,
        warming,
        counter_reset,
        now_epoch()
    );

    write_atomic(&cfg.out, &body).map_err(|e| format!("write {}: {}", cfg.out, e))
}

// =============================================================================
// Host tests
// =============================================================================
// These run on the build machine with `cargo test` (no device, no fixtures on
// the device): the crate is pure std, so nothing here is Linux-only. They cover
// the two things worth a machine check — the /proc/net/dev parse and the
// warming/rate/reset/gap state machine — because every one of those branches is
// a number the dashboard will show as if it were a measurement.
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    struct Scratch {
        dir: String,
    }

    impl Scratch {
        fn new() -> Scratch {
            let n = SEQ.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "qmt-test-{}-{}",
                std::process::id(),
                n
            ));
            let _ = fs::create_dir_all(&dir);
            Scratch {
                dir: dir.to_string_lossy().to_string(),
            }
        }
        fn path(&self, name: &str) -> String {
            format!("{}/{}", self.dir, name)
        }
        fn put(&self, name: &str, body: &str) -> String {
            let p = self.path(name);
            let _ = fs::write(&p, body);
            p
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    const DEVICE_HEADER: &str = "Inter-|   Receive |  Transmit\n face |bytes packets |bytes packets\n";

    fn netdev(ipa_rx: u64, ipa_tx: u64) -> String {
        format!(
            "{}rmnet_ipa0: {} 5 0 0 0 0 0 0 {} 7 0 0 0 0 0 0\n  bridge0: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0\n",
            DEVICE_HEADER, ipa_rx, ipa_tx
        )
    }

    fn cfg_for(s: &Scratch, data_used: &str) -> Config {
        Config {
            interval_ms: 1000,
            out: s.path("out.json"),
            data_used: data_used.to_string(),
            proc_net_dev: s.path("dev"),
            proc_uptime: s.path("uptime"),
            once: false,
        }
    }

    fn counter_for(s: &Scratch, du_name: &str, du_body: &str) -> Counter {
        resolve_counter(&s.put(du_name, du_body))
    }

    #[test]
    fn parses_only_the_two_fields_it_needs() {
        let line = "  \"selected_counter\": \"rmnet_ipa0\",";
        assert_eq!(json_string_field(line, "\"selected_counter\""), Some("rmnet_ipa0"));
        assert_eq!(json_string_field(line, "\"orientation\""), None);
        assert_eq!(json_string_field("  \"orientation\": \"reversed\",", "\"orientation\""), Some("reversed"));
        // Not JSON, and not a substring trap: the key is matched with its quotes.
        assert_eq!(json_string_field("selected_counter: x", "\"selected_counter\""), None);
    }

    #[test]
    fn interface_names_are_restricted() {
        assert!(valid_iface("rmnet_ipa0"));
        assert!(valid_iface("rmnet_data15"));
        assert!(!valid_iface(""));
        assert!(!valid_iface("rmnet\"ipa0"));
        assert!(!valid_iface("../../etc/passwd"));
    }

    #[test]
    fn reads_the_selected_interface_and_orientation() {
        let s = Scratch::new();
        s.put("dev", &netdev(1000, 2000));

        let normal = counter_for(
            &s,
            "du1.json",
            "{\n  \"selected_counter\": \"rmnet_ipa0\",\n  \"orientation\": \"normal\"\n}\n",
        );
        let r = read_counters(&s.path("dev"), &normal).expect("normal read");
        assert_eq!((r.rx, r.tx), (1000, 2000));
        assert_eq!(r.iface, "rmnet_ipa0");

        let reversed = counter_for(
            &s,
            "du2.json",
            "{\n  \"selected_counter\": \"rmnet_ipa0\",\n  \"orientation\": \"reversed\"\n}\n",
        );
        let r = read_counters(&s.path("dev"), &reversed).expect("reversed read");
        assert_eq!((r.rx, r.tx), (2000, 1000), "reversed swaps the two columns");
    }

    #[test]
    fn falls_back_to_the_busiest_rmnet_when_the_selection_is_absent() {
        let s = Scratch::new();
        s.put(
            "dev",
            &format!(
                "{}rmnet_data0: 500 5 0 0 0 0 0 0 600 7 0 0 0 0 0 0\nrmnet_data1: 9000 5 0 0 0 0 0 0 100 7 0 0 0 0 0 0\n  eth0: 1 1 0 0 0 0 0 0 2 1 0 0 0 0 0 0\n",
                DEVICE_HEADER
            ),
        );
        // Empty selection: no data_used.json at all.
        let none = counter_for(&s, "missing.json", "");
        let r = read_counters(&s.path("dev"), &none).expect("fallback read");
        assert_eq!(r.iface, "rmnet_data1", "busiest rmnet by rx wins");
        assert_eq!((r.rx, r.tx), (9000, 100));
    }

    #[test]
    fn reports_unavailable_rather_than_zero_when_no_counter_exists() {
        let s = Scratch::new();
        s.put("dev", "  eth0: 1 1 0 0 0 0 0 0 2 1 0 0 0 0 0 0\n");
        let none = counter_for(&s, "missing.json", "");
        assert!(read_counters(&s.path("dev"), &none).is_err());
    }

    /// The whole point of the state machine: a rate only exists once there are
    /// two samples, and every awkward case in between must say so rather than
    /// invent a number.
    #[test]
    fn rate_state_machine() {
        let s = Scratch::new();
        let du = s.put("du.json", "{\n  \"selected_counter\": \"rmnet_ipa0\",\n  \"orientation\": \"normal\"\n}\n");
        let cfg = cfg_for(&s, &du);
        let counter = resolve_counter(&du);
        let mut sample = Sample::new();
        let mut log = StateLog::new();
        let out = |s: &Scratch| fs::read_to_string(s.path("out.json")).unwrap_or_default();

        // t=100.00 — first sample: warming, no anchor to subtract from.
        s.put("dev", &netdev(1000, 2000));
        s.put("uptime", "100.00 50.00\n");
        tick(&cfg, &counter, &mut sample, &mut log).expect("tick 1");
        assert!(out(&s).contains("\"warming\":true"), "{}", out(&s));
        assert!(out(&s).contains("\"window_ms\":0"));

        // t=101.00, +1000 B rx and +2000 B tx over exactly 1 s.
        s.put("dev", &netdev(2000, 4000));
        s.put("uptime", "101.00 50.00\n");
        tick(&cfg, &counter, &mut sample, &mut log).expect("tick 2");
        assert!(out(&s).contains("\"rx_bps\":8000"), "{}", out(&s));
        assert!(out(&s).contains("\"tx_bps\":16000"), "{}", out(&s));
        assert!(out(&s).contains("\"window_ms\":1000"));
        assert!(out(&s).contains("\"warming\":false"));

        // t=101.05 — 50 ms later: too soon to divide, so the previous window's
        // figures come back unchanged and the anchor stays put.
        s.put("dev", &netdev(3000, 6000));
        s.put("uptime", "101.05 50.00\n");
        tick(&cfg, &counter, &mut sample, &mut log).expect("tick 3");
        assert!(out(&s).contains("\"rx_bps\":8000"), "{}", out(&s));
        assert!(out(&s).contains("\"window_ms\":1000"));

        // t=102.05 — 1 s after the 101.00 anchor, i.e. 1000 B over 1050 ms. The
        // anchor did not move on the too-soon tick, so this window covers the
        // whole gap and nothing is measured twice.
        s.put("uptime", "102.05 50.00\n");
        tick(&cfg, &counter, &mut sample, &mut log).expect("tick 4");
        assert!(out(&s).contains("\"rx_bps\":7619"), "{}", out(&s));
        assert!(out(&s).contains("\"window_ms\":1050"));

        // t=103.05 — counter went BACKWARDS (modem reboot): 0 bps, flagged,
        // never a negative rate.
        s.put("dev", &netdev(10, 20));
        s.put("uptime", "103.05 50.00\n");
        tick(&cfg, &counter, &mut sample, &mut log).expect("tick 5");
        assert!(out(&s).contains("\"counter_reset\":true"), "{}", out(&s));
        assert!(out(&s).contains("\"rx_bps\":0"));

        // t=120.05 — a 17 s gap: an average over that is not live, so warming.
        s.put("dev", &netdev(1000010, 2000020));
        s.put("uptime", "120.05 50.00\n");
        tick(&cfg, &counter, &mut sample, &mut log).expect("tick 6");
        assert!(out(&s).contains("\"warming\":true"), "{}", out(&s));

        // And one tick later it measures again, from the rebased anchor.
        s.put("dev", &netdev(1001010, 2001020));
        s.put("uptime", "121.05 50.00\n");
        tick(&cfg, &counter, &mut sample, &mut log).expect("tick 7");
        assert!(out(&s).contains("\"rx_bps\":8000"), "{}", out(&s));
    }

    #[test]
    fn atomic_write_replaces_without_a_consultable_partial_file() {
        let s = Scratch::new();
        let out = s.path("out.json");
        write_atomic(&out, "{\"a\":1}\n").expect("first write");
        write_atomic(&out, "{\"a\":2}\n").expect("second write");
        assert_eq!(fs::read_to_string(&out).unwrap_or_default(), "{\"a\":2}\n");
        // The temp file is renamed away, never left behind for the next run.
        assert!(!std::path::Path::new(&format!("{}.{}.tmp", out, std::process::id())).exists());
    }
}
