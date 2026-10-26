#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# =============================================================================
# custom_dns.sh — CGI Endpoint: Custom DNS Server Configuration (GET + POST)
# =============================================================================
# GET:  Reads the QManager-managed sentinel block from /etc/data/dnsmasq.conf,
#       reports enabled state, configured servers, and dnsmasq proxy availability.
# POST action=save:
#       Validates input, builds a CANONICAL candidate (block stripped + trailing
#       blank lines dropped + the block re-appended exactly once), asserts its own
#       directives survived, validates with dnsmasq --test, and only then swaps it
#       in. Reloads dnsmasq (HUP — never a restart) only when the bytes actually
#       changed, then verifies the LAN still resolves and rolls back if it does not.
# POST action=clear:
#       Strips the sentinel block and reloads — equivalent to save with enabled=false.
#
# Config injection target:  /etc/data/dnsmasq.conf  (persistent UBIFS, same
#   volume as /usrdata; QCMAP includes it via conf-file= in the runtime bridge0
#   config and never rewrites anything outside known dhcp-option-force fields)
#
# Canonical form — the writer is idempotent, and this is what makes it so:
#   * the sentinel block is removed together with any trailing blank lines, and
#     re-appended exactly once, so two consecutive saves of the same settings
#     produce byte-identical files and `cmp` is a valid change test;
#   * an UNTERMINATED block (BEGIN with no END) is refused, not "repaired" —
#     stripping it would silently drop every line after the marker;
#   * the candidate is checked for our own directives before the live daemon is
#     touched, because `dnsmasq --test` accepts a file that parses but has lost
#     them.
#
# Sentinel format:
#   # QMANAGER-CUSTOM-DNS-BEGIN v1
#   no-resolv                        (only when ignoreCarrier=true)
#   server=1.1.1.1                   (one line per upstream; max 4)
#   # QMANAGER-CUSTOM-DNS-END v1
#
# Sudoers-required commands:
#   sudo /bin/mv /etc/data/qmanager/dnsmasq.conf.new /etc/data/dnsmasq.conf
#   sudo /bin/chown radio:radio /etc/data/dnsmasq.conf
#   sudo /usr/bin/killall -HUP dnsmasq
#   sudo /bin/systemctl start dnsmasq_service@0.service   (only if it is not running)
#
# Rollback deliberately reuses the SAME mv grant (backup -> staging -> mv), so
# undoing a change never needs a privilege the forward path did not already use.
#
# Endpoint: GET/POST /cgi-bin/quecmanager/network/custom_dns.sh
# Install:  /www/cgi-bin/quecmanager/network/custom_dns.sh
# =============================================================================

qlog_init "cgi_custom_dns"
cgi_headers
cgi_handle_options

# --- Constants ----------------------------------------------------------------
DNSMASQ_CONF="/etc/data/dnsmasq.conf"
STAGING_DIR="/etc/data/qmanager"
STAGING_FILE="${STAGING_DIR}/dnsmasq.conf.new"
BACKUP_FILE="${STAGING_DIR}/dnsmasq.conf.prev"
# The runtime config QCMAP_ConnectionManager writes per bridge; it conf-file's
# DNSMASQ_CONF. Used only to discover the LAN address dnsmasq answers on, so the
# post-apply probe asks the same daemon the LAN clients ask.
DNSMASQ_RUN_CONF="/var/run/data/dnsmasq.conf.bridge0"
# The unit that actually runs dnsmasq on this device. /lib/systemd/system/
# dnsmasq.service is dead and disabled — QCMAP starts the template instead, and
# NOTHING supervises it, so a failed start means LAN DNS stays dead silently.
DNSMASQ_UNIT="dnsmasq_service@0.service"
MOBILEAP_XML="/etc/data/mobileap_cfg.xml"
SENTINEL_BEGIN="# QMANAGER-CUSTOM-DNS-BEGIN v1"
SENTINEL_END="# QMANAGER-CUSTOM-DNS-END v1"
MAX_SERVERS=4

# =============================================================================
# Helpers
# =============================================================================

