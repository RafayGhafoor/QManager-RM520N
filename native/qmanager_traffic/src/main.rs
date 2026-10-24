//! qmanager_traffic — the ONE producer behind the dashboard's Live Traffic row.
//!
//! # Where the numbers come from, and why it is not `/proc/net/dev`
//!
//! The first version of this binary deltas `/proc/net/dev`. **That is wrong on
//! this device**, and the sibling product found out first
//! (`greenpacket-o5a`, `deploy/radio-handler.sh:2095`):
//!
//! > Qualcomm IPA hardware forwarding bypasses `/proc/net/dev` on this build. A
//! > measured 20 MB / 82.88 Mbps Cloudflare transfer advanced `eth0`'s
//! > driver-level `tx_octets` by 21.04 MB while `/proc eth0` advanced only
//! > 28.6 KB and **both `rmnet_data0`/`rmnet_ipa0` were effectively flat**.
//!
//! So a forwarded flow — which is every byte a LAN client downloads through this
//! router — is invisible to the netdev counters. Re-measured here on 2026-10-24:
//! the RTL8125 `tx_octets`/`rx_octets` counters stood at 9.11 GB / 5.15 GB while
//! `/proc/net/dev` reported eth0 tx 2.34 GB / rx 4.23 GB — **6.8 GB of forwarded
//! download the netdev counters never saw**. A device-originated transfer (curl
//! *on* the router) is counted correctly by netdev, which is exactly what made
//! the first version look right in testing and wrong in the browser.
//!
//! The source is therefore **`ethtool -S <lan-iface>` → `tx_octets`/`rx_octets`**,
//! the driver's own octet counters, which include the offloaded flow:
//!
//! - **`tx_octets` is DOWNLOAD** — bytes the Ethernet MAC *sends* to the LAN
//!   clients/therefore received from the WAN. Confirmed here by a controlled
//!   8.6 MB pull from the device (hw tx +9.0 MB) and an 8.1 MB push (hw rx
//!   +8.1 MB). The opposite polarity to netdev, on purpose — the sibling says
//!   the same ("On this topology eth0 TX is download").
//! - `rx_octets` is UPLOAD.
//!
//! The `/proc/net/dev` candidate is kept as a **fallback** (devices without
//! ethtool, a different Ethernet driver, or a flow that does not traverse the
//! LAN port), and the two are never summed — the same packets appear in both
//! paths. Selection is the sibling's rule: take the hardware pair when its
//! combined rate is larger, otherwise the netdev pair. Both directions always
//! come from one source, so a rate never mixes them.
//!
//! # Why an ioctl and not `ethtool -S`
//!
//! The sibling runs `/usr/sbin/ethtool -S eth0` per sample. Measured here that is
//! **4.20 ms of CPU and 1.26 forks per read** — at 1 Hz, ~0.42 % of this box's
//! single core, forever, which is more than the static HTTP read the row itself
//! costs. The same two numbers come out of `ioctl(fd, SIOCETHTOOL, ETHTOOL_GSTATS)`
//! for ~10 µs and no process. This is the one place a native sampler is strictly
//! better than the shell+ethtool path, so it takes it.
//!
//! # Why a native sampler at all
//!
//! A CGI that computed this per request was built and measured: 107 ms and 8
//! forks per request (a jq-free CGI floor is 16–26 ms; a static file served by
//! busybox httpd is 9.0 ms). At the 1 Hz a live row needs, a CGI costs more than
//! the whole modem poller, so one process precomputes the document and httpd
//! serves it statically. Rust rather than a shell loop for the same reason one
//! level down: a shell `sleep`+`mv` tick is ~2 forks ≈ 0.5 % of one core, while
//! this loop is one wakeup.
//!
//! # Output contract
//!
//! One line of JSON, replaced atomically every tick:
//!
//! ```json
//! {"ok":true,"iface":"eth0_hw","rx_bps":35500000,"tx_bps":3100000,
//!  "window_ms":1000,"warming":false,"counter_reset":false,"ts":1792803200}
//! ```
//!
//! `rx_bps` is **download**, `tx_bps` **upload**, both in **bits** per second
//! (the canonical rate unit; the dashboard renders bytes/s, matching the sibling
//! product's `formatBytes(n) + "/s"`). `window_ms` is the real interval averaged.
//! `warming` means there is no rate yet and must not be rendered as 0. `iface` is
//! `eth0_hw` when the hardware counters won and the netdev name otherwise, so a
//! reader can tell which source produced the figure.

#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::ffi::c_void;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::process;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A window shorter than this is a measurement artefact, not a rate.
const MIN_WINDOW_MS: u64 = 150;

