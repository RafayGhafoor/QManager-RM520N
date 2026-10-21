#!/bin/sh
# =============================================================================
# phy_metrics.sh — read-only PHY-layer reader (CQI / RI / MCS / beams) + archive
# =============================================================================
# The physical layer QManager's radio cards do not show: CQI, RI, PMI, MIMO
# layers, TM mode, UL/DL MCS, TX power, RRC state and the SSB beam table.
# Two sources, both measured on this unit (GreenPacket O5A Pro, RG520N-EB,
# firmware LE.UM.6.2.3.r1-03100-SDX65.0, 2026-10-22 — the table is repeated in
# docs/reference/platform-matrix.md → "RG520N-EB — PHY command availability"):
#
#   1. `ubus call modemd status` — one cache read, NO AT lock, no qmicli fork.
#      Carries cqi, nr_cqi, lte_rank, nr_rank, lte_dl_tx_mode, regStat, regName
#      and rat. Coarse, and NOT usable for MCS: modemd's own lte_ulmcs /
#      nr_ulmcs report the QNWCFG enable flag, not the MCS (measured live
#      2026-08-26 by the greenpacket project: AT moved 22 -> 21 -> 19 across
#      six reads while modemd sat at a constant 1).
#   2. AT, through `qcmd` and only `qcmd`, for the precise fields:
#        AT+QNWCFG="lte_csi"          -> f1, RI,   CQI, PMI
#        AT+QNWCFG="nr5g_csi"         -> f1, RI,   CQI, PMI
#        AT+QNWCFG="lte_ulMCS"        -> enable, MCS, ...
#        AT+QNWCFG="nr5g_ulMCS"       -> enable, MCS, ...
#        AT+QNWCFG="nr5g_dlMCS"       -> enable, MCS, ...
#        AT+QNWCFG="lte_mimo_layers"  -> ul, dl      (mode-gated, see below)
#        AT+QNWCFG="nr5g_mimo_layers" -> ul, dl      (mode-gated, see below)
#        AT+QNWCFG="lte_dl_tx_mode"   -> mode        (no enable field)
#        AT+QNWCFG="rrc_state"        -> enable, "RAT", state
#        AT+QNWCFG="nr5g_tx_pwr"      -> enable, PUSCH, PUCCH, SRS, PRACH
#        AT+QNWCFG="ssb_beam_id"      -> one line per beam, see R2 below
#
# TWO COMMANDS THAT MUST NEVER BE SENT ON THIS DEVICE:
#   AT+QNWCFG="lte_tx_pwr"    -> "ERROR: command_failed" (absent on RG520N-EB)
#   AT+QNWCFG="nr5g_pathloss" -> "ERROR: command_failed" (absent on RG520N-EB)
# A command that always errors is a wasted AT lock hold every cycle, and inside
# a compound command it takes the whole batch down with it (qcmd classifies a
# reply containing ERROR as a failure and prints NOTHING on stdout). Both are
# therefore absent from the API by design, not missing by omission. A port to
# another modem must re-probe them (platform-matrix.md).
#
# NO SETTERS. Every working command above already answers enabled on this unit,
# so no `AT+QNWCFG="...",1` enable write is issued: a setter on the AT port is a
# radio write, and this is a read path. The MCS readers still honour the enable
# field — when it reads 0 the value is not a measurement, and publishing it
# would be a fabricated number. greenpacket's AT_ENABLE list exists because a
# different unit arrived with reporting disabled; if a port finds
# `AT+QNWCFG="ssb_beam_id"` answering `,0` with no rows, that port must enable
# it once, deliberately, and not from here.
#
# -----------------------------------------------------------------------------
# BLOCKING MODEL — the same three rules as qmi_read.sh, for the same reasons
# -----------------------------------------------------------------------------
# 1. Every external call is bounded by a real `timeout` (qm_timeout -> busybox
#    timeout -> refuse). qcmd's own bound is the AT flock wait; the AT read
#    inside it (atcli_smd11) has none, so a wedged modem blocks there forever
#    and the poller's whole cycle stalls behind it.
# 2. The answer is captured through a FILE, never a command substitution:
#    `x=$(timeout 15 cmd)` is NOT bounded, because the killed child's own
#    children still hold the stdout pipe open and the substitution waits for
#    them (measured, qmi_read.sh:114-127). Redirecting to a file and reading it
#    back is the only portable bound.
# 3. A lib sourced by a daemon never calls exit and never dies on a bad read:
#    every function returns a distinct status and leaves the caller alive.
#
# FUNCTION STATUS CODES
#     0  ok
#     2  unavailable — ubus/modemd missing, or no usable `timeout` bound
#     3  call failed — non-zero exit, empty output, or the modem said ERROR
#     4  parse failed — the answer contained no usable field
#
# AT BATCHING. Eleven separate qcmd calls hold the AT flock for ~6 s (each call
# pays the ~0.27 s port drain plus the command), which is why the reads are
# batched into AT MOST TWO compound commands, split by RAT so one transient
# ERROR costs half the fields rather than all of them. The RAT split is the
# natural blast radius: on an LTE-only attach the NR group simply has nothing to
# report, and losing it costs fields that are absent anyway.
#
# Overrides:  QM_PHY_TIMEOUT (15 s per call), QM_PHY_BEAM_MAX (4),
#             QM_PHY_ARCHIVE_DIR (/usrdata/qmanager/metrics),
#             QM_PHY_ARCHIVE_KEEP_DAYS (30), QM_PHY_UBUS (binary path)
#
# Sourced by qmanager_poller:
#   . /usr/lib/qmanager/phy_metrics.sh
#   qm_phy_available                      # 0 = usable right now (real call, TTL-cached)
#   qm_phy_modemd                         # -> {"cqi":..,"nr_cqi":..,"registered":b,..}
#   qm_phy_at [network_type]              # -> {"lte":{..},"nr":{..},"rrc":{..},"beams":[..]}
#   qm_phy_snapshot <modemd> <at> <ctx>   # -> the API snapshot object
#   qm_phy_archive_row <snapshot> <temp> <total_cells>
#
# Install location: /usr/lib/qmanager/phy_metrics.sh
# =============================================================================

