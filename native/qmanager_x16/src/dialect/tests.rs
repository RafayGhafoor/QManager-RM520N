//! The porting checklist, re-expressed against this crate.
//!
//! Each test names the assertion it mirrors from
//! `zlt-x16/tests/unit_atcli_dialect.sh` (`D/…`) or
//! `zlt-x16/tests/unit_atcli_policy.sh` (`P/…`). The fixtures are the same
//! values, copied from the on-device capture `docs/captures/at-capture-2026-10-26.txt`
//! via `zlt-x16/tests/fake-atcmd`; field positions are asserted individually
//! because `parse_at.sh` indexes by position.
//!
//! A test whose name starts with `suite_` is a direct mirror; the `parity_*`
//! tests are this crate's own (a fixture the shell suite drives through
//! `FAKE_*` overrides).

use super::*;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// A modem that answers from a response table and records what it was asked.
struct Fake {
    calls: RefCell<Vec<String>>,
    replies: BTreeMap<String, String>,
}

impl Fake {
    fn new() -> Fake {
        let mut replies = BTreeMap::new();
        let mut put = |cmd: &str, reply: &str| {
            replies.insert(cmd.to_string(), reply.to_string());
        };
        put(
            "AT+CPSI?",
            "+CPSI: LTE,Online,410-03,0x29DD,212150373,256,EUTRAN-BAND3,1312,5,5,-80,-947,-668,15",
        );
        put(
            "AT+CRSRP?",
            "+CRSRP: LTE,-97,-98,-90,-89\n+CRSRP: NR5G,-74,-76,-83,-75",
        );
        put(
            "AT+CSINR?",
            "+CSINR: LTE,8,0,8,8\n+CSINR: NR5G,22,20,13,20",
        );
        put(
            "AT+CCAINFO?",
            "+CCAINFO: \"PCC\",EUTRAN_BAND3,1312,100,256,-94,-8,-66,200\n\
             +CCAINFO: \"SCC\",EUTRAN_BAND1,150,50,502,2,-108,-9,-82,134,2,3,9\n\
             +CCAINFO: \"SCC\",EUTRAN_BAND5,2450,50,469,1,-92,-11,-71,133,0",
        );
        put("AT+CICCID", "+ICCID: 89410037251217291419");
        put(
            "ATI",
            "Manufacturer: SIMCOM INCORPORATED\nModel: SIMCOM_SIM8260E\nRevision: V1.0.01\nIMEI: 861702085648268\n+GCAP: +CGSM",
        );
        put("AT+CGMR", "+CGMR: 2212B01X62M88A-LGA_CUS_TZ");
        put("AT+CGSN", "861702085648268");
        put("AT+CNMP?", "+CNMP: 2");
        put("AT+CSYSSEL=\"lte_band\"", "+CSYSSEL: \"lte_band\",1:3:5:41");
        put(
            "AT+CSYSSEL=\"nr5g_band\"",
            "+CSYSSEL: \"nr5g_band\",1:8:40:41:78",
        );
        put(
            "AT+CSYSSEL=\"nsa_nr5g_band\"",
            "+CSYSSEL: \"nsa_nr5g_band\",1:8:40:41:78",
        );
        put(
            "AT+CSYSSEL=\"nr5g_disable\"",
            "+CSYSSEL: \"nr5g_disable\",0",
        );
        put(
            "AT+CSYSSEL=?",
            "+CSYSSEL: \"nr5g_disable\",(0-2)\n\
             +CSYSSEL: \"nr5g_band\",1:3:5:7:8:20:26:28:38:40:41:48:77:78:79\n\
             +CSYSSEL: \"nsa_nr5g_band\",1:3:5:7:8:20:26:28:38:40:41:48:77:78:79\n\
             +CSYSSEL: \"lte_band\",1:3:5:7:8:18:19:20:26:28:32:38:39:40:41:42:43:46:48",
        );
        put("AT+QTEMP", "ERROR");
        Fake {
            calls: RefCell::new(Vec::new()),
            replies,
        }
    }

    fn with(mut self, cmd: &str, reply: &str) -> Fake {
        self.replies.insert(cmd.to_string(), reply.to_string());
        self
    }

    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }

    fn calls_to(&self, cmd: &str) -> usize {
        self.calls().iter().filter(|c| *c == cmd).count()
    }
}

impl At for Fake {
    fn raw(&mut self, cmd: &str) -> String {
        self.calls.borrow_mut().push(cmd.to_string());
        self.replies
            .get(cmd)
            .cloned()
            .unwrap_or_else(|| "OK".to_string())
    }
}