/// A window longer than this means the sampler was not running (paused, or a very
/// slow tick). An average over that gap is not live, so it is `warming`.
const MAX_WINDOW_MS: u64 = 10_000;

/// Re-resolve the counters this often. The netdev candidate can move when the
/// modem re-attaches; the hardware string indices never do, but re-checking
/// once a minute costs nothing and heals a driver reload.
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

fn env_flag(key: &str) -> bool {
    matches!(env_or(key, "0").as_str(), "1" | "true" | "yes")
}

struct Config {
    interval_ms: u64,
    out: String,
    data_used: String,
    proc_net_dev: String,
    proc_uptime: String,
    proc_net_route: String,
    /// Ethernet interface whose driver counters are read. Empty disables the
    /// hardware source entirely (netdev only) — useful for a device without it.
    hw_iface: String,
    /// Flip the hardware pair for a topology where RX is download. Unused on
    /// this device; documented so a port does not have to edit code.
    hw_swap: bool,
    once: bool,
}

impl Config {
    fn from_env() -> Config {
        Config {
            interval_ms: env_u64("QMT_INTERVAL_MS", 1000).clamp(200, 10_000),
            out: env_or("QMT_OUT", "/tmp/qmanager_traffic.json"),
            data_used: env_or("QMT_DATA_USED", "/usrdata/qmanager/data_used.json"),
            proc_net_dev: env_or("QMT_PROC_NET_DEV", "/proc/net/dev"),
            proc_uptime: env_or("QMT_PROC_UPTIME", "/proc/uptime"),
            proc_net_route: env_or("QMT_PROC_NET_ROUTE", "/proc/net/route"),
            hw_iface: env_or("QMT_HW_IFACE", "eth0"),
            hw_swap: env_flag("QMT_HW_SWAP"),
            once: env_or("QMT_ONCE", "0") == "1",
        }
    }
}

// =============================================================================
// Hardware octet counters (ethtool ioctl)
// =============================================================================

// `libc::Ioctl` is the per-target type of the request argument: `c_int` on
// 32-bit ARM (where `unsigned long` is 32-bit and passed in one register) and
// `c_ulong` elsewhere. Declaring it by hand as u64 would corrupt the call on
// armv7 — which is the whole reason this crate depends on libc.
// The ioctl layer below is Linux-only: macOS has no SIOCETHTOOL, and the host
// tests never drive it (the ioctl path is verified against `ethtool -S` on the
// device instead). Gating it keeps `cargo test` runnable on the build machine.
#[cfg(target_os = "linux")]
const SIOCETHTOOL: libc::Ioctl = 0x8946;
const ETHTOOL_GSSET_INFO: u32 = 0x0000_0037;
const ETHTOOL_GSTRINGS: u32 = 0x0000_001b;
const ETHTOOL_GSTATS: u32 = 0x0000_001d;
const ETH_SS_STATS: u32 = 0x0000_0001;
const ETH_GSTRING_LEN: usize = 32;
/// The RTL8125 exposes ~70 statistics; 256 is headroom, and the whole request
/// buffer is still under 9 KB on the stack for the one-off name lookup.
const MAX_STATS: usize = 256;

/// `struct ifreq` as the kernel sees it: 16-byte name plus a 16-byte union whose
/// pointer member is what ethtool reads. Declared here rather than reached
/// through libc's union, so the layout is explicit and padded past what the
/// kernel copies (it reads 32 bytes; this struct is at least that on every
/// target we build for).
#[cfg(target_os = "linux")]
#[repr(C)]
struct IfReq {
    name: [u8; 16],
    data: *mut c_void,
    _pad: [u8; 16],
}

/// `struct ethtool_sset_info` — how many statistics the driver has.
#[cfg(target_os = "linux")]
#[repr(C)]
struct SsetInfo {
    cmd: u32,
    reserved: u32,
    sset_mask: u64,
    data: [u32; 1],
}

/// `struct ethtool_gstrings` — the statistics' names.
///
/// The header is **12 bytes**, not 16: `cmd`, `string_set`, `len`, then `data[]`.
/// (Some ethtool structs carry a `pad` field; this one does not.) A 16-byte
/// version here made every name arrive shifted by 4 bytes, so `tx_octets` was
/// never found even though `ethtool -S` listed it — found on the device
/// 2026-10-24 by dumping the raw buffer and seeing the names start at offset 28.
#[cfg(target_os = "linux")]
#[repr(C)]
struct GStrings {
    cmd: u32,
    string_set: u32,
    len: u32,
    data: [u8; MAX_STATS * ETH_GSTRING_LEN],
}