[ -n "${_QM_PHY_METRICS_LOADED:-}" ] && return 0
_QM_PHY_METRICS_LOADED=1

QM_PHY_TIMEOUT="${QM_PHY_TIMEOUT:-15}"
QM_PHY_BEAM_MAX="${QM_PHY_BEAM_MAX:-4}"
QM_PHY_ARCHIVE_DIR="${QM_PHY_ARCHIVE_DIR:-/usrdata/qmanager/metrics}"
QM_PHY_ARCHIVE_KEEP_DAYS="${QM_PHY_ARCHIVE_KEEP_DAYS:-30}"

# Portable `timeout`: the poller does not source platform.sh, so this lib
# sources it for qm_timeout exactly as qmi_read.sh does. The -f test is not
# decoration — `.` on a missing file kills the caller in ash/dash, `||` or not.
if ! command -v qm_timeout >/dev/null 2>&1 && [ -f /usr/lib/qmanager/platform.sh ]; then
    . /usr/lib/qmanager/platform.sh 2>/dev/null
fi

# Capability cache, per process: a positive probe is reused for QM_PHY_AVAIL_TTL
# so a caller that gates on it once a minute pays for one `ubus call` and not
# two; a failure is re-probed after the same window, so a modemd that comes back
# is picked up without restarting the poller. Subshell caveat, same as
# qmi_read.sh: `x=$(qm_phy_available)` cannot write these back, but the child
# inherits them, so probe once in the caller's own shell.
QM_PHY_AVAIL=""
_QM_PHY_AVAIL_AT=""
QM_PHY_AVAIL_TTL="${QM_PHY_AVAIL_TTL:-60}"

# -----------------------------------------------------------------------------
# _qm_phy_ubus — resolve the ubus binary once per process.
#
# `command -v` first (this is the vendor's own tool, on the vendor's PATH), then
# the fixed locations OpenWRT-style images use, because a root helper started by
# systemd does not always inherit the shell PATH that an interactive login has.
# -----------------------------------------------------------------------------
_QM_PHY_UBUS_BIN="${QM_PHY_UBUS:-}"
# qm/jq resolver. Do NOT rely on PATH: the poller unit sets one that includes
# /usrdata/qmanager/bin, but cgi_base.sh's PATH does not, so a future CGI calling
# these functions would silently lose jq and get empty output. Resolve the
# binary once, preferring the deployed shim, exactly as qmi_read.sh resolves qmicli.
_QM_PHY_JQ_BIN=""
_qm_phy_jq() {
    local b
    [ -n "$_QM_PHY_JQ_BIN" ] && { printf '%s' "$_QM_PHY_JQ_BIN"; return 0; }
    for b in "${QM_PHY_JQ:-}" /usrdata/qmanager/bin/jq /opt/bin/jq /usr/bin/jq /bin/jq; do
        [ -n "$b" ] && [ -x "$b" ] && { _QM_PHY_JQ_BIN="$b"; printf '%s' "$b"; return 0; }
    done
    b=$(command -v jq 2>/dev/null) || b=""
    [ -n "$b" ] && { _QM_PHY_JQ_BIN="$b"; printf '%s' "$b"; return 0; }
    return 1
}

