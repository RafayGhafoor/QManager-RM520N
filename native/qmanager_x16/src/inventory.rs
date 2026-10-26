//! The translation inventory: every arm of the shell shim, one row each.
//!
//! This is the map from QManager's Quectel vocabulary to the SIMCom command set
//! the X16 actually implements, taken arm by arm from `run_one()` and its
//! helpers in `zlt-x16/deploy-x16/atcli_smd11` (1065 lines). It exists so the
//! port can be described by coverage instead of by vibes: `--inventory` prints
//! this table, `Arm::Pending` says exactly which arms are known to be missing
//! and why, and `inventory_covers_every_arm` fails if an arm is added to the
//! dispatcher without a row here.
//!
//! The `checklist` column names the assertions in
//! `zlt-x16/tests/unit_atcli_dialect.sh` (`D/…`) and
//! `zlt-x16/tests/unit_atcli_policy.sh` (`P/…`) that pin that arm's behaviour.
//! Those suites drive the shell shim through `ATC=`/`FAKE_*` overrides, so they
//! are the porting checklist, not something this binary can satisfy by being
//! built — the equivalent assertions are re-expressed in this crate's own tests,
//! and `tests/parity.rs` diffs this binary against the shell shim over the same
//! fixtures where the path is supplied.

/// One translation arm. The variants are the dispatcher's contract; the
/// inventory below is the human-readable half.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arm {
    /// `AT+CMGS*` / `AT+CMGW*` — refused: no interactive entry mode on this bus.
    CmgsRefused,
    /// `AT+QENG="neighbourcell"` — the one Quectel query this firmware answers.
    NeighbourCell,
    /// `AT+QENG="servingcell"` and every other `AT+QENG*` -> `AT+CPSI?`.
    ServingCell,
    /// `AT+QNWLOCK="common/4g"` -> `AT+CCELLCFG?`.
    CellLockStatus,
    /// `AT+QNWLOCK="common/4g",0` -> `AT+CCELLCFG=0`.
    CellLockClear,
    /// `AT+QNWLOCK="common/4g",1,<earfcn>,<pci>` -> `AT+CCELLCFG=1,<pci>,<earfcn>`.
    CellLockWrite,
    /// `AT+QNWLOCK="common/4g",2…9…` — refused: one LTE cell only.
    CellLockMultiRefused,
    /// Any other `AT+QNWLOCK*` — refused.
    CellLockOtherRefused,
    /// `AT+QCAINFO=0|1` — no-op that must still answer OK.
    CarrierAggToggle,
    /// `AT+QCAINFO` -> `AT+CCAINFO?`.
    CarrierAggInfo,
    /// `AT+QCCID` -> `AT+CICCID`, prefix rewritten.
    Iccid,
    /// `AT+CVERSION` -> `ATI` (+ `AT+CGMR` fallback), banner synthesised.
    Version,
    /// `AT+CGCONTRDP` -> rows filtered to the active WAN context.
    ContrDp,
    /// `AT+QTEMP` -> modem thermal zone when the modem has no such command.
    Temperature,
    /// `AT+QNWPREFCFG="policy_band"` and bare `AT+QNWPREFCFG` -> 3x `AT+CSYSSEL`.
    PolicyBand,
    /// `AT+QNWPREFCFG="mode_pref"` -> `AT+CNMP?`.
    ModePref,
    /// `AT+QNWPREFCFG="nr5g_disable_mode"` -> `AT+CSYSSEL="nr5g_disable"`.
    Nr5gDisableMode,
    /// `AT+QNWPREFCFG="roam_pref"` — static `1` (no such setting here).
    RoamPref,
    /// `AT+QNWPREFCFG="rat_acq_order"` / `"rat_order_pref"` -> `AT+CNMP?`.
    RatAcqOrder,
    /// `AT+QNWPREFCFG="ue_capability_band"` -> `AT+CSYSSEL=?`.
    UeCapability,
    /// `AT+QNWPREFCFG[,]<key>,<value>` — the buildable writes.
    PrefWrite,
    /// `AT+QNWPREFCFG="<band key>"` -> `AT+CSYSSEL="<band key>"` (single read).
    PrefBandKeyRead,
    /// `AT+QNWPREFCFG="<band key>",<list>` -> `AT+CSYSSEL="<band key>",<list>`.
    PrefBandWrite,
    /// `AT+QNWPREFCFG="<unmodelled key>"` — empty value so the panel can render.
    PrefUnknownRead,
    /// `AT+QSIMDET*` / `AT+QSIMCFG*` — static detect answer.
    SimDetect,
    /// `AT+QUIMSLOT?` — single slot.
    UimSlot,
    /// `AT+EGMR=0,7` -> `AT+CGSN`.
    ImeiRead,
    /// `AT+EGMR=1,7,"<imei>"` -> `AT+SIMEI=<imei>`, shape-gated.
    ImeiWrite,
    /// `AT+EGMR=1,<other record>` — refused.
    EmgrRefused,
    /// `AT+QSIMSTAT?` — static `1,1`.
    SimStatus,
    /// `AT+QRSRP` -> `AT+CRSRP?`.
    AntennaRsrp,
    /// `AT+QRSRQ` — four `-32768` sentinels; no per-chain source exists.
    AntennaRsrq,
    /// `AT+QSINR` -> `AT+CSINR?`.
    AntennaSinr,
    /// `AT+QNWCFG="lte_time_advance"` -> QMI NAS cell location info.
    LteTimeAdvance,
    /// `AT+QNWCFG="nr5g_time_advance"` — bare OK; no source on this box.
    NrTimeAdvance,
    /// `AT+QNWCFG="lte_mimo_layers"` -> the vendor devinfo store's `lte_rank`.
    LteMimo,
    /// `AT+QNWCFG="nr5g_mimo_layers"` -> the vendor devinfo store's `nr_rank`.
    NrMimo,
    /// `AT+QNWCFG*`, `AT+QGETCAPABILITY*`, `AT+QMAP*`, `AT+QNWINFO*`,
    /// `AT+QCSQ*` — bare OK: the feature does not exist here.
    UnsupportedFamily,
    /// Anything else: verbatim, subject to the allowlist.
    Passthrough,
}

