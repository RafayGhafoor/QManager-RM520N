#!/bin/sh
# =============================================================================
# qmi_read.sh — read-only QMI (libqmi / QRTR) reader for QManager
# =============================================================================
# QMI is a second, independent pipe into the modem. It does not use the AT port,
# so it never opens that device, never takes the shared AT mutex, and cannot be
# starved by the vendor's ~0.4 s modemd poll or by a cell scan holding that
# mutex. Measured on this device (GreenPacket O5A Pro, RG520N-EB, 2026-10-22):
# neighbours 30-260 ms (avg 82), signal 40 ms, serving system 30 ms. See
# docs/reference/qmi-transport.md.
#
# AT stays the authority for everything QMI does not answer: per-neighbour SINR,
# NR neighbour cells (QMI has none), per-CC carrier aggregation, CQI/RI/MCS.
# This lib does not replace any AT read — it is an additive second source.
#
# Every function here writes ONE JSON object to stdout and returns a DISTINCT
# non-zero status on failure, so a caller keeps its last-good data instead of
# publishing "no cells were visible" when the read actually failed:
#     0  ok
#     2  unavailable — binary missing/not executable, or the QRTR node silent
#     3  call failed — non-zero exit, empty output, or no success marker
#     4  parse failed — the answer contained no usable rows
# A sourced lib must never take the caller down, so nothing here calls exit.
#
# The trap this lib exists to honour (qmi-transport.md, "The trap: signal is not
# attachment"): --nas-get-signal-info reports a plausible RSRP/RSRQ/SNR for a
# cell the modem is HEARING, whether or not it is attached to it — observed live
# with the modem at 'not-registered-searching'. Therefore qm_qmi_signal returns
# the signal values AND the registration state in one object: there is no way
# for a consumer to read one without the other.
#
# Sourced by qmanager_poller and the neighbour CGIs:
#   . /usr/lib/qmanager/qmi_read.sh
#   qm_qmi_available            # 0 = usable right now
#   qm_qmi_neighbours           # -> {"serving":{...}|null,"cells":[...]}
#   qm_qmi_signal               # -> {"lte":{...},"nr":{...}|null,"registered":b,"carrier":"..."|null}
#   qm_qmi_registration         # -> {"registered":bool,"carrier":"..."|null}
#   qm_qmi_band                 # -> {"band":"1","channel":"250","bandwidth_mhz":"10"}
#
# Overrides (the test stub, and a future QManager-owned binary bundle):
#   QM_QMI_BIN      default /data/gp/qmi/bin/qmicli
#   QM_QMI_LIBDIR   default /data/gp/qmi/lib   (private libqmi-glib/libqrtr-glib)
#   QM_QMI_DEV      default qrtr://3           (this device's NAS node)
#   QM_QMI_TIMEOUT  default 5 s per call
#
# KNOWN DEPENDENCY, recorded deliberately (docs/specs/neighbour-live-aim.md):
# this reads greenpacket's /data/gp/qmi/bin/qmicli. It is READ-ONLY — nothing
# here writes, installs, symlinks or reconfigures /data/gp (AGENTS.md hard rule
# 2). If the vendor relocates or removes the binary, qm_qmi_available goes false
# and every caller keeps working on AT; the degradation is visible, not silent.
# The follow-up is QManager's own qmicli + libs as a deploy-time payload, the
# same pattern as jq / speedtest / sms_tool.bin (hard rule 9).
#
# Install location: /usr/lib/qmanager/qmi_read.sh
# =============================================================================

[ -n "${_QM_QMI_READ_LOADED:-}" ] && return 0
_QM_QMI_READ_LOADED=1

QM_QMI_BIN="${QM_QMI_BIN:-/data/gp/qmi/bin/qmicli}"
QM_QMI_LIBDIR="${QM_QMI_LIBDIR:-/data/gp/qmi/lib}"
QM_QMI_DEV="${QM_QMI_DEV:-qrtr://3}"
QM_QMI_TIMEOUT="${QM_QMI_TIMEOUT:-5}"