_qm_phy_ubus() {
    local b
    if [ -n "$_QM_PHY_UBUS_BIN" ]; then
        printf '%s' "$_QM_PHY_UBUS_BIN"
        return 0
    fi
    b=$(command -v ubus 2>/dev/null)
    if [ -n "$b" ]; then
        _QM_PHY_UBUS_BIN="$b"
        printf '%s' "$b"
        return 0
    fi
    for b in /sbin/ubus /bin/ubus /usr/sbin/ubus /usr/bin/ubus; do
        if [ -x "$b" ]; then
            _QM_PHY_UBUS_BIN="$b"
            printf '%s' "$b"
            return 0
        fi
    done
    return 1
}

# -----------------------------------------------------------------------------
# _qm_phy_capture <timeout-secs> <command> [args...]
#
# Runs one external command with a hard bound and leaves its stdout in
# $_QM_PHY_CAP (a shell variable, in the CALLER's shell — so call it directly,
# not from a subshell, when the answer is needed). Returns the command's exit
# status, or 2 when nothing on this device can bound the call.
#
# Refusing beats running unbounded: the caller degrades to nulls for that cycle,
# which the UI renders as "—". An unbounded call stalls every AT consumer behind
# a wedged modem, which is a whole-boot failure.
# -----------------------------------------------------------------------------
_QM_PHY_CAP=""
_qm_phy_capture() {
    local to="$1" fp
    shift
    _QM_PHY_CAP=""
    _QM_PHY_CAPFILE="${TMPDIR:-/tmp}/.qm_phy_cap.$$"
    if command -v qm_timeout >/dev/null 2>&1; then
        qm_timeout "$to" "$@" >"$_QM_PHY_CAPFILE" 2>/dev/null
    elif command -v timeout >/dev/null 2>&1; then
        timeout "$to" "$@" >"$_QM_PHY_CAPFILE" 2>/dev/null
    else
        rm -f "$_QM_PHY_CAPFILE"
        return 2
    fi
    fp=$?
    if [ -s "$_QM_PHY_CAPFILE" ]; then
        _QM_PHY_CAP=$(cat "$_QM_PHY_CAPFILE")
    fi
    rm -f "$_QM_PHY_CAPFILE"
    return "$fp"
}

