#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
. /usr/lib/qmanager/ippt.sh
# =============================================================================
# ip_passthrough.sh — O5A IP Passthrough endpoint (GET + POST)
# =============================================================================
# Drives Quectel's ql_qmap (see lib/ippt.sh for why not AT+QMAP and what was
# measured). The device that receives the carrier IP is found automatically from
# the router's DHCP leases + ARP table; the page never asks for a MAC.
#
# GET  -> {success, enabled, state, target_mac, clients}
#           enabled    what the owner asked for (/etc/qmanager/ippt.json)
#           state      active | inactive | unknown   (read from QCMAP, never guessed)
#           target_mac the device that is / would be bound ("" if none connected)
#           clients    number of live LAN clients (passthrough binds exactly one)
# POST {"action":"apply","enabled":true}
#        persist, bind the target now, confirm ACTIVATED; no reboot. With no client
#        connected it stays "inactive" and a background waiter binds one as soon as
#        a device appears.
# POST {"action":"apply","enabled":false}
#        persist. A live disable does not work on this firmware, so if passthrough
#        is currently active the response is the usual acknowledged reboot handoff
#        ({"success":true}); if it is not active nothing needs to happen.
# =============================================================================

qlog_init "cgi_ip_passthrough"
cgi_headers
cgi_handle_options

# Detached retry for "enabled but nothing to bind yet". qmanager_ippt_apply holds a
# lock, so spawning it repeatedly is harmless.
spawn_waiter() {
    ( setsid nohup /usr/bin/qmanager_ippt_apply --boot </dev/null >/dev/null 2>&1 & ) >/dev/null 2>&1
}

emit_state() {
    # $1 detail (optional)
    _want=$(ippt_desired)
    _st=$(ippt_state)
    _cl=$(ippt_clients | wc -l | tr -d ' ')
    _mac=$(ippt_target_mac)
    jq -n --argjson enabled "$_want" --arg state "$_st" --arg mac "$_mac" \
        --argjson clients "${_cl:-0}" --arg detail "${1:-}" \
        '{success:true, enabled:$enabled, state:$state, target_mac:$mac, clients:$clients}
         + (if $detail != "" then {detail:$detail} else {} end)'
}

if [ "$REQUEST_METHOD" = "GET" ]; then
    emit_state
    exit 0
fi

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
        *) cgi_error "invalid_enabled" "enabled must be a JSON boolean"; exit 0 ;;
    esac

    if [ "$ENABLED" = "true" ]; then
        qlog_info "Apply: enable"
        PREV=$(ippt_desired)
        ippt_set_desired true || { cgi_error "save_failed" "Could not save the setting"; exit 0; }
        MAC=$(ippt_apply_on); RC=$?
        case "$RC" in
            0)
                qlog_info "passthrough active for $MAC"
                emit_state
                ;;
            2)
                # Saved; nothing to bind yet. Not an error: it starts when a device connects.
                qlog_info "no LAN client yet; waiting in the background"
                spawn_waiter
                emit_state "no_client"
                ;;
            4)
                qlog_warn "ql_qmap answered but QCMAP did not confirm; retrying in the background"
                spawn_waiter
                emit_state "unconfirmed"
                ;;
            *)
                qlog_error "ql_qmap failed (rc=$RC)"
                ippt_set_desired "$PREV" 2>/dev/null
                cgi_error "apply_failed" "The modem refused the passthrough setting"
                ;;
        esac
        exit 0
    fi

    # Disable.
    qlog_info "Apply: disable"
    WAS=$(ippt_state)
    ippt_set_desired false || { cgi_error "save_failed" "Could not save the setting"; exit 0; }
    if [ "$WAS" = "active" ]; then
        qlog_info "was active; rebooting to clear it (a live disable does not work here)"
        cgi_reboot_response
    fi
    emit_state
    exit 0
fi

cgi_method_not_allowed
