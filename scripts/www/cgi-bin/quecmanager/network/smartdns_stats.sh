#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# =============================================================================
# smartdns_stats.sh — CGI: the numbers behind the resolver's "why is this faster"
# =============================================================================
# GET -> the performance panel payload (Contract 3 in
#        docs/specs/dns-edge-selection.md)
#
# READ THIS BEFORE ADDING A FIGURE
#   smartdns-rs 0.13.1 EXPORTS NO COUNTERS. `--help` offers only
#   run/update/service/resolve/symlink/test, and the binary contains no api-server
#   and no statistics surface (checked with --help and strings, 2026-10-23). So
#   every number below is derived from somewhere else, and each one NAMES its
#   source in the payload. A fabricated "queries processed" figure would look
#   better and be worthless.
#
#   Sources, exhaustively:
#     cache + forwarding   dnsmasq's SIGUSR1 dump in /var/log/syslog. It is
#                          dnsmasq's front cache that serves LAN clients in 0-1 ms,
#                          so these counters describe the path users actually take.
#     latency + speed-up   /tmp/qmanager_dns.json — the same name timed against the
#                          carrier resolver and against the LAN resolver
#                          (qmanager_ping's two-tier probe, shipped 2026-10-23).
#     pool health          bounded /tmp/smartdns.log (128 kB x2 cap) ERROR count.
#     blocked rules        `address /.../#` lines in the config.
#
#   CORRECTION 2026-10-24 — a hit rate IS computable, and this file said otherwise
#   for one revision. dnsmasq's dump is actually:
#       queries forwarded 749, queries answered locally 477
#   M = 477 is the cache-hit count, so hit_rate = M / (N + M) = 38.9 % from a
#   SINGLE reading. No log-queries and no sampling window required. The earlier
#   claim ("dnsmasq never reports the local total, so only a rate over time is
#   possible") was written from memory instead of from the syslog line — and it was
#   wrong. The time-series sampler is still worth having for TRENDS; it is simply
#   not needed for the hit rate. Corrected here because a wrong comment outlives
#   the mistake it describes.
#
#   What genuinely is absent:
#     queries_saved  needs "cache hits x upstream RTT saved", and dnsmasq does not
#                    attribute a hit to the upstream lookup it might have replaced.
#   It is returned as null rather than approximated.
#
# Sudoers: www-data ALL=(root) NOPASSWD: /usr/bin/killall -USR1 dnsmasq
# Endpoint: /cgi-bin/quecmanager/network/smartdns_stats.sh
# =============================================================================

qlog_init "cgi_smartdns_stats"
cgi_headers
cgi_handle_options

require_auth

if [ "$REQUEST_METHOD" != "GET" ]; then
    cgi_method_not_allowed
fi

CONF="/usrdata/qmanager/etc/smartdns.conf"
DNS_SIDECAR="/tmp/qmanager_dns.json"
STATUS_JSON="/tmp/qmanager_status.json"
LOG="/tmp/smartdns.log"
SYSLOG="/var/log/syslog"
HIST="/tmp/qmanager_dns_stats_history.json"

# --- range selection -------------------------------------------------------
# The page charts a WINDOW, so the sampler's ring file is the primary input: a
# single snapshot has no rate in it. Anything unrecognised falls back to 6 h rather
# than erroring — a bad chart range is not a reason to lose the whole panel.
_rsec=21600
case "${QUERY_STRING:-}" in
    *range=1h*)  _rsec=3600 ;;
    *range=24h*) _rsec=86400 ;;
    *range=6h*)  _rsec=21600 ;;
esac

# --- dnsmasq counters ------------------------------------------------------
# SIGUSR1 makes dnsmasq print one summary block. We take the LAST block, because
# the log keeps every previous dump and an old block would silently age the panel.
cache_size="null"; reuse_reused="null"; reuse_total="null"
fwd_queries="null"; local_answers="null"; hit_rate="null"; servers="[]"; sampled=false