/// `struct ethtool_stats` — one value per name, in the same order.
#[cfg(target_os = "linux")]
#[repr(C)]
struct GStats {
    cmd: u32,
    n_stats: u32,
    data: [u64; MAX_STATS],
}

#[cfg(target_os = "linux")]
fn ethtool_call(fd: libc::c_int, iface: &str, request: *mut c_void) -> bool {
    let mut ifr = IfReq {
        name: [0; 16],
        data: request,
        _pad: [0; 16],
    };
    let bytes = iface.as_bytes();
    let n = bytes.len().min(15);
    ifr.name[..n].copy_from_slice(&bytes[..n]);
    // SAFETY: `ifr` is a live, fully initialised `struct ifreq`-shaped value and
    // `request` points at one of the `#[repr(C)]` request structs above, which
    // outlive this call. SIOCETHTOOL reads `ifr_name`, follows `ifr_data` and
    // writes into that buffer.
    unsafe { libc::ioctl(fd, SIOCETHTOOL, &mut ifr as *mut IfReq) == 0 }
}

/// A resolved handle on the Ethernet driver's octet counters.
///
/// The statistics are positional, so the indices of `tx_octets` / `rx_octets` are
/// looked up once (two ioctls) and reused; each tick is then a single
/// `ETHTOOL_GSTATS` ioctl.
struct HwCounters {
    fd: libc::c_int,
    iface: String,
    n_stats: u32,
    tx_idx: usize,
    rx_idx: usize,
}

impl Drop for HwCounters {
    fn drop(&mut self) {
        if self.fd >= 0 {
            // SAFETY: fd is ours, opened in `open` and not closed anywhere else.
            unsafe {
                libc::close(self.fd);
            }
        }
    }
}

#[cfg(target_os = "linux")]
impl HwCounters {
    fn open(iface: &str) -> Option<HwCounters> {
        // SAFETY: a plain socket(2) call; the fd is owned by the returned struct.
        let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM, 0) };
        if fd < 0 {
            return None;
        }

        let mut info = SsetInfo {
            cmd: ETHTOOL_GSSET_INFO,
            reserved: 0,
            sset_mask: 1u64 << ETH_SS_STATS,
            data: [0],
        };
        if !ethtool_call(fd, iface, &mut info as *mut SsetInfo as *mut c_void) {
            eprintln!("qmanager_traffic: ethtool GSSET_INFO failed on {}", iface);
            // SAFETY: fd was just opened and is not owned by anything yet.
            unsafe {
                libc::close(fd);
            }
            return None;
        }
        let n_stats = info.data[0];
        if n_stats == 0 || n_stats as usize > MAX_STATS {
            // SAFETY: as above.
            unsafe {
                libc::close(fd);
            }
            return None;
        }

        let mut names = GStrings {
            cmd: ETHTOOL_GSTRINGS,
            string_set: ETH_SS_STATS,
            len: n_stats,
            data: [0; MAX_STATS * ETH_GSTRING_LEN],
        };
        if !ethtool_call(fd, iface, &mut names as *mut GStrings as *mut c_void) {
            eprintln!(
                "qmanager_traffic: ethtool GSTRINGS failed on {} ({} stats)",
                iface, n_stats
            );
            // SAFETY: as above.
            unsafe {
                libc::close(fd);
            }
            return None;
        }

        let mut tx_idx = None;
        let mut rx_idx = None;
        for i in 0..n_stats as usize {
            let off = i * ETH_GSTRING_LEN;
            let raw = &names.data[off..off + ETH_GSTRING_LEN];
            // The kernel hands back ETH_GSTRING_LEN bytes per name and does NOT
            // guarantee how the driver padded the tail: some NUL-fill, some
            // space-fill, some neither. Trimming both is what makes the match
            // work — the r8125 driver's names arrive space-padded, and comparing
            // the raw 32 bytes found `tx_octets` in `ethtool -S`'s output but not
            // here (found on the device, 2026-10-24).
            let end = raw.iter().position(|&b| b == 0).unwrap_or(ETH_GSTRING_LEN);
            let mut name = &raw[..end];
            while let Some(&last) = name.last() {
                if last == b' ' || last == b'\t' {
                    name = &name[..name.len() - 1];
                } else {
                    break;
                }
            }
            if env_flag("QMT_DEBUG_NAMES") {
                eprintln!("  stat[{}] = {:?}", i, String::from_utf8_lossy(&raw));
            }
            if name == b"tx_octets".as_slice() {
                tx_idx = Some(i);
            } else if name == b"rx_octets".as_slice() {
                rx_idx = Some(i);
            }
        }

        match (tx_idx, rx_idx) {
            (Some(tx_idx), Some(rx_idx)) => Some(HwCounters {
                fd,
                iface: iface.to_string(),
                n_stats,
                tx_idx,
                rx_idx,
            }),
            _ => {
                eprintln!(
                    "qmanager_traffic: ethtool stats on {} have no tx_octets/rx_octets ({} stats)",
                    iface, n_stats
                );
                // SAFETY: as above.
                unsafe {
                    libc::close(fd);
                }
                None
            }
        }
    }

    /// `(tx_octets, rx_octets)` — raw driver counters, TX first.
    fn read(&self) -> Option<(u64, u64)> {
        let mut stats = GStats {
            cmd: ETHTOOL_GSTATS,
            n_stats: self.n_stats,
            data: [0; MAX_STATS],
        };
        if !ethtool_call(
            self.fd,
            &self.iface,
            &mut stats as *mut GStats as *mut c_void,
        ) {
            return None;
        }
        Some((stats.data[self.tx_idx], stats.data[self.rx_idx]))
    }
}