# get_dns_mode — read <DNSMode> from mobileap_cfg.xml as a tri-state: the value
# verbatim, ABSENT when the element is not present, UNKNOWN when it cannot be read.
get_dns_mode() {
    if [ ! -f "$MOBILEAP_XML" ] || [ ! -r "$MOBILEAP_XML" ]; then
        printf "UNKNOWN"
        return
    fi
    # Presence must not depend on xmlstarlet — it is absent on both live devices.
    local rc
    grep -qE '<DNSMode([[:space:]]|>|/>)' "$MOBILEAP_XML" 2>/dev/null
    rc=$?
    if [ "$rc" -ne 0 ]; then
        # ABSENT needs a clean no-match (1, not a grep error) AND the <DHCPCfg>
        # container in view — otherwise the file is truncated and we fail closed.
        if [ "$rc" -eq 1 ] && grep -q '<DHCPCfg' "$MOBILEAP_XML" 2>/dev/null; then
            printf "ABSENT"
        else
            printf "UNKNOWN"
        fi
        return
    fi
    local val
    if command -v xmlstarlet >/dev/null 2>&1; then
        val=$(xmlstarlet sel -t -v "//DNSMode" "$MOBILEAP_XML" 2>/dev/null)
    else
        val=$(grep -oE '<DNSMode>[^<]*</DNSMode>' "$MOBILEAP_XML" 2>/dev/null \
              | sed 's/<[^>]*>//g')
    fi
    printf '%s' "${val:-UNKNOWN}"
}

# dns_mode_available — writes are permitted when the mode reads PROXY, or when
# the firmware has no DNSMode selector at all (SDX55: absent means proxy-only).
dns_mode_available() {
    case "$1" in
        PROXY|ABSENT) return 0 ;;
    esac
    return 1
}

# get_passthrough_bypass — true when IP passthrough is active AND DNS proxy is
# disabled, meaning LAN clients bypass dnsmasq entirely.
# Both fields live in mobileap_cfg.xml.
# Returns the literal strings "true" or "false".
get_passthrough_bypass() {
    # TODO: full passthrough-bypass detection needs robust XML parsing of
    # MPDN_rule fields; returning false is the safe default (frontend treats
    # false as "no interop concern").
    printf "false"
}

# validate_ip_addr — returns 0 if the argument looks like a valid IPv4 or IPv6
# address.  Uses a permissive regex — the real gate is dnsmasq --test.
validate_ip_addr() {
    local addr="$1"
    # IPv4: four dotted decimal octets 0-255
    case "$addr" in
        *:*) : ;;   # contains colon — treat as IPv6 below
        [0-9]*.[0-9]*.[0-9]*.[0-9]*)
            # Each octet must be 0-255
            local IFS='.'
            set -- $addr
            [ $# -eq 4 ] || return 1
            for octet in "$@"; do
                case "$octet" in
                    ''|*[!0-9]*) return 1 ;;
                esac
                [ "$octet" -ge 0 ] && [ "$octet" -le 255 ] || return 1
            done
            return 0
            ;;
        *) return 1 ;;
    esac
    # IPv6: must contain at least one colon and only hex digits, colons, or
    # a single '%' scope suffix; empty segments from '::' are fine.
    case "$addr" in
        *[!0-9A-Fa-f:.]* ) return 1 ;;
        *:*) return 0 ;;
    esac
    return 1
}

# parse_sentinel_block — emit only the lines between our sentinels (exclusive).
# Returns nothing if the block is not present or is corrupted.
# Signals corruption via exit status 2.
parse_sentinel_block() {
    local file="$1"
    local in_block=0
    local found_begin=0
    local found_end=0
    # `|| [ -n "$line" ]`: read returns 1 at EOF even when it filled $line, so a
    # bare `while read` never runs the body for a final line with no trailing
    # newline — a healthy file ending at the END marker then reported
    # blockCorrupt. QCMAP rewrites this file with `sed -i`, which is exactly the
    # kind of rewriter that can leave it without a final newline.
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            "$SENTINEL_BEGIN")
                found_begin=1
                in_block=1
                ;;
            "$SENTINEL_END")
                found_end=1
                in_block=0
                ;;
            *)
                [ "$in_block" -eq 1 ] && printf '%s\n' "$line"
                ;;
        esac
    done < "$file"
    # Corrupted: one sentinel present without the other
    if [ "$found_begin" -eq 1 ] && [ "$found_end" -eq 0 ]; then return 2; fi
    if [ "$found_begin" -eq 0 ] && [ "$found_end" -eq 1 ]; then return 2; fi
    return 0
}