/// Whether an arm is implemented, and if not, what a port still needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ported,
    /// Not ported. The arm answers `ERROR` — never a fabricated success — and
    /// the reason names what is missing.
    Pending(&'static str),
}

pub struct Row {
    pub arm: Arm,
    pub quectel: &'static str,
    pub native: &'static str,
    pub status: Status,
    pub checklist: &'static [&'static str],
}

const fn row(
    arm: Arm,
    quectel: &'static str,
    native: &'static str,
    status: Status,
    checklist: &'static [&'static str],
) -> Row {
    Row {
        arm,
        quectel,
        native,
        status,
        checklist,
    }
}

/// Every arm of `run_one()`, in the order the shell `case` tests them (the order
/// is load-bearing: `AT+QENG*` before the antenna arms, `AT+QCAINFO=1` before
/// `AT+QCAINFO`, the `AT+EGMR` record check before the catch-all).
pub const INVENTORY: &[Row] = &[
    // --- refused before anything else ------------------------------------
    row(
        Arm::CmgsRefused,
        "AT+CMGS* / AT+CMGW*",
        "(refused: ERROR, no SMS prompt on this bus)",
        Status::Ported,
        &["D/transport: interactive CMGS is refused"],
    ),
    // --- serving cell + CA ------------------------------------------------
    row(
        Arm::NeighbourCell,
        "AT+QENG=\"neighbourcell\"",
        "AT+QENG=\"neighbourcell\" (verbatim)",
        Status::Ported,
        &["(no assertion in either suite: only the qcmd passthrough is used)"],
    ),
    row(
        Arm::ServingCell,
        "AT+QENG=\"servingcell\" (any AT+QENG*)",
        "AT+CPSI? (+QENG synthesised, LTE-only and EN-DC layouts)",
        Status::Ported,
        &[
            "D/qeng: f1..f17 field positions",
            "D/qeng: f14 RSRP = f12/10 truncating",
            "D/qeng: f15 RSRQ = f11/10",
            "D/qeng: f16 RSSI = f13/10",
            "D/qeng: f17 SINR passthrough (whole dB)",
            "D/qeng: stat Search -> SEARCH",
            "D/qeng: stat Limited -> LIMSRV",
            "D/qeng: TDD band 41 -> TDD",
            "D/qeng: no LTE -> SEARCH sentinel",
            "D/qeng: EN-DC emits three QENG lines",
            "D/qeng: EN-DC L2 has no servingcell tag",
            "D/qeng: EN-DC L3 NR RSRQ rounded (-110 -> -11)",
            "D/qeng: EN-DC L3 NR SINR whole dB (21, not 2)",
            "D/qeng: LTE-only keeps servingcell prefix",
            "P/cache: one CPSI call serves QENG + all three antenna queries",
            "P/cache: fresh cache avoids the modem entirely",
        ],
    ),
    row(
        Arm::CarrierAggToggle,
        "AT+QCAINFO=0 / AT+QCAINFO=1",
        "(no modem call: reports are always on-demand here)",
        Status::Ported,
        &["D/ca: QCAINFO=1 answers OK"],
    ),
    row(
        Arm::CarrierAggInfo,
        "AT+QCAINFO",
        "AT+CCAINFO? (+QCAINFO rows synthesised)",
        Status::Ported,
        &[
            "D/ca: PCC earfcn / bandwidth code / band text / PCI",
            "D/ca: PCC RSRP, RSRQ, RSSI",
            "D/ca: PCC SINR from CCAINFO field 9 (200 -> 20)",
            "D/ca: wideband RSSI (-39) is not blanked",
            "D/ca: RSSI below RSRP is still rejected",
            "D/ca: SCC band / PCI / RSRP / RSRQ / RSSI (offset shift)",
            "D/ca: implausible metrics are dropped, not plotted",
            "D/ca: no CA -> PCC-only sentinel",
        ],
    ),
    // --- identity ---------------------------------------------------------
    row(
        Arm::Iccid,
        "AT+QCCID",
        "AT+CICCID (prefix rewritten to +QCCID)",
        Status::Ported,
        &[
            "D/identity: QCCID answer carries the +QCCID prefix",
            "D/identity: no raw +ICCID prefix leaks",
        ],
    ),
    row(
        Arm::Version,
        "AT+CVERSION",
        "ATI, then AT+CGMR for the revision if ATI has none",
        Status::Ported,
        &[
            "D/identity: model line comes first",
            "D/identity: Authors line present",
            "D/identity: VERSION line present",
        ],
    ),
    row(
        Arm::ContrDp,
        "AT+CGCONTRDP / AT+CGCONTRDP=0",
        "AT+CGCONTRDP, filtered to the row whose local address is the WAN's",
        Status::Pending(
            "selecting the active context means reading rmnet_data0's address. The \
             shell shells out to `ip`, which this firmware does not put in PATH, and \
             the forkless replacement is getifaddrs(3); that substitution has not been \
             compared against `ip -4 -o addr show dev rmnet_data0` on the device, and \
             there is no way to test the real path off-device",
        ),
        &[
            "D/apn: active WAN context is selected",
            "D/apn: dormant profile is filtered out",
            "D/apn: unmatched WAN keeps all rows (fallback)",
            "D/apn: no WAN address still answers rows",
        ],
    ),
    row(
        Arm::Temperature,
        "AT+QTEMP",
        "AT+QTEMP, else the modem thermal zone in /sys/class/thermal",
        Status::Ported,
        &[
            "D/qtemp: QTEMP falls back to the modem thermal zone",
            "D/qtemp: non-modem zones are ignored",
            "D/qtemp: modem QTEMP passthrough",
        ],
    ),
    // --- band / mode policy ----------------------------------------------
    row(
        Arm::PolicyBand,
        "AT+QNWPREFCFG=\"policy_band\" / bare AT+QNWPREFCFG",
        "AT+CSYSSEL=\"lte_band\"/\"nsa_nr5g_band\"/\"nr5g_band\"",
        Status::Ported,
        &[
            "D/bands: lte_band key",
            "D/bands: nsa_nr5g_band key",
            "D/bands: nr5g_band key",
            "D/qnwprefcfg: policy still carries the ENABLED set",
            "D/qnwprefcfg: policy is not the capability list",
        ],
    ),
    row(
        Arm::ModePref,
        "AT+QNWPREFCFG=\"mode_pref\"",
        "AT+CNMP? (2 -> AUTO, 38 -> LTE, 109 -> NR5G)",
        Status::Ported,
        &["D/bands: mode_pref AUTO from CNMP=2"],
    ),
    row(
        Arm::Nr5gDisableMode,
        "AT+QNWPREFCFG=\"nr5g_disable_mode\"",
        "AT+CSYSSEL=\"nr5g_disable\"",
        Status::Ported,
        &["D/bands: nr5g_disable_mode"],
    ),
    row(
        Arm::RoamPref,
        "AT+QNWPREFCFG=\"roam_pref\"",
        "(static +QNWPREFCFG: \"roam_pref\",1)",
        Status::Ported,
        &["D/bands: roam_pref"],
    ),
    row(
        Arm::RatAcqOrder,
        "AT+QNWPREFCFG=\"rat_acq_order\" / \"rat_order_pref\"",
        "AT+CNMP? -> LTE:NR5G:WCDMA order string",
        Status::Ported,
        &["D/bands: rat_acq_order answered"],
    ),
    row(
        Arm::UeCapability,
        "AT+QNWPREFCFG=\"ue_capability_band\"",
        "AT+CSYSSEL=? (capability, with the policy as fallback)",
        Status::Ported,
        &[
            "D/qnwprefcfg: capability carries the full LTE set",
            "D/qnwprefcfg: capability line still present",
            "D/qnwprefcfg: capability carries the full NSA NR set",
            "D/qnwprefcfg: capability carries the SA NR set",
            "D/bands: capability also carries lte_band / nsa_nr5g_band / nr5g_band",
        ],
    ),
    row(
        Arm::PrefWrite,
        "AT+QNWPREFCFG,\"<key>\",<value>",
        "AT+CNMP=2|38|109 for mode_pref / rat_acq_order; band keys go to PrefBandWrite; anything else ERROR",
        Status::Ported,
        &[
            "D/bands: rat_acq_order write is accepted",
            "D/bands: mode_pref write maps to CNMP",
            "D/bands: mode_pref write emits no phantom ERROR",
            "D/bands: rat_acq_order write emits no phantom ERROR",
            "D/bands: writing a read-only key refused",
        ],
    ),
    row(
        Arm::PrefBandKeyRead,
        "AT+QNWPREFCFG=\"lte_band\" / \"nsa_nr5g_band\" / \"nr5g_band\" / \"w_band\"",
        "AT+CSYSSEL=\"<key>\" (empty answer is ERROR, never an empty band list)",
        Status::Ported,
        &[
            "D/bands: single-key read answers the list",
            "D/bands: unknown read key answered, page cannot fail",
        ],
    ),
    row(
        Arm::PrefBandWrite,
        "AT+QNWPREFCFG=\"<band key>\",<colon list>",
        "AT+CSYSSEL=\"<key>\",<list>, after checking every band against AT+CSYSSEL=?",
        Status::Pending(
            "band write is not ported: the arm answers ERROR. It must validate \
             every band against AT+CSYSSEL=? and then issue AT+CSYSSEL=<key>,<list>; \
             an unsupported band can leave the modem on NO SERVICE.",
        ),
        &[
            "D/bands: <key> band write accepted",
            "D/bands: <key> write reaches the modem as CSYSSEL",
            "D/bands: band write emits no phantom ERROR",
            "D/bands: bitmask band value refused (encoding differs)",
            "D/bands: empty band list refused",
            "D/bands: empty band element refused",
            "D/bands: unsupported band refused",
            "D/bands: refusal names the band",
        ],
    ),
    row(
        Arm::PrefUnknownRead,
        "AT+QNWPREFCFG=\"<unmodelled key>\"",
        "(empty value: +QNWPREFCFG: \"<key>\",)",
        Status::Ported,
        &["D/bands: unknown read key answered, page cannot fail"],
    ),
    // --- SIM --------------------------------------------------------------
    row(
        Arm::SimDetect,
        "AT+QSIMDET? / AT+QSIMCFG*",
        "(static +QSIMDET: 0,1)",
        Status::Ported,
        &["D/identity: SIM detect answered"],
    ),
    row(
        Arm::UimSlot,
        "AT+QUIMSLOT?",
        "(static +QUIMSLOT: 1: this device has one slot)",
        Status::Ported,
        &["D/identity: single SIM slot"],
    ),
    row(
        Arm::SimStatus,
        "AT+QSIMSTAT?",
        "(static +QSIMSTAT: 1,1: no hot-swap status is exposed)",
        Status::Ported,
        &["D/identity: SIM inserted"],
    ),
    // --- identity write ---------------------------------------------------
    row(
        Arm::ImeiRead,
        "AT+EGMR=0,7",
        "AT+CGSN",
        Status::Ported,
        &["P/safety: IMEI read maps to AT+CGSN"],
    ),
    row(
        Arm::ImeiWrite,
        "AT+EGMR=1,7,\"<imei>\"",
        "AT+SIMEI=<15 digits> (short, long, non-digit and placeholder values refused before the modem)",
        Status::Ported,
        &[
            "P/safety: IMEI write answers OK",
            "P/safety: IMEI write became AT+SIMEI=<15 digits>",
            "P/safety: IMEI write refuses [short/long/non-digit/empty/000...]",
            "P/safety: ... and never reaches the modem",
        ],
    ),
    row(
        Arm::EmgrRefused,
        "AT+EGMR=1,<other record>",
        "(refused: ERROR)",
        Status::Ported,
        &["P/safety: AT+EGMR=1,4 is refused"],
    ),
    // --- per-antenna ------------------------------------------------------
    row(
        Arm::AntennaRsrp,
        "AT+QRSRP",
        "AT+CRSRP? (four chains per RAT, value-first Quectel order)",
        Status::Ported,
        &[
            "D/identity: QRSRP LTE line comes from AT+CRSRP?",
            "D/identity: QRSRP NR5G line is carried too",
            "D/identity: QRSRP issues exactly one modem query",
            "D/identity: QRSRP without per-chain support answers ERROR",
            "P/cache: one CPSI call serves QENG + all three antenna queries",
        ],
    ),
    row(
        Arm::AntennaRsrq,
        "AT+QRSRQ",
        "(four -32768 sentinels: this modem has no per-chain RSRQ)",
        Status::Ported,
        &[
            "D/identity: QRSRQ reports four unavailable ports",
            "D/identity: QRSRQ does not fake a Main reading",
        ],
    ),
    row(
        Arm::AntennaSinr,
        "AT+QSINR",
        "AT+CSINR?",
        Status::Ported,
        &[
            "D/identity: QSINR LTE line comes from AT+CSINR?",
            "D/identity: QSINR NR5G line is carried too",
        ],
    ),
    // --- QNWCFG (does not exist on this modem) ----------------------------
    row(
        Arm::LteTimeAdvance,
        "AT+QNWCFG=\"lte_time_advance\"",
        "qmicli --nas-get-cell-location-info (us -> TA index, x1.92)",
        Status::Pending(
            "needs libqmi at a known path and the us->index conversion checked \
             against a live TA on the device; the shell version also bounds itself \
             with an external `timeout`, which this crate would have to replace",
        ),
        &["(no assertion in either suite)"],
    ),
    row(
        Arm::NrTimeAdvance,
        "AT+QNWCFG=\"nr5g_time_advance\"",
        "(bare OK: no NR timing advance source on this box)",
        Status::Ported,
        &["(no assertion in either suite)"],
    ),
    row(
        Arm::LteMimo,
        "AT+QNWCFG=\"lte_mimo_layers\"",
        "vendor devinfo store, key lte_rank (UL emitted as 1 layer: a documented inference, not a reading)",
        Status::Ported,
        &["D/identity: QNWCFG unsupported -> OK"],
    ),
    row(
        Arm::NrMimo,
        "AT+QNWCFG=\"nr5g_mimo_layers\"",
        "vendor devinfo store, key nr_rank",
        Status::Ported,
        &["D/identity: QNWCFG unsupported -> OK"],
    ),
    row(
        Arm::UnsupportedFamily,
        "AT+QNWCFG* / AT+QGETCAPABILITY* / AT+QMAP* / AT+QNWINFO* / AT+QCSQ*",
        "(bare OK: the feature does not exist on this firmware)",
        Status::Ported,
        &["D/identity: QNWCFG unsupported -> OK"],
    ),
    // --- cell lock --------------------------------------------------------
    row(
        Arm::CellLockStatus,
        "AT+QNWLOCK=\"common/4g\"",
        "AT+CCELLCFG? -> +QNWLOCK: \"common/4g\",<0|1,earfcn,pci>",
        Status::Pending(
            "a write path that changes radio state, with ZERO assertions in either \
             suite — porting it without a test would be unverifiable by the \
             checklist",
        ),
        &["(no assertion in either suite)"],
    ),
    row(
        Arm::CellLockClear,
        "AT+QNWLOCK=\"common/4g\",0",
        "AT+CCELLCFG=0",
        Status::Pending("same as cell-lock status: no suite coverage"),
        &["(no assertion in either suite)"],
    ),
    row(
        Arm::CellLockWrite,
        "AT+QNWLOCK=\"common/4g\",1,<earfcn>,<pci>",
        "AT+CCELLCFG=1,<pci>,<earfcn> (argument order reversed, bounded)",
        Status::Pending("same as cell-lock status: no suite coverage"),
        &["(no assertion in either suite)"],
    ),
    row(
        Arm::CellLockMultiRefused,
        "AT+QNWLOCK=\"common/4g\",2-9...",
        "(refused: ERROR, one LTE cell only)",
        Status::Pending(
            "trivial to port, but it is the error half of a write path that has no \
             tests; it ships with the rest of the cell-lock port or not at all",
        ),
        &["(no assertion in either suite)"],
    ),
    row(
        Arm::CellLockOtherRefused,
        "AT+QNWLOCK* (anything else)",
        "(refused: ERROR)",
        Status::Pending("trivial; held back with the rest of the cell-lock port"),
        &["(no assertion in either suite)"],
    ),
    // --- fallthrough ------------------------------------------------------
    row(
        Arm::Passthrough,
        "anything not translated",
        "the same command, subject to the allowlist",
        Status::Ported,
        &[
            "D/transport: blank modem reply becomes ERROR",
            "D/transport: modem ERROR passes through",
            "D/transport: atcmd_receive echo is stripped",
            "D/transport: passthrough returns payload",
            "D/transport: shim always exits 0",
            "P/safety: unverified [...] is refused without contacting the daemon",
            "P/safety: unrelated commands still reach the modem",
            "P/compound: compound replies keep their order",
        ],
    ),
];