/// A private scratch directory per call: tests run in parallel inside one
/// process, and both the CPSI cache and the devinfo store are files that the
/// arms legitimately share.
fn paths() -> Paths {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("qm16-dialect-{}-{}", std::process::id(), n));
    let _ = std::fs::create_dir_all(&dir);
    Paths {
        cpsi_cache: dir.join("cpsi.cache"),
        cpsi_ttl: 1,
        thermal_dir: PathBuf::from("/sys/class/thermal"),
        devinfo: dir.join("devinfo"),
    }
}

fn run_with(fake: &mut Fake, cmd: &str) -> String {
    run(fake, &paths(), cmd)
}

/// Field `n` (1-based) of the first matching line, comma separated.
fn field_of(output: &str, line_prefix: &str, n: usize) -> String {
    let line = output
        .lines()
        .find(|l| l.starts_with(line_prefix))
        .unwrap_or_else(|| panic!("no line starting with {} in:\n{}", line_prefix, output));
    let body = &line[line_prefix.len()..];
    let f: Vec<&str> = body.split(',').collect();
    f.get(n - 1)
        .map(|v| v.trim_matches(|c| c == ' ' || c == '\r').to_string())
        .unwrap_or_else(|| panic!("field {} missing from {}", n, line))
}

// ===========================================================================
// D/transport
// ===========================================================================
#[test]
fn suite_transport_interactive_cmgs_is_refused() {
    let mut f = Fake::new();
    assert_eq!(
        run_with(&mut f, "AT+CMGS=\"+923001234567\""),
        "ERROR\n",
        "D/transport: interactive CMGS is refused (no prompt on this bus)"
    );
    assert_eq!(f.calls().len(), 0, "the modem must not be asked");
}

#[test]
fn suite_transport_passthrough_returns_payload() {
    let mut f = Fake::new();
    assert_eq!(run_with(&mut f, "AT+CGSN"), "861702085648268\n");
}

#[test]
fn suite_transport_empty_command_answers_nothing() {
    // The shim's `[ -n "$1" ] || exit 0`: no output, which qcmd reads as
    // command_failed. Faithful, and worth pinning.
    let mut f = Fake::new();
    assert_eq!(run_with(&mut f, ""), "");
    assert_eq!(run_with(&mut f, ";"), "ERROR\n");
}

// ===========================================================================
// D/qeng — AT+QENG="servingcell" <- AT+CPSI?
// ===========================================================================
#[test]
fn suite_qeng_field_positions() {
    let mut f = Fake::new();
    let out = run_with(&mut f, "AT+QENG=\"servingcell\"");
    let p = "+QENG: ";
    assert_eq!(field_of(&out, p, 1), "\"servingcell\"");
    assert_eq!(field_of(&out, p, 2), "\"CONNECT\"");
    assert_eq!(field_of(&out, p, 3), "\"LTE\"");
    assert_eq!(field_of(&out, p, 4), "\"FDD\"");
    assert_eq!(field_of(&out, p, 5), "410");
    assert_eq!(field_of(&out, p, 6), "03");
    // 212150373 -> 0xCA52865
    assert_eq!(field_of(&out, p, 7), "CA52865");
    assert_eq!(field_of(&out, p, 8), "256");
    assert_eq!(field_of(&out, p, 9), "1312");
    assert_eq!(field_of(&out, p, 10), "3");
    assert_eq!(field_of(&out, p, 11), "5");
    assert_eq!(field_of(&out, p, 12), "5");
    assert_eq!(field_of(&out, p, 13), "29DD");
    assert_eq!(field_of(&out, p, 14), "-94", "f14 RSRP = f12/10 truncating");
    assert_eq!(field_of(&out, p, 15), "-8", "f15 RSRQ = f11/10");
    assert_eq!(field_of(&out, p, 16), "-66", "f16 RSSI = f13/10");
    assert_eq!(field_of(&out, p, 17), "15", "f17 SINR passthrough");
    assert_eq!(out.matches("\nOK\n").count(), 1, "trailing OK present");
    assert_eq!(
        out.lines().filter(|l| l.starts_with("+QENG:")).count(),
        1,
        "LTE-only keeps one line and the servingcell prefix"
    );
}

#[test]
fn suite_qeng_live_capture_order() {
    // The exact triplet read in the same second as vendor RSRP -88 / RSRQ -11 /
    // RSSI -58: this is what pins the field ORDER, not just the scaling.
    let mut f = Fake::new().with(
        "AT+CPSI?",
        "+CPSI: LTE,Online,410-01,0xD857,48466199,104,EUTRAN-BAND1,250,3,3,-120,-884,-600,0",
    );
    let out = run_with(&mut f, "AT+QENG=\"servingcell\"");
    assert_eq!(field_of(&out, "+QENG: ", 14), "-88");
    assert_eq!(field_of(&out, "+QENG: ", 15), "-12");
    assert_eq!(field_of(&out, "+QENG: ", 16), "-60");
    assert_eq!(field_of(&out, "+QENG: ", 17), "0");
}