# canonical_conf_body — emit $1 to stdout with QManager's sentinel block removed
# AND the file's trailing blank lines dropped, so that re-appending the block
# yields a byte-identical file.
#
# This is what makes the writer idempotent. Without it the block's position drifts
# every save (each run appended after whatever blank lines the previous run left),
# so `cmp` against the live file could never be used as a "did anything actually
# change" test — and an unchanged save reloaded the daemon for nothing.
#
# Exit 3 on an UNTERMINATED block (BEGIN with no END). A one-way in-block flag
# drops every line after such a BEGIN — the entire tail of /etc/data/dnsmasq.conf
# — and `dnsmasq --test` accepts the truncated result, because it is
# syntactically valid and merely missing directives. Refusing is the only safe
# answer: the caller leaves the live file untouched and says so.
canonical_conf_body() {
    awk -v b="$SENTINEL_BEGIN" -v e="$SENTINEL_END" '
        $0 == b { inb = 1; next }
        inb && $0 == e { inb = 0; next }
        inb { next }
        # Hold TRULY EMPTY lines back and flush them when real content follows,
        # so interior blank lines survive and trailing ones do not. The test is
        # `$0 == ""`, NOT /^[[:space:]]*$/: this stock dnsmasq.conf contains
        # whitespace-only lines ("  ", " ") inside its own comments, and treating
        # those as blank rewrote them to empty — mutating bytes QManager does not
        # own. Verified 2026-10-26: the whitespace-only test changed two lines on
        # every save+clear cycle and md5 never returned to its baseline.
        $0 == "" { held++; next }
        { while (held > 0) { print ""; held-- } print }
        END { if (inb) exit 3 }
    ' "$1"
}

# assert_own_block — the candidate must carry exactly one complete, self-
# consistent block. Run BEFORE the live daemon is touched: `dnsmasq --test` only
# proves the file parses, it cannot know that OUR directives are still in it.
assert_own_block() {
    local f="$1"
    local n_begin n_end s
    n_begin=$(grep -cxF "$SENTINEL_BEGIN" "$f" 2>/dev/null)
    n_end=$(grep -cxF "$SENTINEL_END" "$f" 2>/dev/null)
    if [ "$ENABLED" = "true" ]; then
        [ "$n_begin" = "1" ] || return 1
        [ "$n_end" = "1" ] || return 1
        if [ "$IGNORE_CARRIER" = "true" ]; then
            grep -qxF 'no-resolv' "$f" || return 1
        fi
        for s in $server_addrs; do
            grep -qxF "server=$s" "$f" || return 1
        done
    else
        # Disabled means our block is gone — not merely emptied.
        [ "$n_begin" = "0" ] || return 1
        [ "$n_end" = "0" ] || return 1
    fi
    return 0
}

