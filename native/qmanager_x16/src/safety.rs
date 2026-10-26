//! Which commands may reach `atcmd_daemon` at all — a port of `is_safe_cmd()`.
//!
//! `atcmd_daemon` serves one request at a time and has NO timeout of its own, so
//! one command the modem never answers blocks every later client, including the
//! vendor dialer's — that took the WAN down on 2026-10-26. The shim therefore
//! allowlists rather than passes through, and so must this.
//!
//! Each entry below is a command that was verified against the device capture
//! `docs/captures/at-capture-2026-10-26.txt`. Deliberately absent, and they must
//! stay absent: `AT+CRSM` (FPLMN), `AT+QMBNCFG` (MBN), `AT+EGMR` writes,
//! `AT+QPOWD`, any `AT+CMGS` (interactive prompt), `AT+COPS=1/2/4`,
//! `AT+CFUN=1,1`, `AT+COPS=?` (long scan), `AT+QSCAN*`.
//!
//! `AT+SIMEI=<imei>` is the one permitted command that changes persistent modem
//! state, so its argument shape is pinned here as exactly 15 digits — the caller
//! (`cellular/imei.sh`) validates Luhn first; this is the second line.

const EXACT: &[&str] = &[
    "AT+CPSI?",
    "AT+CCAINFO?",
    "AT+QENG=\"neighbourcell\"",
    "AT+CCELLCFG?",
    "AT+CCELLCFG=0",
    "AT+CRSRP?",
    "AT+CSINR?",
    "AT+CRSSI?",
    "AT+CSQ",
    "ATI",
    "AT+CGMM",
    "AT+CGMR",
    "AT+CGSN",
    "AT+CIMI",
    "AT+CNUM",
    "AT+CPIN?",
    "AT+CGATT?",
    "AT+COPS?",
    "AT+CEREG?",
    "AT+C5GREG?",
    "AT+CGACT?",
    "AT+CGDCONT?",
    "AT+CGCONTRDP",
    "AT+CFUN?",
    "AT+CNMP?",
    "AT+CICCID",
    "AT+CPAS",
    "AT+CPMS?",
    "AT+CRESET",
    "AT+CPOF",
    "AT+CFUN=0",
    "AT+CFUN=1",
    "AT+CFUN=4",
];

const PREFIX: &[&str] = &[
    "AT+CCELLCFG=1,",
    "AT+CGCONTRDP=",
    "AT+CSYSSEL=",
    "AT+CPMS=",
    "AT+CMGF=",
    "AT+CMGD=",
    "AT+CGPADDR",
    "AT+CGEREP=",
    "AT+CNMP=",
];

pub fn is_safe(cmd: &str) -> bool {
    if EXACT.contains(&cmd) {
        return true;
    }
    if PREFIX.iter().any(|p| cmd.starts_with(p)) {
        return true;
    }
    match cmd.strip_prefix("AT+SIMEI=") {
        Some(imei) => is_fifteen_digits(imei),
        None => false,
    }
}

fn is_fifteen_digits(value: &str) -> bool {
    value.len() == 15 && value.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_reads_and_writes_are_allowed() {
        for cmd in [
            "AT+CPSI?",
            "AT+CGSN",
            "ATI",
            "AT+CSYSSEL=\"lte_band\"",
            "AT+CCELLCFG=1,256,1312",
            "AT+SIMEI=490154203237518",
        ] {
            assert!(is_safe(cmd), "{} must be allowed", cmd);
        }
    }

    // tests/unit_atcli_policy.sh, "unverified [...] is refused without
    // contacting the daemon".
    #[test]
    fn unverified_commands_are_refused() {
        for cmd in [
            "AT+CRSM=176,28539,0,0,12",
            "AT+QMBNCFG=\"list\"",
            "AT+QSCAN=1",
            "AT+COPS=?",
            "AT+CGSN;AT+CRSM=1",
            "AT+QPOWD=1",
            "AT+CFUN=1,1",
        ] {
            assert!(!is_safe(cmd), "{} must be refused", cmd);
        }
    }

    // tests/unit_atcli_policy.sh, the five IMEI write shapes.
    #[test]
    fn simei_argument_shape_is_pinned() {
        assert!(is_safe("AT+SIMEI=490154203237518"));
        for bad in [
            "AT+SIMEI=49015420323751",
            "AT+SIMEI=4901542032375189",
            "AT+SIMEI=49015420323751a",
            "AT+SIMEI=",
            "AT+SIMEI=000000000000000",
        ] {
            // "000000000000000" is 15 digits, so the ALLOWLIST accepts it; the
            // placeholder refusal belongs to the dialect arm, which is where
            // tests/unit_atcli_policy.sh asserts it ("IMEI write refuses [...]").
            let expected = bad == "AT+SIMEI=000000000000000";
            assert_eq!(is_safe(bad), expected, "{}", bad);
        }
    }
}