# Portable `timeout`. platform.sh's qm_timeout dispatches to the CLI shape the
# resolved binary actually accepts, because BusyBox moved SECS from `-t SECS` to
# a positional argument in 1.30 and the targets straddle that change — a literal
# `timeout SECS CMD` exits 127 on the older build (docs/reference/
# connection-quality.md:265). The poller does not source platform.sh, so this lib
# sources it itself; qmanager_sites' pattern of depending on the caller is not
# available to a lib that two different process types load. The -f test is not
# decoration: `.` on a missing file kills the caller in ash/dash, `||` or not.
if ! command -v qm_timeout >/dev/null 2>&1 && [ -f /usr/lib/qmanager/platform.sh ]; then
    . /usr/lib/qmanager/platform.sh 2>/dev/null
fi

# Capability cache, per process. A positive result is reused for
# QM_QMI_AVAIL_TTL so a 1 Hz reader pays for the probe once a minute; a failure
# is cached for the same window and then re-probed, so a modem that comes back
# is picked up without restarting the reader.
#
# Subshell caveat, stated because it is the one thing that can silently make
# this cache useless: `x=$(qm_qmi_neighbours)` runs the function in a child, so
# an update to these variables is lost on return. The child INHERITS them
# though, so a caller that probes once in its own shell first
# (`qm_qmi_available && x=$(qm_qmi_neighbours)`) pays for one probe, not three.
QM_QMI_AVAIL=""
_QM_QMI_AVAIL_AT=""
QM_QMI_AVAIL_TTL="${QM_QMI_AVAIL_TTL:-60}"

# -----------------------------------------------------------------------------
# _qm_qmi_raw — one read-only qmicli call. Stdout is the raw answer.
#
# Returns 2 when the binary is not there/not executable, 3 when the call did not
# produce a usable answer. The bound is per call: the worst measured latency for
# any --nas-get-* read on this firmware is 260 ms, so the 5 s default is margin
# against a wedged modem, not against normal operation. If neither platform.sh's
# qm_timeout nor anything else can bound the call, it runs unbounded rather than
# not at all — a caller with a stuck modem loses its own read either way, and a
# neighbour view that refuses to work is worse than one that can block.
#
# The "Successfully got" marker check is the RDY-equivalent guard from
# qmi-transport.md's porting checklist: an exit-0 answer with no payload marker
# is a half-answered call, and caching device state from one is exactly how the
# poller once baked "model": "RDY" into a whole boot (AGENTS.md hard rule 8).
# -----------------------------------------------------------------------------
# Usage: _qm_qmi_raw <payload-marker> <qmicli args...>
#
# <payload-marker> is the substring qmicli prints on success for THAT call. It is
# per-call because qmicli's first line is not uniform — captured on this unit
# 2026-10-22:
#   --dms-get-operating-mode      "Operating mode retrieved:"
#   --nas-get-cell-location-info  "Successfully got cell location info"
#   --nas-get-signal-info         "Successfully got signal info"
#   --nas-get-serving-system      "Successfully got serving system:"
#   --nas-get-rf-band-info        "Successfully got RF band info"
# A single shared 'Successfully got' string made every --dms call return 3, which
# made qm_qmi_available report the whole transport unavailable on a healthy device
# (caught by the conductor running this lib on the target, not by a fixture test).
# Pass '-' to require only non-empty output.
_qm_qmi_raw() {
    local out rc marker
    marker=$1; shift
    if [ -z "$QM_QMI_BIN" ] || [ ! -f "$QM_QMI_BIN" ] || [ ! -x "$QM_QMI_BIN" ]; then
        return 2
    fi
    # Bound every call, and capture through a FILE, not a command substitution.
    #
    # Two traps, both measured on this unit 2026-10-22:
    # 1. `qm_timeout` is the house wrapper, but this device does NOT have it, so
    #    the fallback to busybox `timeout` is the real bound.
    # 2. `out=$(timeout 5 cmd)` is NOT bounded. busybox `timeout` kills the direct
    #    child, but any grandchild it spawned still holds the stdout PIPE, so the
    #    command substitution blocks until that grandchild exits. Measured: a stub
    #    running `sleep 30` returned in 5 s to a plain redirect and in 30 s through
    #    `$( )`. Redirecting to a file and reading it back is the only portable
    #    bound. This matters because a wedged qmicli inside the poller would stall
    #    a whole cycle.
    # Edge cases EC2 in docs/specs/neighbour-live-aim.md.
    if ! command -v qm_timeout >/dev/null 2>&1 && ! command -v timeout >/dev/null 2>&1; then
        # No timeout utility at all: refuse rather than risk an unbounded call.
        # Returning non-zero degrades the caller to AT, which is safe.
        return 3
    fi
    QM_QMI_TMP="${TMPDIR:-/tmp}/.qm_qmi_raw.$$"
    if command -v qm_timeout >/dev/null 2>&1; then
        LD_LIBRARY_PATH="$QM_QMI_LIBDIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
            qm_timeout "$QM_QMI_TIMEOUT" "$QM_QMI_BIN" -d "$QM_QMI_DEV" "$@" \
            >"$QM_QMI_TMP" 2>/dev/null
    else
        LD_LIBRARY_PATH="$QM_QMI_LIBDIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
            timeout "$QM_QMI_TIMEOUT" "$QM_QMI_BIN" -d "$QM_QMI_DEV" "$@" \
            >"$QM_QMI_TMP" 2>/dev/null
    fi
    rc=$?
    if [ -s "$QM_QMI_TMP" ]; then
        out=$(cat "$QM_QMI_TMP")
    else
        out=""
    fi
    rm -f "$QM_QMI_TMP"
    [ "$rc" -eq 0 ] || return 3
    [ -n "$out" ] || return 3
    if [ "$marker" != "-" ]; then
        printf '%s\n' "$out" | grep -qF "$marker" || return 3
    fi
    printf '%s\n' "$out"
    return 0
}

