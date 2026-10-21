#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# =============================================================================
# neighbour_scan_status.sh — CGI Endpoint: Neighbour Cell Scan Status
# =============================================================================
# Polled by the frontend to check neighbour scan progress.
# Returns idle/running/complete/error with results when available.
#
# Endpoint: GET /cgi-bin/quecmanager/at_cmd/neighbour_scan_status.sh
# Response:
#   {"status": "idle"}
#   {"status": "running"}
#   {"status": "complete", "results": [...]}
#   {"status": "error", "message": "..."}
#
# The four responses above are what a request WITHOUT a query string gets, and
# they are unchanged. Two ranges were added for the live neighbour view:
#
# Response (range=last — the last completed scan, plus its age):
#   {"success":true,"range":"last","generated_at":<epoch|null>,"age_s":<int|null>,
#    "registered":<bool>,"carrier":<string|null>,
#    "serving":{"pci","earfcn","rsrp","rsrq","rssi"}|null,
#    "cells":[<the scan result rows, unchanged>]}
#
# Response (range=now — renews the live lease, serves the live sample):
#   {"success":true,"range":"now","live_at":<epoch|null>,"age_s":<int|null>,
#    "registered":<bool>,"carrier":<string|null>,
#    "serving":{"pci","earfcn","rsrp","rsrq","rssi","sinr"}|null,
#    "cells":[{"type","rat","earfcn","pci","rsrp","rsrq","rssi","serving","source"}]}
#
# Live mode is a browser-held LEASE, the same shape the sites monitor uses
# (docs/reference/sites-monitor.md): range=now writes an epoch to
# /tmp/qmanager_neighbours_live, qmanager_poller reads it and ticks while it is
# 0-10 s old, and the ticks stop on their own when the renewals stop. Nothing
# here is an always-on sampler, and this CGI never writes the live data file.
#
# Install location: /www/cgi-bin/quecmanager/at_cmd/neighbour_scan_status.sh
# =============================================================================

# --- Configuration -----------------------------------------------------------
PID_FILE="/tmp/qmanager_neighbour_scan.pid"
RESULT_FILE="/tmp/qmanager_neighbour_scan_result.json"
ERROR_FILE="/tmp/qmanager_neighbour_scan_error"
# Lease (written here, read by qmanager_poller) and live sample (written by
# qmanager_poller, read here). The poller's own copy of this age window is
# NEIGHBOURS_LIVE_LEASE_SEC=10; this one is deliberately shorter: a sample the
# poller has not refreshed inside LIVE_MAX_AGE is not "now" any more.
LIVE_LEASE="/tmp/qmanager_neighbours_live"
LIVE_FILE="/tmp/qmanager_neighbours_live.json"
STATUS_FILE="/tmp/qmanager_status.json"
LIVE_MAX_AGE=6

qlog_init "cgi_neighbour_scan_status"
cgi_headers
cgi_handle_options

# =============================================================================
# RANGE MODES (added by the live neighbour view; the default path below is
# untouched and answers exactly as it did before)
# =============================================================================

# range=now — renew the lease, then serve the poller's live sample.
#
# The lease is renewed FIRST so a page that keeps asking keeps the poller
# ticking; the sample served is whatever the poller last published. If there is
# no sample, or it is older than LIVE_MAX_AGE, the answer says so (`live_at:
# null`, `cells: []`) instead of handing back stale cells as if they were
# current: an operator aiming an antenna would otherwise chase a tower the dish
# left behind a minute ago.
handle_range_now() {
    local now live_json resp
    now=$(date +%s)
    { printf '%s\n' "$now" > "$LIVE_LEASE"; } 2>/dev/null

    live_json=$(cat "$LIVE_FILE" 2>/dev/null)
    case "$live_json" in '{'*) ;; *) live_json='null' ;; esac

    resp=$(jq -c -n --argjson now "$now" --argjson max "$LIVE_MAX_AGE" --argjson d "$live_json" '
        ($d | if type == "object" and (.at | type) == "number"
                 and ($now - .at) >= 0 and ($now - .at) <= $max then . else null end) as $live
        | {success: true, range: "now",
           live_at: (if $live == null then null else ($live.at | floor) end),
           age_s: (if $live == null then null else ($now - ($live.at | floor)) end),
           registered: ($live.registered == true),
           carrier: (if ($live.carrier | type) == "string" then $live.carrier else null end),
           serving: (if ($live.serving | type) == "object" then $live.serving else null end),
           cells: (if ($live.cells | type) == "array" then $live.cells else [] end)}' 2>/dev/null)

    if [ -n "$resp" ]; then
        printf '%s\n' "$resp"
    else
        # Constant payload, no jq: a device whose jq bootstrap failed must not
        # answer this endpoint with an empty body.
        printf '%s\n' '{"success":true,"range":"now","live_at":null,"age_s":null,"registered":false,"carrier":null,"serving":null,"cells":[]}'
    fi
}