pub fn counts() -> (usize, usize) {
    let ported = INVENTORY
        .iter()
        .filter(|r| r.status == Status::Ported)
        .count();
    (ported, INVENTORY.len() - ported)
}

/// Markdown for `qmanager_x16 --inventory`, so the table cannot drift from the
/// dispatcher.
pub fn markdown() -> String {
    let (ported, pending) = counts();
    let mut out = String::new();
    out.push_str(&format!(
        "<!-- generated by `qmanager_x16 --inventory`; do not edit by hand -->\n\n\
         {} arms, {} ported, {} pending.\n\n\
         | arm | QManager sends (Quectel) | native command emitted | status | tests it must satisfy |\n\
         |---|---|---|---|---|\n",
        INVENTORY.len(),
        ported,
        pending
    ));
    for row in INVENTORY {
        let status = match row.status {
            Status::Ported => "ported".to_string(),
            Status::Pending(reason) => format!("**pending** — {}", reason.replace('|', "/")),
        };
        let checklist = row
            .checklist
            .iter()
            .map(|c| format!("`{}`", c))
            .collect::<Vec<_>>()
            .join("<br>");
        out.push_str(&format!(
            "| `{:?}` | `{}` | `{}` | {} | {} |\n",
            row.arm,
            row.quectel.replace('|', "/"),
            row.native.replace('|', "/"),
            status,
            checklist
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventory_covers_every_arm_exactly_once() {
        let all = [
            Arm::CmgsRefused,
            Arm::NeighbourCell,
            Arm::ServingCell,
            Arm::CellLockStatus,
            Arm::CellLockClear,
            Arm::CellLockWrite,
            Arm::CellLockMultiRefused,
            Arm::CellLockOtherRefused,
            Arm::CarrierAggToggle,
            Arm::CarrierAggInfo,
            Arm::Iccid,
            Arm::Version,
            Arm::ContrDp,
            Arm::Temperature,
            Arm::PolicyBand,
            Arm::ModePref,
            Arm::Nr5gDisableMode,
            Arm::RoamPref,
            Arm::RatAcqOrder,
            Arm::UeCapability,
            Arm::PrefWrite,
            Arm::PrefBandKeyRead,
            Arm::PrefBandWrite,
            Arm::PrefUnknownRead,
            Arm::SimDetect,
            Arm::UimSlot,
            Arm::ImeiRead,
            Arm::ImeiWrite,
            Arm::EmgrRefused,
            Arm::SimStatus,
            Arm::AntennaRsrp,
            Arm::AntennaRsrq,
            Arm::AntennaSinr,
            Arm::LteTimeAdvance,
            Arm::NrTimeAdvance,
            Arm::LteMimo,
            Arm::NrMimo,
            Arm::UnsupportedFamily,
            Arm::Passthrough,
        ];
        for arm in all {
            let hits = INVENTORY.iter().filter(|r| r.arm == arm).count();
            assert_eq!(hits, 1, "{:?} appears {} times in the inventory", arm, hits);
        }
        assert_eq!(INVENTORY.len(), all.len(), "an inventory row has no arm");
    }

    #[test]
    fn every_row_names_the_tests_that_pin_it() {
        for row in INVENTORY {
            assert!(
                !row.checklist.is_empty(),
                "{:?} has no checklist entry",
                row.arm
            );
        }
    }

    #[test]
    fn markdown_lists_one_row_per_arm() {
        let md = markdown();
        let rows = md.lines().filter(|l| l.starts_with("| `")).count();
        assert_eq!(rows, INVENTORY.len());
    }
}