# =============================================================================
# SOURCE 1 — ubus / modemd
# =============================================================================
# THE WHITELIST IS THE WHOLE POINT. `ubus call modemd status` also carries the
# subscriber identity (imei / imsi / iccid) and the vendor's whole status set.
# AGENTS.md hard rule 10 forbids persisting or publishing any of it, so this
# reader copies NAMED KEYS and nothing else — the jq program below cannot emit a
# key it does not name, and a grep for those three identifiers is part of the
# review of this file.
#
# modemd prints its cache as pretty JSON with every value QUOTED, so each value
# needs a coercion: a quoted number becomes a JSON number, anything that is not
# a number (`-`, `n/a`, empty) becomes null. Never 0 — 0 is a measurement.
_QM_PHY_MODEMD_JQ='
def num: if type == "number" then . elif type == "string" then (tonumber? // null) else null end;
def str: if type == "string" then . else "" end;
(.regStat | str) as $rs
| (.regName | str) as $rn
| (.rat | str) as $rat
| {cqi:             (.cqi | num),
   nr_cqi:          (.nr_cqi | num),
   lte_mimo_layers: (.lte_rank | num),
   nr_mimo_layers:  (.nr_rank | num),
   lte_tm_mode:     (.lte_dl_tx_mode | num),
   # "REGISTERD" is the spelling this firmware actually prints, confirmed on
   # this unit and handled by the vendor UI too (greenpacket
   # gp-dashboard-v2.js:267). Both spellings are accepted so a firmware update
   # that corrects it changes nothing here.
   # null when modemd reported no registration state at all — that is "not
   # known", which is not the same claim as "not registered".
   registered: (if $rs == "" then null
                elif ($rs == "REGISTERD" or $rs == "REGISTERED") then true
                else false end),
   carrier: (if $rn == "" then null else $rn end),
   rat:     (if $rat == "" then null else $rat end)}'

# qm_phy_modemd — one `ubus call modemd status`, whitelisted keys only.
# Prints a compact JSON object; status 0 ok, 2 no ubus, 3 call failed, 4 parse.
qm_phy_modemd() {
    local bin out rc
    bin=$(_qm_phy_ubus)
    if [ -z "$bin" ]; then
        return 2
    fi
    _qm_phy_capture "$QM_PHY_TIMEOUT" "$bin" call modemd status
    rc=$?
    [ "$rc" -eq 0 ] || return 3
    [ -n "$_QM_PHY_CAP" ] || return 3
    out=$(printf '%s' "$_QM_PHY_CAP" | "$(_qm_phy_jq)" -c "$_QM_PHY_MODEMD_JQ" 2>/dev/null)
    rc=$?
    [ "$rc" -eq 0 ] || return 4
    [ -n "$out" ] || return 4
    printf '%s\n' "$out"
    return 0
}

# -----------------------------------------------------------------------------
# qm_phy_available — 0 when this device can answer PHY reads right now.
#
# A presence test is not an availability test (the lesson behind AGENTS.md hard
# rule 8: the device node existing proves nothing), so this makes a real read —
# the same `ubus call modemd status` qm_phy_modemd uses — and caches the answer
# for QM_PHY_AVAIL_TTL. The poller's Tier 3 gates on it: when the vendor's modem
# daemon is not answering, the AT half cannot populate the fields this tier
# exists for, so spending two AT lock holds on it would cost the port time for
# nothing.
# -----------------------------------------------------------------------------
qm_phy_available() {
    local now rc
    now=$(date +%s)
    if [ -n "$QM_PHY_AVAIL" ]; then
        if [ $(( now - _QM_PHY_AVAIL_AT )) -le "$QM_PHY_AVAIL_TTL" ] 2>/dev/null; then
            [ "$QM_PHY_AVAIL" = "1" ]
            return $?
        fi
    fi
    _QM_PHY_AVAIL_AT=$now
    qm_phy_modemd >/dev/null
    rc=$?
    if [ "$rc" -eq 0 ]; then
        QM_PHY_AVAIL=1
        return 0
    fi
    QM_PHY_AVAIL=0
    return 1
}

# =============================================================================
# SOURCE 2 — AT (two compound commands, at most)
# =============================================================================
# Group A: the LTE anchor plus the RAT-agnostic RRC read. Group B: the NR leg
# plus the beam table. Split by RAT, never merged into one eleven-command line:
# qcmd classifies the WHOLE reply, so a single `*ERROR*` anywhere in it blanks
# every field in the batch (qcmd:175; the poller's own boot chain was split for
# this exact reason, poller:1284-1296).
QM_PHY_AT_LTE='AT+QNWCFG="lte_csi";+QNWCFG="lte_ulMCS";+QNWCFG="lte_dl_tx_mode";+QNWCFG="rrc_state"'
QM_PHY_AT_NR='AT+QNWCFG="nr5g_csi";+QNWCFG="nr5g_ulMCS";+QNWCFG="nr5g_dlMCS";+QNWCFG="nr5g_tx_pwr";+QNWCFG="ssb_beam_id"'

# The AT parser. Field semantics were pinned empirically by cross-checking
# against modemd's own cache at the same instant (greenpacket
# gp-metricsd.awk:160-215 and detailed-metrics.md, re-confirmed on this unit
# 2026-10-22):
#   "lte_csi",<f1>,<RI>,<CQI>,<PMI>              -> RI=f[3] CQI=f[4] PMI=f[5]
#   "lte_ulMCS",<enable>,<MCS>,...               -> MCS=f[3], only when enable!=0
#   "lte_mimo_layers",<ul>,<dl>                  -> DL=f[3]
#   "lte_dl_tx_mode",<mode>                      -> NO enable field; mode=f[2]
#   "rrc_state",<enable>,"<RAT>",<state>         -> RAT=f[3] state=f[4]
#   "nr5g_tx_pwr",<enable>,<PUSCH>,<PUCCH>,<SRS>,<PRACH>
#   "ssb_beam_id",<enable>,<count>,<beam>,<rsrp>,<rsrq>,<pci>
#       ONE LINE PER BEAM. f[3] is the COUNT on every line, identical, and is
#       NOT a beam id — the trap that hid here once is that both read 6 when
#       this was first wired up (docs/reference/qmi-transport.md, "The NR gap").
#       Beam id is f[4], and the lines arrive strongest-first.
QM_PHY_AT_AWK='
function trim(s) { gsub(/^[ \t\r]+|[ \t\r]+$/, "", s); return s }
function unq(s)  { gsub(/^"|"$/, "", s); return trim(s) }
# A measurement is a JSON number INSIDE its physical range, or null. 0 is a
# measurement for MCS and PMI, so it is not filtered; it is not a rank
# indicator, a CQI or a TM mode, so for those a 0 is the modem saying "nothing"
# and publishing it as a measurement would be a fabricated number.
function rng(v, lo, hi) {
    v = trim(v)
    if (v !~ /^-?[0-9]+$/) return ""
    if (v + 0 < lo || v + 0 > hi) return ""
    return sprintf("%d", v + 0)
}
function jn(v) { return (v == "") ? "null" : v }

BEGIN { nb = 0; rat = "" }

# Anchor on the reply prefix at column 0. Line 1 of a qcmd answer is the echoed
# command, which CONTAINS these command names — a pattern that did not anchor
# would parse the echo (docs/reference/at-command-transport.md, "Parsers must
# anchor on the reply prefix").
/^\+QNWCFG: / {
    body = substr($0, 11)
    n = split(body, F, ",")
    if (n < 2) next
    key = unq(F[1])

    if (key == "lte_csi" && n >= 5) {
        l_ri = rng(F[3], 1, 8); l_cqi = rng(F[4], 1, 15); l_pmi = rng(F[5], 0, 31)
    } else if (key == "nr5g_csi" && n >= 5) {
        n_ri = rng(F[3], 1, 8); n_cqi = rng(F[4], 1, 15); n_pmi = rng(F[5], 0, 31)
    } else if (key == "lte_ulMCS" && n >= 3) {
        if (trim(F[2]) != "0") l_ulmcs = rng(F[3], 0, 31)
    } else if (key == "nr5g_ulMCS" && n >= 3) {
        if (trim(F[2]) != "0") n_ulmcs = rng(F[3], 0, 31)
    } else if (key == "nr5g_dlMCS" && n >= 3) {
        if (trim(F[2]) != "0") n_dlmcs = rng(F[3], 0, 31)
    } else if (key == "lte_mimo_layers" && n >= 3) {
        l_layers = rng(F[3], 1, 8)
    } else if (key == "nr5g_mimo_layers" && n >= 3) {
        n_layers = rng(F[3], 1, 8)
    } else if (key == "lte_dl_tx_mode" && n >= 2) {
        l_tm = rng(F[2], 1, 10)
    } else if (key == "rrc_state" && n >= 4) {
        t = unq(F[3])
        if (t ~ /^[A-Za-z0-9]+$/) rat = t
        rrc_state = rng(F[4], 0, 6)
    } else if (key == "nr5g_tx_pwr" && n >= 6) {
        # -32768 is the modem sentinel for "not transmitting on this channel",
        # not a reading; it falls out of the range check below.
        n_txp = rng(F[3], -60, 40)
    } else if (key == "ssb_beam_id" && n >= 7) {
        # Range-check before accepting, so a line whose layout differs (a
        # header carrying only the count, a firmware that omits a field) can
        # never be read as a beam with rsrp 6.
        if (rng(F[4], 0, 63) != "" && rng(F[5], -200, 0) != "" && rng(F[7], 1, 1007) != "") {
            nb++
            B_id[nb] = F[4] + 0
            B_rp[nb] = F[5] + 0
            B_rq[nb] = (rng(F[6], -50, 0) == "") ? "" : F[6] + 0
            B_pc[nb] = F[7] + 0
        }
    }
    next
}

END {
    # Strongest first, capped. Insertion sort: busybox awk has no asort, and the
    # list is at most a handful of beams.
    for (i = 2; i <= nb; i++) {
        k = i
        while (k > 1 && B_rp[k] > B_rp[k - 1]) {
            t = B_id[k]; B_id[k] = B_id[k - 1]; B_id[k - 1] = t
            t = B_rp[k]; B_rp[k] = B_rp[k - 1]; B_rp[k - 1] = t
            t = B_rq[k]; B_rq[k] = B_rq[k - 1]; B_rq[k - 1] = t
            t = B_pc[k]; B_pc[k] = B_pc[k - 1]; B_pc[k - 1] = t
            k--
        }
    }
    out = (nb > beam_max) ? beam_max : nb
    beams = ""
    for (i = 1; i <= out; i++) {
        # NOTE: `beams = beams (cond ? ... : ...)` is NOT concatenation to awk — a
        # name followed directly by "(" is parsed as a FUNCTION CALL, so busybox awk
        # dies with "Call to undefined function" at parse time. Third occurrence of
        # this in this repo (see qmi_read.sh and neighbours_scan). Build the
        # separator into its own variable.
        sep = (i > 1 ? "," : "")
        beams = beams sep "{\"beam\":" B_id[i] \
                ",\"rsrp\":" B_rp[i] ",\"rsrq\":" jn(B_rq[i]) ",\"pci\":" B_pc[i] "}"
    }
    # Built by concatenation, NOT by a printf with a continued argument list:
    # BWK awk (the Mac this is proved on) reads `printf "fmt" \<newline> a, b`
    # as a ONE-argument call and dies with "not enough args in printf". The
    # concatenation form parses identically in every awk, busybox included.
    o = "{"
    o = o "\"lte\":{\"cqi\":" jn(l_cqi)
    o = o ",\"ri\":" jn(l_ri)
    o = o ",\"pmi\":" jn(l_pmi)
    o = o ",\"mimo_layers\":" jn(l_layers)
    o = o ",\"tm_mode\":" jn(l_tm)
    o = o ",\"ul_mcs\":" jn(l_ulmcs) "}"
    o = o ",\"nr\":{\"cqi\":" jn(n_cqi)
    o = o ",\"ri\":" jn(n_ri)
    o = o ",\"pmi\":" jn(n_pmi)
    o = o ",\"mimo_layers\":" jn(n_layers)
    o = o ",\"dl_mcs\":" jn(n_dlmcs)
    o = o ",\"ul_mcs\":" jn(n_ulmcs)
    o = o ",\"tx_power\":" jn(n_txp) "}"
    o = o ",\"rrc\":{\"rat\":" (rat == "" ? "null" : "\"" rat "\"")
    o = o ",\"state\":" jn(rrc_state) "}"
    o = o ",\"beams\":[" beams "]}"
    print o
}
'

# -----------------------------------------------------------------------------
# qm_phy_at [network_type]
#
# Two compound commands, at most. <network_type> is the poller's own figure
# ("LTE" | "5G-NSA" | "5G-SA") and it gates ONLY the two mimo_layers reads,
# because those carry a recorded device hazard: lte_mimo_layers crashes in SA
# and nr5g_mimo_layers crashes in LTE/NSA (poller:1300-1307, and the same gate is
# applied at poller:1598-1624 for the warm tier). With no mode hint neither is
# sent at all, which is the conservative direction — mimo_layers then comes from
# modemd's lte_rank / nr_rank, which reports the same number (the 2026-10-22
# probe shows AT 1,2 against modemd nr_rank 2).
#
# NOTE for a port: the 2026-10-22 probe on this unit answered BOTH commands in
# NSA, which contradicts the older "crashes in NSA" note. Keep the gate until a
# port re-measures; it costs no field, because modemd covers the fallback.
#
# A partial answer is a success: whichever group answered contributes its
# fields, and every absent field is null (never 0, never a previous cycle's
# value). Only when BOTH groups produce nothing is this a failure.
# -----------------------------------------------------------------------------
qm_phy_at() {
    local mode="${1:-}" lte_cmds nr_cmds cap_a cap_b
    lte_cmds="$QM_PHY_AT_LTE"
    nr_cmds="$QM_PHY_AT_NR"
    case "$mode" in
        5G-SA)      nr_cmds="$nr_cmds"';+QNWCFG="nr5g_mimo_layers"' ;;
        LTE|5G-NSA) lte_cmds="$lte_cmds"';+QNWCFG="lte_mimo_layers"' ;;
    esac

    _qm_phy_capture "$QM_PHY_TIMEOUT" qcmd "$lte_cmds"
    cap_a="$_QM_PHY_CAP"
    _qm_phy_capture "$QM_PHY_TIMEOUT" qcmd "$nr_cmds"
    cap_b="$_QM_PHY_CAP"

    if [ -z "$cap_a" ] && [ -z "$cap_b" ]; then
        return 3
    fi
    # One awk pass over both captures: every payload line names its own command,
    # so no section marker is needed and an empty group is simply no lines.
    printf '%s\n%s\n' "$cap_a" "$cap_b" \
        | awk -v beam_max="$QM_PHY_BEAM_MAX" "$QM_PHY_AT_AWK"
    return 0
}

