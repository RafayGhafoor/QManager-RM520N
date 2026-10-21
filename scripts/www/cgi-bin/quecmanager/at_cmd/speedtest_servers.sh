#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# =============================================================================
# speedtest_servers.sh — CGI Endpoint: List Nearby Speedtest Servers
# =============================================================================
# Runs `speedtest --servers -f json`, extracts the server list, and returns it.
#
# Endpoint: GET /cgi-bin/quecmanager/at_cmd/speedtest_servers.sh
# Install location: /www/cgi-bin/quecmanager/at_cmd/speedtest_servers.sh
# =============================================================================

qlog_init "cgi_speedtest_servers"
cgi_headers
cgi_handle_options

# =============================================================================
# Favourite server
# =============================================================================
# A favourite is the server the user wants used every time without re-picking
# it from a freshly-fetched list on a single-core device. It is stored in the
# QManager config so it survives reboots and re-dials, and speedtest_start.sh
# falls back to it whenever the request carries no explicit server_id.
#
# Kept HERE rather than in its own endpoint because the favourite is a property
# of the server list the UI already loads: one round trip instead of two, and
# the UI always sees the list and its favourite from the same instant.
# ============================================================================
. /usr/lib/qmanager/config.sh 2>/dev/null || {
    qm_config_get() { printf '%s' "${3:-}"; }
    qm_config_set() { return 1; }
}

if [ "$REQUEST_METHOD" = "POST" ]; then
    # This endpoint was GET-only, so it never read the request body. Without
    # this call $POST_DATA is empty and every action looks "unknown".
    cgi_read_post
    _action=$(printf '%s' "$POST_DATA" | jq -r '.action // empty' 2>/dev/null)

    case "$_action" in
        set_favourite)
            _id=$(printf '%s' "$POST_DATA" | jq -r '.server_id // empty' 2>/dev/null)
            _name=$(printf '%s' "$POST_DATA" | jq -r '.name // empty' 2>/dev/null)
            case "$_id" in
                ''|*[!0-9]*)
                    cgi_error "invalid_server_id" "server_id must be a numeric Ookla id"
                    exit 0
                    ;;
            esac
            qm_config_set speedtest favourite_id "$_id" || {
                cgi_error "save_failed" "Could not persist the favourite server"
                exit 0
            }
            qm_config_set speedtest favourite_name "$_name"
            qlog_info "Speedtest favourite set to $\$_id"
            jq -cn --argjson id "$_id" --arg name "$_name" \
                '{success:true,favourite:{id:$id,name:$name}}'
            exit 0
            ;;
        clear_favourite)
            qm_config_set speedtest favourite_id ""
            qm_config_set speedtest favourite_name ""
            qlog_info "Speedtest favourite cleared"
            printf '{"success":true,"favourite":null}\n'
            exit 0
            ;;
        *)
            cgi_error "unknown_action" "action must be set_favourite or clear_favourite"
            exit 0
            ;;
    esac
fi

if [ "$REQUEST_METHOD" != "GET" ]; then
    cgi_error "method_not_allowed" "Use GET"
    exit 0
fi

if ! command -v speedtest >/dev/null 2>&1; then
    cgi_error "not_installed" "speedtest-cli is not installed"
    exit 0
fi

# Set environment the Ookla binary needs (without sourcing /etc/profile)
export HOME="${HOME:-/root}"
export USER="${USER:-root}"
export LOGNAME="${LOGNAME:-root}"
export TMPDIR="${TMPDIR:-/tmp}"
export LANG="${LANG:-C}"
export LC_ALL="${LC_ALL:-C}"
export TERM="${TERM:-xterm}"
export PATH="/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"

# Run server list to temp file. Measured live on an RM520N-GL: ~1.2s, cold or
# warm (the earlier "2-5 seconds" estimate here was pessimistic). Note this
# forks the Ookla binary SYNCHRONOUSLY inside the request, so the UI's refresh
# affordance costs a real process spawn on a single-core device each time.
OUTFILE="/tmp/qmanager_speedtest_servers.json"
speedtest --servers --accept-license --accept-gdpr -f json > "$OUTFILE" 2>/dev/null

if [ ! -s "$OUTFILE" ]; then
    rm -f "$OUTFILE"
    cgi_error "list_failed" "Failed to fetch server list"
    exit 0
fi

# Extract .servers array from {"type":"serverList","servers":[...]}
SERVERS=$(jq -c '.servers' "$OUTFILE" 2>/dev/null)
rm -f "$OUTFILE"

if [ -z "$SERVERS" ] || [ "$SERVERS" = "null" ]; then
    cgi_error "list_failed" "No servers found in response"
    exit 0
fi

# Favourite, read AFTER the list so a config problem can never cost the user
# the server list itself.
_fav_id=$(qm_config_get speedtest favourite_id "")
_fav_name=$(qm_config_get speedtest favourite_name "")
case "$_fav_id" in
    ''|*[!0-9]*) FAVOURITE="null" ;;
    *) FAVOURITE=$(jq -cn --argjson id "$_fav_id" --arg name "$_fav_name" '{id:$id,name:$name}') ;;
esac

printf '{"success":true,"servers":%s,"favourite":%s}\n' "$SERVERS" "$FAVOURITE"
