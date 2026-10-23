#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# =============================================================================
# ip_passthrough.sh — O5A IP Passthrough endpoint (GET + POST)
#
# The RG520N-EB firmware used by the GreenPacket O5A Pro does not answer the
# QMAP IPPT commands used by upstream QManager. The product's loopback
# radio-handler owns this setting and exposes only an enabled boolean. Keep
# this CGI as a thin authenticated adapter; never write the vendor XML directly
# and never report success unless the product endpoint confirms the requested
# value and says a reboot is required.
#
# Product API:
#   GET  http://127.0.0.1:8091/passthrough
#   POST http://127.0.0.1:8091/passthrough/set {"enabled":true|false}
#
# Enabling can make the LAN gateway unreachable. The UI confirms this before
# POST; cgi_reboot_response performs the existing acknowledged reboot handoff.
# =============================================================================

qlog_init "cgi_ip_passthrough"
cgi_headers
cgi_handle_options

PASSTHROUGH_GET_URL="http://127.0.0.1:8091/passthrough"
PASSTHROUGH_SET_URL="http://127.0.0.1:8091/passthrough/set"

# fetch_enabled sets PT_ENABLED to the literal JSON boolean text true/false.
# Transport, HTTP, malformed JSON and wrong-type failures are all distinct from
# the legitimate false state.
fetch_enabled() {
    _pt_response=$(curl -fsS --connect-timeout 2 --max-time 8 "$PASSTHROUGH_GET_URL" 2>/dev/null)
    _pt_rc=$?
    if [ "$_pt_rc" -ne 0 ] || [ -z "$_pt_response" ]; then
        return 1
    fi

    PT_ENABLED=$(printf '%s' "$_pt_response" | jq -r \
        'if type == "object" and (.enabled | type) == "boolean" then (.enabled | tostring) else empty end' \
        2>/dev/null)
    case "$PT_ENABLED" in
        true|false) return 0 ;;
        *) PT_ENABLED=""; return 1 ;;
    esac
}

# =============================================================================
# GET — Read the product backend's configured passthrough flag
# =============================================================================
if [ "$REQUEST_METHOD" = "GET" ]; then
    if ! fetch_enabled; then
        qlog_error "Product passthrough GET failed or returned an invalid enabled flag"
        cgi_error "passthrough_backend_unavailable" "The device passthrough service did not return a valid state"
        exit 0
    fi

    jq -n --argjson enabled "$PT_ENABLED" \
        '{success:true, enabled:$enabled}'
    exit 0
fi

# =============================================================================
# POST — Set enabled flag through the product API and reboot after confirmation
# =============================================================================
if [ "$REQUEST_METHOD" = "POST" ]; then
    cgi_read_post

    ACTION=$(printf '%s' "$POST_DATA" | jq -r \
        'if type == "object" then (.action // "") else "" end' 2>/dev/null)
    if [ "$ACTION" != "apply" ]; then
        cgi_error "invalid_action" "action must be apply"
        exit 0
    fi

    ENABLED=$(printf '%s' "$POST_DATA" | jq -r \
        'if type == "object" and (.enabled | type) == "boolean" then (.enabled | tostring) else empty end' \
        2>/dev/null)
    case "$ENABLED" in
        true|false) ;;
        *)
            cgi_error "invalid_enabled" "enabled must be a JSON boolean"
            exit 0
            ;;
    esac

    qlog_info "Apply: enabled=$ENABLED via product passthrough API"
    PT_BODY=$(printf '{"enabled":%s}' "$ENABLED")
    PT_RESPONSE=$(curl -fsS --connect-timeout 2 --max-time 8 \
        -H 'Content-Type: application/json' \
        --data-binary "$PT_BODY" "$PASSTHROUGH_SET_URL" 2>/dev/null)
    PT_RC=$?
    if [ "$PT_RC" -ne 0 ] || [ -z "$PT_RESPONSE" ]; then
        qlog_error "Product passthrough setter transport failed (curl rc=$PT_RC)"
        cgi_error "passthrough_backend_failed" "The device passthrough service could not apply the setting"
        exit 0
    fi

    # The product API owns persistence; accept only an exact matching state and
    # its rebootRequired acknowledgement. Never reboot after an ambiguous write.
    if ! printf '%s' "$PT_RESPONSE" | jq -e --argjson expected "$ENABLED" \
        'type == "object" and .enabled == $expected and (.rebootRequired == true or .reboot_required == true)' \
        >/dev/null 2>&1; then
        qlog_error "Product passthrough setter did not confirm enabled=$ENABLED and rebootRequired"
        cgi_error "passthrough_backend_unconfirmed" "The device did not confirm the requested setting; no reboot was scheduled"
        exit 0
    fi

    qlog_info "Product backend confirmed enabled=$ENABLED; scheduling acknowledged reboot"
    cgi_reboot_response
fi

# --- Method not allowed -------------------------------------------------------
cgi_method_not_allowed