# -----------------------------------------------------------------------------
# qm_qmi_available — 0 when this device can answer QMI right now, else 1.
#
# A presence test is not an availability test (the lesson behind hard rule 8:
# the device node existing proves nothing), so this makes a real call —
# --dms-get-operating-mode, the same precondition scripts-dev/qmi-probe.sh uses,
# because it answers on a modem that is still booting while the NAS reads do not.
# -----------------------------------------------------------------------------
qm_qmi_available() {
    local now rc
    now=$(date +%s)
    if [ -n "$QM_QMI_AVAIL" ]; then
        if [ $(( now - _QM_QMI_AVAIL_AT )) -le "$QM_QMI_AVAIL_TTL" ] 2>/dev/null; then
            [ "$QM_QMI_AVAIL" = "1" ]
            return $?
        fi
    fi
    _QM_QMI_AVAIL_AT=$now
    _qm_qmi_raw 'Operating mode retrieved' --dms-get-operating-mode >/dev/null
    rc=$?
    if [ "$rc" -eq 0 ]; then
        QM_QMI_AVAIL=1
        return 0
    fi
    QM_QMI_AVAIL=0
    return 1
}

# =============================================================================
# PARSERS
# =============================================================================
# The values below are read off captured device output, one field per line. The
# reference bytes for the neighbour read are
# .orchestra/scratch/qmi-fix/neighbour-sample.txt; the awk programs are written
# against those lines, not against the libqmi C structs.
#
# Every awk program in this file is a shell variable rather than an inline
# heredoc so the caller keeps a single quoted word (sites.sh's AWK_AGG/JQ_GET
# shape). "\047" is an apostrophe — awk's own single quotes would end the shell
# quoting, and every value in this output is wrapped in them.

