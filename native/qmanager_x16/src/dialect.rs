//! The dialect layer: QManager's Quectel vocabulary on the SIMCom command set.
//!
//! Port of `zlt-x16/deploy-x16/atcli_smd11`. The contract is the shell shim's
//! and is not negotiable, because ~87 CGIs and `parse_at.sh` read the answers:
//!
//! * one AT command in, **raw response text on stdout**;
//! * **always exit 0** — `qcmd` classifies on `OK`/`ERROR` in the text;
//! * a `;`-compound chain is split and each part answered in order;
//! * a bare `+X` continuation token means `AT+X`;
//! * field POSITIONS are the interface (`parse_at.sh` indexes by position), so
//!   a translation that is merely close is a bug.
//!
//! Arms marked `Status::Pending` in `inventory.rs` answer `ERROR` and are logged;
//! they never fabricate a success. That is the difference between "this port is
//! incomplete" and "the UI shows a number the radio never reported".
//!
//! The `At` trait is the seam: the arms are pure functions of the modem's text,
//! so they are tested in-process against the captured fixtures with no device
//! and no child process, and the same code runs against `/bin/atcmd` in
//! production.

use crate::inventory::Arm;
use crate::text;
use std::path::PathBuf;

/// One modem exchange, by the shell `at_raw()` contract (text, never an error).
pub trait At {
    fn raw(&mut self, cmd: &str) -> String;
}

/// Paths and limits the arms read, with the shell's environment names so both
/// implementations can be driven by the same harness.
pub struct Paths {
    pub cpsi_cache: PathBuf,
    pub cpsi_ttl: u64,
    pub thermal_dir: PathBuf,
    /// The vendor's own module-data store; the only MIMO rank source on this box.
    pub devinfo: PathBuf,
}

impl Paths {
    pub fn from_env() -> Paths {
        let cpsi_cache = std::env::var("QM_CPSI_CACHE")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "/tmp/qmanager_cpsi.cache".to_string());
        let cpsi_ttl = std::env::var("QM_CPSI_TTL")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(1);
        let thermal_dir = std::env::var("QM_THERMAL_DIR")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "/sys/class/thermal".to_string());
        let devinfo = std::env::var("QM_PHY_DEVINFO_FILE")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "/tmp/.devinfo_module_data".to_string());
        Paths {
            cpsi_cache: PathBuf::from(cpsi_cache),
            cpsi_ttl,
            thermal_dir: PathBuf::from(thermal_dir),
            devinfo: PathBuf::from(devinfo),
        }
    }
}

/// Runs a whole command (possibly a `;` chain) and returns the text to print.
pub fn run(at: &mut dyn At, paths: &Paths, command: &str) -> String {
    // The shell exits silently on an empty command rather than answering ERROR.
    if command.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    let mut done = false;
    for mut part in split_chain(command) {
        if part.starts_with('+') {
            // A compound continuation arrives as a bare token; the shell's
            // `case "$_cmd" in +*) _cmd="AT$_cmd"` prepends, it does not
            // replace the '+'.
            part = format!("AT{}", part);
        }
        if part.is_empty() {
            continue;
        }
        let mut interp = Interp { at, paths };
        out.push_str(&interp.run_one(&part));
        done = true;
    }
    if !done {
        return "ERROR\n".to_string();
    }
    out
}

/// `;` split, empty parts dropped. Whitespace is NOT trimmed: the shell does not
/// trim either, and `AT+CSQ; AT+CPIN?` fails its allowlist for the second token.
fn split_chain(command: &str) -> Vec<String> {
    command
        .split(';')
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .collect()
}

