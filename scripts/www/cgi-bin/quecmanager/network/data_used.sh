#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# =============================================================================
# data_used.sh — CGI Endpoint: Accumulated Data Usage (GET)
# =============================================================================
# Serves the .data_used block from /tmp/qmanager_status.json.
# The block is written by the qmanager_poller on every tier-1 tick.
#
# Adds a "stale" boolean: true when the status cache timestamp is older
# than STALE_SECONDS (indicates the poller is not running).
# Returns a zeroed fallback shape (stale=true) when the cache is missing
# or the .data_used key is absent — the frontend never needs to guard
# against missing keys.
#
# Endpoint: GET /cgi-bin/quecmanager/network/data_used.sh
# Response: application/json
# Install location: /www/cgi-bin/quecmanager/network/data_used.sh
# =============================================================================

# --- Logging -----------------------------------------------------------------
qlog_init "cgi_data_used"
cgi_headers
cgi_handle_options

# --- Configuration -----------------------------------------------------------
STATUS_FILE="/tmp/qmanager_status.json"
STALE_SECONDS=10

# --- Method guard ------------------------------------------------------------
if [ "$REQUEST_METHOD" != "GET" ]; then
    cgi_method_not_allowed
    exit 0
fi

# --- Serve data --------------------------------------------------------------
if [ ! -f "$STATUS_FILE" ]; then
    qlog_warn "Status cache missing, returning zeroed fallback"
    jq -n '{
        "accumulated_rx_bytes": 0,
        "accumulated_tx_bytes": 0,
        "selected_counter": "",
        "last_update_ts": 0,
        "last_reset_ts": 0,
        "modem_reset_count": 0,
        "stale": true
    }'
    exit 0
fi

# ONE jq on the hot path instead of `date` + three jq: the dashboard polls this
# every 2 s, and it cost ~83 ms of CPU per request on the RG520N-EB
# (2026-10-22). Output is unchanged: the data_used block plus `stale`. jq's
# `now` is the same wall clock `date +%s` read. An absent block comes back as a
# one-line marker so the zeroed fallback below (and its warning) still runs;
# an unreadable cache gives no output, which the old code treated as ts=0,
# i.e. stale.
data_used=$(jq --argjson stale_s "$STALE_SECONDS" '
    ((((now | floor) - (.timestamp // 0)) > $stale_s)) as $stale
    | if (.data_used // null) == null then {"__qm_absent": true, "stale": $stale}
      else .data_used + { stale: $stale } end' < "$STATUS_FILE" 2>/dev/null)
stale="true"
case "$data_used" in
    *'"__qm_absent": true'*)
        case "$data_used" in *'"stale": false'*) stale="false" ;; esac
        data_used=""
        ;;
    '') ;;
    *)
        printf '%s\n' "$data_used"
        exit 0
        ;;
esac

if [ -z "$data_used" ]; then
    qlog_warn "data_used block absent in status cache, returning zeroed fallback"
    jq -n --argjson stale "$stale" '{
        "accumulated_rx_bytes": 0,
        "accumulated_tx_bytes": 0,
        "selected_counter": "",
        "last_update_ts": 0,
        "last_reset_ts": 0,
        "modem_reset_count": 0,
        "stale": $stale
    }'
    exit 0
fi