# qmicli --nas-get-cell-location-info  ->  {"serving":{...}|null,"cells":[...]}
#
# Cell shape is the API contract's live row (docs/specs/neighbour-live-aim.md):
#   {"type":"intra"|"inter","rat":"LTE","earfcn":"250","pci":"104",
#    "rsrp":-77.9,"rsrq":-11.0,"rssi":-50.3,"serving":true,"source":"qmi"}
#
# Only the two LTE sections carry cells. `LTE Info Neighboring GSM/WCDMA`,
# `LTE Timing Advance` and `5GNR` are flush boundaries with an empty section:
# this call returns no NR neighbour cells (qmi-transport.md, "The NR gap"), and
# the `5GNR` line only carries the serving ARFCN. Inventing NR rows from it
# would be a lie the UI cannot distinguish from data.
_QM_QMI_NEIGHBOURS_AWK='
function qv(s,   a, b) {
    # first single-quoted token on the line: EUTRA Absolute RF Channel Number: (E-UTRA band 1: 2100)
    a = index(s, "\047")
    if (a == 0) return ""
    s = substr(s, a + 1)
    b = index(s, "\047")
    if (b == 0) return ""
    return substr(s, 1, b - 1)
}
function jnum(v) {
    # A measurement is a JSON number or null — never 0 as a stand-in. Anything
    # qmicli prints for "not reported" (`n/a`, empty, a torn line) is null,
    # because 0 is a measurement and null is "the modem did not say".
    if (v !~ /^-?[0-9]+(\.[0-9]+)?$/) return "null"
    return v
}
function jstr(v) {
    # An identity (PCI, EARFCN) is a quoted digit string in the API.
    if (v !~ /^[0-9]+$/) return "null"
    return "\"" v "\""
}
function flush(   svc, row) {
    if (!open_) return
    open_ = 0
    if (pci == "") return
    svc = "false"
    if (sec_svc != "" && pci == sec_svc && !svc_done) { svc = "true"; svc_done = 1 }
    row = "{\"type\":\"" sec "\",\"rat\":\"LTE\",\"earfcn\":" jstr(sec_earfcn) \
          ",\"pci\":" jstr(pci) \
          ",\"rsrp\":" jnum(rsrp) ",\"rsrq\":" jnum(rsrq) ",\"rssi\":" jnum(rssi) \
          ",\"serving\":" svc ",\"source\":\"qmi\"}"
    # NOTE: build the separator into its own variable. `cells = cells (n++ ? "," : "") row`
    # is NOT concatenation to awk — a name followed directly by "(" is a function
    # call, so busybox awk reported "Call to undefined function" for `cells(`.
    # Found by running this on the target; it reproduces with -f as well.
    sep = (n++ ? "," : "")
    cells = cells sep row
    if (svc == "true")
        serving = "{\"pci\":" jstr(pci) ",\"earfcn\":" jstr(sec_earfcn) \
                  ",\"rsrp\":" jnum(rsrp) ",\"rsrq\":" jnum(rsrq) \
                  ",\"rssi\":" jnum(rssi) "}"
}
/^Intrafrequency LTE Info/ { flush(); sec = "intra"; sec_earfcn = ""; sec_svc = ""; next }
/^Interfrequency LTE Info/ { flush(); sec = "inter"; sec_earfcn = ""; sec_svc = ""; next }
/^(LTE Info Neighboring|5GNR|LTE Timing Advance)/ { flush(); sec = ""; next }
sec == "" { next }
/^[ \t]*EUTRA Absolute RF Channel Number:/ { sec_earfcn = qv($0); next }
/^[ \t]*Serving Cell ID:/                  { sec_svc = qv($0); next }
/^[ \t]*Cell \[[0-9]+\]:/ {
    flush()
    open_ = 1; pci = ""; rsrp = ""; rsrq = ""; rssi = ""
    next
}
!open_ { next }
/^[ \t]*Physical Cell ID:/ { pci = qv($0); next }
/^[ \t]*RSRQ:/             { rsrq = qv($0); next }
/^[ \t]*RSRP:/             { rsrp = qv($0); next }
/^[ \t]*RSSI:/             { rssi = qv($0); next }
END {
    flush()
    # A successful answer on this firmware always includes the serving cell as
    # Cell [0]. Zero rows therefore means a truncated/empty reply, which is a
    # read failure (exit 4) — never "the air is empty", which is a claim no
    # consumer could tell apart from a working but empty scan.
    if (n == 0) exit 4
    printf "{\"serving\":%s,\"cells\":[%s]}\n", (serving == "" ? "null" : serving), cells
}
'