# Trigger only when the log is readable; otherwise leave the figures null instead
# of failing the whole endpoint (the latency half is still worth returning).
if [ -r "$SYSLOG" ]; then
    _before=$(wc -l < "$SYSLOG" 2>/dev/null)
    if sudo -n /usr/bin/killall -USR1 dnsmasq >/dev/null 2>&1; then
        _i=0
        while [ "$_i" -lt 5 ]; do
            _after=$(wc -l < "$SYSLOG" 2>/dev/null)
            [ "${_after:-0}" -gt "${_before:-0}" ] && break
            sleep 1; _i=$((_i + 1))
        done
    fi

    # One awk pass over the tail: dnsmasq's dump is contiguous, so the last match
    # of each pattern is the newest sample.
    _dump=$(tail -120 "$SYSLOG" 2>/dev/null | grep -E 'cache size|queries forwarded|queries sent' | tail -60)

    _line=$(printf '%s\n' "$_dump" | grep 'cache size' | tail -1)
    if [ -n "$_line" ]; then
        cache_size=$(printf '%s' "$_line" | sed -n 's/.*cache size \([0-9][0-9]*\).*/\1/p')
        _rt=$(printf '%s' "$_line" | sed -n 's/.*[ ,]\([0-9][0-9]*\)\/\([0-9][0-9]*\) cache insertions.*/\1 \2/p')
        # "X/Y cache insertions re-used unexpired cache entries": X re-used (the
        # eviction signal), Y insertions total.
        if [ -n "$_rt" ]; then
            reuse_reused=${_rt%% *}; reuse_total=${_rt##* }
        fi
        sampled=true
    fi
    case "$cache_size" in ''|*[!0-9]*) cache_size=null ;; esac
    case "$reuse_reused" in ''|*[!0-9]*) reuse_reused=null ;; esac
    case "$reuse_total" in ''|*[!0-9]*) reuse_total=null ;; esac

    # "queries forwarded N, queries answered locally M" — M is the cache-hit
    # count, so the hit rate is M/(N+M). CORRECTION 2026-10-24: an earlier version
    # of this file (and the spec) claimed dnsmasq exposed no local-query total and
    # returned hit_rate_pct:null. It does, and the real syslog line proves it.
    _line=$(printf '%s\n' "$_dump" | grep 'queries forwarded' | tail -1)
    if [ -n "$_line" ]; then
        fwd_queries=$(printf '%s' "$_line" | sed -n 's/.*queries forwarded \([0-9][0-9]*\).*/\1/p')
        local_answers=$(printf '%s' "$_line" | sed -n 's/.*queries answered locally \([0-9][0-9]*\).*/\1/p')
    fi
    case "$fwd_queries" in ''|*[!0-9]*) fwd_queries=null ;; esac
    case "$local_answers" in ''|*[!0-9]*) local_answers=null ;; esac
    if [ "$fwd_queries" != "null" ] && [ "$local_answers" != "null" ]; then
        _tot=$(( fwd_queries + local_answers ))
        if [ "$_tot" -gt 0 ]; then
            hit_rate=$(awk -v l="$local_answers" -v t="$_tot" 'BEGIN{printf "%.1f", l*100/t}')
        fi
    fi
    case "$hit_rate" in ''|*[!0-9.]*) hit_rate=null ;; esac

    # Per-server lines: "server 127.0.0.1#5353: queries sent 412, retried 3, gave up 0"
    # Real format: "server 127.0.0.1#5353: queries sent 689, retried or failed 59".
    # The earlier regex expected "retried N ... gave up M" and silently produced an
    # empty array — a parser that matches nothing looks identical to a quiet pool.
    servers=$(printf '%s\n' "$_dump" | grep 'queries sent' \
        | sed -n 's/.*server \([^:]*\): queries sent \([0-9][0-9]*\).*retried or failed \([0-9][0-9]*\).*/\1 \2 \3/p' \
        | jq -R -s -c 'split("\n") | map(select(length > 0)) | map(split(" ") | {server: .[0], sent: (.[1]|tonumber), retried_or_failed: (.[2]|tonumber)})' 2>/dev/null)
    [ -n "$servers" ] || servers="[]"
fi

# --- latency: the figure users feel ---------------------------------------
carrier="null"; lan="null"; speedup="null"; saved="null"
_dns_src="none"
if [ -f "$DNS_SIDECAR" ]; then
    _c=$(jq -r 'if .ok == true then (.ms // "null") else "null" end' "$DNS_SIDECAR" 2>/dev/null)
    _l=$(jq -r 'if .ok_lan == true then (.ms_lan // "null") else "null" end' "$DNS_SIDECAR" 2>/dev/null)
    case "$_c" in ''|*[!0-9]*) _c=null ;; esac
    case "$_l" in ''|*[!0-9]*) _l=null ;; esac
    carrier=$_c; lan=$_l
    if [ "$carrier" != "null" ] && [ "$lan" != "null" ] && [ "$lan" -gt 0 ]; then
        # Both samples come from the same nslookup harness, so the RATIO is
        # meaningful even though each absolute figure includes a fork.
        speedup=$(awk -v a="$carrier" -v b="$lan" 'BEGIN{printf "%.1f", a/b}')
        saved=$((carrier - lan))
        [ "$saved" -lt 0 ] && saved=0
    fi
    _dns_src="qmanager_ping two-tier probe"
