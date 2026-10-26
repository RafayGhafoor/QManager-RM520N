//! End-to-end checks of the CLI contract, driving the real binary.
//!
//! These are the assertions a caller can see: stdout text, stderr text, exit
//! codes, jq-shaped JSON, the lock, and the allowlist blocking a command BEFORE
//! it reaches the broker. The modem is `tests/fixtures/fake_atcmd`, which is a
//! copy of the fixture the shell suites use, so a reply here is a reply the
//! device has actually produced.
//!
//! The binary is invoked through symlinks named `qcmd` and `atcli_smd11`,
//! because the multicall face is chosen by argv[0] — that IS the deployment
//! shape (`qcmd` and `atcli_smd11` are what the device runs).

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Env {
    dir: PathBuf,
    bin: PathBuf,
}

impl Env {
    fn new(tag: &str) -> Env {
        let dir = std::env::temp_dir().join(format!(
            "qm16-cli-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Env {
            bin: PathBuf::from(env!("CARGO_BIN_EXE_qmanager_x16")),
            dir,
        }
    }

    /// A `/bin/atcmd` stand-in path (the fixture, made executable).
    fn atcmd(&self) -> PathBuf {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_atcmd");
        let dst = self.dir.join("fake_atcmd");
        std::fs::copy(&src, &dst).unwrap();
        std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755)).unwrap();
        dst
    }

    /// A symlink to the binary under the name a caller would use.
    fn link(&self, name: &str) -> PathBuf {
        let p = self.dir.join(name);
        let _ = std::fs::remove_file(&p);
        std::os::unix::fs::symlink(&self.bin, &p).unwrap();
        p
    }

    fn cmd(&self, name: &str) -> Command {
        let mut c = Command::new(self.link(name));
        // Native dialect, so the crate under test does the translation rather
        // than handing the work to an installed shim.
        c.env("QCMD_MODE", "native")
            .env("ATC", self.atcmd())
            .env("QM_AT_BLACKLIST", self.dir.join("blacklist"))
            .env("QM_CPSI_CACHE", self.dir.join("cpsi.cache"))
            .env("QLOG_FILE", self.dir.join("qmanager.log"));
        c
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

#[test]
fn no_argument_is_the_shell_error_and_exit_1() {
    let env = Env::new("noargs");
    let out = env.cmd("qcmd").output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        stderr(&out).trim_end(),
        "{\"error\":\"no_command\",\"detail\":\"Usage: qcmd [-j] \\\"AT+COMMAND\\\"\"}"
    );
    assert!(stdout(&out).is_empty(), "the detail goes to stderr");
}

#[test]
fn success_prints_the_payload_and_exits_0() {
    let env = Env::new("ok");
    let out = env.cmd("qcmd").arg("AT+CSQ").output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    // The CRs are kept: the shell's command substitution strips trailing
    // NEWLINES only, so `echo "$_raw"` emits "...OK\r\n" there too.
    assert_eq!(stdout(&out), "+CSQ: 24,99\r\n\r\nOK\r\n");
}

#[test]
fn json_mode_matches_the_shell_shape() {
    let env = Env::new("json");
    let out = env.cmd("qcmd").arg("-j").arg("AT+CSQ").output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let text = stdout(&out);
    assert!(
        text.starts_with(
            "{\n  \"success\": true,\n  \"response\": \"+CSQ: 24,99\\r\\n\\r\\nOK\\r\","
        ),
        "jq's own layout, with the payload's CRs escaped: {}",
        text
    );
    assert!(text.trim_end().ends_with("\"command\": \"AT+CSQ\"\n}"));
}

#[test]
fn modem_error_is_command_failed() {
    let env = Env::new("err");
    let out = env
        .cmd("qcmd")
        .env("FAKE_FAIL", "AT+CSQ")
        .arg("AT+CSQ")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(stderr(&out).trim_end(), "ERROR: command_failed");
    assert!(stdout(&out).is_empty());
}

#[test]
fn modem_error_in_json_mode_keeps_the_error_key() {
    let env = Env::new("errjson");
    let out = env
        .cmd("qcmd")
        .env("FAKE_FAIL", "AT+CSQ")
        .arg("-j")
        .arg("AT+CSQ")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let text = stdout(&out);
    assert!(text.contains("\"success\": false"), "{}", text);
    assert!(text.contains("\"error\": \"command_failed\""), "{}", text);
}

#[test]
fn blank_reply_is_command_failed() {
    // "A silent empty string has twice been read as 'modem fine, no data'."
    let env = Env::new("blank");
    let out = env
        .cmd("qcmd")
        .env("FAKE_BLANK", "AT+CSQ")
        .arg("AT+CSQ")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(stderr(&out).trim_end(), "ERROR: command_failed");
}