#[cfg(not(target_os = "linux"))]
impl HwCounters {
    fn open(_iface: &str) -> Option<HwCounters> {
        None
    }
    fn read(&self) -> Option<(u64, u64)> {
        None
    }
}

// =============================================================================
// /proc/net/dev fallback candidate
// =============================================================================

/// Which netdev to read as the fallback, resolved the sibling's way: the
/// interface carrying the default route, because that is what the traffic
/// actually uses. `data_used.json`'s selection (the aggregate `rmnet_ipa0` on
/// this unit) is the next choice, and "busiest rmnet" is the last.
fn default_route_iface(path: &str) -> Option<String> {
    let body = fs::read_to_string(path).ok()?;
    for line in body.lines().skip(1) {
        let mut fields = line.split_whitespace();
        let iface = fields.next()?;
        let dest = fields.next()?;
        let _gateway = fields.next()?;
        let flags = fields.next()?;
        if dest != "00000000" || iface == "lo" {
            continue;
        }
        // RTF_UP must be set; wanmon's monthly-cap enforces with a *blackhole*
        // default route rather than deleting it, and that must not be mistaken
        // for a live WAN interface.
        match u32::from_str_radix(flags, 16) {
            Ok(f) if f & 1 == 1 => {}
            _ => continue,
        }
        return Some(iface.to_string());
    }
    None
}

/// `"key": "value"` on a line of pretty-printed JSON, without a JSON parser.
fn json_string_field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let rest = line.split_once(key)?.1;
    let rest = rest.trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn valid_iface(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// The netdev this sampler edges with: default-route interface, else whatever the
/// persistent data counter selected, else "" (meaning "busiest rmnet" below).
fn resolve_netdev(path_route: &str, data_used: &str) -> String {
    if let Some(iface) = default_route_iface(path_route) {
        if valid_iface(&iface) {
            return iface;
        }
    }
    if let Ok(body) = fs::read_to_string(data_used) {
        for line in body.lines() {
            if let Some(v) = json_string_field(line, "\"selected_counter\"") {
                if valid_iface(v) {
                    return v.to_string();
                }
            }
        }
    }
    String::new()
}

struct Reading {
    dl: u64,
    ul: u64,
    iface: String,
}

/// One pass over `/proc/net/dev`, already oriented into (download, upload):
/// field 1 after the colon is rx (download), field 9 is tx (upload).
fn read_netdev(path: &str, want: &str) -> Result<Reading, String> {
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
        let Some(tx) = fields.nth(7).and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        if !want.is_empty() && name == want {
            return Ok(Reading {
                dl: rx,
                ul: tx,
                iface: name.to_string(),
            });
        }
        if name.starts_with("rmnet") {
            let better = match &fallback {
                Some(b) => rx > b.dl,
                None => true,
            };
            if better {
                fallback = Some(Reading {
                    dl: rx,
                    ul: tx,
                    iface: name.to_string(),
                });
            }
        }
    }
    fallback.ok_or_else(|| format!("no usable byte counter in {}", path))
}