fi

# --- pool + blocked --------------------------------------------------------
members=0
if [ -f "$CONF" ]; then
    # Exclude the generated EDGE block and the bootstrap entries: the block
    # RE-DECLARES providers already in the base pool, so counting it reported 11
    # for an 8-provider pool and the card disagreed with the probe.
    _n=$(awk '
        /^# BEGIN QMANAGER-EDGE/ { inb = 1; next }
        /^# END QMANAGER-EDGE/   { inb = 0; next }
        inb { next }
        /^server / && !/bootstrap-dns/ { c++ }
        END { print c + 0 }
    ' "$CONF" 2>/dev/null)
    case "$_n" in ''|*[!0-9]*) _n=0 ;; esac
    members=$_n
fi
errors=0
if [ -f "$LOG" ]; then
    _e=$(grep -c ERROR "$LOG" 2>/dev/null); errors=${_e:-0}
fi
blocked=0
if [ -f "$CONF" ]; then
    _b=$(grep -cE '^address /.*/#$' "$CONF" 2>/dev/null); blocked=${_b:-0}
fi

_now=$(date +%s)

# --- history: the rate series ---------------------------------------------
# Deltas are computed in awk rather than inside the final jq expression: the
# arithmetic is the part a reader needs to check, and burying a
# subtraction-and-scale inside 20 lines of JSON assembly hides it.
#
# NOTE ON A BUG THIS REPLACES: the first version of this file referenced
# $hist/$hn/$rsec/... without ever assigning them (an edit applied the jq half but
# not this half), so every --argjson received an empty string, jq exited with
# "invalid JSON text passed to --argjson", and the endpoint returned HTTP 200 with
# an EMPTY BODY — which the page renders as "couldn't read performance figures".
# A 200 with no body is the worst failure shape: it looks like success at the
# transport layer. Every block below has a default so it can never be empty.
_hist='[]'
if [ -f "$HIST" ]; then
    _h=$(jq -c --argjson now "$_now" --argjson rsec "$_rsec" \
        '[.[] | select((.ts // 0) >= ($now - $rsec))]' "$HIST" 2>/dev/null)
    case "$_h" in \[*\]) _hist=$_h ;; esac
fi
_hn=$(printf '%s' "$_hist" | jq 'length' 2>/dev/null)
case "$_hn" in ''|*[!0-9]*) _hn=0 ;; esac