#[test]
fn an_unverified_command_never_reaches_the_broker() {
    let env = Env::new("allowlist");
    let log = env.dir.join("calls.log");
    let out = env
        .cmd("qcmd")
        .env("FAKE_CALL_LOG", &log)
        .arg("AT+CRSM=176,28539,0,0,12")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(stderr(&out).trim_end(), "ERROR: command_failed");
    let calls = std::fs::read_to_string(&log).unwrap_or_default();
    assert!(
        calls.is_empty(),
        "the allowlist must refuse before exec, but the fixture saw: {}",
        calls
    );
}

#[test]
fn a_hanging_command_times_out_and_is_blacklisted() {
    let env = Env::new("hang");
    let blacklist = env.dir.join("blacklist");
    let start = std::time::Instant::now();
    let out = env
        .cmd("qcmd")
        .env("FAKE_HANG", "AT+CSQ")
        .env("QM_AT_TIMEOUT", "1")
        .arg("AT+CSQ")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(
        start.elapsed() < std::time::Duration::from_secs(10),
        "the deadline must bound the call, took {:?}",
        start.elapsed()
    );
    let listed = std::fs::read_to_string(&blacklist).unwrap_or_default();
    assert!(listed.contains("AT+CSQ"), "blacklisted: {:?}", listed);

    // Second call short-circuits: it must not wait for the broker again.
    let t = std::time::Instant::now();
    let out = env
        .cmd("qcmd")
        .env("FAKE_HANG", "AT+CSQ")
        .env("QM_AT_TIMEOUT", "1")
        .arg("AT+CSQ")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(
        t.elapsed() < std::time::Duration::from_secs(1),
        "a blacklisted command is answered without the modem, took {:?}",
        t.elapsed()
    );
}

#[test]
fn the_dialect_face_answers_through_argv0_and_always_exits_0() {
    let env = Env::new("shim");
    // The shim contract: raw text on stdout, exit 0 even for ERROR.
    let out = env.cmd("atcli_smd11").arg("AT+QCCID").output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(stdout(&out).contains("+QCCID: 89410037251217291419"));

    let out = env
        .cmd("atcli_smd11")
        .arg("AT+QENG=\"servingcell\"")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    let text = stdout(&out);
    assert!(text.contains("+QENG: \"servingcell\",\"CONNECT\""), "{}", text);
    assert!(!text.contains("atcmd_receive"), "echo stripped: {}", text);

    // Unverified command: ERROR text, still exit 0.
    let out = env.cmd("atcli_smd11").arg("AT+QSCAN=1").output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(stdout(&out), "ERROR\n");
}

#[test]
fn compound_chain_through_qcmd() {
    let env = Env::new("chain");
    let out = env
        .cmd("qcmd")
        .arg("AT+CGSN;+CIMI")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    let text = stdout(&out);
    assert!(text.contains("861702085648268"), "{}", text);
    assert!(text.contains("410032100729141"), "{}", text);
}

#[test]
fn shim_mode_runs_the_configured_shim_under_the_lock() {
    // The deployable-now variant: qcmd drives an existing shim, and must keep
    // the shim's stderr out of the payload and its OK out of the classifier.
    let env = Env::new("shimmode");
    let shim = env.dir.join("fake_shim");
    let mut f = std::fs::File::create(&shim).unwrap();
    writeln!(f, "#!/bin/sh").unwrap();
    writeln!(f, "printf '%s\\n\\nOK\\n' \"payload-for:$1\"").unwrap();
    writeln!(f, "echo noise >&2").unwrap();
    drop(f);
    std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();

    let out = env
        .cmd("qcmd")
        .env("QCMD_MODE", "shim")
        .env("QM_AT_CLI", &shim)
        .arg("AT+CSQ")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(stdout(&out), "payload-for:AT+CSQ\n\nOK\n");
    assert!(stderr(&out).is_empty(), "shim stderr is discarded");
}

#[test]
fn a_held_lock_delays_the_call_then_lets_it_through() {
    // Blocking flock with a deadline: a contended call waits for the holder and
    // succeeds, without the 1 s quantisation the shell's sleep loop had.
    let env = Env::new("lock");
    // The REAL lock path: interop with the shell callers is the requirement, so
    // the test takes the same file the deployed `qcmd` takes. The lock is free
    // again after 300 ms, and a contended acquire is exactly what the other
    // tests in this binary would wait out, not fail.
    let lock_path = "/tmp/qmanager_at.lock";
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(lock_path)
        .unwrap();
    let file = std::fs::File::open(lock_path).unwrap();

    // SAFETY: a valid fd for the life of the test.
    let rc = unsafe { libc::flock(std::os::unix::io::AsRawFd::as_raw_fd(&file), libc::LOCK_EX) };
    assert_eq!(rc, 0);

    let mut child = env
        .cmd("qcmd")
        .arg("AT+CSQ")
        .spawn()
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    // SAFETY: as above.
    unsafe { libc::flock(std::os::unix::io::AsRawFd::as_raw_fd(&file), libc::LOCK_UN) };

    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0));
}
