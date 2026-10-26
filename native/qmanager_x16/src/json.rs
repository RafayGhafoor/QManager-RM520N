//! `qcmd -j` output, without `jq`.
//!
//! The shell version pipes through `jq -n --arg ... '{success: .., ...}'`. Its
//! callers parse with `jq`, so any valid JSON would do; what is reproduced here
//! is jq's *default* shape — two-space indent, one key per line, keys in
//! object order, one trailing newline — so a human diff and a byte diff agree,
//! which is what makes the parity test in `tests/parity.rs` meaningful.
//!
//! Escaping also follows jq: `"` and `\` are escaped, `\n \r \t \b \f` get their
//! short forms, remaining control characters become `\u00XX`, and everything
//! else (including non-ASCII UTF-8) passes through unchanged.
//!
//! One difference that cannot be removed without `jq` itself: the modem reply is
//! bytes, and `/bin/atcmd` can return bytes that are not UTF-8. The shell hands
//! those to `jq`, which rejects them; this crate has already replaced them with
//! U+FFFD at the transport boundary (`String::from_utf8_lossy`). Recorded in
//! MEMO.md.

pub fn success(response: &str, command: &str) -> String {
    format!(
        "{{\n  \"success\": true,\n  \"response\": {},\n  \"command\": {}\n}}\n",
        quote(response),
        quote(command)
    )
}

pub fn failure(error: &str, command: &str) -> String {
    format!(
        "{{\n  \"success\": false,\n  \"error\": {},\n  \"command\": {}\n}}\n",
        quote(error),
        quote(command)
    )
}

/// jq-compatible string quoting, surrounding quotes included.
pub fn quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_shape_matches_jq_default_output() {
        // `jq -n --arg response 'OK' --arg command 'AT+CSQ' \
        //    '{success: true, response: $response, command: $command}'`
        assert_eq!(
            success("OK", "AT+CSQ"),
            "{\n  \"success\": true,\n  \"response\": \"OK\",\n  \"command\": \"AT+CSQ\"\n}\n"
        );
    }

    #[test]
    fn failure_shape_matches_jq_default_output() {
        assert_eq!(
            failure("modem_busy", "AT+CSQ"),
            "{\n  \"success\": false,\n  \"error\": \"modem_busy\",\n  \"command\": \"AT+CSQ\"\n}\n"
        );
    }

    #[test]
    fn newlines_in_a_payload_are_escaped_not_literal() {
        let json = success("+CSQ: 24,99\r\n\r\nOK\r", "AT+CSQ");
        assert!(json.contains("\\r\\n"), "{}", json);
        assert_eq!(json.matches('\n').count(), 5, "only the 4 layout + 1 final");
    }

    #[test]
    fn control_characters_use_short_or_u_escapes() {
        assert_eq!(quote("\u{1}"), "\"\\u0001\"");
        assert_eq!(quote("\t"), "\"\\t\"");
    }
}