fn read_uptime_ms(path: &str) -> Result<u64, String> {
    let body = fs::read_to_string(path).map_err(|e| format!("{}: {}", path, e))?;
    let first = body.split_whitespace().next().ok_or("empty uptime")?;
    let secs: f64 = first
        .parse()
        .map_err(|_| format!("uptime {:?} not numeric", first))?;
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
/// both properties matter.
fn write_atomic(path: &str, body: &str) -> io::Result<()> {
    let tmp = format!("{}.{}.tmp", path, process::id());
    match write_tmp(&tmp, body) {
        Ok(()) => {}
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
    // tmpfs: a memcpy, not a disk flush. It also guarantees a reader can never
    // observe a short document through the rename.
    f.sync_all()
}

/// Log only when the state actually changes — a daemon printing every tick is a
/// worse cost than the sampling itself.
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

// =============================================================================
// The rate state machine (pure — host tests drive this directly)
// =============================================================================

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Source {
    NetDev,
    Hw,
}

struct Sample {
    prev_uptime_ms: Option<u64>,
    prev_nd: Option<(u64, u64)>,
    prev_hw: Option<(u64, u64)>,
    last_rx_bps: u64,
    last_tx_bps: u64,
    last_window_ms: u64,
    last_source: Option<Source>,
}

impl Sample {
    fn new() -> Sample {
        Sample {
            prev_uptime_ms: None,
            prev_nd: None,
            prev_hw: None,
            last_rx_bps: 0,
            last_tx_bps: 0,
            last_window_ms: 0,
            last_source: None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Outcome {
    rx_bps: u64,
    tx_bps: u64,
    window_ms: u64,
    warming: bool,
    counter_reset: bool,
    source: Option<Source>,
}

/// bits/s for one source, or None when there is no usable previous sample or a
/// counter went backwards.
fn rate(prev: Option<(u64, u64)>, cur: Option<(u64, u64)>, dt_ms: u64) -> Option<(u64, u64)> {
    let (p, c) = (prev?, cur?);
    if dt_ms == 0 || c.0 < p.0 || c.1 < p.1 {
        return None;
    }
    Some((
        (c.0 - p.0).saturating_mul(8000) / dt_ms,
        (c.1 - p.1).saturating_mul(8000) / dt_ms,
    ))
}

/// The whole sampling rule, in one place and free of IO.
///
/// `nd` and `hw` are the CURRENT cumulative counters, already oriented into
/// (download, upload). Returns the rates to publish.
fn compute(
    sample: &mut Sample,
    uptime_ms: u64,
    nd: Option<(u64, u64)>,
    hw: Option<(u64, u64)>,
) -> Outcome {
    let mut counter_reset = false;
    for (prev, cur) in [(sample.prev_nd, nd), (sample.prev_hw, hw)] {
        if let (Some(p), Some(c)) = (prev, cur) {
            if c.0 < p.0 || c.1 < p.1 {
                counter_reset = true;
            }
        }
    }

    let mut out = Outcome {
        rx_bps: 0,
        tx_bps: 0,
        window_ms: 0,
        warming: true,
        counter_reset,
        source: None,
    };

    let dt = match sample.prev_uptime_ms {
        Some(prev) if uptime_ms > prev => Some(uptime_ms - prev),
        _ => None,
    };

    match dt {
        // Too soon to divide: hand back the previous window's figure and do NOT
        // move the anchors, so the next tick still measures a real interval.
        Some(dt) if dt < MIN_WINDOW_MS => {
            out.rx_bps = sample.last_rx_bps;
            out.tx_bps = sample.last_tx_bps;
            out.window_ms = sample.last_window_ms;
            out.warming = false;
            out.source = sample.last_source;
            return out;
        }
        Some(dt) if dt <= MAX_WINDOW_MS => {
            let nd_rate = rate(sample.prev_nd, nd, dt);
            let hw_rate = rate(sample.prev_hw, hw, dt);
            // The sibling's rule, kept exactly: the hardware pair is preferred
            // only when its combined rate is larger, and both directions always
            // come from the same source — never summed, because offloaded
            // packets appear in both paths.
            let chosen = match (hw_rate, nd_rate) {
                (Some(h), Some(n)) if h.0 + h.1 > n.0 + n.1 => Some((Source::Hw, h)),
                (Some(h), None) => Some((Source::Hw, h)),
                (None, Some(n)) => Some((Source::NetDev, n)),
                (Some(_), Some(n)) => Some((Source::NetDev, n)),
                (None, None) => None,
            };
            if let Some((source, (rx, tx))) = chosen {
                out.rx_bps = rx;
                out.tx_bps = tx;
                out.window_ms = dt;
                out.warming = false;
                out.source = Some(source);
            }
        }
        // A gap longer than MAX_WINDOW_MS (or no previous sample): stay warming
        // and rebase below, so the next tick is a clean 1 s window.
        _ => {}
    }

    if !out.warming {
        sample.last_rx_bps = out.rx_bps;
        sample.last_tx_bps = out.tx_bps;
        sample.last_window_ms = out.window_ms;
        sample.last_source = out.source;
    }
    sample.prev_uptime_ms = Some(uptime_ms);
    // A source that is unreadable this tick anchors to nothing, so the tick where
    // it comes back cannot divide by a stale multi-second gap.
    sample.prev_nd = nd;
    sample.prev_hw = hw;
    out
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

// =============================================================================
// Ticking
// =============================================================================

struct Ticker {
    counter: String,
    /// The netdev that the LAST read actually came from. `counter` is the name
    /// we asked for; `read_netdev` falls back to the busiest rmnet when that name
    /// is absent, so the published `iface` must be this, not the request.
    last_nd_iface: String,
    hw: Option<HwCounters>,
    hw_enabled: bool,
    ticks: u32,
}

impl Ticker {
    fn new(cfg: &Config, log: &mut StateLog) -> Ticker {
        let counter = resolve_netdev(&cfg.proc_net_route, &cfg.data_used);
        let hw_enabled = !cfg.hw_iface.is_empty() && valid_iface(&cfg.hw_iface);
        let hw = if hw_enabled {
            let h = HwCounters::open(&cfg.hw_iface);
            if h.is_none() {
                log.warn(&format!(
                    "ethtool counters unavailable on {}; netdev only",
                    cfg.hw_iface
                ));
            }
            h
        } else {
            None
        };
        log.info(&format!(
            "starting: interval={}ms out={} netdev={} hw={}",
            cfg.interval_ms,
            cfg.out,
            if counter.is_empty() {
                "auto (busiest rmnet)"
            } else {
                counter.as_str()
            },
            match (&hw, cfg.hw_swap) {
                (Some(_), false) => "eth0_hw (tx=down)",
                (Some(_), true) => "eth0_hw (rx=down, swapped)",
                (None, _) => "none",
            }
        ));
        Ticker {
            last_nd_iface: counter.clone(),
            counter,
            hw,
            hw_enabled,
            ticks: 0,
        }
    }

    fn sources(&mut self, cfg: &Config, log: &mut StateLog) -> (Option<(u64, u64)>, Option<(u64, u64)>) {
        let nd = match read_netdev(&cfg.proc_net_dev, &self.counter) {
            Ok(r) => {
                self.last_nd_iface = r.iface;
                Some((r.dl, r.ul))
            }
            Err(e) => {
                log.warn(&format!("netdev unreadable: {}", e));
                None
            }
        };

        if self.ticks % RESOLVE_REFRESH_TICKS == 0 {
            // Netdev selection can move on a re-attach; the ethtool handle can go
            // stale on a driver reload. Re-resolve both, quietly.
            self.counter = resolve_netdev(&cfg.proc_net_route, &cfg.data_used);
            if self.hw_enabled && self.hw.is_none() {
                self.hw = HwCounters::open(&cfg.hw_iface);
            }
        }
        self.ticks = self.ticks.wrapping_add(1);

        let raw = self.hw.as_ref().and_then(|h| h.read());
        if raw.is_none() && self.hw_enabled && self.hw.is_some() {
            // One failed read: reopen next tick rather than silently losing the
            // better source for the rest of the process's life.
            self.hw = None;
            log.warn("ethtool read failed; reopening");
        }
        // tx_octets is DOWNLOAD on this topology (bytes leaving the LAN port
        // toward the clients); rx_octets is upload. See the module header.
        let hw = raw.map(|(tx, rx)| if cfg.hw_swap { (rx, tx) } else { (tx, rx) });

        (nd, hw)
    }
}

fn main() {
    let cfg = Config::from_env();
    let mut log = StateLog::new();
    let mut ticker = Ticker::new(&cfg, &mut log);
    let mut sample = Sample::new();

    let interval = Duration::from_millis(cfg.interval_ms);
    let mut next = Instant::now();

    loop {
        next += interval;

        match tick(&cfg, &mut ticker, &mut sample, &mut log) {
            Ok(()) => {}
            Err(e) => {
                // Emitting the failure (rather than nothing) is what lets the row
                // say "unavailable" instead of freezing on the last rate.
                let body = format!(
                    "{{\"ok\":false,\"error\":\"counter_unavailable\",\"detail\":\"{}\",\"ts\":{}}}\n",
                    json_escape(&e),
                    now_epoch()
                );
                if let Err(we) = write_atomic(&cfg.out, &body) {
                    log.warn(&format!("write {} failed: {}", cfg.out, we));
                }
                sample.prev_uptime_ms = None;
                log.warn(&format!("no usable counter: {}", e));
            }
        }

        if cfg.once {
            return;
        }

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
    ticker: &mut Ticker,
    sample: &mut Sample,
    log: &mut StateLog,
) -> Result<(), String> {
    let uptime_ms = read_uptime_ms(&cfg.proc_uptime)?;
    let (nd, hw) = ticker.sources(cfg, log);

    if nd.is_none() && hw.is_none() {
        sample.prev_uptime_ms = None;
        return Err(format!("no usable byte counter in {}", cfg.proc_net_dev));
    }

    let outcome = compute(sample, uptime_ms, nd, hw);

    let iface = match outcome.source {
        Some(Source::Hw) => format!("{}_hw", cfg.hw_iface),
        Some(Source::NetDev) => ticker.last_nd_iface.clone(),
        None => String::new(),
    };

    if outcome.counter_reset {
        log.info("counter reset (rebased)");
    }
    if outcome.warming && sample.prev_uptime_ms.is_some() {
        log.info("warming");
    } else if !outcome.warming {
        log.info(&format!("sampling {}", iface));
    }

    let body = format!(
        "{{\"ok\":true,\"iface\":\"{}\",\"rx_bps\":{},\"tx_bps\":{},\"window_ms\":{},\"warming\":{},\"counter_reset\":{},\"ts\":{}}}\n",
        json_escape(&iface),
        outcome.rx_bps,
        outcome.tx_bps,
        outcome.window_ms,
        outcome.warming,
        outcome.counter_reset,
        now_epoch()
    );
    write_atomic(&cfg.out, &body).map_err(|e| format!("write {}: {}", cfg.out, e))
}

// =============================================================================
// Host tests
// =============================================================================
// Run on the build machine with `cargo test`. The ioctl path is device-only (and
// is verified against `ethtool -S` on the unit instead), but everything that
// decides which number is published is pure and is tested here.
#[cfg(test)]
mod tests {
    use super::*;

    fn boxed(
        uptime: u64,
        nd: Option<(u64, u64)>,
        hw: Option<(u64, u64)>,
    ) -> (Sample, Outcome) {
        let mut s = Sample::new();
        let o = compute(&mut s, uptime, nd, hw);
        (s, o)
    }

    #[test]
    fn first_sample_is_warming() {
        let (_, o) = boxed(100_000, Some((1000, 2000)), Some((5000, 7000)));
        assert!(o.warming);
        assert_eq!((o.rx_bps, o.tx_bps, o.window_ms), (0, 0, 0));
        assert_eq!(o.source, None);
    }

    #[test]
    fn hardware_pair_wins_when_its_combined_rate_is_larger() {
        let mut s = Sample::new();
        compute(&mut s, 100_000, Some((1_000_000, 1_000_000)), Some((1_000_000, 1_000_000)));
        // netdev +1 KB/s each way, hw +1 MB/s each way.
        let o = compute(
            &mut s,
            101_000,
            Some((1_001_000, 1_001_000)),
            Some((2_000_000, 2_000_000)),
        );
        assert_eq!(o.source, Some(Source::Hw));
        assert_eq!(o.rx_bps, 8_000_000, "1 MB/s of hw tx is 8 Mbit/s down");
        assert_eq!(o.tx_bps, 8_000_000);
        assert_eq!(o.window_ms, 1000);
        assert!(!o.warming);
    }

    #[test]
    fn netdev_pair_wins_when_the_hardware_is_flat() {
        let mut s = Sample::new();
        compute(&mut s, 100_000, Some((1_000_000, 1_000_000)), Some((7, 7)));
        let o = compute(
            &mut s,
            101_000,
            Some((1_100_000, 1_000_000)),
            Some((7, 7)),
        );
        assert_eq!(o.source, Some(Source::NetDev));
        assert_eq!(o.rx_bps, 800_000, "100 000 B/s is 800 kbit/s");
        assert_eq!(o.tx_bps, 0);
    }

    #[test]
    fn a_missing_source_does_not_poison_the_next_window() {
        let mut s = Sample::new();
        compute(&mut s, 100_000, Some((1000, 1000)), Some((0, 0)));

        // The hardware source disappears: report netdev, and anchor nothing for hw.
        let o = compute(&mut s, 101_000, Some((2000, 1000)), None);
        assert_eq!(o.source, Some(Source::NetDev));
        assert_eq!(o.rx_bps, 8_000);

        // It comes back carrying a counter far ahead of where it left off. This
        // tick has no hw anchor, so it must NOT divide that jump by one second
        // and publish a spike — netdev answers instead.
        let o2 = compute(&mut s, 102_000, Some((3000, 1000)), Some((999_999_999, 0)));
        assert_eq!(o2.source, Some(Source::NetDev));
        assert_eq!(o2.rx_bps, 8_000);

        // From here the hw anchor is re-established, so its rate is real again.
        let o3 = compute(&mut s, 103_000, Some((4000, 1000)), Some((1_000_002_999, 0)));
        assert_eq!(o3.source, Some(Source::Hw));
        assert_eq!(o3.rx_bps, 24_000);
    }

    #[test]
    fn too_soon_reuses_the_previous_window_and_keeps_the_anchor() {
        let mut s = Sample::new();
        compute(&mut s, 100_000, None, Some((0, 0)));
        // hw is already oriented (download, upload): +1000 B down, +2000 B up.
        let o = compute(&mut s, 101_000, None, Some((1000, 2000)));
        assert_eq!((o.rx_bps, o.tx_bps, o.window_ms), (8_000, 16_000, 1000));

        // 50 ms later: same figures, still from the 101_000 anchor.
        let o2 = compute(&mut s, 101_050, None, Some((9_000, 9_000)));
        assert_eq!((o2.rx_bps, o2.tx_bps, o2.window_ms), (8_000, 16_000, 1000));

        // 1050 ms after the anchor: 9 000 - 1 000 bytes land in one window.
        let o3 = compute(&mut s, 102_050, None, Some((9000, 9000)));
        assert_eq!(o3.window_ms, 1050);
        assert_eq!(o3.rx_bps, (8000u64).saturating_mul(8000) / 1050);
        assert_eq!(o3.tx_bps, (7000u64).saturating_mul(8000) / 1050);
    }

    #[test]
    fn a_backwards_counter_is_flagged_not_negative() {
        let mut s = Sample::new();
        compute(&mut s, 100_000, None, Some((5_000_000, 5_000_000)));
        let o = compute(&mut s, 101_000, None, Some((10, 20)));
        assert!(o.counter_reset);
        assert_eq!((o.rx_bps, o.tx_bps), (0, 0));
        assert!(o.source.is_none());
    }

    #[test]
    fn a_long_gap_is_warming_not_an_average() {
        let mut s = Sample::new();
        compute(&mut s, 100_000, None, Some((0, 0)));
        let o = compute(&mut s, 117_000, None, Some((1_000_000, 1_000_000)));
        assert!(o.warming);
        let o2 = compute(&mut s, 118_000, None, Some((2_000_000, 2_000_000)));
        assert!(!o2.warming);
        assert_eq!(o2.rx_bps, 8_000_000);
    }

    #[test]
    fn netdev_parse_reads_rx_as_download() {
        let dir = std::env::temp_dir().join(format!("qmt-parse-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let p = dir.join("dev");
        let _ = fs::write(
            &p,
            "Inter-|   Receive |  Transmit\n face |bytes packets |bytes packets\nrmnet_data0: 1000 5 0 0 0 0 0 0 2000 7 0 0 0 0 0 0\n",
        );
        let r = read_netdev(&p.to_string_lossy(), "rmnet_data0").expect("parse");
        assert_eq!((r.dl, r.ul, r.iface.as_str()), (1000, 2000, "rmnet_data0"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_route_interface_is_the_candidate() {
        let dir = std::env::temp_dir().join(format!("qmt-route-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let p = dir.join("route");
        let _ = fs::write(
            &p,
            "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n\
             rmnet_data0\t00000000\tA5FD050A\t0003\t0\t0\t0\t00000000\t0\t0\t0\n\
             bridge0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n",
        );
        assert_eq!(
            default_route_iface(&p.to_string_lossy()).as_deref(),
            Some("rmnet_data0")
        );
        // A blackhole default (wanmon's cap enforcement) has no RTF_UP.
        let _ = fs::write(
            &p,
            "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n\
             lo\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0\n",
        );
        assert_eq!(default_route_iface(&p.to_string_lossy()), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_are_atomic_and_leave_no_temp_behind() {
        let dir = std::env::temp_dir().join(format!("qmt-write-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let out = dir.join("out.json");
        let p = out.to_string_lossy().to_string();
        write_atomic(&p, "{\"a\":1}\n").expect("first");
        write_atomic(&p, "{\"a\":2}\n").expect("second");
        assert_eq!(fs::read_to_string(&p).unwrap_or_default(), "{\"a\":2}\n");
        assert!(!std::path::Path::new(&format!("{}.{}.tmp", p, std::process::id())).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
