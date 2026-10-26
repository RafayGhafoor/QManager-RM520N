//! `qmanager_x16` — one armv7 static binary with two faces, chosen by argv[0],
//! the same multicall shape as `native/qmanager_atd`.
//!
//! * invoked as **`qcmd`** — the CLI contract of the QManager AT gatekeeper
//!   (`qcmd.rs`); drives the vendor broker, or the existing shim under a real
//!   lock.
//! * invoked as **`atcli_smd11`** — the dialect layer alone (`dialect.rs`): the
//!   Quectel-to-SIMCom translation, always exit 0.
//! * invoked as **`qmanager_x16`** — `--inventory` (the translation table),
//!   `--version`, `--help`, or `qcmd …` / `dialect …` to pick a face by
//!   argument.
//!
//! DIFFERENCE FROM `qmanager_atd`: that broker OWNS `/dev/smd11`. Nothing here
//! opens a modem device. The modem on this board is on-die and owned by the
//! vendor's `atcmd_daemon`; `/bin/atcmd` is the vendor's own client for it, and
//! driving it is what inherits the vendor's locking and keeps QManager from
//! interleaving with `/bin/dialer`'s poll (the dialer reboots the router after
//! repeated AT failures).

mod atcmd;
mod dialect;
mod inventory;
mod json;
mod lock;
mod qcmd;
mod qlog;
mod safety;
mod text;

const USAGE: &str = "\
usage:
  qmanager_x16 --version | --inventory | --help
  qmanager_x16 qcmd [-j] \"AT+COMMAND\"      (or invoke as `qcmd`)
  qmanager_x16 dialect \"AT+COMMAND\"        (or invoke as `atcli_smd11`)

environment:
  ATC                       /bin/atcmd, the vendor AT client
  QM_AT_TIMEOUT             seconds per AT command (default 6)
  QM_AT_BLACKLIST           commands that timed out (default /tmp/qmanager_at_blacklist)
  QM_AT_CLI                 shim binary for qcmd's shim mode
  QCMD_MODE                 shim | native (default: shim if present)
  QM_CPSI_CACHE, QM_CPSI_TTL
  QM_THERMAL_DIR            /sys/class/thermal
  QM_PHY_DEVINFO_FILE       /tmp/.devinfo_module_data
  QLOG_FILE                 /tmp/qmanager.log
exit: qcmd 0 on success, 1 on any failure; the dialect layer always exits 0.
";

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let base = argv
        .first()
        .and_then(|a| a.rsplit('/').next())
        .unwrap_or("qmanager_x16")
        .to_string();
    let rest: Vec<String> = argv.iter().skip(1).cloned().collect();

    let code = match base.as_str() {
        "qcmd" => qcmd::main(&rest),
        "atcli_smd11" | "atcli" => dialect_cli(&rest),
        _ => match rest.first().map(String::as_str) {
            Some("--version") | Some("-V") => {
                println!("qmanager_x16 {}", env!("CARGO_PKG_VERSION"));
                0
            }
            Some("--help") | Some("-h") => {
                print!("{}", USAGE);
                0
            }
            Some("--inventory") => {
                print!("{}", inventory::markdown());
                0
            }
            Some("qcmd") => qcmd::main(&rest[1..]),
            Some("dialect") | Some("atcli") => dialect_cli(&rest[1..]),
            _ => {
                eprint!("{}", USAGE);
                2
            }
        },
    };
    std::process::exit(code);
}

/// The shim's contract: one command in, text out, ALWAYS exit 0.
///
/// A binary invoked as `atcli_smd11` has to be drop-in, so a missing argument is
/// silence and not an error — `qcmd` classifies on the text.
fn dialect_cli(args: &[String]) -> i32 {
    let command = args.first().cloned().unwrap_or_default();
    let cfg = atcmd::Cfg::from_env();
    let mut at = atcmd::Atcmd::new(cfg);
    let paths = dialect::Paths::from_env();
    print!("{}", dialect::run(&mut at, &paths, &command));
    use std::io::Write;
    let _ = std::io::stdout().flush();
    0
}
