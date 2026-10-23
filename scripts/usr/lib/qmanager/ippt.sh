#!/bin/sh
# =============================================================================
# ippt.sh — IP Passthrough helpers for the GreenPacket O5A Pro (RG520N-EB)
# =============================================================================
# Sourced by network/ip_passthrough.sh (CGI) and qmanager_ippt_apply (boot).
#
# WHY THIS IS NOT AT+QMAP
#   The upstream QManager page drove IP Passthrough with AT+QMAP="MPDN_rule" /
#   IPPT_NAT / DHCPV4DNS. On this firmware every one of those answers ERROR, and
#   the vendor's XML flag (<IPPassthroughEnable>) only records intent: QCMAP then
#   reports "Device Type Not Set" / "NOT ACTIVATED" and nothing changes. What the
#   vendor stack itself calls is Quectel's libql_qmap (ql_qmap_lan_ippt_set_v1),
#   which the device ships as /usr/bin/ql_qmap. Measured 2026-10-23 on this unit:
#
#     ql_qmap LAN IPPT set 0 1 <mac>   -> state ACTIVATED in ~4 s, router's DHCP
#                                         lease becomes the carrier IP, no reboot
#     ql_qmap LAN IPPT set 0 0         -> "CMD OK" but state stays ACTIVATED
#     systemctl restart QCMAP ...      -> QCMAP auto-reboots the device ("IPA HW
#                                         offload") and the state clears
#     ql_qmap LAN IPPT adaptive 0 2    -> "CMD OK", state stayed NOT ACTIVATED
#
#   So: ON is live; OFF needs a reboot; and the setting is runtime-only (the XML is
#   not updated), so it must be re-applied after every boot. docs/reference/
#   ip-passthrough.md has the full record.
#
# STATE
#   /etc/qmanager/ippt.json   {"enabled": true|false}  — what the owner asked for.
#   The ACTUAL state is always read from QCMAP, never inferred from this file.
#
# BUSYBOX NOTES: no `local` outside functions that need it, no arrays, no [[ ]].
# =============================================================================

IPPT_CONF="${IPPT_CONF:-/etc/qmanager/ippt.json}"
IPPT_LEASES="${IPPT_LEASES:-/var/run/data/dnsmasq.leases}"
IPPT_ARP="${IPPT_ARP:-/proc/net/arp}"
IPPT_QMAP="${IPPT_QMAP:-/usr/bin/ql_qmap}"
IPPT_CLI="${IPPT_CLI:-/usr/bin/QCMAP_CLI}"

# ippt_desired — prints "true" or "false"; absent/unreadable file means false.
ippt_desired() {
    _v=$(jq -r 'if (.enabled == true) then "true" else "false" end' "$IPPT_CONF" 2>/dev/null)
    [ "$_v" = "true" ] && echo true || echo false
}

# ippt_set_desired <true|false> — atomic write (temp + mv).
ippt_set_desired() {
    mkdir -p "$(dirname "$IPPT_CONF")" 2>/dev/null
    _t="$IPPT_CONF.tmp.$$"
    jq -n --argjson e "$1" '{enabled:$e}' > "$_t" 2>/dev/null && mv "$_t" "$IPPT_CONF" || { rm -f "$_t"; return 1; }
}

# !! Both vendor tools are run under `timeout -s KILL`, never plain `timeout`.
# Measured 2026-10-23: at boot QCMAP_CLI blocks while QCMAP is still coming up and
# IGNORES the SIGTERM BusyBox `timeout` sends by default (1.31 has no -k), so a
# plain `timeout 8` never ended it and the boot applier hung for 5+ minutes in its
# first state read. KILL cannot be ignored.
#
# ippt_state — prints active | inactive | unknown. Read from QCMAP itself:
# QCMAP_CLI menu 6 (Backhaul) -> 2 (WWAN) -> 16 (Get IP Passthrough State).
# "NOT ACTIVATED" contains "ACTIVATED", so the negative must be tested first.
# unknown (CLI missing, hung, or no recognisable line) is never reported as inactive.
#
# !! QCMAP_CLI NEVER EXITS ON EOF: it reprints its whole menu forever. Measured
# 2026-10-23: 93 MB in 8 s. /tmp is tmpfs (RAM, 182 MB total), and capturing the
# stream with $(...) is what got the CGI OOM-killed. So the output is ALWAYS cut
# at the first matching line (`grep -m1`); grep exiting breaks the pipe and the CLI
# dies on SIGPIPE at its next write. Never redirect this CLI to a file or a variable.
ippt_state() {
    [ -x "$IPPT_CLI" ] || { echo unknown; return 0; }
    _o=$(printf '6\n2\n16\n' | timeout -s KILL 8 "$IPPT_CLI" 2>&1 | grep -m1 'IP Passthrough is')
    case "$_o" in
        *"IP Passthrough is NOT ACTIVATED"*) echo inactive ;;
        *"IP Passthrough is ACTIVATED"*)     echo active ;;
        *)                                   echo unknown ;;
    esac
}

# ippt_clients — prints "<mac> <ip>" lines for LAN clients, newest lease first,
# restricted to MACs that currently have a complete ARP entry (flag 0x2) so a
# stale lease for a unplugged device is never chosen. Falls back to the plain
# lease list when ARP shows none (e.g. right after QCMAP restarts).
ippt_clients() {
    [ -r "$IPPT_LEASES" ] || return 0
    _all=$(sort -rn "$IPPT_LEASES" 2>/dev/null | awk 'NF>=3 && $2 ~ /^[0-9A-Fa-f][0-9A-Fa-f](:[0-9A-Fa-f][0-9A-Fa-f]){5}$/ {print tolower($2), $3}')
    [ -n "$_all" ] || return 0
    _live=$(printf '%s\n' "$_all" | while read -r _m _i; do
        awk -v m="$_m" 'tolower($4)==m && $3=="0x2" {f=1} END{exit !f}' "$IPPT_ARP" 2>/dev/null && echo "$_m $_i"
    done)
    if [ -n "$_live" ]; then printf '%s\n' "$_live"; else printf '%s\n' "$_all"; fi
}

# ippt_target_mac — the device that will receive the carrier IP: the newest live
# client. Passthrough binds exactly one device, so more than one client means the
# newest wins (the page reports the count).
ippt_target_mac() {
    ippt_clients | head -1 | cut -d' ' -f1
}

# ippt_apply_on — bind the target and wait for QCMAP to say ACTIVATED.
# Prints the MAC on success. Return: 0 ok, 2 no client, 3 ql_qmap failed, 4 not
# active after the wait (the setter answered OK but QCMAP never confirmed).
# ql_qmap is always under `timeout`: it printed "CMD OK" yet kept the caller's
# SSH session hanging during testing.
ippt_apply_on() {
    _mac=$(ippt_target_mac)
    [ -n "$_mac" ] || return 2
    [ -x "$IPPT_QMAP" ] || return 3
    timeout -s KILL 20 "$IPPT_QMAP" LAN IPPT set 0 1 "$_mac" >/dev/null 2>&1 || return 3
    _n=0
    while [ "$_n" -lt 8 ]; do
        sleep 2
        if [ "$(ippt_state)" = "active" ]; then echo "$_mac"; return 0; fi
        _n=$((_n + 1))
    done
    return 4
}
