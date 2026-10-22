#!/bin/sh
# =============================================================================
# qm_dualnet.sh — reach the GreenPacket on 192.168.0.1 WITHOUT losing internet
# =============================================================================
# PROBLEM
#   Ethernet (en5) carries the internet: 192.168.88.x, router 192.168.88.1.
#   Wi-Fi  (en0) is how you reach the GreenPacket: its LAN is 192.168.0.x.
#
#   If Wi-Fi takes that address by DHCP, the GreenPacket also hands over
#   "router 192.168.0.1" and its own DNS. macOS then installs a SECOND default
#   route and adds the GreenPacket as a resolver — so traffic can leave through
#   a gateway with no working uplink, and names stop resolving. That is the
#   "I can see greenpacket but the internet is gone" symptom.
#
# FIX
#   Give Wi-Fi a STATIC address on the GreenPacket's subnet with NO router and
#   NO DNS. Then macOS creates exactly one thing on en0: the on-link route for
#   192.168.0.0/24. The Ethernet keeps the only default route and the only DNS.
#
#    192.168.0.0/24  -> en0 on-link      -> GreenPacket at 192.168.0.1
#    0.0.0.0/0       -> en5 192.168.88.1 -> internet
#
# Usage:  sudo sh qm_dualnet.sh            # apply
#         sudo sh qm_dualnet.sh --status   # show current state, change nothing
#         sudo sh qm_dualnet.sh --revert   # back to DHCP on Wi-Fi
# =============================================================================
set -u

WIFI_SERVICE="${WIFI_SERVICE:-Wi-Fi}"
ETH_SERVICE="${ETH_SERVICE:-USB 10/100/1000 LAN}"
GP_SUBNET_IP="${GP_SUBNET_IP:-192.168.0.250}"   # .250: outside the usual DHCP pool
GP_SUBNET_MASK="255.255.255.0"
GP_HOST="192.168.0.1"

status() {
    echo "=== service order (1 = highest priority) ==="
    networksetup -listnetworkserviceorder 2>/dev/null | grep -E '^\([0-9]+\)'
    echo
    echo "=== Wi-Fi ($WIFI_SERVICE) ==="
    networksetup -getinfo "$WIFI_SERVICE" 2>/dev/null | grep -E '^IP address|^Subnet|^Router|^Configuration'
    echo
    echo "=== Ethernet ($ETH_SERVICE) ==="
    networksetup -getinfo "$ETH_SERVICE" 2>/dev/null | grep -E '^IP address|^Subnet|^Router'
    echo
    echo "=== default routes ==="
    netstat -rn -f inet 2>/dev/null | grep '^default'
    echo
    echo "=== DNS ==="
    networksetup -getdnsservers "$WIFI_SERVICE" 2>/dev/null | sed 's/^/wifi: /'
    networksetup -getdnsservers "$ETH_SERVICE" 2>/dev/null | sed 's/^/eth:  /'
    echo
    echo "=== reachability ==="
    ping -c 1 -t 3 "$GP_HOST" >/dev/null 2>&1 && echo "greenpacket $GP_HOST UP" || echo "greenpacket $GP_HOST DOWN"
    ping -c 1 -t 3 1.1.1.1  >/dev/null 2>&1 && echo "internet UP" || echo "internet DOWN"
}

apply() {
    echo "1/3  Wi-Fi -> static $GP_SUBNET_IP/24, no router, no DNS"
    # Empty string as the router is what stops a competing default route.
    networksetup -setmanual "$WIFI_SERVICE" "$GP_SUBNET_IP" "$GP_SUBNET_MASK" "" || exit 1
    # Empty DNS list ("Empty") so the GreenPacket is never used as a resolver.
    networksetup -setdnsservers "$WIFI_SERVICE" Empty || exit 1

    echo "2/3  ensuring Ethernet is above Wi-Fi in service order"
    # Build the order: this list is applied top-down, so put Ethernet first and
    # Wi-Fi after it. Every other service keeps its relative position.
    networksetup -ordernetworkservices "$ETH_SERVICE" "$WIFI_SERVICE" \
        "realme GT Master" "Thunderbolt Bridge" "Tailscale" "OneXraySE" 2>/dev/null \
        || networksetup -ordernetworkservices "$ETH_SERVICE" "$WIFI_SERVICE" 2>/dev/null \
        || echo "     (order unchanged; Ethernet was already ahead of Wi-Fi)"

    echo "3/3  dropping any leftover scoped default route on Wi-Fi"
    # Harmless if absent: route(8) exits non-zero and we ignore it.
    route -n delete default -ifscope en0 >/dev/null 2>&1 || true

    echo
    echo "=== after ==="
    status
    echo
    echo "GreenPacket UI : http://$GP_HOST:8080/"
    echo "GreenPacket SSH: ssh -p 2222 root@$GP_HOST"
}

revert() {
    echo "reverting Wi-Fi to DHCP"
    networksetup -setdhcp "$WIFI_SERVICE" || exit 1
    networksetup -setdnsservers "$WIFI_SERVICE" Empty || true
    echo "done; Wi-Fi is on DHCP again"
}

case "${1:---apply}" in
    --status) status ;;
    --revert) revert ;;
    --apply|"") apply ;;
    *) echo "usage: $0 [--apply|--status|--revert]" >&2; exit 2 ;;
esac