#[test]
fn suite_qeng_state_mapping_and_tdd() {
    for (state, expected) in [
        ("Search", "SEARCH"),
        ("Limited service", "LIMSRV"),
        ("Online", "CONNECT"),
        ("Something else", "NOCONN"),
    ] {
        let mut f = Fake::new().with(
            "AT+CPSI?",
            &format!(
                "+CPSI: LTE,{},410-03,0x1,1,2,EUTRAN-BAND1,100,5,5,-90,-900,-600,3",
                state
            ),
        );
        let out = run_with(&mut f, "AT+QENG=\"servingcell\"");
        assert_eq!(field_of(&out, "+QENG: ", 2), format!("\"{}\"", expected));
    }

    let mut f = Fake::new().with(
        "AT+CPSI?",
        "+CPSI: LTE,Online,460-00,0x1,1,2,EUTRAN-BAND41,40000,20,20,-80,-880,-500,20",
    );
    let out = run_with(&mut f, "AT+QENG=\"servingcell\"");
    assert_eq!(field_of(&out, "+QENG: ", 4), "\"TDD\"");
    assert_eq!(field_of(&out, "+QENG: ", 10), "41");
}

#[test]
fn suite_qeng_no_lte_service_is_a_search_sentinel() {
    let mut f = Fake::new().with("AT+CPSI?", "OK");
    assert_eq!(
        run_with(&mut f, "AT+QENG=\"servingcell\""),
        "+QENG: \"servingcell\",\"SEARCH\"\n\nOK\n"
    );
}

#[test]
fn suite_qeng_endc_emits_three_lines() {
    let mut f = Fake::new().with(
        "AT+CPSI?",
        "+CPSI: LTE,Online,410-01,0xD857,48466199,104,EUTRAN-BAND1,250,3,3,-133,-898,-579,-9\n\
         +CPSI: NR5G_NSA,47,NR5G_BAND41,509070,-770,-110,21,1,9",
    );
    let out = run_with(&mut f, "AT+QENG=\"servingcell\"");
    let qeng: Vec<&str> = out.lines().filter(|l| l.starts_with("+QENG:")).collect();
    assert_eq!(qeng.len(), 3, "EN-DC emits three QENG lines:\n{}", out);

    // line 1: servingcell + state only
    assert_eq!(field_of(qeng[0], "+QENG: ", 1), "\"servingcell\"");
    assert_eq!(field_of(qeng[0], "+QENG: ", 2), "\"CONNECT\"");

    // line 2: the LTE anchor WITHOUT the servingcell prefix
    assert_eq!(field_of(qeng[1], "+QENG: ", 1), "\"LTE\"");
    assert_eq!(field_of(qeng[1], "+QENG: ", 2), "\"FDD\"");
    assert_eq!(field_of(qeng[1], "+QENG: ", 8), "1", "anchor band B1");
    assert_eq!(field_of(qeng[1], "+QENG: ", 6), "104", "anchor PCI");
    assert_eq!(field_of(qeng[1], "+QENG: ", 7), "250", "anchor EARFCN");
    assert!(
        !qeng[1].contains("servingcell"),
        "EN-DC L2 must not carry the servingcell tag: {}",
        qeng[1]
    );

    // line 3: the NR leg — MCC MNC PCID RSRP SINR RSRQ ARFCN band
    assert_eq!(field_of(qeng[2], "+QENG: ", 1), "\"NR5G-NSA\"");
    assert_eq!(field_of(qeng[2], "+QENG: ", 2), "410");
    assert_eq!(field_of(qeng[2], "+QENG: ", 3), "01");
    assert_eq!(field_of(qeng[2], "+QENG: ", 4), "47");
    assert_eq!(field_of(qeng[2], "+QENG: ", 5), "-77", "-770 tenths truncated");
    assert_eq!(
        field_of(qeng[2], "+QENG: ", 6),
        "21",
        "NR SINR is WHOLE dB on this unit (21, not 2)"
    );
    assert_eq!(field_of(qeng[2], "+QENG: ", 7), "-11", "-110 rounded");
    assert_eq!(field_of(qeng[2], "+QENG: ", 8), "509070");
    assert_eq!(field_of(qeng[2], "+QENG: ", 9), "41");
    assert_eq!(out.matches("\nOK\n").count(), 1, "EN-DC trailing OK");
}

