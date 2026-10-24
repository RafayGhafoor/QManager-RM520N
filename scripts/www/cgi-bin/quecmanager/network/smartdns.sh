#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# =============================================================================
# smartdns.sh — CGI: resolver status, on/off toggle, config edit, edge refresh
# =============================================================================
# GET   -> status object (Contract 3 in docs/specs/dns-edge-selection.md)
# POST  {"action":"enable"|"disable"}          -> toggle
# POST  {"action":"save","config":"<text>"}    -> validate + apply config text
# POST  {"action":"refresh_edges"}             -> re-measure providers, regenerate
#
# THE SECURITY SHAPE OF THIS FILE
#   It NEVER forms a path that the root daemon reads. `save` takes config TEXT and
#   pipes it to the one privileged helper (qmanager_dns_apply), which owns every
#   filesystem decision and validates by RUNNING the candidate on a throwaway port.
#   `smartdns test -c` is deliberately not used: on 0.13.1 it accepts
#   `totally-bogus-directive` and `bind not-a-port` and exits 0, so gating on it
#   would ship a broken resolver and call it validated (measured; sibling dns.md:489).
#
# WHY `config_valid` IS ALWAYS null
#   There is no honest way to validate the live file without disturbing it. The
#   field exists so the UI has a stable key, and it says null rather than lying.
#
# WHY THE TOGGLE IS SAFE
#   dnsmasq owns 192.168.0.1:53 and `strict-order`-forwards to 127.0.0.1:5353 with
#   the carrier resolvers as its next tier, so stopping this unit DEGRADES LAN DNS
#   (slower, longer tail) instead of breaking it. Nothing here edits dnsmasq.
#
# Sudoers: www-data ALL=(root) NOPASSWD: /usr/bin/qmanager_dns_apply   (one grant)
# Endpoint: /cgi-bin/quecmanager/network/smartdns.sh
# =============================================================================

qlog_init "cgi_smartdns"
cgi_headers
cgi_handle_options

require_auth

CONF="/usrdata/qmanager/etc/smartdns.conf"
UNIT="qmanager-dns.service"
PORT=5353
APPLY="/usr/bin/qmanager_dns_apply"
EDGE_LEDGER="/tmp/qmanager_dns_edge.json"
PROBE="/usr/bin/qmanager_dns_edge_probe"
LOG="/tmp/smartdns.log"

# --- helpers ---------------------------------------------------------------

# Running state is decided by the LISTENER, not by systemd: a unit can read
# "active" for a second before the process binds, and the UI's toggle must reflect
# what clients actually experience.
listening() {
    netstat -lnu 2>/dev/null | grep -q "127.0.0.1:$PORT"
}

smartdns_pid() {
    for _p in /proc/[0-9]*; do
        [ "$(cat "$_p/comm" 2>/dev/null)" = "smartdns" ] || continue
        _c=$(tr '\0' ' ' < "$_p/cmdline" 2>/dev/null) || continue
        case "$_c" in
            *"$CONF"*) printf '%s\n' "${_p#/proc/}"; return 0 ;;
        esac
    done
    return 1
}

# Process age from /proc only — ps -o etimes is not reliable across busybox builds.
proc_uptime_sec() {
    _pid=$1
    _st=$(awk '{print $22}' "/proc/$_pid/stat" 2>/dev/null)
    case "$_st" in ''|*[!0-9]*) printf 'null'; return ;; esac
    _now=$(cut -d. -f1 /proc/uptime 2>/dev/null)
    case "$_now" in ''|*[!0-9]*) printf 'null'; return ;; esac
    _sec=$(( _now - _st / 100 ))   # HZ=100 on this firmware
    [ "$_sec" -lt 0 ] && _sec=0
    printf '%s' "$_sec"
}

# The generated block, parsed out of the live config. This is what the algorithm
# decided last time, so the UI can show "these providers are in the edge group"
# without trusting a separate cache that could drift from the file.
edge_block() {
    [ -f "$CONF" ] || { printf '[]'; return; }
    awk '
        /^# BEGIN QMANAGER-EDGE v1/ { inb = 1; next }
        /^# END QMANAGER-EDGE v1/   { inb = 0; next }
        inb && /^server / { print }
    ' "$CONF" 2>/dev/null | jq -R -s -c 'split("\n") | map(select(length > 0)) | map(capture("^server (?<url>[^ ]+)").url)'
}

edge_domains() {
    [ -f "$CONF" ] || { printf '[]'; return; }
    # Extract the domain straight out of `nameserver /<domain>/<group>` with awk.
    # The previous version regex-captured it through jq and over-escaped the
    # slashes, so it matched nothing and the page showed an empty domain list even
    # though three nameserver lines were live.
    awk '
        /^# BEGIN QMANAGER-EDGE/ { inb = 1; next }
        /^# END QMANAGER-EDGE/   { inb = 0; next }
        inb && /^nameserver \// { n = split($2, a, "/"); if (n >= 2 && a[2] != "") print a[2] }
    ' "$CONF" 2>/dev/null | jq -R -s -c 'split("\n") | map(select(length > 0))'
}