/// Which arm a single (already de-chained) command belongs to.
///
/// The ORDER is a port of the shell's `case` order and is load-bearing: see the
/// comment in `inventory.rs`.
pub fn arm_for(cmd: &str) -> Arm {
    if cmd.starts_with("AT+CMGS") || cmd.starts_with("AT+CMGW") {
        return Arm::CmgsRefused;
    }
    if cmd == "AT+QENG=\"neighbourcell\"" {
        return Arm::NeighbourCell;
    }
    if cmd.starts_with("AT+QENG") {
        return Arm::ServingCell;
    }
    if cmd == "AT+QNWLOCK=\"common/4g\"" {
        return Arm::CellLockStatus;
    }
    if cmd == "AT+QNWLOCK=\"common/4g\",0" {
        return Arm::CellLockClear;
    }
    if cmd.starts_with("AT+QNWLOCK=\"common/4g\",1,") {
        return Arm::CellLockWrite;
    }
    if let Some(rest) = cmd.strip_prefix("AT+QNWLOCK=\"common/4g\",") {
        if matches!(rest.as_bytes().first(), Some(b'2'..=b'9')) {
            return Arm::CellLockMultiRefused;
        }
    }
    if cmd.starts_with("AT+QNWLOCK") {
        return Arm::CellLockOtherRefused;
    }
    if cmd == "AT+QCAINFO=0" || cmd == "AT+QCAINFO=1" {
        return Arm::CarrierAggToggle;
    }
    if cmd == "AT+QCAINFO" {
        return Arm::CarrierAggInfo;
    }
    if cmd == "AT+QCCID" {
        return Arm::Iccid;
    }
    if cmd == "AT+CVERSION" {
        return Arm::Version;
    }
    if cmd == "AT+CGCONTRDP" || cmd == "AT+CGCONTRDP=0" {
        return Arm::ContrDp;
    }
    if cmd == "AT+QTEMP" {
        return Arm::Temperature;
    }
    if cmd == "AT+QNWPREFCFG=\"policy_band\"" || cmd == "AT+QNWPREFCFG=" {
        return Arm::PolicyBand;
    }
    if matches!(
        cmd,
        "AT+QNWPREFCFG=\"lte_band\""
            | "AT+QNWPREFCFG=\"nsa_nr5g_band\""
            | "AT+QNWPREFCFG=\"nr5g_band\""
            | "AT+QNWPREFCFG=\"w_band\""
    ) {
        return Arm::PrefBandKeyRead;
    }
    if cmd == "AT+QNWPREFCFG=\"mode_pref\"" {
        return Arm::ModePref;
    }
    if cmd == "AT+QNWPREFCFG=\"nr5g_disable_mode\"" {
        return Arm::Nr5gDisableMode;
    }
    if cmd == "AT+QNWPREFCFG=\"roam_pref\"" {
        return Arm::RoamPref;
    }
    if cmd == "AT+QNWPREFCFG=\"rat_acq_order\"" || cmd == "AT+QNWPREFCFG=\"rat_order_pref\"" {
        return Arm::RatAcqOrder;
    }
    if cmd == "AT+QNWPREFCFG=\"ue_capability_band\"" {
        return Arm::UeCapability;
    }
    // Band-key WRITES must be classified before the generic PrefWrite fallback.
    //
    // PrefWrite answers OK for anything it does not specifically recognise, so
    // letting `AT+QNWPREFCFG="lte_band",1:3` fall through to it is a
    // FABRICATED SUCCESS: the write never reaches the modem and the UI would
    // believe a band lock had been applied. Band writes go to PrefBandWrite,
    // which is deliberately Pending and answers ERROR.
    //
    // Found 2026-10-27: Arm::PrefBandWrite was declared and inventoried as
    // `Ported` but was unreachable, because this function sent every comma form
    // to PrefWrite.
    if let Some(rest) = cmd.strip_prefix("AT+QNWPREFCFG=") {
        if rest.contains(',') {
            let key = rest.split(',').next().unwrap_or("").trim().trim_matches('"');
            if matches!(
                key,
                "lte_band" | "nsa_nr5g_band" | "nr5g_band" | "nrdc_nr5g_band" | "w_band"
            ) {
                return Arm::PrefBandWrite;
            }
        }
    }
    if cmd.starts_with("AT+QNWPREFCFG,") {
        return Arm::PrefWrite;
    }
    if let Some(rest) = cmd.strip_prefix("AT+QNWPREFCFG=") {
        return if rest.contains(',') {
            Arm::PrefWrite
        } else {
            Arm::PrefUnknownRead
        };
    }
    if cmd == "AT+QNWPREFCFG" {
        return Arm::PolicyBand;
    }
    if cmd.starts_with("AT+QSIMDET") || cmd.starts_with("AT+QSIMCFG") {
        return Arm::SimDetect;
    }
    if cmd == "AT+QUIMSLOT?" || cmd == "AT+QUIMSLOT" {
        return Arm::UimSlot;
    }
    if cmd == "AT+EGMR=0,7" {
        return Arm::ImeiRead;
    }
    if cmd.starts_with("AT+EGMR=1,7,\"") {
        return Arm::ImeiWrite;
    }
    if cmd.starts_with("AT+EGMR=1,") {
        return Arm::EmgrRefused;
    }
    if cmd == "AT+QSIMSTAT?" || cmd == "AT+QSIMSTAT" {
        return Arm::SimStatus;
    }
    if cmd == "AT+QRSRP" || cmd == "AT+QRSRP?" {
        return Arm::AntennaRsrp;
    }
    if cmd == "AT+QRSRQ" || cmd == "AT+QRSRQ?" {
        return Arm::AntennaRsrq;
    }
    if cmd == "AT+QSINR" || cmd == "AT+QSINR?" {
        return Arm::AntennaSinr;
    }
    if cmd.starts_with("AT+QNWCFG=\"lte_time_advance\"") {
        return Arm::LteTimeAdvance;
    }
    if cmd.starts_with("AT+QNWCFG=\"nr5g_time_advance\"") {
        return Arm::NrTimeAdvance;
    }
    if cmd.starts_with("AT+QNWCFG=\"lte_mimo_layers\"") {
        return Arm::LteMimo;
    }
    if cmd.starts_with("AT+QNWCFG=\"nr5g_mimo_layers\"") {
        return Arm::NrMimo;
    }
    if cmd.starts_with("AT+QNWCFG")
        || cmd.starts_with("AT+QGETCAPABILITY")
        || cmd.starts_with("AT+QMAP")
        || cmd.starts_with("AT+QNWINFO")
        || cmd.starts_with("AT+QCSQ")
    {
        return Arm::UnsupportedFamily;
    }
    Arm::Passthrough
}

struct Interp<'a> {
    at: &'a mut dyn At,
    paths: &'a Paths,
}