// ===========================================================================
// D/ca — AT+QCAINFO <- AT+CCAINFO?
// ===========================================================================
#[test]
fn suite_ca_pcc_fields() {
    let mut f = Fake::new();
    let out = run_with(&mut f, "AT+QCAINFO");
    let pcc = out
        .lines()
        .find(|l| l.contains("\"PCC\""))
        .expect("a PCC row");
    let f4: Vec<&str> = pcc.split(',').collect();
    assert_eq!(f4[1], "1312", "earfcn");
    assert_eq!(f4[2], "100", "bandwidth code");
    assert_eq!(f4[3], "LTE BAND 3", "band text");
    assert_eq!(f4[5], "256", "PCI");
    assert_eq!(f4[6], "-94", "RSRP");
    assert_eq!(f4[7], "-8", "RSRQ");
    assert_eq!(f4[8], "-66", "RSSI");
    assert_eq!(f4[9], "20", "SINR from CCAINFO field 9 (200 -> 20)");
}

#[test]
fn suite_ca_wideband_rssi_is_not_blanked() {
    // This modem's wideband RSSI sits at -32..-39 dBm; the old -40 floor blanked
    // every metric on every healthy row ("Spectrum in use: not reported").
    let mut f = Fake::new().with(
        "AT+CCAINFO?",
        "+CCAINFO: \"PCC\",EUTRAN_BAND3,1850,100,227,-73,-14,-39,137",
    );
    let out = run_with(&mut f, "AT+QCAINFO");
    let pcc: Vec<&str> = out
        .lines()
        .find(|l| l.contains("\"PCC\""))
        .unwrap()
        .split(',')
        .collect();
    assert_eq!(pcc[8], "-39");
    assert_eq!(pcc[6], "-73");
    assert_eq!(pcc[9], "13");
}

#[test]
fn suite_ca_rssi_below_rsrp_is_rejected() {
    let mut f = Fake::new().with(
        "AT+CCAINFO?",
        "+CCAINFO: \"PCC\",EUTRAN_BAND3,1850,100,227,-73,-14,-95,137",
    );
    let out = run_with(&mut f, "AT+QCAINFO");
    let pcc: Vec<&str> = out
        .lines()
        .find(|l| l.contains("\"PCC\""))
        .unwrap()
        .split(',')
        .collect();
    assert_eq!(pcc[8], "-", "RSSI below RSRP is still rejected");
}

#[test]
fn suite_ca_scc_metric_offset_shift() {
    let mut f = Fake::new();
    let out = run_with(&mut f, "AT+QCAINFO");
    let scc: Vec<&str> = out
        .lines()
        .filter(|l| l.contains("\"SCC\""))
        .next()
        .unwrap()
        .split(',')
        .collect();
    assert_eq!(scc[3], "LTE BAND 1");
    assert_eq!(scc[5], "502", "PCI");
    assert_eq!(scc[6], "-108", "RSRP from field 7, not 6");
    assert_eq!(scc[7], "-9", "RSRQ");
    assert_eq!(scc[8], "-82", "RSSI");
    let second = out
        .lines()
        .filter(|l| l.contains("\"SCC\""))
        .nth(1)
        .unwrap()
        .split(',')
        .nth(3)
        .unwrap()
        .to_string();
    assert_eq!(second, "LTE BAND 5");
}

#[test]
fn suite_ca_implausible_metrics_are_dropped() {
    let mut f = Fake::new().with(
        "AT+CCAINFO?",
        "+CCAINFO: \"SCC\",EUTRAN_BAND1,150,50,502,2,-44,-3,-82,134,2,3,9",
    );
    let out = run_with(&mut f, "AT+QCAINFO");
    let row = out.lines().find(|l| l.contains("\"SCC\"")).unwrap();
    let f4: Vec<&str> = row.split(',').collect();
    assert_eq!(
        format!("{},{},{}", f4[6], f4[7], f4[8]),
        "-,-,-",
        "implausible metrics are dropped, not plotted"
    );
}

#[test]
fn suite_ca_absent_and_toggle() {
    let mut f = Fake::new().with("AT+CCAINFO?", "OK");
    let out = run_with(&mut f, "AT+QCAINFO");
    assert_eq!(out, "+QCAINFO: \"PCC\"\n\nOK\n");
    assert_eq!(run_with(&mut f, "AT+QCAINFO=1"), "OK\n");
    assert_eq!(run_with(&mut f, "AT+QCAINFO=0"), "OK\n");
}

// ===========================================================================
// D/identity / P/safety
// ===========================================================================
#[test]
fn suite_identity_prefixes_and_static_answers() {
    let mut f = Fake::new();
    let out = run_with(&mut f, "AT+QCCID");
    assert!(out.contains("+QCCID: 89410037251217291419"), "{}", out);
    assert!(!out.contains("+ICCID:"), "{}", out);

    assert!(run_with(&mut f, "AT+QUIMSLOT?").contains("+QUIMSLOT: 1"));
    assert!(run_with(&mut f, "AT+QSIMSTAT?").contains("+QSIMSTAT: 1,1"));
    assert!(run_with(&mut f, "AT+QSIMDET?").contains("+QSIMDET: 0,1"));
}