# Number of upstreams that actually race for ordinary names. Bootstrap entries are
# excluded: they exist to resolve the DoH hostnames themselves, not to answer.
provider_count() {
    [ -f "$CONF" ] || { printf '0'; return; }
    # Exclude the generated EDGE block: it RE-DECLARES providers that are already in
    # the base pool, so counting it reports 11 for an 8-provider pool (measured), and
    # the page then disagrees with the probe, which skips the block.
    _n=$(awk '
        /^# BEGIN QMANAGER-EDGE/ { inb = 1; next }
        /^# END QMANAGER-EDGE/   { inb = 0; next }
        inb { next }
        /^server / && !/bootstrap-dns/ { c++ }
        END { print c + 0 }
    ' "$CONF" 2>/dev/null)
    case "$_n" in ''|*[!0-9]*) _n=0 ;; esac
    printf '%s' "$_n"
}

blocked_count() {
    [ -f "$CONF" ] || { printf '0'; return; }
    _n=$(grep -cE '^address /.*/#$' "$CONF" 2>/dev/null); printf '%s' "${_n:-0}"
}

cache_size_cfg() {
    _n=$(grep -E '^cache-size ' "$CONF" 2>/dev/null | awk '{print $2}' | tail -1)
    case "$_n" in ''|*[!0-9]*) printf 'null' ;; *) printf '%s' "$_n" ;; esac
}

# smartdns logs at warn, so this line only appears at debug/info or when the cache
# is restored. Absent means UNKNOWN, never zero — a zero would read as "empty pool".
cache_loaded() {
    [ -f "$LOG" ] || { printf 'null'; return; }
    _n=$(grep -oE 'DNS cache [0-9]+ records loaded' "$LOG" 2>/dev/null | tail -1 | awk '{print $3}')
    case "$_n" in ''|*[!0-9]*) printf 'null' ;; *) printf '%s' "$_n" ;; esac
}

error_count() {
    [ -f "$LOG" ] || { printf '0'; return; }
    _n=$(grep -c ERROR "$LOG" 2>/dev/null); printf '%s' "${_n:-0}"
}

# --- GET: status -----------------------------------------------------------
build_status() {
    _running=false; _pid="null"; _up="null"; _rss="null"
    if listening; then
        _running=true
        _p=$(smartdns_pid)
        if [ -n "${_p:-}" ]; then
            _pid=$_p
            _up=$(proc_uptime_sec "$_p")
            _r=$(awk '/VmRSS/{print $2}' "/proc/$_p/status" 2>/dev/null)
            case "$_r" in ''|*[!0-9]*) ;; *) _rss=$_r ;; esac
        fi
    fi

    _cpath=$CONF; _fsize="null"; _cmtime="null"
    if [ -f "$CONF" ]; then
        _meta=$(stat -c '%s %Y' "$CONF" 2>/dev/null)
        case "$_meta" in
            *' '*) _fsize=${_meta%% *}; _cmtime=${_meta##* } ;;
        esac
        case "$_fsize" in ''|*[!0-9]*) _fsize=null ;; esac
        case "$_cmtime" in ''|*[!0-9]*) _cmtime=null ;; esac
    fi

    _members=$(edge_block); _domains=$(edge_domains)
    _last="null"
    _measured="[]"
    # The helper stamps this on each successful refresh; absence means never run.
    if [ -f "$EDGE_LEDGER" ]; then
        _last=$(jq -r '.ts // "null"' "$EDGE_LEDGER" 2>/dev/null)
        case "$_last" in ''|*[!0-9]*) _last=null ;; esac
        # The last full provider measurement, so the edge table is populated on
        # first load instead of blank until someone presses Refresh. This is a
        # STORED reading with a timestamp beside it, not a fresh probe: the card
        # renders it as measured-since-boot, and `last_refresh` dates it.
        _measured=$(jq -c '.providers // []' "$EDGE_LEDGER" 2>/dev/null)
        case "$_measured" in \[*\]) ;; *) _measured="[]" ;; esac
    fi

    _tail=$(tail -6 "$LOG" 2>/dev/null | jq -R -s -c 'split("\n") | map(select(length > 0))')

    # The config TEXT, because the editor needs it and no other endpoint returns it.
    # This was a gap in the contract: `save` takes text, the page offers an editor,
    # but the only reader returned metadata. The page therefore sat on its
    # "could not read the config" state forever.
    #
    # --rawfile keeps the bytes verbatim (no shell newline stripping); an unreadable
    # or missing file is swapped for /dev/null so jq still runs, and an empty read
    # becomes null rather than "" so the UI can tell "empty file" from "no file".
    _readconf="$CONF"
    [ -r "$_readconf" ] || _readconf=/dev/null

    jq -n \
        --argjson enabled "$_running" \
        --argjson running "$_running" \
        --argjson pid "$_pid" \
        --argjson uptime "$_up" \
        --argjson rss "$_rss" \
        --arg path "$_cpath" \
        --argjson size "$_fsize" \
        --argjson mtime "$_cmtime" \
        --argjson csize "$(cache_size_cfg)" \
        --argjson cloaded "$(cache_loaded)" \
        --argjson pcount "$(provider_count)" \
        --argjson blocked "$(blocked_count)" \
        --argjson errors "$(error_count)" \
        --argjson members "$_members" \
        --argjson domains "$_domains" \
        --argjson last "$_last" \
        --argjson measured "$_measured" \
        --argjson tail "$_tail" \
        --rawfile cfg "$_readconf" \
        '{
            success: true,
            enabled: $enabled,
            running: $running,
            pid: $pid,
            uptime_sec: $uptime,
            rss_kb: $rss,
            config_path: $path,
            config_size: $size,
            config_mtime: $mtime,
            config_valid: null,
            config: (if $cfg == "" then null else $cfg end),
            cache_size: $csize,
            cache_loaded: $cloaded,
            provider_count: $pcount,
            blocked_count: $blocked,
            error_count: $errors,
            edge: {
                mode: (if ($members | length) > 0 then "generated" else "none" end),
                members: $members,
                domains: $domains,
                last_refresh: $last,
                measured: $measured
            },
            logs_tail: $tail
        }'
}

