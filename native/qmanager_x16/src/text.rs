//! Pure text/scaling helpers the dialect arms need.
//!
//! Every function here is a port of one shell function or inlined `case` in
//! `zlt-x16/deploy-x16/atcli_smd11`, and every one is exercised by
//! `tests/unit_atcli_dialect.sh` through the arm that uses it. The shell tests
//! index fields by position, so "close" is a bug; these must agree to the
//! character, including where the shell truncates toward zero.
//!
//! Deliberately NOT ported, because nothing calls them in the shim (measured by
//! `grep -c` on 2026-10-27 — one hit each, the definition itself):
//! `tenth_to_int`, `hundredth_to_int`, `band_num`, `is_tdd`. The shim inlines
//! `$(( x / 10 ))`, the `BAND` suffix trick and the TDD band list. Porting dead
//! helpers would create two spellings of one rule.

/// The TDD band list from `emit_qeng`'s inlined `case` (3GPP LTE TDD bands).
/// NR bands are all TDD on this modem and are not classified here.
const TDD_BANDS: &[&str] = &[
    "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48",
    "50", "51", "52", "53",
];

/// `$(( x / 10 ))` for an all-digits (optionally negative) string.
///
/// Rust integer division also truncates toward zero, which is what the shim
/// does and what the device's vendor dump reports for the same second
/// (`-947 -> -94`, not `-95`).
pub fn tenths(value: &str) -> Option<i32> {
    parse_int(value).map(|v| v / 10)
}

/// `-110 -> -11`, `110 -> 11`: the rounding rule `emit_qeng` uses for NR RSRQ
/// only (LTE RSRQ truncates).
pub fn tenths_rounded(value: &str) -> Option<i32> {
    parse_int(value).map(|v| {
        if v < 0 {
            (v - 5) / 10
        } else {
            (v + 5) / 10
        }
    })
}

/// `dec_to_hex`: `212150373 -> CA52865`, uppercase, no `0x`.
///
/// The shim relies on busybox `printf '%X'` on a 32-bit int. Values above
/// `u32::MAX` cannot occur in `+CPSI` (the field is a 28-bit Cell Identity), so
/// this is a `u32` parse and a rejection rather than a wrap.
pub fn dec_to_hex(value: &str) -> Option<String> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse::<u32>().ok().map(|v| format!("{:X}", v))
}

