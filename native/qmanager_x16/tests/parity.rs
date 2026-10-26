//! Byte-for-byte parity with the shell shim, where the shim is reachable.
//!
//! ```sh
//! X16_SHIM=/Users/…/zlt-x16/deploy-x16/atcli_smd11 cargo test --test parity
//! ```
//!
//! The shell shim is the specification: 87 CGIs and `parse_at.sh` were written
//! against its exact field positions. Running both implementations over the same
//! fixture (`tests/fixtures/fake_atcmd`) and diffing stdout is the only check
//! that cannot be fooled by a test I wrote to match my own port.
//!
//! Without `X16_SHIM` every test here reports that it was skipped — the crate is
//! self-contained by design (no sibling-repo path is baked in) and this is the
//! one check that needs the other tree.
//!
//! PENDING arms are listed separately: for those the shell has an answer and this
//! binary deliberately refuses. The test asserts the refusal is `ERROR` and
//! PRINTS the shell's answer, so the gap is visible in the log rather than
//! silently tolerated.

use std::fmt::Write as _;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

fn shim() -> Option<PathBuf> {
    let p = std::env::var("X16_SHIM").ok().filter(|v| !v.is_empty())?;
    let path = PathBuf::from(p);
    if path.is_file() {
        Some(path)
    } else {
        eprintln!("X16_SHIM={} is not a file: skipping parity", path.display());
        None
    }
}