# --- POST handlers ---------------------------------------------------------

do_toggle() {
    _want=$1
    _res=$(qm_timeout 40 sudo -n "$APPLY" "$_want" 2>/dev/null </dev/null)
    if [ -z "$_res" ]; then
        cgi_error "helper_failed" "qmanager_dns_apply $_want produced no output"
        return
    fi
    printf '%s\n' "$_res" | jq --argjson run "$(listening && echo true || echo false)" \
        '. + {running: $run}'
}

do_save() {
    _text=$(printf '%s' "$POST_DATA" | jq -r '.config // empty' 2>/dev/null)
    if [ -z "$_text" ]; then
        cgi_error "empty_config" "config text is required"
        return
    fi
    # Bounded: validation starts the candidate on a throwaway port (up to ~10 s)
    # and the restart watch adds up to 15 s.
    _res=$(printf '%s' "$_text" | qm_timeout 90 sudo -n "$APPLY" save 2>/dev/null)
    if [ -z "$_res" ]; then
        cgi_error "helper_failed" "apply produced no output (timeout or crash); the live config was not changed"
        return
    fi
    printf '%s\n' "$_res"
}

do_refresh_edges() {
    if [ ! -x "$PROBE" ]; then
        cgi_error "probe_missing" "qmanager_dns_edge_probe is not installed"
        return
    fi
    # Measure first (read-only), so the UI can show the decision even if the apply
    # step refuses to act on it.
    _m=$(qm_timeout 90 "$PROBE" --json 2>/dev/null </dev/null)
    if [ -z "$_m" ]; then
        cgi_error "probe_failed" "Provider measurement did not complete"
        return
    fi
    _rec=$(printf '%s' "$_m" | jq -c '.recommendation // null' 2>/dev/null)
    # Hand the measurement over instead of letting apply-edge repeat it: the sweep
    # is the slow part (30-40 s), and running it twice per click is what made this
    # feel stalled. apply-edge still measures on its own when the timer calls it.
    _res=$(printf '%s' "$_m" | qm_timeout 150 sudo -n "$APPLY" apply-edge 2>/dev/null)
    _applied=false
    case "$_res" in *'"applied":false'*) _applied=false ;; *'"ok":true'*) _applied=true ;; esac
    jq -n --argjson rec "$_rec" --argjson applied "$_applied" --argjson providers \
        "$(printf '%s' "$_m" | jq -c '.providers // []')" \
        '{success: true, applied: $applied, recommendation: $rec, providers: $providers}'
}

# --- dispatch --------------------------------------------------------------
case "$REQUEST_METHOD" in
    GET)
        build_status
        ;;
    POST)
        cgi_read_post
        _action=$(printf '%s' "$POST_DATA" | jq -r '.action // empty' 2>/dev/null)
        case "$_action" in
            enable)  qlog_info "smartdns enable";  do_toggle enable ;;
            disable) qlog_info "smartdns disable"; do_toggle disable ;;
            save)
                qlog_info "smartdns config save requested"
                do_save
                ;;
            refresh_edges)
                qlog_info "smartdns edge refresh requested"
                do_refresh_edges
                ;;
            '') cgi_error "missing_action" "action is required" ;;
            *)  cgi_error "unknown_action" "Unsupported action: $_action" ;;
        esac
        ;;
    *)
        cgi_method_not_allowed
        ;;
esac
exit 0