/// `+CPSI`/`+CCAINFO` band token to a bare number: `EUTRAN-BAND3 -> "3"`,
/// `NR5G_BAND41 -> "41"`. Returns `"0"` when the token carries no digits,
/// matching `_bn=${_bn%%[!0-9]*}; [ -n "$_bn" ] || _bn=0`.
pub fn band_number(token: &str) -> String {
    let digits: String = match token.find("BAND").or_else(|| token.find("band")) {
        Some(pos) => token[pos + 4..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect(),
        None => String::new(),
    };
    if digits.is_empty() {
        "0".to_string()
    } else {
        digits
    }
}

/// `"410-03" -> ("410", "03")`. A token with no `-` yields an empty MNC, which
/// is what the shim's `[ "$_mnc" = "$1" ] && _mnc=""` produces.
pub fn plmn_split(plmn: &str) -> (String, String) {
    match plmn.split_once('-') {
        Some((mcc, mnc)) => (mcc.to_string(), mnc.to_string()),
        None => (plmn.to_string(), String::new()),
    }
}

/// `is_tdd`, inlined in the shim: a bare band number decides FDD/TDD.
pub fn is_tdd(band: &str) -> bool {
    TDD_BANDS.contains(&band)
}

/// `_tac_hex`: strip the `0x`, then strip exactly ONE leading zero, then `0` if
/// that leaves nothing. `0x29DD -> 29DD`, `0x0D857 -> 0D857`.
pub fn tac_hex(tac: &str) -> String {
    let stripped: String = tac.chars().filter(|c| *c != 'x' && *c != 'X').collect();
    let trimmed = stripped.strip_prefix('0').unwrap_or(&stripped);
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `"${x:--}"`: render an optional reading, `-` when absent.
pub fn or_dash(value: Option<i32>) -> String {
    match value {
        Some(v) => v.to_string(),
        None => "-".to_string(),
    }
}

/// `"${x:-0}"`: render a raw field, `0` when empty.
pub fn or_zero(value: &str) -> String {
    if value.is_empty() {
        "0".to_string()
    } else {
        value.to_string()
    }
}

/// All-digits, optionally negative — the shim's `case "$x" in ''|*[!0-9-]*)`.
///
/// Note this accepts `-` in any position, exactly like the shell pattern does;
/// `parse_int` below is the stricter gate those callers actually go through.
fn is_numeric_shape(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit() || c == '-')
}

/// The shim only reaches arithmetic after `case "$x" in ''|*[!0-9-]*) ;;`
/// passes, so a value that is not a well-formed integer never gets here in
/// practice; in Rust a `None` is the honest answer rather than a wrapped one.
fn parse_int(value: &str) -> Option<i32> {
    if !is_numeric_shape(value) {
        return None;
    }
    value.parse::<i32>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The values below are the ones tests/unit_atcli_dialect.sh pins.
    #[test]
    fn tenths_truncates_toward_zero() {
        assert_eq!(tenths("-947"), Some(-94)); // "f14 RSRP = f12/10 truncating"
        assert_eq!(tenths("-80"), Some(-8)); // "f15 RSRQ = f11/10"
        assert_eq!(tenths("-668"), Some(-66)); // "f16 RSSI = f13/10"
        assert_eq!(tenths("-884"), Some(-88)); // "live capture RSRP"
        assert_eq!(tenths("-600"), Some(-60)); // "live capture RSSI"
        assert_eq!(tenths("0"), Some(0));
        assert_eq!(tenths("15"), Some(1));
        assert_eq!(tenths(""), None);
        assert_eq!(tenths("abc"), None);
    }

    #[test]
    fn tenths_rounded_matches_the_nr_rsrq_rule() {
        assert_eq!(tenths_rounded("-110"), Some(-11)); // "EN-DC L3 NR RSRQ"
        assert_eq!(tenths_rounded("-105"), Some(-11));
        assert_eq!(tenths_rounded("-104"), Some(-10));
        assert_eq!(tenths_rounded("105"), Some(11));
        assert_eq!(tenths_rounded("nan"), None);
    }

    #[test]
    fn dec_to_hex_matches_the_cell_id() {
        assert_eq!(dec_to_hex("212150373").as_deref(), Some("CA52865"));
        assert_eq!(dec_to_hex("48466199").as_deref(), Some("2E38917"));
        assert_eq!(dec_to_hex("0").as_deref(), Some("0"));
        assert_eq!(dec_to_hex("0x29DD"), None);
        assert_eq!(dec_to_hex(""), None);
    }

    #[test]
    fn band_number_reads_both_spellings() {
        assert_eq!(band_number("EUTRAN-BAND3"), "3");
        assert_eq!(band_number("EUTRAN_BAND3"), "3");
        assert_eq!(band_number("NR5G_BAND41"), "41");
        assert_eq!(band_number("NR5G_BAND78"), "78");
        // "LTE BAND 3" carries a space before the digits, so the shim's
        // `${x##*BAND}` + `${x%%[!0-9]*}` pair yields an empty number -> 0.
        assert_eq!(band_number("LTE BAND 3"), "0");
        assert_eq!(band_number("nonsense"), "0");
    }

    #[test]
    fn plmn_split_matches_the_qeng_fields() {
        assert_eq!(plmn_split("410-03"), ("410".into(), "03".into()));
        assert_eq!(plmn_split("410-01"), ("410".into(), "01".into()));
        assert_eq!(plmn_split("410"), ("410".into(), "".into()));
    }

    #[test]
    fn tdd_is_the_lte_tdd_list() {
        assert!(is_tdd("41")); // "TDD band 41 -> TDD"
        assert!(is_tdd("33"));
        assert!(is_tdd("48"));
        assert!(!is_tdd("3"));
        assert!(!is_tdd("1"));
        assert!(!is_tdd(""));
    }

    #[test]
    fn tac_hex_strips_one_zero_only() {
        assert_eq!(tac_hex("0x29DD"), "29DD");
        assert_eq!(tac_hex("0x0D857"), "0D857");
        assert_eq!(tac_hex("0x0"), "0");
        assert_eq!(tac_hex("0"), "0");
    }
}