#[test]
fn suite_identity_cversion() {
    let mut f = Fake::new();
    let out = run_with(&mut f, "AT+CVERSION");
    let first_body = out
        .lines()
        .filter(|l| !l.starts_with("+CVERSION:") && !l.is_empty())
        .next()
        .unwrap();
    assert_eq!(first_body, "SIMCOM_SIM8260E", "model line comes first");
    assert!(out.contains("Authors: SIMCOM INCORPORATED"), "{}", out);
    assert!(out.contains("VERSION: V1.0.01"), "{}", out);
}

#[test]
fn suite_identity_cversion_falls_back_to_cgmr() {
    let mut f = Fake::new().with("ATI", "Model: SIMCOM_SIM8260E");
    let out = run_with(&mut f, "AT+CVERSION");
    assert!(out.contains("VERSION: 2212B01X62M88A-LGA_CUS_TZ"), "{}", out);
    assert_eq!(f.calls_to("AT+CGMR"), 1);
}

#[test]
fn suite_identity_per_antenna_arms() {
    let mut f = Fake::new();
    let out = run_with(&mut f, "AT+QRSRP");
    assert!(out.contains("+QRSRP: -97,-98,-90,-89,LTE"), "{}", out);
    assert!(out.contains("+QRSRP: -74,-76,-83,-75,NR5G"), "{}", out);
    assert_eq!(f.calls_to("AT+CRSRP?"), 1, "exactly one modem query");

    let out = run_with(&mut f, "AT+QSINR");
    assert!(out.contains("+QSINR: 8,0,8,8,LTE"), "{}", out);
    assert!(out.contains("+QSINR: 22,20,13,20,NR5G"), "{}", out);

    let out = run_with(&mut f, "AT+QRSRQ");
    assert!(out.contains("+QRSRQ: -32768,-32768,-32768,-32768,LTE"), "{}", out);
    assert!(!out.contains("+QRSRQ: -7,"), "no faked Main reading");
}

#[test]
fn suite_identity_qrsrp_without_per_chain_support_is_error() {
    let mut f = Fake::new().with("AT+CRSRP?", "ERROR");
    assert_eq!(run_with(&mut f, "AT+QRSRP"), "ERROR\n");
}

#[test]
fn suite_identity_qnwcfg_unsupported_family_is_ok() {
    let mut f = Fake::new();
    for cmd in [
        "AT+QNWCFG=\"lte_mimo_layers\"",
        "AT+QNWCFG=\"nr5g_mimo_layers\"",
        "AT+QGETCAPABILITY",
        "AT+QMAP=\"WWAN\"",
        "AT+QNWINFO",
        "AT+QCSQ",
    ] {
        assert_eq!(run_with(&mut f, cmd), "OK\n", "{}", cmd);
    }
    assert_eq!(f.calls().len(), 0, "none of these may touch the modem");
}

#[test]
fn suite_identity_mimo_from_the_devinfo_store() {
    let p = paths();
    std::fs::write(&p.devinfo, "lte_rank: 2\nnr_rank:4\nMIMO_STATUS: \n").unwrap();
    let mut f = Fake::new();
    assert_eq!(
        run(&mut f, &p, "AT+QNWCFG=\"lte_mimo_layers\""),
        "+QNWCFG: \"lte_mimo_layers\",1,2\n\nOK\n"
    );
    assert_eq!(
        run(&mut f, &p, "AT+QNWCFG=\"nr5g_mimo_layers\""),
        "+QNWCFG: \"nr5g_mimo_layers\",1,4\n\nOK\n"
    );
    // Out of range or non-numeric: a bare OK, never a fabricated rank.
    std::fs::write(&p.devinfo, "lte_rank: 99\n").unwrap();
    assert_eq!(run(&mut f, &p, "AT+QNWCFG=\"lte_mimo_layers\""), "OK\n");
    let _ = std::fs::remove_file(&p.devinfo);
}

#[test]
fn suite_safety_imei_read_and_write() {
    let mut f = Fake::new();
    assert!(run_with(&mut f, "AT+EGMR=0,7").contains("861702085648268"));

    let out = run_with(&mut f, "AT+EGMR=1,7,\"490154203237518\"");
    assert!(out.contains("OK"), "{}", out);
    assert_eq!(
        f.calls().last().map(|s| s.as_str()),
        Some("AT+SIMEI=490154203237518"),
        "IMEI write became AT+SIMEI=<15 digits>"
    );
}