hist_ok=false
win_sec=null; fwd_delta=null; fwd_per_min=null
ins_delta=null; ins_per_min=null; ret_delta=null; hist_cache=null
if [ "$_hn" -ge 2 ]; then
    # [.[0], .[-1]][] is NOT the same as .[0, (.[-1])]: the latter indexes the array
    # WITH 0 and the last element as KEYS, which jq rejects ("Array/string slice
    # indices must be integers") and prints only the first row before failing, so
    # every rate came out null and the card said "still collecting".
    _rows=$(printf '%s' "$_hist" | jq -r '[.[0], .[-1]][]
        | [(.ts // 0), (if .forwarded == null then "n" else (.forwarded|tostring) end),
           (if .ins_total == null then "n" else (.ins_total|tostring) end),
           (if .cache_size == null then "n" else (.cache_size|tostring) end)] | @tsv' 2>/dev/null)
    _a=$(printf '%s\n' "$_rows" | sed -n '1p')
    _b=$(printf '%s\n' "$_rows" | sed -n '2p')
    if [ -n "$_a" ] && [ -n "$_b" ]; then
        _calc=$(printf '%s\n%s\n' "$_a" "$_b" | awk -F'\t' '
            NR==1 { t1=$1; f1=$2; i1=$3; cs=$4; next }
            NR==2 {
                dt=$1-t1; d="-"; pr="-"; di="-"; pi="-"
                if ($2 != "n" && f1 != "n") { d=$2-f1; if (dt > 0) pr=sprintf("%.2f", d*60/dt) }
                if ($3 != "n" && i1 != "n") { di=$3-i1; if (dt > 0) pi=sprintf("%.2f", di*60/dt) }
                printf "%s %s %s %s %s %s\n", dt, d, pr, di, pi, $4
            }')
        set -- $_calc
        win_sec=$1; fwd_delta=$2; fwd_per_min=$3
        ins_delta=$4; ins_per_min=$5; hist_cache=$6
        hist_ok=true
        [ "$fwd_delta" = "-" ] && fwd_delta=null
        [ "$fwd_per_min" = "-" ] && fwd_per_min=null
        [ "$ins_delta" = "-" ] && ins_delta=null
        [ "$ins_per_min" = "-" ] && ins_per_min=null
        case "$hist_cache" in ''|n|*[!0-9]*) hist_cache=null ;; esac
    fi
fi
# Last-resort guards: an --argjson with an empty value kills the whole payload.
for _v in _hist; do :; done
[ -n "${_hist:-}" ] || _hist='[]'
[ -n "${_hn:-}" ] || _hn=0
[ -n "${_rsec:-}" ] || _rsec=21600
[ -n "${hist_ok:-}" ] || hist_ok=false
[ -n "${win_sec:-}" ] || win_sec=null
[ -n "${fwd_delta:-}" ] || fwd_delta=null
[ -n "${fwd_per_min:-}" ] || fwd_per_min=null
[ -n "${ins_delta:-}" ] || ins_delta=null
[ -n "${ins_per_min:-}" ] || ins_per_min=null
[ -n "${ret_delta:-}" ] || ret_delta=null
[ -n "${hist_cache:-}" ] || hist_cache=null

jq -n \
    --argjson sampled "$sampled" \
    --argjson csize "$cache_size" \
    --argjson reused "$reuse_reused" \
    --argjson rtotal "$reuse_total" \
    --argjson fwdq "$fwd_queries" \
    --argjson loc "$local_answers" \
    --argjson hrate "$hit_rate" \
    --argjson servers "$servers" \
    --argjson carrier "$carrier" \
    --argjson lan "$lan" \
    --argjson speedup "$speedup" \
    --argjson saved "$saved" \
    --arg dns_src "$_dns_src" \
    --argjson members "$members" \
    --argjson errors "$errors" \
    --argjson blocked "$blocked" \
    --argjson now "$_now" \
    --argjson hist "$_hist" \
    --argjson hn "$_hn" \
    --argjson rsec "$_rsec" \
    --argjson hist_ok "$hist_ok" \
    --argjson win "$win_sec" \
    --argjson fwd_d "$fwd_delta" \
    --argjson fwd_r "$fwd_per_min" \
    --argjson ins_d "$ins_delta" \
    --argjson ins_r "$ins_per_min" \
    --argjson ret_d "$ret_delta" \
    --argjson hcache "$hist_cache" \
    '{
        success: true,
        sampled_at: $now,
        cache: {
            size: $csize,
            insertions: $rtotal,
            reused: $reused,
            evictions: null,
            answered_locally: $loc,
            hit_rate_pct: $hrate,
            source: "dnsmasq SIGUSR1 (front cache — the path clients actually take)",
            note: "hit rate = answered locally / (forwarded + answered locally); insertions/reused come from the dnsmasq N/M line. Evictions is null on purpose: dnsmasq reports RE-USE of unexpired entries, not a separate eviction count, and inventing one would be a guess"
        },
        forwarding: {
            queries_forwarded: $fwdq,
            servers: $servers,
            source: "dnsmasq SIGUSR1"
        },
        latency: {
            carrier_ms: $carrier,
            lan_ms: $lan,
            speedup_x: $speedup,
            saved_ms: $saved,
            source: $dns_src
        },
        pool: {members: $members, errors: $errors, source: "config + bounded /tmp/smartdns.log"},
        blocked: {rules: $blocked, source: "address /…/# rules in the config"},
        sampled: $sampled,
        history: {
            range_sec: $rsec,
            samples: $hn,
            sufficient: $hist_ok,
            window_sec: $win,
            forwarded_delta: $fwd_d,
            forwarded_per_min: $fwd_r,
            insertions_delta: $ins_d,
            insertions_per_min: $ins_r,
            retried_delta: $ret_d,
            cache_size: $hcache,
            series: ($hist | map({ts: .ts, forwarded: .forwarded, ins_total: .ins_total, cache_size: .cache_size})),
            source: "qmanager-dns-stats.timer, one sample per 5 min into /tmp (tmpfs — cleared on reboot)",
            collector: "device-side. Two samples are required before any rate exists; the page says so rather than drawing a line from one point"
        }
    }'
exit 0