impl Interp<'_> {
    fn run_one(&mut self, cmd: &str) -> String {
        match arm_for(cmd) {
            Arm::CmgsRefused => error(),

            // NOT PORTED (found 2026-10-27 by the parity harness, which is also
            // what exposed this row as falsely `Ported`). The shell answers
            // AT+CSYSSEL="<key>",<list> only after checking every band against
            // AT+CSYSSEL=?; neither half is written here, and the dispatch did
            // not handle the arm at all -- this file did not compile.
            //
            // It answers ERROR on purpose. A fabricated success is worse than
            // an honest refusal here: an unsupported or malformed band list can
            // leave the modem on NO SERVICE, which is exactly the failure mode
            // docs/29 is chasing.
            Arm::PrefBandWrite => error(),

            Arm::NeighbourCell => passthrough(self.at, cmd),

            Arm::ServingCell => self.serving_cell(),

            Arm::CarrierAggToggle => "OK\n".to_string(),

            Arm::CarrierAggInfo => self.carrier_agg_info(),

            Arm::Iccid => {
                // The shell pipes through `sed`, which terminates the last line
                // with a newline; `at.raw` does not. Without this the payload
                // loses exactly one trailing newline, which parity caught.
                let raw = self.at.raw("AT+CICCID");
                format!("{}\n", replace_prefix(&raw, "+ICCID:", "+QCCID:"))
            }

            Arm::Version => self.version(),

            Arm::Temperature => self.temperature(),

            Arm::PolicyBand => self.policy_band(),

            Arm::ModePref => {
                let n = cnmp(self.at);
                let v = match n.as_str() {
                    "38" => "LTE",
                    "109" => "NR5G",
                    _ => "AUTO",
                };
                format!("+QNWPREFCFG: \"mode_pref\",{}\n\nOK\n", v)
            }

            Arm::Nr5gDisableMode => {
                let v = first_line_after(
                    &self.at.raw("AT+CSYSSEL=\"nr5g_disable\""),
                    "+CSYSSEL: \"nr5g_disable\",",
                    Strip::CrSpace,
                )
                .unwrap_or_default();
                let v = if v.is_empty() { "0".to_string() } else { v };
                format!("+QNWPREFCFG: \"nr5g_disable_mode\",{}\n\nOK\n", v)
            }

            Arm::RoamPref => "+QNWPREFCFG: \"roam_pref\",1\n\nOK\n".to_string(),

            Arm::RatAcqOrder => {
                let n = cnmp(self.at);
                let v = match n.as_str() {
                    "38" => "LTE",
                    "109" => "NR5G",
                    _ => "LTE:NR5G:WCDMA",
                };
                format!("+QNWPREFCFG: \"rat_acq_order\",{}\n\nOK\n", v)
            }

            Arm::UeCapability => self.ue_capability(),

            Arm::PrefBandKeyRead => {
                let key = strip_quotes(&cmd["AT+QNWPREFCFG=".len()..]);
                self.band_key_read(&key)
            }

            Arm::PrefWrite => self.pref_write(cmd),

            Arm::PrefUnknownRead => {
                let key = strip_quotes(&cmd["AT+QNWPREFCFG=".len()..]);
                format!("+QNWPREFCFG: \"{}\",\n\nOK\n", key)
            }

            Arm::SimDetect => "+QSIMDET: 0,1\n\nOK\n".to_string(),

            Arm::UimSlot => "+QUIMSLOT: 1\n\nOK\n".to_string(),

            Arm::SimStatus => "+QSIMSTAT: 1,1\n\nOK\n".to_string(),

            Arm::ImeiRead => self.at.raw("AT+CGSN") + "\n",

            Arm::ImeiWrite => {
                // The shell strips ONE trailing quote and then gates on shape.
                let value = &cmd["AT+EGMR=1,7,\"".len()..];
                let imei = value.strip_suffix('"').unwrap_or(value);
                match imei_shape_ok(imei) {
                    true => self.at.raw(&format!("AT+SIMEI={}", imei)) + "\n",
                    false => error(),
                }
            }

            Arm::EmgrRefused => error(),

            Arm::AntennaRsrp => self.antenna("QRSRP", "AT+CRSRP?", "CRSRP"),

            Arm::AntennaSinr => self.antenna("QSINR", "AT+CSINR?", "CSINR"),

            Arm::AntennaRsrq => {
                "+QRSRQ: -32768,-32768,-32768,-32768,LTE\n\nOK\n".to_string()
            }

            Arm::NrTimeAdvance => "OK\n".to_string(),

            Arm::LteMimo => self.mimo("lte_rank", "lte_mimo_layers"),

            Arm::NrMimo => self.mimo("nr_rank", "nr5g_mimo_layers"),

            Arm::UnsupportedFamily => "OK\n".to_string(),

            Arm::Passthrough => passthrough(self.at, cmd),

            // Pending arms answer ERROR, never a fabricated success.
            Arm::ContrDp
            | Arm::LteTimeAdvance
            | Arm::CellLockStatus
            | Arm::CellLockClear
            | Arm::CellLockWrite
            | Arm::CellLockMultiRefused
            | Arm::CellLockOtherRefused => {
                crate::qlog::warn(&format!(
                    "dialect arm {:?} not ported; answered ERROR for: {}",
                    arm_for(cmd),
                    cmd
                ));
                error()
            }
        }
    }

    // -- AT+QENG="servingcell" <- AT+CPSI? --------------------------------
    //
    // TWO layouts, chosen by what the modem reports:
    //
    // LTE-only — 17 fields, indexed WITH the "servingcell" prefix included;
    //   +CPSI field order is RAT,state,PLMN,TAC,CID,PCID,band,EARFCN,UL,DLL,
    //   RSRQ(tenths),RSRP(tenths),RSSI(tenths),SINR(whole). Verified against the
    //   vendor's own devinfo dump in the same second: reading f11 as RSSI and
    //   f13/100 as RSRQ produced -120 dBm and -6 dB where the radio was at -60
    //   and -12.
    //
    // EN-DC — three lines, because SIMCom returns the 5G leg as a SECOND +CPSI
    //   record and `parse_at.sh` only takes the EN-DC branch when it sees both.
    //   The LTE row must NOT carry the servingcell prefix (the parser selects it
    //   with `index(...LTE) && !index(...servingcell)`).
    fn serving_cell(&mut self) -> String {
        let cpsi = self.cpsi();
        let mut lte: Option<&str> = None;
        let mut nr: Option<&str> = None;
        for line in cpsi.lines() {
            if line.starts_with("+CPSI: LTE") {
                lte = Some(line); // last wins, like the shell
            } else if line.starts_with("+CPSI: NR5G_NSA") {
                nr = Some(line);
            }
        }
        let lte = match lte {
            Some(l) => rm_cr(l),
            None => return "+QENG: \"servingcell\",\"SEARCH\"\n\nOK\n".to_string(),
        };
        let f = fields(&lte["+CPSI: ".len()..]);

        let qstat = match f.get(1).copied().unwrap_or("") {
            "Online" | "online" | "Registered" | "registered" | "Full service" => "CONNECT",
            s if s.contains("earch") => "SEARCH",
            s if s.contains("imited") || s.contains("enied") => "LIMSRV",
            _ => "NOCONN",
        };

        let band = text::band_number(f.get(6).copied().unwrap_or(""));
        let tdd = if text::is_tdd(&band) { "TDD" } else { "FDD" };

        let (mcc, mnc) = text::plmn_split(f.get(2).copied().unwrap_or(""));
        let cell_hex = text::dec_to_hex(f.get(4).copied().unwrap_or("")).unwrap_or_default();
        let tac_hex = text::tac_hex(f.get(3).copied().unwrap_or(""));

        let rsrp = text::tenths(f.get(11).copied().unwrap_or(""));
        let rsrq = text::tenths(f.get(10).copied().unwrap_or(""));
        let rssi = text::tenths(f.get(12).copied().unwrap_or(""));
        // The LTE branch passes SINR through unvalidated, exactly like the shim;
        // only the NR branch checks it.
        let sinr = f.get(13).copied().unwrap_or("").to_string();
        let sinr = if sinr.is_empty() {
            "-".to_string()
        } else {
            sinr
        };

        let pcid = text::or_zero(f.get(5).copied().unwrap_or(""));
        let earfcn = text::or_zero(f.get(7).copied().unwrap_or(""));
        let ulbw = text::or_zero(f.get(8).copied().unwrap_or(""));
        let dlbw = text::or_zero(f.get(9).copied().unwrap_or(""));

        // Shared by both layouts: duplex, MCC, MNC, then the LTE metrics. The
        // two layouts differ only in the leading token and the NR tail.
        let tail = |cell_hex: &str, pcid: &str, earfcn: &str, band: &str| {
            vec![
                format!("\"{}\"", tdd),
                or_num(&mcc),
                or_num(&mnc),
                if cell_hex.is_empty() {
                    "0".to_string()
                } else {
                    cell_hex.to_string()
                },
                pcid.to_string(),
                earfcn.to_string(),
                band.to_string(),
                ulbw.clone(),
                dlbw.clone(),
                tac_hex.clone(),
                text::or_dash(rsrp),
                text::or_dash(rsrq),
                text::or_dash(rssi),
                sinr.clone(),
            ]
        };

        match nr {
            // ---- LTE-only: one line, servingcell prefix included ----------
            //
            // The parser's LTE-only branch indexes by position WITH the
            // "servingcell" prefix included, so this shape must not change.
            None => {
                let mut f = vec![
                    "\"servingcell\"".to_string(),
                    format!("\"{}\"", qstat),
                    "\"LTE\"".to_string(),
                ];
                f.extend(tail(&cell_hex, &pcid, &earfcn, &band));
                format!("+QENG: {}\n\nOK\n", f.join(","))
            }
            // ---- EN-DC: servingcell + LTE + NR5G-NSA ---------------------
            Some(nr) => {
                let nr = rm_cr(nr);
                let nf = fields(nr["+CPSI: NR5G_NSA".len()..].trim_start_matches(','));
                let nband = text::band_number(nf.get(1).copied().unwrap_or(""));
                let nr_rsrp = text::tenths(nf.get(3).copied().unwrap_or(""));
                let nr_rsrq = text::tenths_rounded(nf.get(4).copied().unwrap_or(""));
                // NR SINR is WHOLE dB on this unit: two same-second samples read
                // CPSI 21/22 against +CSINR 21/19 then 22/20. Do not divide.
                let nr_sinr = match nf.get(5).copied().unwrap_or("") {
                    s if s.is_empty() || !is_int(s) => "-".to_string(),
                    s => s.to_string(),
                };
                let npcid = text::or_dash(nf.get(0).and_then(|v| v.parse::<i32>().ok()));
                let narfcn = text::or_dash(nf.get(2).and_then(|v| v.parse::<i32>().ok()));

                let mut out = String::new();
                out.push_str(&format!("+QENG: \"servingcell\",\"{}\"\n", qstat));

                // The LTE anchor row WITHOUT the servingcell prefix: the parser
                // selects it with `index(..,"LTE") && !index(..,"servingcell")`,
                // so a line keeping the prefix is invisible to it.
                let mut anchor = vec!["\"LTE\"".to_string()];
                anchor.extend(tail(&cell_hex, &pcid, &earfcn, &band));
                out.push_str(&format!("+QENG: {}\n", anchor.join(",")));

                let nr_row = vec![
                    "\"NR5G-NSA\"".to_string(),
                    or_num(&mcc),
                    or_num(&mnc),
                    npcid,
                    text::or_dash(nr_rsrp),
                    nr_sinr,
                    text::or_dash(nr_rsrq),
                    narfcn,
                    nband,
                ];
                out.push_str(&format!("+QENG: {}\n\nOK\n", nr_row.join(",")));
                out
            }
        }
    }

    // -- AT+QCAINFO <- AT+CCAINFO? ---------------------------------------
    //
    // The SIMCom rows do not share an offset: PCC is
    //   label,band,earfcn,bw,pci,rsrp,rsrq,rssi,sinr(tenths)
    // and SCC carries one extra field after PCI:
    //   label,band,earfcn,bw,pci,<u>,rsrp,rsrq,rssi,sinr(tenths)
    // so the metric columns are read from explicit indexes, never guessed.
    fn carrier_agg_info(&mut self) -> String {
        let raw = self.at.raw("AT+CCAINFO?");
        let mut out = String::new();
        let mut any = false;
        for line in raw.lines() {
            if !line.starts_with("+CCAINFO:") {
                continue;
            }
            any = true;
            let body = line["+CCAINFO: ".len()..].replace(['\r', '"'], "");
            let f = fields(&body);
            let label = f.first().copied().unwrap_or("");
            let pcc = label == "PCC";
            let (rsrp_i, rsrq_i, rssi_i, sinr_i) = if pcc { (5, 6, 7, 8) } else { (6, 7, 8, 9) };

            let earfcn = text::or_zero(f.get(2).copied().unwrap_or(""));
            let bw = text::or_zero(f.get(3).copied().unwrap_or(""));
            let band_raw = f.get(1).copied().unwrap_or("");
            let band = {
                let b = text::band_number(band_raw);
                if b == "0" {
                    "0".to_string()
                } else {
                    b
                }
            };
            let pci = text::or_zero(f.get(4).copied().unwrap_or(""));

            let mut rsrp = f.get(rsrp_i).map(|v| v.to_string());
            let mut rsrq = f.get(rsrq_i).map(|v| v.to_string());
            let mut rssi = f.get(rssi_i).map(|v| v.to_string());
            // A value that is not a number is a missing reading, not a metric.
            for v in [&mut rsrp, &mut rsrq, &mut rssi] {
                if v.as_deref().is_some_and(|s| !is_int(s)) {
                    *v = None;
                }
            }
            let mut sinr = match f.get(sinr_i).and_then(|v| v.parse::<i32>().ok()) {
                Some(v) => Some(v / 10),
                None => None,
            };
            // SINR sanity: -20..40 dB. Outside that it is a sentinel.
            if sinr.is_some_and(|s| !(-20..=40).contains(&s)) {
                sinr = None;
            }
            // A wrong pick is worse than a blank one: the UI plots it as
            // measured. The RSSI floor is -20, chosen from the physics (RSSI is
            // the whole band, ~20-30 dB above RSRP), and the decisive rule is
            // that RSSI must never be BELOW RSRP.
            if let (Some(rp), Some(rq), Some(rs)) = (
                rsrp.as_deref().and_then(|v| v.parse::<i32>().ok()),
                rsrq.as_deref().and_then(|v| v.parse::<i32>().ok()),
                rssi.as_deref().and_then(|v| v.parse::<i32>().ok()),
            ) {
                if !(-140..=-50).contains(&rp)
                    || !(-25..=-3).contains(&rq)
                    || !(-120..=-20).contains(&rs)
                    || rp > rs
                {
                    rsrp = None;
                    rsrq = None;
                    rssi = None;
                }
            }
            out.push_str(&format!(
                "+QCAINFO: \"{}\",{},{},LTE BAND {},0,{},{},{},{},{}\n",
                if label.is_empty() { "SCC" } else { label },
                earfcn,
                bw,
                band,
                pci,
                dash(rsrp),
                dash(rsrq),
                dash(rssi),
                sinr.map(|v| v.to_string()).unwrap_or_else(|| "-".to_string())
            ));
        }
        if !any {
            out.push_str("+QCAINFO: \"PCC\"\n");
        }
        out.push_str("\nOK\n");
        out
    }

    // -- AT+CVERSION <- ATI + AT+CGMR ------------------------------------
    fn version(&mut self) -> String {
        let ati = self.at.raw("ATI");
        let rev = first_line_after(&ati, "Revision:", Strip::CrTrimLead).unwrap_or_default();
        let model = first_line_after(&ati, "Model:", Strip::CrTrimLead)
            .unwrap_or_else(|| "SIMCOM_SIM8260E".to_string());
        let man = first_line_after(&ati, "Manufacturer:", Strip::CrTrimLead)
            .unwrap_or_else(|| "SIMCOM INCORPORATED".to_string());
        let rev = if rev.is_empty() {
            let cgmr = self.at.raw("AT+CGMR");
            let r = first_line_after(&cgmr, "+CGMR:", Strip::CrTrimLead).unwrap_or_default();
            if r.is_empty() {
                "unknown".to_string()
            } else {
                r
            }
        } else {
            rev
        };
        format!(
            "+CVERSION: {}\n{}\nRevision: {}\nVERSION: {}\nAuthors: {}\n\nOK\n",
            rev, model, rev, rev, man
        )
    }

    // -- AT+QTEMP <- AT+QTEMP, else the modem thermal zone ----------------
    fn temperature(&mut self) -> String {
        let t = self.at.raw("AT+QTEMP");
        if !t.contains("ERROR") {
            return format!("{}\n", t);
        }
        // First modem-ish zone that carries a plausible reading wins; a zone
        // reading -40 degC or 0 is a disabled sensor, not a temperature.
        let mut entries: Vec<PathBuf> = match std::fs::read_dir(&self.paths.thermal_dir) {
            Ok(rd) => rd
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("thermal_zone"))
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        entries.sort();
        for zone in entries {
            let ty = match std::fs::read_to_string(zone.join("type")) {
                Ok(v) => rm_cr(v.trim_end_matches('\n')),
                Err(_) => continue,
            };
            let ty = ty.trim();
            if !(ty.starts_with("modem") || ty.contains("mdm") || ty.contains("modem")) {
                continue;
            }
            let raw = match std::fs::read_to_string(zone.join("temp")) {
                Ok(v) => rm_cr(v.trim_end_matches('\n')),
                Err(_) => continue,
            };
            let millideg = match raw.trim().parse::<i64>() {
                Ok(v) => v,
                Err(_) => continue,
            };
            let celsius = (millideg + 500) / 1000;
            if celsius <= -40 || celsius == 0 {
                continue;
            }
            return format!("+QTEMP: \"modem-0\",{}\n\nOK\n", celsius);
        }
        error()
    }

    // -- AT+QNWPREFCFG="policy_band" <- three AT+CSYSSEL reads ------------
    fn policy_band(&mut self) -> String {
        let lte = first_line_after(
            &self.at.raw("AT+CSYSSEL=\"lte_band\""),
            "+CSYSSEL: \"lte_band\",",
            Strip::Cr,
        )
        .unwrap_or_default();
        let nsa = first_line_after(
            &self.at.raw("AT+CSYSSEL=\"nsa_nr5g_band\""),
            "+CSYSSEL: \"nsa_nr5g_band\",",
            Strip::Cr,
        )
        .unwrap_or_default();
        let sa = first_line_after(
            &self.at.raw("AT+CSYSSEL=\"nr5g_band\""),
            "+CSYSSEL: \"nr5g_band\",",
            Strip::Cr,
        )
        .unwrap_or_default();
        format!(
            "+QNWPREFCFG: \"lte_band\",{}\n+QNWPREFCFG: \"nsa_nr5g_band\",{}\n+QNWPREFCFG: \"nr5g_band\",{}\n\nOK\n",
            lte, nsa, sa
        )
    }

    // -- AT+QNWPREFCFG="<band key>" <- AT+CSYSSEL="<band key>" -----------
    //
    // The single-key read. It used to fall into the "unmodelled key" branch and
    // answer an EMPTY value, which reads as "no bands selected" — the one wrong
    // answer worse than an error, because it renders every box in the picker
    // unticked. The band keys are the same vocabulary on both sides, so this is
    // a rename.
    fn band_key_read(&mut self, key: &str) -> String {
        let prefix = format!("+CSYSSEL: \"{}\",", key);
        let value = first_line_after(&self.at.raw(&format!("AT+CSYSSEL=\"{}\"", key)), &prefix, Strip::Cr)
            .unwrap_or_default();
        if value.is_empty() {
            return error();
        }
        format!("+QNWPREFCFG: \"{}\",{}\n\nOK\n", key, value)
    }

    // -- AT+QNWPREFCFG="<band key>",<list> -> AT+CSYSSEL="<band key>",<list> --
    //
    // Every band is checked against the modem's own capability answer first. An
    // unsupported band is normally answered OK and then silently never attaches:
    // a green "Locked" toast with no service is worse than a red error, and this
    // is the page reached by someone already trying to fix a bad connection.
    fn band_selection(&mut self, key: &str, value: &str) -> String {
        // shape: colon-delimited positive integers, no empty element
        if value.is_empty()
            || value.starts_with(':')
            || value.ends_with(':')
            || value.contains("::")
            || !value.chars().all(|c| c.is_ascii_digit() || c == ':')
        {
            return error();
        }
        let cap = first_line_after(
            &self.at.raw("AT+CSYSSEL=?"),
            &format!("+CSYSSEL: \"{}\",", key),
            Strip::CrSpace,
        )
        .unwrap_or_default();
        if !cap.is_empty() {
            let needle = format!(":{}:", cap);
            for band in value.split(':') {
                if !needle.contains(&format!(":{}:", band)) {
                    return format!(
                        "ERROR\nband {} is not supported by this modem ({})\n",
                        band, key
                    );
                }
            }
        }
        format!("{}\n", self.at.raw(&format!("AT+CSYSSEL=\"{}\",{}", key, value)))
    }

    // -- AT+QNWPREFCFG="ue_capability_band" <- AT+CSYSSEL=? ---------------
    //
    // CAPABILITY, not policy. The shim used to answer the capability line and
    // then delegate to policy_band, so every consumer that parses by key read
    // the *enabled* set: the band picker offered only the bands already on
    // (LTE 1:3:5:41 instead of the modem's 19).
    fn ue_capability(&mut self) -> String {
        let cap = self.at.raw("AT+CSYSSEL=?");
        let lte = first_line_after(&cap, "+CSYSSEL: \"lte_band\",", Strip::CrSpace)
            .unwrap_or_default();
        if lte.is_empty() {
            // No capability answer at all: fall back to the policy rather than
            // invent a band list the modem would refuse.
            return self.policy_band();
        }
        let nsa = first_line_after(&cap, "+CSYSSEL: \"nsa_nr5g_band\",", Strip::CrSpace)
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| lte.clone());
        // "nr5g_band" also appears inside "nsa_nr5g_band"; the prefix above
        // starts with '+', so nsa_/nrdc_ lines cannot match it.
        let sa = first_line_after(&cap, "+CSYSSEL: \"nr5g_band\",", Strip::CrSpace)
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| lte.clone());
        format!(
            "+QNWPREFCFG: \"ue_capability_band\",{}\n+QNWPREFCFG: \"lte_band\",{}\n+QNWPREFCFG: \"nsa_nr5g_band\",{}\n+QNWPREFCFG: \"nr5g_band\",{}\n\nOK\n",
            lte, lte, nsa, sa
        )
    }

    // -- AT+QNWPREFCFG="<key>",<value> -----------------------------------
    //
    // Only the network-mode family has a native equivalent. Everything else is
    // REFUSED rather than silently accepted, so the UI reports a real failure.
    fn pref_write(&mut self, cmd: &str) -> String {
        let rest = &cmd["AT+QNWPREFCFG=".len()..];
        let (key, value) = match rest.split_once(',') {
            Some((k, v)) => (strip_quotes(k), v.to_string()),
            None => (strip_quotes(rest), String::new()),
        };
        match key.as_str() {
            // THE BAND LOCK WRITE. Quectel's band list is a hex BITMASK and
            // SIMCom's is the colon list the read returns; QManager
            // (bands/lock.sh) sends the colon list, so the value translates
            // verbatim. A bare bitmask is REFUSED, never reinterpreted: the same
            // digits mean a different set of bands on each side.
            "lte_band" | "nsa_nr5g_band" | "nr5g_band" | "nrdc_nr5g_band" | "w_band" => {
                // Raw value: a quoted list is refused by the shape check below,
                // exactly as the shell refuses it.
                self.band_selection(&key, &value)
            }
            "rat_acq_order" | "rat_order_pref" => {
                let first = strip_quotes(&value)
                    .split(':')
                    .next()
                    .unwrap_or("")
                    .to_string();
                match first.as_str() {
                    "LTE" | "WCDMA" | "GSM" => self.at.raw("AT+CNMP=38") + "\n",
                    "NR5G" | "NR" => self.at.raw("AT+CNMP=109") + "\n",
                    "AUTO" | "auto" => self.at.raw("AT+CNMP=2") + "\n",
                    _ => error(),
                }
            }
            "mode_pref" => match strip_quotes(&value).as_str() {
                "AUTO" | "auto" => self.at.raw("AT+CNMP=2") + "\n",
                "LTE" | "lte" => self.at.raw("AT+CNMP=38") + "\n",
                "NR5G" | "nr5g" => self.at.raw("AT+CNMP=109") + "\n",
                "NR5G:LTE" | "NR5G:LTE:" | "nr5g:lte" => self.at.raw("AT+CNMP=2") + "\n",
                _ => error(),
            },
            _ => error(),
        }
    }

    // -- AT+QRSRP / AT+QSINR <- AT+CRSRP? / AT+CSINR? ---------------------
    //
    // This firmware reports per-chain values, four per RAT, already in whole
    // dBm/dB. Quectel's shape is values first, RAT token last.
    fn antenna(&mut self, kind: &str, native: &str, tag: &str) -> String {
        let raw = self.at.raw(native);
        let prefix = format!("+{}: ", tag);
        let mut out = String::new();
        for line in raw.lines() {
            let line = rm_cr(line);
            let body = match line.strip_prefix(&prefix) {
                Some(b) => b,
                None => continue,
            };
            let (rat, vals) = match body.split_once(',') {
                Some(pair) => pair,
                None => continue,
            };
            if rat != "LTE" && rat != "NR5G" {
                continue;
            }
            out.push_str(&format!("+{}: {},{}\n", kind, vals, rat));
        }
        if out.is_empty() {
            // Never invent four values when the modem refused the query.
            return error();
        }
        format!("{}\nOK\n", out)
    }

    // -- AT+QNWCFG="*_mimo_layers" <- the vendor devinfo store --------
    //
    // SIMCom has no QNWCFG at all. The rank the modem reports (`lte_rank` /
    // `nr_rank`) is the DL layer count, and it is the only source the "Active
    // MIMO" tile can be filled from. UL is emitted as 1 layer: this UE does not
    // report UL layers and single-layer UL is the norm without SRS-based UL
    // MIMO. That is an inference, so do not "improve" it to equal the DL rank —
    // 2x2 UL is a claim the radio never made.
    //
    // A missing or malformed store answers a bare OK, which is what the shell
    // does: the tile then says "Unavailable" instead of a fabricated rank.
    fn mimo(&mut self, key: &str, name: &str) -> String {
        let text_value = match std::fs::read_to_string(&self.paths.devinfo) {
            Ok(v) => v,
            Err(_) => return "OK\n".to_string(),
        };
        let prefix = format!("{}:", key);
        let rank = text_value
            .lines()
            .find_map(|l| l.strip_prefix(&prefix))
            .map(|v| v.chars().filter(|c| *c != ' ' && *c != '\r').collect::<String>())
            .unwrap_or_default();
        if rank.is_empty() || !rank.bytes().all(|b| b.is_ascii_digit()) {
            return "OK\n".to_string();
        }
        match rank.parse::<u32>() {
            Ok(n) if (1..=8).contains(&n) => {
                format!("+QNWCFG: \"{}\",1,{}\n\nOK\n", name, n)
            }
            _ => "OK\n".to_string(),
        }
    }

    // -- the 1 s +CPSI cache ---------------------------------------------
    //
    // The poller asks for the serving cell and all three per-antenna values in
    // one Tier-1.5 pass; the shim's cache collapses those into one round trip
    // without ever crossing a poll cycle (~3-4 s).
    fn cpsi(&mut self) -> String {
        let path = &self.paths.cpsi_cache;
        if let Ok(text) = std::fs::read_to_string(path) {
            let now = now_secs();
            let mut lines = text.lines();
            let cached_at = lines
                .next()
                .and_then(|l| l.trim().parse::<u64>().ok())
                .unwrap_or(0);
            if cached_at > 0 && now >= cached_at && now - cached_at <= self.paths.cpsi_ttl {
                return lines.collect::<Vec<_>>().join("\n");
            }
        }
        let fresh = self.at.raw("AT+CPSI?");
        let _ = std::fs::write(path, format!("{}\n{}\n", now_secs(), fresh));
        fresh
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn passthrough(at: &mut dyn At, cmd: &str) -> String {
    format!("{}\n", at.raw(cmd))
}

fn error() -> String {
    "ERROR\n".to_string()
}

/// `AT+CNMP?` -> the bare number, spaces and CR removed.
fn cnmp(at: &mut dyn At) -> String {
    first_line_after(&at.raw("AT+CNMP?"), "+CNMP:", Strip::CrSpace).unwrap_or_default()
}

fn dash(v: Option<String>) -> String {
    match v {
        Some(s) if !s.is_empty() => s,
        _ => "-".to_string(),
    }
}

fn or_num(v: &str) -> String {
    if v.is_empty() {
        "0".to_string()
    } else {
        v.to_string()
    }
}

fn is_int(s: &str) -> bool {
    if let Some(rest) = s.strip_prefix('-') {
        !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())
    } else {
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
    }
}