# =============================================================================
# THE API SNAPSHOT
# =============================================================================
# The one place that knows the shape the CGI serves. Args are three JSON
# objects, any of which may be absent/empty:
#   $1 the qm_phy_modemd answer      $2 the qm_phy_at answer
#   $3 the poller's own Tier-1 values and carrier:
#      {"lte_rsrp":..,"lte_rsrq":..,"lte_rssi":..,"lte_sinr":..,
#       "nr_rsrp":..,"nr_rsrq":..,"nr_sinr":..,"carrier":"..."}
#
# Join rules, each with a reason:
#   - RSRP/RSRQ/RSSI/SINR come from the poller's serving-cell reads, not from
#     here: those are per-antenna measurements from AT+QRSRP/+QRSRQ/+QSINR, and
#     re-reading them through a second path would give two numbers for one card.
#   - CQI prefers AT (a live per-subframe figure) over modemd's coarse cache;
#     modemd is the fallback so the field survives an AT failure.
#   - MCS and RI come from AT only. modemd's mcs keys report the QNWCFG enable
#     flag, not the MCS, so there is nothing honest to fall back to.
#   - tx_power is the NR PUSCH figure: the API carries ONE number and PUSCH is
#     the channel carrying uplink user data. LTE TX power does not exist on this
#     firmware, and neither does NR pathloss — both are absent from the object
#     rather than present and always null.
#   - carrier prefers the poller's operator name (what the rest of the UI shows)
#     and falls back to modemd's regName.
QM_PHY_SNAPSHOT_JQ='
def n:   if type == "number" then . else null end;
def str: if type == "string" and (length > 0) then . else null end;
($md  // {}) as $m
| ($at // {}) as $a
| ($ctx // {}) as $c
| {lte: {rsrp: ($c.lte_rsrp | n),
         rsrq: ($c.lte_rsrq | n),
         rssi: ($c.lte_rssi | n),
         sinr: ($c.lte_sinr | n),
         cqi:  (($a.lte.cqi | n) // ($m.cqi | n)),
         ri:   ($a.lte.ri | n),
         pmi:  ($a.lte.pmi | n),
         mimo_layers: (($a.lte.mimo_layers | n) // ($m.lte_mimo_layers | n)),
         tm_mode:     (($a.lte.tm_mode | n) // ($m.lte_tm_mode | n)),
         ul_mcs: ($a.lte.ul_mcs | n)},
   nr:  {rsrp: ($c.nr_rsrp | n),
         rsrq: ($c.nr_rsrq | n),
         sinr: ($c.nr_sinr | n),
         cqi:  (($a.nr.cqi | n) // ($m.nr_cqi | n)),
         ri:   ($a.nr.ri | n),
         pmi:  ($a.nr.pmi | n),
         mimo_layers: (($a.nr.mimo_layers | n) // ($m.nr_mimo_layers | n)),
         dl_mcs: ($a.nr.dl_mcs | n),
         ul_mcs: ($a.nr.ul_mcs | n),
         tx_power: ($a.nr.tx_power | n)},
   rrc:  {rat: (($a.rrc.rat | str) // ($m.rat | str)),
          state: ($a.rrc.state | n)},
   registered: (if ($m.registered | type) == "boolean" then $m.registered else null end),
   carrier: (($c.carrier | str) // ($m.carrier | str)),
   beams: (if ($a.beams | type) == "array" then $a.beams else [] end)}'

qm_phy_snapshot() {
    local out rc
    out=$("$(_qm_phy_jq)" -cn --argjson md "${1:-null}" --argjson at "${2:-null}" --argjson ctx "${3:-null}" \
          "$QM_PHY_SNAPSHOT_JQ" 2>/dev/null)
    rc=$?
    [ "$rc" -eq 0 ] || return 4
    [ -n "$out" ] || return 4
    printf '%s\n' "$out"
    return 0
}

# =============================================================================
# DURABLE ARCHIVE — one CSV row per minute, /usrdata/qmanager/metrics
# =============================================================================
# The /tmp ring (SIGNAL_HISTORY_MAX=180) is 30 minutes and stays exactly as it
# is; it is what the dashboard chart reads. This is the long trend: one row per
# minute per UTC day, so `fetch_signal_history.sh?range=30d` has something to
# serve. Kept out of /tmp on purpose — tmpfs does not survive a reboot.
#
# Line 1 of every file is the schema marker, and it carries the COLUMN NAMES so
# the reader resolves them by name instead of by hardcoded index. A future
# column addition then appends rather than shifting every reader.
#
# Nulls are EMPTY fields, never the string "null" and never 0: a missing sample
# and a sample that measured zero are different claims, and the reader turns an
# empty field into a JSON null (which the chart draws as a gap).
#
# Size, from the column count rather than a soak (device not touched by this
# change): 23 columns averaging ~6 bytes of digits and separators is ~120 B/row,
# ~170 KB/day, ~5 MB for the full 30-day retention. The measured figure belongs
# in the PR body, per R3.
QM_PHY_ARCHIVE_SCHEMA="qm_phy_archive,1"
QM_PHY_ARCHIVE_COLUMNS="ts,lte_rsrp,lte_rsrq,lte_rssi,lte_sinr,lte_cqi,lte_ri,lte_pmi,lte_mimo_layers,lte_tm_mode,lte_ul_mcs,nr_rsrp,nr_rsrq,nr_sinr,nr_cqi,nr_ri,nr_pmi,nr_mimo_layers,nr_dl_mcs,nr_ul_mcs,nr_tx_power,temp,total_cells"

# Column ORDER must match QM_PHY_ARCHIVE_COLUMNS above, minus `ts`, `temp` and
# `total_cells` (which are passed as separate arguments because they do not come
# from the snapshot).
QM_PHY_ARCHIVE_JQ='
def f: if type == "number" then tostring else "" end;
[ .lte.rsrp, .lte.rsrq, .lte.rssi, .lte.sinr, .lte.cqi, .lte.ri, .lte.pmi,
  .lte.mimo_layers, .lte.tm_mode, .lte.ul_mcs,
  .nr.rsrp, .nr.rsrq, .nr.sinr, .nr.cqi, .nr.ri, .nr.pmi, .nr.mimo_layers,
  .nr.dl_mcs, .nr.ul_mcs, .nr.tx_power ] | map(f) | join(",")'

_QM_PHY_ARCHIVE_OK=true
_QM_PHY_ARCHIVE_PRUNED_DAY=""

# One warning, then silence for the rest of the run: a full or read-only
# /usrdata would otherwise log a line a minute forever, and the /tmp ring keeps
# working either way. Recovery is a poller restart (or a reboot), which is the
# supervised action; there is deliberately no retry loop, because the failure
# this guards — a full filesystem — is not fixed by trying again 60 s later.
_qm_phy_archive_disable() {
    _QM_PHY_ARCHIVE_OK=false
    if command -v qlog_warn >/dev/null 2>&1; then
        qlog_warn "phy archive: $1 — disabled until the poller restarts (/tmp signal ring unaffected)"
    fi
}

# Whole day files older than QM_PHY_ARCHIVE_KEEP_DAYS, by the UTC date in the
# file name. It never rewrites a file it is appending to. When `date -d` is not
# available the cutoff cannot be computed, and a retention pass that cannot
# compute its cutoff must delete nothing rather than guess one.
_qm_phy_archive_prune() {
    local dir="$1" cut cutnum f name num keep="$QM_PHY_ARCHIVE_KEEP_DAYS"
    cut=$(date -u -d "@$(( $(date +%s) - keep * 86400 ))" +%Y-%m-%d 2>/dev/null)
    [ -n "$cut" ] || return 0
    cutnum=$(_qm_phy_daynum "$cut")
    [ -n "$cutnum" ] || return 0
    for f in "$dir"/*.csv; do
        [ -f "$f" ] || continue
        name="${f##*/}"
        name="${name%.csv}"
        num=$(_qm_phy_daynum "$name")
        [ -n "$num" ] || continue
        if [ "$num" -lt "$cutnum" ]; then
            rm -f "$f" 2>/dev/null
        fi
    done
    return 0
}

# yyyy-mm-dd -> yyyymmdd so the comparison is numeric (ash `[` has no string <).
_qm_phy_daynum() {
    local y r
    y="${1%%-*}"
    r="${1#*-}"
    case "$y$r" in ''|*[!0-9]*) return 0 ;; esac
    printf '%s%s%s' "$y" "${r%%-*}" "${r#*-}"
}

# -----------------------------------------------------------------------------
# qm_phy_archive_row <snapshot-json> <temp> <total_cells>
#
# Appends one row. <temp> and <total_cells> are the two panel sources that are
# not part of the API snapshot, passed as separate arguments so the published
# snapshot keeps exactly the shape the CGI contract names. Either may be "null".
#
# The append is a single `printf >> file`, i.e. one O_APPEND write of one line:
# no read-modify-write, no rename, so a reader never sees a truncated day file.
# A crash mid-write can leave one torn final line, which the reader drops.
# -----------------------------------------------------------------------------
qm_phy_archive_row() {
    local snap="$1" temp="$2" cells="$3" ts dir file day vals row
    [ "$_QM_PHY_ARCHIVE_OK" = "true" ] || return 3

    ts=$(date +%s)
    case "$ts" in ''|*[!0-9]*) return 3 ;; esac

    vals=$(printf '%s' "$snap" | "$(_qm_phy_jq)" -r "$QM_PHY_ARCHIVE_JQ" 2>/dev/null)
    case "$vals" in
        *","*) ;;                 # the 20 numeric columns are always present
        *) return 4 ;;
    esac

    case "$temp"  in ''|null) temp=""  ;; esac
    case "$cells" in ''|null) cells="" ;; esac
    row="$ts,$vals,$temp,$cells"

    dir="$QM_PHY_ARCHIVE_DIR"
    if [ ! -d "$dir" ]; then
        if ! mkdir -p "$dir" 2>/dev/null; then
            _qm_phy_archive_disable "cannot create $dir"
            return 3
        fi
    fi

    day=$(date -u +%Y-%m-%d)
    case "$day" in
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
        *) return 3 ;;
    esac
    file="$dir/$day.csv"

    # First row of the day: schema marker and row in ONE write, so a file can
    # never exist with a header and no data.
    if [ ! -s "$file" ]; then
        if ! printf '#%s,%s\n%s\n' "$QM_PHY_ARCHIVE_SCHEMA" "$QM_PHY_ARCHIVE_COLUMNS" "$row" \
                >> "$file" 2>/dev/null; then
            _qm_phy_archive_disable "cannot write $file (read-only or full /usrdata)"
            return 3
        fi
    else
        if ! printf '%s\n' "$row" >> "$file" 2>/dev/null; then
            _qm_phy_archive_disable "cannot append to $file (read-only or full /usrdata)"
            return 3
        fi
    fi

    # Retention, once per UTC day.
    if [ "$_QM_PHY_ARCHIVE_PRUNED_DAY" != "$day" ]; then
        _qm_phy_archive_prune "$dir"
        _QM_PHY_ARCHIVE_PRUNED_DAY="$day"
    fi
    return 0
}