# qmicli --nas-get-signal-info  ->  "lte":{...},"nr":{...}|null   (fragment)
#
# Units travel inside the quotes ('-53 dBm'), which is why jnum strips at the
# first space. LTE carries RSSI; the 5G block does not. `nr` is null when the
# modem printed no 5G section at all — on LTE-only attach there is none.
_QM_QMI_SIGNAL_AWK='
function qv(s,   a, b) {
    a = index(s, "\047")
    if (a == 0) return ""
    s = substr(s, a + 1)
    b = index(s, "\047")
    if (b == 0) return ""
    return substr(s, 1, b - 1)
}
function jnum(v,   t) {
    t = v
    sub(/[ \t].*$/, "", t)
    if (t !~ /^-?[0-9]+(\.[0-9]+)?$/) return "null"
    return t
}
/^[ \t]*LTE:[ \t]*$/ { blk = "lte"; next }
/^[ \t]*5G:[ \t]*$/  { blk = "nr"; next }
{
    if (blk == "") next
    line = $0
    sub(/^[ \t]+/, "", line)
    if (index(line, ":") == 0) next
    key = substr(line, 1, index(line, ":") - 1)
    if (key == "RSRP")      v[blk "_rsrp"] = qv(line)
    else if (key == "RSRQ") v[blk "_rsrq"] = qv(line)
    else if (key == "RSSI") v[blk "_rssi"] = qv(line)
    else if (key == "SNR")  v[blk "_snr"] = qv(line)
    else next
    seen = 1
    if (blk == "nr") has5g = 1
}
END {
    if (!seen) exit 4
    printf "\"lte\":{\"rsrp\":%s,\"rsrq\":%s,\"rssi\":%s,\"snr\":%s},\"nr\":%s\n",
        jnum(v["lte_rsrp"]), jnum(v["lte_rsrq"]), jnum(v["lte_rssi"]), jnum(v["lte_snr"]),
        (has5g ? "{\"rsrp\":" jnum(v["nr_rsrp"]) ",\"rsrq\":" jnum(v["nr_rsrq"]) \
                 ",\"snr\":" jnum(v["nr_snr"]) "}" : "null")
}
'