#[test]
fn suite_safety_imei_write_refuses_bad_values_and_never_reaches_the_modem() {
    for bad in [
        "AT+EGMR=1,7,\"49015420323751\"",
        "AT+EGMR=1,7,\"4901542032375189\"",
        "AT+EGMR=1,7,\"49015420323751a\"",
        "AT+EGMR=1,7,\"\"",
        "AT+EGMR=1,7,\"000000000000000\"",
        "AT+EGMR=1,4,\"490154203237518\"",
    ] {
        let mut f = Fake::new();
        assert_eq!(run_with(&mut f, bad), "ERROR\n", "{}", bad);
        assert_eq!(f.calls().len(), 0, "{} must never reach the modem", bad);
    }
}

// ===========================================================================
// D/qtemp
// ===========================================================================
#[test]
fn suite_qtemp_thermal_fallback() {
    let dir = std::env::temp_dir().join(format!("qm16-thermal-{}", std::process::id()));
    for (i, (ty, temp)) in [
        ("modem-lte-sub6", "38500"),
        ("cpuss-0-usr", "99999"),
        ("modem-ambient", "0"),
    ]
    .iter()
    .enumerate()
    {
        let z = dir.join(format!("thermal_zone{}", i));
        std::fs::create_dir_all(&z).unwrap();
        std::fs::write(z.join("type"), format!("{}\n", ty)).unwrap();
        std::fs::write(z.join("temp"), format!("{}\n", temp)).unwrap();
    }
    let mut p = paths();
    p.thermal_dir = dir.clone();
    let mut f = Fake::new();
    let out = run(&mut f, &p, "AT+QTEMP");
    assert!(out.contains("+QTEMP: \"modem-0\",39"), "{}", out);
    assert!(!out.contains("100"), "non-modem zones are ignored: {}", out);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn suite_qtemp_passthrough_when_the_modem_answers() {
    let mut f = Fake::new().with("AT+QTEMP", "+QTEMP: \"mdm-0\",42\n\nOK");
    let out = run_with(&mut f, "AT+QTEMP");
    assert!(out.contains("+QTEMP: \"mdm-0\",42"), "{}", out);
}

// ===========================================================================
// D/bands + D/qnwprefcfg
// ===========================================================================
#[test]
fn suite_bands_policy_mode_and_order() {
    let mut f = Fake::new();
    let out = run_with(&mut f, "AT+QNWPREFCFG=\"policy_band\"");
    assert!(out.contains("+QNWPREFCFG: \"lte_band\",1:3:5:41"), "{}", out);
    assert!(
        out.contains("+QNWPREFCFG: \"nsa_nr5g_band\",1:8:40:41:78"),
        "{}",
        out
    );
    assert!(
        out.contains("+QNWPREFCFG: \"nr5g_band\",1:8:40:41:78"),
        "{}",
        out
    );
    assert_eq!(
        run_with(&mut f, "AT+QNWPREFCFG"),
        out,
        "bare AT+QNWPREFCFG is the policy read"
    );
    assert!(run_with(&mut f, "AT+QNWPREFCFG=\"mode_pref\"")
        .contains("+QNWPREFCFG: \"mode_pref\",AUTO"));
    assert!(run_with(&mut f, "AT+QNWPREFCFG=\"nr5g_disable_mode\"")
        .contains("+QNWPREFCFG: \"nr5g_disable_mode\",0"));
    assert!(run_with(&mut f, "AT+QNWPREFCFG=\"roam_pref\"")
        .contains("+QNWPREFCFG: \"roam_pref\",1"));
    assert!(run_with(&mut f, "AT+QNWPREFCFG=\"rat_acq_order\"")
        .contains("+QNWPREFCFG: \"rat_acq_order\",LTE:NR5G:WCDMA"));

    // an unmodelled key must still answer so the panel renders "unknown"
    let out = run_with(&mut f, "AT+QNWPREFCFG=\"some_future_key\"");
    assert!(out.contains("\"some_future_key\","), "{}", out);
}

#[test]
fn suite_qnwprefcfg_capability_is_not_the_policy() {
    let mut f = Fake::new();
    let out = run_with(&mut f, "AT+QNWPREFCFG=\"ue_capability_band\"");
    let cap = out
        .lines()
        .find(|l| l.contains("\"lte_band\""))
        .expect("a capability line");
    assert!(
        cap.contains("1:3:5:7:8:18:19:20:26:28:32:38:39:40:41:42:43:46:48"),
        "capability carries the full LTE set: {}",
        cap
    );
    assert!(out.contains("ue_capability_band"), "{}", out);
    let nsa = out
        .lines()
        .find(|l| l.contains("\"nsa_nr5g_band\""))
        .unwrap();
    assert!(nsa.contains("77:78:79"), "{}", nsa);
    // nr5g_band must not be read out of the nsa_nr5g_band/nrdc_nr5g_band lines
    let sa = out
        .lines()
        .find(|l| l.contains("\"nr5g_band\"") && !l.contains("nsa_") && !l.contains("nrdc_"))
        .unwrap();
    assert!(sa.contains("77:78:79"), "{}", sa);

    // policy stays the enabled set
    let pol = run_with(&mut f, "AT+QNWPREFCFG=\"policy_band\"");
    let lte = pol.lines().find(|l| l.contains("\"lte_band\"")).unwrap();
    assert!(lte.contains("1:3:5:41"), "{}", lte);
    assert!(!lte.contains("18:19:20"), "{}", lte);
}

#[test]
fn suite_bands_capability_falls_back_to_policy() {
    let mut f = Fake::new().with("AT+CSYSSEL=?", "OK");
    let out = run_with(&mut f, "AT+QNWPREFCFG=\"ue_capability_band\"");
    assert!(!out.contains("ue_capability_band"), "{}", out);
    assert!(out.contains("+QNWPREFCFG: \"lte_band\",1:3:5:41"), "{}", out);
}

#[test]
fn suite_bands_writes() {
    // rat_acq_order and mode_pref map to CNMP; everything else is refused.
    for (cmd, expected) in [
        (
            "AT+QNWPREFCFG=\"mode_pref\",LTE",
            "AT+CNMP=38",
        ),
        (
            "AT+QNWPREFCFG=\"rat_acq_order\",LTE",
            "AT+CNMP=38",
        ),
        (
            "AT+QNWPREFCFG=\"rat_acq_order\",\"NR5G:NR5G\"",
            "AT+CNMP=109",
        ),
        (
            "AT+QNWPREFCFG,\"mode_pref\",AUTO",
            "AT+CNMP=2",
        ),
    ] {
        let mut f = Fake::new();
        let out = run_with(&mut f, cmd);
        assert!(out.starts_with("OK"), "{} -> {}", cmd, out);
        assert_eq!(
            f.calls().last().map(|s| s.as_str()),
            Some(expected),
            "{} must emit {}",
            cmd,
            expected
        );
    }

    let mut f = Fake::new();
    assert_eq!(run_with(&mut f, "AT+QNWPREFCFG=\"lte_band\",1:3"), "ERROR\n");
    assert_eq!(f.calls().len(), 0, "an unmapped write must not reach the modem");
}

// ===========================================================================
// P/compound — chain handling
// ===========================================================================
#[test]
fn suite_compound_chain_keeps_order_and_continuations() {
    let mut f = Fake::new()
        .with("AT+COPS?", "+COPS: 0,0,\"Onic\",7")
        .with("AT+CPIN?", "+CPIN: READY");
    let out = run_with(&mut f, "AT+COPS?;+CPIN?");
    assert!(out.contains("+COPS:"), "{}", out);
    assert!(out.contains("+CPIN:"), "{}", out);
    assert!(f.calls().contains(&"AT+CPIN?".to_string()));
}

#[test]
fn suite_compound_tier1_chain() {
    let mut f = Fake::new();
    let out = run_with(
        &mut f,
        "AT+QENG=\"servingcell\";+QCAINFO=1;+QCAINFO;+QCAINFO=0",
    );
    assert!(out.contains("+QENG: \"servingcell\""), "{}", out);
    assert!(out.contains("+QCAINFO: \"PCC\""), "{}", out);
    assert_eq!(f.calls_to("AT+CPSI?"), 1, "one CPSI call serves the chain");
    assert_eq!(f.calls_to("AT+CCAINFO?"), 1);
}

#[test]
fn suite_compound_order_is_preserved() {
    let mut f = Fake::new()
        .with("AT+COPS?", "+COPS: 0,0,\"Onic\",7")
        .with("AT+CPIN?", "+CPIN: READY");
    let out = run_with(&mut f, "AT+COPS?;+CPIN?");
    let cops = out.find("+COPS:").expect("COPS");
    let pin = out.find("+CPIN:").expect("CPIN");
    assert!(cops < pin, "compound replies keep their order:\n{}", out);
}

// ===========================================================================
// P/cache — the 1 s +CPSI cache
// ===========================================================================
#[test]
fn suite_cache_one_cpsi_call_serves_the_tier15_chain() {
    let mut f = Fake::new();
    let out = run_with(&mut f, "AT+QENG=\"servingcell\";+QRSRP;+QRSRQ;+QSINR");
    assert_eq!(
        f.calls_to("AT+CPSI?"),
        1,
        "one CPSI call serves QENG + all three antenna queries (got {})",
        out.len()
    );
}

#[test]
fn suite_cache_fresh_entry_avoids_the_modem() {
    let p = paths();
    let now = now_secs();
    std::fs::write(
        &p.cpsi_cache,
        format!(
            "{}\n+CPSI: LTE,Online,410-03,0x29DD,212150373,256,EUTRAN-BAND3,1312,5,5,-80,-947,-668,15\n",
            now
        ),
    )
    .unwrap();
    let mut f = Fake::new();
    let out = run(&mut f, &p, "AT+QENG=\"servingcell\"");
    assert_eq!(f.calls_to("AT+CPSI?"), 0, "fresh cache, no modem call");
    assert!(out.contains("+QENG: \"servingcell\""), "{}", out);
    let _ = std::fs::remove_file(&p.cpsi_cache);
}

#[test]
fn suite_cache_stale_entry_is_refreshed() {
    let mut p = paths();
    p.cpsi_ttl = 1;
    std::fs::write(&p.cpsi_cache, format!("{}\n+CPSI: LTE,Search\n", now_secs() - 30)).unwrap();
    let mut f = Fake::new();
    let out = run(&mut f, &p, "AT+QENG=\"servingcell\"");
    assert_eq!(f.calls_to("AT+CPSI?"), 1, "a stale entry must be refreshed");
    assert!(out.contains("\"CONNECT\""), "{}", out);
    let _ = std::fs::remove_file(&p.cpsi_cache);
}

// ===========================================================================
// pending arms refuse rather than fabricate
// ===========================================================================
#[test]
fn pending_arms_answer_error_and_never_reach_the_modem() {
    for cmd in [
        "AT+CGCONTRDP",
        "AT+QNWCFG=\"lte_time_advance\"",
        "AT+QNWLOCK=\"common/4g\"",
        "AT+QNWLOCK=\"common/4g\",0",
        "AT+QNWLOCK=\"common/4g\",1,1312,256",
        "AT+QNWLOCK=\"common/4g\",2,3,4",
        "AT+QNWLOCK=\"weird\"",
    ] {
        let mut f = Fake::new();
        assert_eq!(run_with(&mut f, cmd), "ERROR\n", "{}", cmd);
        assert_eq!(f.calls().len(), 0, "{} must not touch the modem", cmd);
        assert!(
            matches!(
                crate::inventory::INVENTORY
                    .iter()
                    .find(|r| r.arm == arm_for(cmd))
                    .unwrap()
                    .status,
                crate::inventory::Status::Pending(_)
            ),
            "{} is answered ERROR but the inventory calls it ported",
            cmd
        );
    }
}

#[test]
fn arm_dispatch_matches_the_shell_case_order() {
    // Pairs that the shell distinguishes by order alone.
    assert_eq!(arm_for("AT+QENG=\"neighbourcell\""), Arm::NeighbourCell);
    assert_eq!(arm_for("AT+QENG=\"servingcell\""), Arm::ServingCell);
    assert_eq!(arm_for("AT+QCAINFO=1"), Arm::CarrierAggToggle);
    assert_eq!(arm_for("AT+QCAINFO"), Arm::CarrierAggInfo);
    assert_eq!(arm_for("AT+EGMR=0,7"), Arm::ImeiRead);
    assert_eq!(arm_for("AT+EGMR=1,7,\"490154203237518\""), Arm::ImeiWrite);
    assert_eq!(arm_for("AT+EGMR=1,4,\"490154203237518\""), Arm::EmgrRefused);
    assert_eq!(arm_for("AT+QNWPREFCFG"), Arm::PolicyBand);
    assert_eq!(arm_for("AT+QNWPREFCFG="), Arm::PolicyBand);
    assert_eq!(arm_for("AT+QNWPREFCFG=\"mode_pref\""), Arm::ModePref);
    assert_eq!(arm_for("AT+QNWPREFCFG=\"nope\""), Arm::PrefUnknownRead);
    assert_eq!(arm_for("AT+QNWPREFCFG,\"mode_pref\",LTE"), Arm::PrefWrite);
    assert_eq!(arm_for("AT+QNWCFG=\"lte_time_advance\""), Arm::LteTimeAdvance);
    assert_eq!(arm_for("AT+QNWCFG=\"nr5g_time_advance\""), Arm::NrTimeAdvance);
    assert_eq!(arm_for("AT+QNWCFG=\"lte_mimo_layers\""), Arm::LteMimo);
    assert_eq!(arm_for("AT+QNWCFG=\"nr5g_mimo_layers\""), Arm::NrMimo);
    assert_eq!(arm_for("AT+QNWCFG=\"x\""), Arm::UnsupportedFamily);
    assert_eq!(arm_for("AT+CRSM=176,28539,0,0,12"), Arm::Passthrough);
}