# lan_dns_addr — the address LAN clients are actually told to query.
#
# The runtime config's `dhcp-option-force=6,<ip>` is the PRIMARY source because it
# is literally the answer DHCP hands clients, and because on this firmware it is
# the only one available: neither `ip` nor `ifconfig` is installed on the O5A
# (verified 2026-10-26 — `command -v ip` and `command -v ifconfig` both miss).
# The interface lookups stay as fallbacks for other devices, after the DHCP value,
# so a wrong guess there cannot override the address clients really use.
lan_dns_addr() {
    local ip
    if [ -f "$DNSMASQ_RUN_CONF" ]; then
        ip=$(sed -n 's/^dhcp-option-force=6,//p' "$DNSMASQ_RUN_CONF" 2>/dev/null | head -1)
    fi
    if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
        ip=$(ip -4 -o addr show bridge0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
    fi
    if [ -z "$ip" ] && command -v ifconfig >/dev/null 2>&1; then
        ip=$(ifconfig bridge0 2>/dev/null | awk '/inet /{print $2}' | sed 's/^addr://' | head -1)
    fi
    printf '%s' "$ip"
}

# verify_dns_live — after a reload, prove the LAN still has a working resolver.
# Two independent assertions: the daemon is running (nothing supervises it on
# this firmware), and it answers on the LAN address. Returns 1 if either fails,
# which makes the caller roll back.
verify_dns_live() {
    local addr out
    addr=$(lan_dns_addr)

    if ! pidof dnsmasq >/dev/null 2>&1; then
        qlog_warn "dnsmasq not running after reload; starting $DNSMASQ_UNIT"
        sudo /bin/systemctl start "$DNSMASQ_UNIT" >/dev/null 2>&1 || true
        sleep 1
        if ! pidof dnsmasq >/dev/null 2>&1; then
            qlog_warn "dnsmasq still not running after start attempt"
            return 1
        fi
    fi

    # No address to probe (unexpected: bridge0 is how the CGI was reached) — the
    # daemon-alive check above is all that can be asserted, so do not fail on it.
    [ -n "$addr" ] || { qlog_warn "no LAN address found; skipped the resolve probe"; return 0; }

    if command -v dig >/dev/null 2>&1; then
        out=$(dig +time=2 +tries=1 "@${addr}" example.com A 2>/dev/null) || return 1
        printf '%s' "$out" | grep -q 'status: NOERROR' || return 1
    elif command -v nslookup >/dev/null 2>&1; then
        nslookup example.com "$addr" >/dev/null 2>&1 || return 1
    else
        qlog_warn "neither dig nor nslookup is installed; skipped the resolve probe"
    fi
    return 0
}

# rollback_live_conf — put BACKUP_FILE back and re-signal the daemon.
# Deliberately staged through STAGING_FILE and installed with the same
# `sudo /bin/mv` grant the forward path uses: no new privilege is needed to undo
# a change, so rollback cannot be the step that lacks permission.
rollback_live_conf() {
    [ -f "$BACKUP_FILE" ] || return 1
    cp -f "$BACKUP_FILE" "$STAGING_FILE" 2>/dev/null || return 1
    sudo /bin/mv "$STAGING_FILE" "$DNSMASQ_CONF" || return 1
    sudo /bin/chown radio:radio "$DNSMASQ_CONF" 2>/dev/null || true
    sudo /usr/bin/killall -HUP dnsmasq 2>/dev/null || true
    return 0
}

# build_get_payload — emit the full GET JSON object.
# Used by GET directly and also embedded in a successful POST response.
build_get_payload() {
    local conf_missing=0
    local block_corrupt=0
    local enabled=false
    local ignore_carrier=false
    local servers_json="[]"
    local dns_mode
    local available=false
    local current_upstream_json="[]"
    local current_source="unknown"
    local passthrough_bypass

    # --- Config file presence ---
    if [ ! -f "$DNSMASQ_CONF" ]; then
        conf_missing=1
    fi

    # --- Parse sentinel block ---
    if [ "$conf_missing" -eq 0 ]; then
        block_content=$(parse_sentinel_block "$DNSMASQ_CONF")
        block_status=$?

        if [ "$block_status" -eq 2 ]; then
            block_corrupt=1
            # Return enabled=false — frontend offers "Clear stored config"
        elif [ "$block_status" -eq 0 ] && [ -n "$block_content" ]; then
            enabled=true
            # Extract no-resolv and server= lines from block content
            if printf '%s\n' "$block_content" | grep -q '^no-resolv$'; then
                ignore_carrier=true
            fi
            # Build servers array from server= lines
            servers_json=$(printf '%s\n' "$block_content" \
                | grep '^server=' \
                | sed 's/^server=//' \
                | jq -R . \
                | jq -s .)
        fi
    fi

    # --- DNS mode from XML ---
    dns_mode=$(get_dns_mode)
    if dns_mode_available "$dns_mode"; then
        available=true
    fi

    # --- Current upstream resolution ---
    if [ "$enabled" = "true" ]; then
        # Our block is active — live upstream is our configured servers
        current_upstream_json="$servers_json"
        current_source="custom"
    else
        # Carrier-assigned upstream: /run/resolv.conf, else /etc/resolv.conf
        # (SDX55 has only the latter). First candidate with nameservers wins.
        local resolv_file
        local resolv_json
        for resolv_file in /run/resolv.conf /etc/resolv.conf; do
            [ -f "$resolv_file" ] || continue
            resolv_json=$(grep '^nameserver ' "$resolv_file" \
                | awk '{print $2}' \
                | jq -R . \
                | jq -s .)
            if [ -n "$resolv_json" ] && [ "$resolv_json" != "[]" ]; then
                current_upstream_json="$resolv_json"
                current_source="carrier"
                break
            fi
        done
    fi

    # --- Passthrough bypass ---
    passthrough_bypass=$(get_passthrough_bypass)

    # --- Emit JSON ---
    if [ "$conf_missing" -eq 1 ]; then
        jq -n \
            --argjson enabled false \
            --argjson available false \
            '{"enabled":$enabled,"ignoreCarrier":false,"servers":[],"dnsMode":"UNKNOWN","available":$available,"currentUpstream":[],"currentSource":"unknown","passthroughBypass":false,"error":"dnsmasq config file not found"}'
        return
    fi

    jq -n \
        --argjson enabled          "$enabled" \
        --argjson ignoreCarrier    "$ignore_carrier" \
        --argjson servers          "$servers_json" \
        --arg     dnsMode          "$dns_mode" \
        --argjson available        "$available" \
        --argjson currentUpstream  "$current_upstream_json" \
        --arg     currentSource    "$current_source" \
        --argjson passthroughBypass "$passthrough_bypass" \
        --argjson blockCorrupt     "$( [ "$block_corrupt" -eq 1 ] && printf 'true' || printf 'false' )" \
        '{
            "enabled":           $enabled,
            "ignoreCarrier":     $ignoreCarrier,
            "servers":           $servers,
            "dnsMode":           $dnsMode,
            "available":         $available,
            "currentUpstream":   $currentUpstream,
            "currentSource":     $currentSource,
            "passthroughBypass": $passthroughBypass,
            "blockCorrupt":      $blockCorrupt
        }'
}