# qmicli --nas-get-serving-system  ->  "registered":bool,"carrier":...  (fragment)
#
# `Description` is read only from the Current PLMN block: the same word appears
# in other blocks of this answer, and taking the first one on the page would
# attach the wrong operator name to a registered state.
_QM_QMI_REG_AWK='
function qv(s,   a, b) {
    a = index(s, "\047")
    if (a == 0) return ""
    s = substr(s, a + 1)
    b = index(s, "\047")
    if (b == 0) return ""
    return substr(s, 1, b - 1)
}
/^[ \t]*Registration state:/ { state = qv($0); next }
/^[ \t]*Current PLMN:/       { plmn = 1; next }
plmn && /^[ \t]*Description:/ { if (desc == "") desc = qv($0); plmn = 0; next }
END {
    if (state == "") exit 4
    # The PLMN description is a string the modem supplies: strip the two
    # characters that could break the JSON envelope it is pasted into.
    gsub(/["\\]/, "", desc)
    printf "\"registered\":%s,\"carrier\":%s\n",
        (state == "registered" ? "true" : "false"),
        (desc == "" || desc == "n/a" ? "null" : "\"" desc "\"")
}
'

# qmicli --nas-get-rf-band-info  ->  {"band":"1","channel":"250","bandwidth_mhz":"10"}
#
# UNTESTED on the O5A: scripts-dev/qmi-probe.sh measured the three --nas-get-*
# reads this feature uses and not this one, so the field names below come from
# libqmi's documented output, not from a capture on this unit. It is here
# because the spec lists it, and it is deliberately not on any live path — a
# wrong guess here cannot affect the neighbour view.
_QM_QMI_BAND_AWK='
function qv(s,   a, b) {
    a = index(s, "\047")
    if (a == 0) return ""
    s = substr(s, a + 1)
    b = index(s, "\047")
    if (b == 0) return ""
    return substr(s, 1, b - 1)
}
function jstr(v) {
    if (v !~ /^[0-9]+$/) return "null"
    return "\"" v "\""
}
/^[ \t]*Active Band Class:/ { band = qv($0); sub(/^[a-z]+-?/, "", band); seen = 1; next }
/^[ \t]*Active Channel:/    { chan = qv($0); seen = 1; next }
# `Bandwidth:` is BOTH a section header and a key line. qv() returns "" for the
# header (no quoted token), so only the key line sets bw.
/^[ \t]*Bandwidth:/         { v = qv($0); if (v != "") { bw = v; seen = 1 }; next }
END {
    if (!seen) exit 4
    printf "{\"band\":%s,\"channel\":%s,\"bandwidth_mhz\":%s}\n", jstr(band), jstr(chan), jstr(bw)
}
'

# =============================================================================
# PUBLIC READERS
# =============================================================================

# -----------------------------------------------------------------------------
# qm_qmi_neighbours — LTE neighbour cells plus the serving cell identified in
# the same answer.
# Output: {"serving":{"pci","earfcn","rsrp","rsrq","rssi"}|null,
#          "cells":[{"type","rat","earfcn","pci","rsrp","rsrq","rssi","serving","source"}]}
# `serving` is true exactly when the cell's PCI equals that section's
# `Serving Cell ID` — the same match greenpacket makes (gp-qmi.sh:155).
# -----------------------------------------------------------------------------
qm_qmi_neighbours() {
    local raw json rc
    qm_qmi_available || return 2
    raw=$(_qm_qmi_raw 'Successfully got cell location info' --nas-get-cell-location-info)
    rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
    json=$(printf '%s\n' "$raw" | awk "$_QM_QMI_NEIGHBOURS_AWK")
    rc=$?
    [ "$rc" -eq 0 ] || return 4
    [ -n "$json" ] || return 4
    printf '%s\n' "$json"
    return 0
}

# -----------------------------------------------------------------------------
# qm_qmi_registration — attachment state and the operator name the modem states.
# Output: {"registered":bool,"carrier":"Jazz"|null}
# -----------------------------------------------------------------------------
qm_qmi_registration() {
    local raw frag rc
    qm_qmi_available || return 2
    raw=$(_qm_qmi_raw 'Successfully got serving system' --nas-get-serving-system)
    rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
    frag=$(printf '%s\n' "$raw" | awk "$_QM_QMI_REG_AWK")
    rc=$?
    [ "$rc" -eq 0 ] || return 4
    printf '{%s}\n' "$frag"
    return 0
}

# -----------------------------------------------------------------------------
# qm_qmi_signal — serving signal values AND the registration state, one object.
# Output: {"lte":{"rsrp","rsrq","rssi","snr"},"nr":{...}|null,
#          "registered":bool,"carrier":"Jazz"|null}
#
# The registration half is not optional and not a separate call for the caller:
# this answer is the ONLY place a consumer of QMI signal learns whether the modem
# is attached to the cell it is reporting. Both halves must succeed — a
# registered flag without values, or values with no attachment state, are both
# worse than no answer, so either failure returns non-zero and the caller keeps
# its last-good data.
#
# Two calls, not one: --nas-get-signal-info and --nas-get-serving-system are
# each measured at 40 ms / 30 ms separately on this unit, and combining them
# into one qmicli invocation is unverified on this binary. 70 ms of verified
# calls beats one unverified shortcut.
# -----------------------------------------------------------------------------
qm_qmi_signal() {
    local sig reg sig_frag reg_frag rc
    qm_qmi_available || return 2

    sig=$(_qm_qmi_raw 'Successfully got signal info' --nas-get-signal-info)
    rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
    sig_frag=$(printf '%s\n' "$sig" | awk "$_QM_QMI_SIGNAL_AWK")
    rc=$?
    [ "$rc" -eq 0 ] || return 4

    reg=$(_qm_qmi_raw 'Successfully got serving system' --nas-get-serving-system)
    rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
    reg_frag=$(printf '%s\n' "$reg" | awk "$_QM_QMI_REG_AWK")
    rc=$?
    [ "$rc" -eq 0 ] || return 4

    [ -n "$sig_frag" ] || return 4
    [ -n "$reg_frag" ] || return 4
    printf '{%s,%s}\n' "$sig_frag" "$reg_frag"
    return 0
}

# -----------------------------------------------------------------------------
# qm_qmi_band — active band, channel and bandwidth. Complement only: AT+QCAINFO
# is richer per component carrier, so nothing derived from this replaces it.
# Output: {"band":"1","channel":"250","bandwidth_mhz":"10"}
# -----------------------------------------------------------------------------
qm_qmi_band() {
    local raw json rc
    qm_qmi_available || return 2
    raw=$(_qm_qmi_raw 'Successfully got RF band info' --nas-get-rf-band-info)
    rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
    json=$(printf '%s\n' "$raw" | awk "$_QM_QMI_BAND_AWK")
    rc=$?
    [ "$rc" -eq 0 ] || return 4
    [ -n "$json" ] || return 4
    printf '%s\n' "$json"
    return 0
}