struct Fixture {
    dir: PathBuf,
    atcmd: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!(
            "qm16-parity-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let atcmd = dir.join("fake_atcmd");
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_atcmd"),
            &atcmd,
        )
        .unwrap();
        std::fs::set_permissions(&atcmd, std::fs::Permissions::from_mode(0o755)).unwrap();
        Fixture { dir, atcmd }
    }

    fn link(&self) -> PathBuf {
        let p = self.dir.join("atcli_smd11");
        let _ = std::fs::remove_file(&p);
        std::os::unix::fs::symlink(PathBuf::from(env!("CARGO_BIN_EXE_qmanager_x16")), &p).unwrap();
        p
    }

    fn run_shell(&self, shim: &Path, cmd: &str, extra: &[(&str, &str)]) -> String {
        let mut c = Command::new("sh");
        c.arg(shim).arg(cmd);
        self.base_env(&mut c, "shell", extra);
        let out = c.output().unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn run_rust(&self, cmd: &str, extra: &[(&str, &str)]) -> String {
        let mut c = Command::new(self.link());
        c.arg(cmd);
        self.base_env(&mut c, "rust", extra);
        let out = c.output().unwrap();
        assert_eq!(
            out.status.code(),
            Some(0),
            "the shim contract is exit 0 always, for {}",
            cmd
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn base_env(&self, c: &mut Command, side: &str, extra: &[(&str, &str)]) {
        // Separate cache and blacklist files per side, so one implementation's
        // caching cannot make the other look different.
        let cache = self.dir.join(format!("cpsi-{}.cache", side));
        let blacklist = self.dir.join(format!("blacklist-{}", side));
        let _ = std::fs::remove_file(&cache);
        let _ = std::fs::remove_file(&blacklist);
        c.env("ATC", &self.atcmd)
            .env("QM_CPSI_CACHE", cache)
            .env("QM_AT_BLACKLIST", blacklist)
            .env("QM_THERMAL_DIR", self.dir.join("no-thermal"))
            .env("QM_PHY_DEVINFO_FILE", self.dir.join("no-devinfo"))
            .env("QLOG_FILE", self.dir.join(format!("log-{}", side)));
        for (k, v) in extra {
            c.env(k, v);
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn diff(name: &str, shell: &str, rust: &str) {
    if shell == rust {
        return;
    }
    let mut report = String::new();
    for (i, (a, b)) in shell.lines().zip(rust.lines()).enumerate() {
        if a != b {
            let _ = writeln!(report, "  line {}:\n    shell: {:?}\n    rust:  {:?}", i + 1, a, b);
        }
    }
    panic!(
        "{}: outputs differ\n--- shell ---\n{:?}\n--- rust ---\n{:?}\n--- first differing lines ---\n{}",
        name, shell, rust, report
    );
}

/// Arms this crate answers and the shell answers: the output must be identical.
const PORTED: &[&str] = &[
    "AT+CGSN",
    "AT+CGMM",
    "AT+CSQ",
    "AT+COPS?",
    "AT+CPIN?",
    "ATI",
    "AT+QCCID",
    "AT+CVERSION",
    "AT+QENG=\"servingcell\"",
    "AT+QENG=\"neighbourcell\"",
    "AT+QCAINFO",
    "AT+QCAINFO=1",
    "AT+QCAINFO=0",
    "AT+QRSRP",
    "AT+QRSRQ",
    "AT+QSINR",
    "AT+QUIMSLOT?",
    "AT+QSIMSTAT?",
    "AT+QSIMDET?",
    "AT+EGMR=0,7",
    "AT+EGMR=1,7,\"490154203237518\"",
    "AT+EGMR=1,4,\"490154203237518\"",
    "AT+QNWPREFCFG",
    "AT+QNWPREFCFG=\"policy_band\"",
    "AT+QNWPREFCFG=\"mode_pref\"",
    "AT+QNWPREFCFG=\"nr5g_disable_mode\"",
    "AT+QNWPREFCFG=\"roam_pref\"",
    "AT+QNWPREFCFG=\"rat_acq_order\"",
    "AT+QNWPREFCFG=\"ue_capability_band\"",
    "AT+QNWPREFCFG=\"some_future_key\"",
    "AT+QNWPREFCFG=\"lte_band\"",
    "AT+QNWPREFCFG=\"nsa_nr5g_band\"",
    "AT+QNWPREFCFG=\"nr5g_band\"",
    "AT+QNWPREFCFG=\"ue_capability_band\",1:3",
    "AT+QNWPREFCFG=\"mode_pref\",LTE",
    "AT+QNWPREFCFG=\"rat_acq_order\",NR5G",
    "AT+QNWCFG=\"lte_mimo_layers\"",
    "AT+QNWCFG=\"nr5g_mimo_layers\"",
    "AT+QNWCFG=\"nr5g_time_advance\"",
    "AT+QGETCAPABILITY",
    "AT+QMAP=\"WWAN\"",
    "AT+QNWINFO",
    "AT+QCSQ",
    "AT+QTEMP",
    "AT+CMGS=\"+923001234567\"",
    "AT+QSCAN=1",
    "AT+CRSM=176,28539,0,0,12",
    "AT+COPS=?",
    "AT+QENG=\"servingcell\";+QCAINFO=1;+QCAINFO;+QCAINFO=0",
    "AT+CVERSION;+CGMM;+CGSN;+CIMI;+QCCID;+CNUM",
    "AT+QRSRP;+QRSRQ;+QSINR",
];

/// Arms this crate refuses (see `src/inventory.rs`): the shell answers them.
const PENDING: &[&str] = &[
    // Band WRITES are not ported. The port deliberately answers ERROR; the
    // shell implements them via AT+CSYSSEL after validating against
    // AT+CSYSSEL=?. Arm::PrefBandWrite is Status::Pending in the inventory, so
    // these belong here and not in PORTED -- a byte-identity assertion against
    // an arm that is knowingly not ported can only ever be a false failure.
    "AT+QNWPREFCFG=\"lte_band\",1:3",
    "AT+QNWPREFCFG=\"lte_band\",3:99",
    "AT+QNWPREFCFG=\"lte_band\",0x1a8000a",
    "AT+QNWPREFCFG=\"lte_band\",1::3",
    "AT+CGCONTRDP",
    "AT+CGCONTRDP=0",
    "AT+QNWCFG=\"lte_time_advance\"",
    "AT+QNWLOCK=\"common/4g\"",
    "AT+QNWLOCK=\"common/4g\",0",
    "AT+QNWLOCK=\"common/4g\",1,1312,256",
    "AT+QNWLOCK=\"common/4g\",2,1312,256",
    "AT+QNWLOCK=\"weird\"",
];

#[test]
fn ported_arms_are_byte_identical_to_the_shell_shim() {
    let shim = match shim() {
        Some(p) => p,
        None => {
            eprintln!("skipped: set X16_SHIM=/path/to/zlt-x16/deploy-x16/atcli_smd11");
            return;
        }
    };
    let fx = Fixture::new("ported");
    for cmd in PORTED {
        let shell = fx.run_shell(&shim, cmd, &[]);
        let rust = fx.run_rust(cmd, &[]);
        diff(cmd, &shell, &rust);
    }
}

#[test]
fn ported_arms_agree_on_the_captured_edge_cases() {
    let shim = match shim() {
        Some(p) => p,
        None => {
            eprintln!("skipped: set X16_SHIM=…");
            return;
        }
    };
    let fx = Fixture::new("edges");
    let endc = "+CPSI: LTE,Online,410-01,0xD857,48466199,104,EUTRAN-BAND1,250,3,3,-133,-898,-579,-9\n\
                +CPSI: NR5G_NSA,47,NR5G_BAND41,509070,-770,-110,21,1,9";
    let cases: &[(&str, &[(&str, &str)])] = &[
        ("AT+QENG=\"servingcell\"", &[("FAKE_CPSI", endc)]),
        (
            "AT+QENG=\"servingcell\"",
            &[("FAKE_CPSI", "EMPTY")],
        ),
        (
            "AT+QENG=\"servingcell\"",
            &[(
                "FAKE_CPSI",
                "+CPSI: LTE,Limited service,410-03,0x1,1,2,EUTRAN-BAND41,40000,20,20,-80,-880,-500,20",
            )],
        ),
        (
            "AT+QCAINFO",
            &[(
                "FAKE_CCA",
                "+CCAINFO: \"PCC\",EUTRAN_BAND3,1850,100,227,-73,-14,-39,137",
            )],
        ),
        (
            "AT+QCAINFO",
            &[(
                "FAKE_CCA",
                "+CCAINFO: \"SCC\",EUTRAN_BAND1,150,50,502,2,-44,-3,-82,134,2,3,9",
            )],
        ),
        ("AT+QCAINFO", &[("FAKE_CCA", "EMPTY")]),
        ("AT+QRSRP", &[("FAKE_CRSRP", "ERROR")]),
        ("ATI", &[("FAKE_ATI", "Model: SIMCOM_SIM8260E")]),
        ("AT+CVERSION", &[("FAKE_ATI", "Revision: X99\nModel: M\nManufacturer: ACME")]),
        ("AT+QNWPREFCFG=\"ue_capability_band\"", &[("FAKE_CSYSSEL_CAP", "EMPTY")]),
        ("AT+QTEMP", &[("FAKE_QTEMP", "+QTEMP: \"mdm-0\",42")]),
        ("AT+CSQ", &[("FAKE_FAIL", "AT+CSQ")]),
        ("AT+CSQ", &[("FAKE_BLANK", "AT+CSQ")]),
    ];
    for (cmd, extra) in cases {
        let shell = fx.run_shell(&shim, cmd, extra);
        let rust = fx.run_rust(cmd, extra);
        diff(&format!("{} {:?}", cmd, extra), &shell, &rust);
    }
}

#[test]
fn pending_arms_refuse_while_the_shell_answers() {
    let shim = match shim() {
        Some(p) => p,
        None => {
            eprintln!("skipped: set X16_SHIM=…");
            return;
        }
    };
    let fx = Fixture::new("pending");
    let mut gaps = String::new();
    for cmd in PENDING {
        let shell = fx.run_shell(&shim, cmd, &[]);
        let rust = fx.run_rust(cmd, &[]);
        assert_eq!(rust, "ERROR\n", "{} must refuse, not guess", cmd);
        if shell != rust {
            let _ = writeln!(gaps, "  {} -> shell answered {:?}", cmd, shell.trim_end());
        }
    }
    eprintln!(
        "PENDING arms: this binary answers ERROR, the shell answers:\n{}",
        gaps
    );
}