# =============================================================================
# GET — read current state
# =============================================================================
if [ "$REQUEST_METHOD" = "GET" ]; then
    qlog_info "GET custom DNS config"
    build_get_payload
    exit 0
fi

# =============================================================================
# POST — save or clear
# =============================================================================
if [ "$REQUEST_METHOD" = "POST" ]; then

    cgi_read_post

    ACTION=$(printf '%s' "$POST_DATA" | jq -r '.action // empty')

    if [ -z "$ACTION" ]; then
        cgi_error "missing_action" "action field is required"
        exit 0
    fi

    # -------------------------------------------------------------------------
    # action=clear — strip our block and reload; same path as save with enabled=false
    # -------------------------------------------------------------------------
    if [ "$ACTION" = "clear" ]; then
        POST_DATA=$(printf '{"action":"save","enabled":"false","ignore_carrier":"false","servers":""}')
        ACTION="save"
        qlog_info "action=clear mapped to save with enabled=false"
    fi

    # -------------------------------------------------------------------------
    # action=save
    # -------------------------------------------------------------------------
    if [ "$ACTION" = "save" ]; then

        # has() — NOT "// empty": jq's alternative operator treats `false` as
        # absent (false // empty → no output), so a disable request read as an
        # empty string and failed the true|false gate below.
        ENABLED=$(printf '%s' "$POST_DATA" | jq -r 'if has("enabled") then .enabled else empty end')
        IGNORE_CARRIER=$(printf '%s' "$POST_DATA" | jq -r 'if has("ignore_carrier") then .ignore_carrier else "false" end')
        SERVERS_RAW=$(printf '%s' "$POST_DATA" | jq -r '.servers // empty')

        qlog_info "save: enabled=$ENABLED ignore_carrier=$IGNORE_CARRIER servers=$SERVERS_RAW"

        # --- Validate enabled ---
        case "$ENABLED" in
            true|false) ;;
            *)
                jq -n '{"ok":false,"error":"enabled must be true or false","field":"enabled"}'
                exit 0
                ;;
        esac

        # --- Validate ignore_carrier ---
        case "$IGNORE_CARRIER" in
            true|false) ;;
            *)
                jq -n '{"ok":false,"error":"ignore_carrier must be true or false","field":"ignore_carrier"}'
                exit 0
                ;;
        esac

        # --- Gate: dnsMode must be PROXY ---
        dns_mode=$(get_dns_mode)
        if ! dns_mode_available "$dns_mode"; then
            jq -n --arg mode "$dns_mode" \
                '{"ok":false,"error":"Custom DNS is unavailable while DNS Mode is \($mode)"}'
            # HTTP 409 body; lighttpd reads status from Status: header if present
            # cgi_base.sh emits headers already — annotate with a comment here
            # noting the semantic intent (409 Conflict).
            exit 0
        fi

        # --- Validate and collect servers (only when enabled=true) ---
        server_list=""
        server_addrs=""
        server_count=0

        if [ "$ENABLED" = "true" ]; then
            if [ -z "$SERVERS_RAW" ]; then
                jq -n '{"ok":false,"error":"at least one server is required when enabled is true","field":"servers"}'
                exit 0
            fi

            # SERVERS_RAW is comma-separated; split on commas. Save and restore
            # the original IFS so we don't permanently clobber the POSIX default
            # (space-tab-newline) for the rest of the script.
            old_IFS="$IFS"
            IFS=','
            for raw_addr in $SERVERS_RAW; do
                IFS="$old_IFS"
                # Strip surrounding whitespace
                addr=$(printf '%s' "$raw_addr" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
                if [ -z "$addr" ]; then
                    IFS=','
                    continue
                fi

                if ! validate_ip_addr "$addr"; then
                    IFS="$old_IFS"
                    jq -n --arg addr "$addr" \
                        '{"ok":false,"error":"invalid IP address: \($addr)","field":"servers"}'
                    exit 0
                fi

                server_count=$((server_count + 1))
                if [ "$server_count" -gt "$MAX_SERVERS" ]; then
                    IFS="$old_IFS"
                    jq -n --arg max "$MAX_SERVERS" \
                        '{"ok":false,"error":"too many servers (max \($max))","field":"servers"}'
                    exit 0
                fi

                server_list="${server_list}server=${addr}
"
                server_addrs="${server_addrs} ${addr}"
                IFS=','
            done
            IFS="$old_IFS"

            if [ "$server_count" -eq 0 ]; then
                jq -n '{"ok":false,"error":"at least one valid server is required","field":"servers"}'
                exit 0
            fi
        fi

        # --- Confirm config file exists ---
        if [ ! -f "$DNSMASQ_CONF" ]; then
            jq -n '{"ok":false,"error":"dnsmasq config file not found"}'
            exit 0
        fi

        # --- Staging dir ---
        # Installer-created (0700 www-data). Recreated here if a restore or a
        # hand-cleanup dropped it: without it the redirect below fails and every
        # save reports "failed to write staging config file" with no clue why.
        if [ ! -d "$STAGING_DIR" ]; then
            if ! mkdir -p "$STAGING_DIR" 2>/dev/null; then
                jq -n --arg d "$STAGING_DIR" \
                    '{"ok":false,"error":"staging directory \($d) is missing and could not be created"}'
                exit 0
            fi
            chmod 0700 "$STAGING_DIR" 2>/dev/null || true
            qlog_warn "staging directory $STAGING_DIR was missing; recreated"
        fi

        # --- Build candidate: canonical body, then the block exactly once ---
        canonical_conf_body "$DNSMASQ_CONF" > "$STAGING_FILE"
        build_status=$?
        if [ "$build_status" -eq 3 ]; then
            rm -f "$STAGING_FILE"
            qlog_warn "refusing to write: sentinel BEGIN present without END"
            jq -n '{"ok":false,"error":"The QManager DNS block in /etc/data/dnsmasq.conf is unterminated (a BEGIN marker with no matching END). Rewriting it would discard every line after that marker, so nothing was changed. Repair the file by hand — remove the stray BEGIN line — and save again.","field":"config"}'
            exit 0
        fi
        if [ "$build_status" -ne 0 ]; then
            rm -f "$STAGING_FILE"
            jq -n '{"ok":false,"error":"failed to read the dnsmasq config file"}'
            exit 0
        fi

        if [ "$ENABLED" = "true" ]; then
            {
                printf '%s\n' "$SENTINEL_BEGIN"
                if [ "$IGNORE_CARRIER" = "true" ]; then
                    printf 'no-resolv\n'
                fi
                # server_list already has each line terminated with \n
                printf '%s' "$server_list"
                printf '%s\n' "$SENTINEL_END"
            } >> "$STAGING_FILE"
            if [ $? -ne 0 ]; then
                rm -f "$STAGING_FILE"
                jq -n '{"ok":false,"error":"failed to write staging config file"}'
                exit 0
            fi
        fi

        # --- Assert the candidate carries OUR directives ---
        # `dnsmasq --test` only proves the file parses; it happily accepts a file
        # that has lost the block we just wrote. This is the check that catches
        # "saved successfully, configured nothing".
        if ! assert_own_block "$STAGING_FILE"; then
            rm -f "$STAGING_FILE"
            qlog_warn "candidate failed its own block check; live config untouched"
            jq -n '{"ok":false,"error":"the generated configuration failed its own consistency check (QManager block missing or duplicated); the live config was not touched"}'
            exit 0
        fi

        # --- Server-side syntax validation ---
        dnsmasq_err=$(dnsmasq --test --conf-file="$STAGING_FILE" 2>&1)
        dnsmasq_exit=$?
        if [ "$dnsmasq_exit" -ne 0 ]; then
            rm -f "$STAGING_FILE"
            jq -n --arg err "$dnsmasq_err" \
                '{"ok":false,"error":"dnsmasq rejected this configuration: \($err)"}'
            exit 0
        fi

        # --- Apply only when the file actually changed ---
        # The candidate is canonical, so this comparison is meaningful: an
        # identical save means the daemon is already serving this config and a
        # reload would only flush the front cache for nothing.
        if cmp -s "$STAGING_FILE" "$DNSMASQ_CONF"; then
            rm -f "$STAGING_FILE"
            qlog_info "custom DNS unchanged; dnsmasq not reloaded"
            applied=$(build_get_payload)
            jq -n --argjson applied "$applied" '{"ok":true,"changed":false,"applied":$applied}'
            exit 0
        fi

        qlog_info "dnsmasq --test passed; config changed, applying"

        # --- Keep the previous file so a rejected apply can be undone ---
        if ! cp -f "$DNSMASQ_CONF" "$BACKUP_FILE" 2>/dev/null; then
            rm -f "$STAGING_FILE"
            jq -n '{"ok":false,"error":"could not back up the current config; nothing was changed"}'
            exit 0
        fi

        # --- Apply: atomic mv + chown + HUP ---
        if ! sudo /bin/mv "$STAGING_FILE" "$DNSMASQ_CONF"; then
            rm -f "$STAGING_FILE"
            jq -n '{"ok":false,"error":"failed to install config (mv failed)"}'
            exit 0
        fi

        if ! sudo /bin/chown radio:radio "$DNSMASQ_CONF"; then
            qlog_warn "chown radio:radio failed (non-fatal but QCMAP rewrites may break)"
        fi

        # HUP is a reload, not a restart: the daemon keeps its PID, so there is
        # no window in which the LAN has no resolver. Do not convert this to
        # `systemctl restart` — see docs/reference/custom-dns.md.
        if ! sudo /usr/bin/killall -HUP dnsmasq; then
            qlog_warn "killall -HUP dnsmasq failed; rolling back"
            rollback_live_conf && qlog_warn "previous config restored"
            jq -n '{"ok":false,"error":"dnsmasq could not be signalled to reload; the previous configuration was restored"}'
            exit 0
        fi

        # --- Prove the LAN still resolves; roll back if it does not ---
        if ! verify_dns_live; then
            qlog_warn "post-apply DNS verification failed; rolling back"
            if rollback_live_conf; then
                qlog_warn "previous config restored after failed verification"
                jq -n '{"ok":false,"error":"dnsmasq stopped answering on the LAN address after the reload; the previous configuration was restored. Check /var/log/qmanager.log."}'
            else
                qlog_warn "ROLLBACK FAILED after failed verification — LAN DNS may be degraded"
                jq -n '{"ok":false,"error":"dnsmasq stopped answering on the LAN address and the previous configuration could not be restored. Reboot the device or re-save the configuration."}'
            fi
            exit 0
        fi

        rm -f "$BACKUP_FILE"
        qlog_info "custom DNS applied successfully"

        # --- Return ok + full current state so frontend avoids a refetch ---
        applied=$(build_get_payload)
        jq -n --argjson applied "$applied" '{"ok":true,"changed":true,"applied":$applied}'
        exit 0
    fi

    # --- Unknown action ---
    cgi_error "invalid_action" "action must be save or clear"
    exit 0
fi

# --- Method not allowed -------------------------------------------------------
cgi_method_not_allowed