fn strip_quotes(s: &str) -> String {
    s.chars().filter(|c| *c != '"').collect()
}

fn rm_cr(s: &str) -> String {
    s.replace('\r', "")
}

/// The shell's `sed -n 's/^+PREFIX//p' | tr -d ...  | head -1`, in one pass.
#[derive(Clone, Copy)]
enum Strip {
    /// `tr -d '\r'`
    Cr,
    /// `tr -d '\r '` — removes every space
    CrSpace,
    /// `sed 's/^Prefix: *//'` — the spaces directly after the prefix only
    CrTrimLead,
}

fn first_line_after(text: &str, prefix: &str, strip: Strip) -> Option<String> {
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(prefix) {
            let value = match strip {
                Strip::Cr => rm_cr(rest),
                Strip::CrSpace => rest.chars().filter(|c| *c != '\r' && *c != ' ').collect(),
                Strip::CrTrimLead => rm_cr(rest.trim_start_matches(' ')),
            };
            return Some(value);
        }
    }
    None
}

/// Comma split with no trimming: the shell sets `IFS=,` and nothing else.
fn fields(s: &str) -> Vec<&str> {
    s.split(',').collect()
}

fn replace_prefix(text: &str, from: &str, to: &str) -> String {
    let mut out = String::new();
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        match line.strip_prefix(from) {
            Some(rest) => {
                out.push_str(to);
                out.push_str(rest);
            }
            None => out.push_str(line),
        }
    }
    out
}

/// The persistent-identity gate, second line of defence after Luhn.
fn imei_shape_ok(value: &str) -> bool {
    if value.len() != 15 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    !matches!(value, "000000000000000" | "111111111111111" | "999999999999999")
}

#[cfg(test)]
mod tests;