# range=last — the last completed scan (RESULT_FILE) plus its age.
#
# The scan rows carry no serving-cell marker (the AT neighbour read does not
# report one), so `serving`, `registered` and `carrier` come from the poller's
# cache: the same AT serving-cell read the dashboard uses. One transport for the
# rows, one for the serving identity — never a value mixed from both.
handle_range_last() {
    local now gen age cells_json status_json resp
    now=$(date +%s)

    gen=""
    if [ -f "$RESULT_FILE" ]; then
        gen=$(stat -c %Y "$RESULT_FILE" 2>/dev/null)
        case "$gen" in ''|*[!0-9]*) gen="" ;; esac
    fi
    if [ -n "$gen" ]; then
        age=$(( now - gen ))
        [ "$age" -ge 0 ] || age=0
    else
        gen=null
        age=null
    fi

    cells_json=$(jq -c '.' "$RESULT_FILE" 2>/dev/null)
    case "$cells_json" in \[*) ;; *) cells_json='[]' ;; esac
    status_json=$(jq -c '.' "$STATUS_FILE" 2>/dev/null)
    case "$status_json" in '{'*) ;; *) status_json='null' ;; esac

    resp=$(jq -c -n --argjson gen "$gen" --argjson age "$age" \
        --argjson cells "$cells_json" --argjson st "$status_json" '
        {success: true, range: "last",
         generated_at: $gen, age_s: $age,
         registered: (($st.lte.state == "connected") or ($st.nr.state == "connected")),
         carrier: (if ($st.network.carrier | type) == "string" and ($st.network.carrier | length) > 0
                   then $st.network.carrier else null end),
         serving: (if ($st.lte.pci | type) == "number"
                   then {pci: ($st.lte.pci | tostring),
                         earfcn: (if ($st.lte.earfcn | type) == "number" then ($st.lte.earfcn | tostring) else null end),
                         rsrp: (if ($st.lte.rsrp | type) == "number" then $st.lte.rsrp else null end),
                         rsrq: (if ($st.lte.rsrq | type) == "number" then $st.lte.rsrq else null end),
                         rssi: (if ($st.lte.rssi | type) == "number" then $st.lte.rssi else null end)}
                   else null end),
         cells: $cells}' 2>/dev/null)

    if [ -n "$resp" ]; then
        printf '%s\n' "$resp"
    else
        printf '%s\n' '{"success":true,"range":"last","generated_at":null,"age_s":null,"registered":false,"carrier":null,"serving":null,"cells":[]}'
    fi
}

# --- Range dispatch ----------------------------------------------------------
# An empty range (no query string at all) falls through to the original body
# below, unchanged. This is a branch, not a rewrite: the scan-status path still
# owns "is a scan running / what did it produce" exactly as before.
RANGE=""
case "&$QUERY_STRING" in
    *"&range="*) RANGE="${QUERY_STRING#*range=}"; RANGE="${RANGE%%&*}" ;;
esac
case "$RANGE" in
    "") ;;
    now) handle_range_now; exit 0 ;;
    last) handle_range_last; exit 0 ;;
    *)
        # Constant payload rather than cgi_error: the UI codes against this
        # endpoint's `message` key, while cgi_error emits `detail`. The value is
        # fixed, so no escaper (and no jq) is needed to stay un-mutable.
        printf '%s\n' '{"success":false,"error":"invalid_range","message":"range must be now or last"}'
        exit 0
        ;;
esac

# --- Check: scanner process running? -----------------------------------------
# NOTE on PID_FILE removal ordering (see speedtest_status.sh:155-166 for the
# case where this DOES cause a running->idle->complete flicker, and
# cell_scan_status.sh for the full version of this note): not reachable here
# for the same reason — qmanager_neighbour_scanner writes RESULT_FILE/
# ERROR_FILE and removes its own PID_FILE (trap cleanup on EXIT) inside one
# worker process, and the trap is the process's last act, so pid_alive can
# only go false after that rm has already happened. This branch firing on a
# stale-but-present PID_FILE only happens after a SIGKILL, which skips the
# trap and never produces a result — falling through to "idle" there is
# correct. Left unordered deliberately.
if [ -f "$PID_FILE" ]; then
    SCAN_PID=$(cat "$PID_FILE" 2>/dev/null)
    if pid_alive "$SCAN_PID"; then
        jq -n '{"status":"running"}'
        exit 0
    fi
    # Process died — clean up stale PID
    rm -f "$PID_FILE"
fi

# --- Check: result file present? ----------------------------------------------
# RESULT must be checked BEFORE ERROR — see cell_scan_status.sh for the full
# rationale. Short version: this GET is now non-destructive (no more
# `rm -f "$ERROR_FILE"` below), so a stale error from an earlier failed
# worker in a double-start pair must never shadow a later worker's genuine
# result. Checking result first can't mask a real error either, since a real
# error means the start endpoint already deleted RESULT_FILE and no worker
# wrote one.
if [ -f "$RESULT_FILE" ]; then
    jq -n --slurpfile results "$RESULT_FILE" '{"status":"complete","results":$results[0]}'
    exit 0
fi

# --- Check: error file present? ----------------------------------------------
# Read-only on purpose — a GET must not mutate server state. The error is
# cleared on the next scan start instead (both the start endpoint and the
# worker already do this), so a lost poll can no longer erase it forever.
if [ -f "$ERROR_FILE" ]; then
    ERR_MSG=$(cat "$ERROR_FILE" 2>/dev/null | head -1)
    jq -n --arg msg "$ERR_MSG" '{"status":"error","message":$msg}'
    exit 0
fi

# --- Default: idle (no scan has been run yet) ---------------------------------
jq -n '{"status":"idle"}'
