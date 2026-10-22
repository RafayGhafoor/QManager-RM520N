#!/bin/sh
# =============================================================================
# qm_offline_diag.sh — read-only diagnostic for a QManager device in trouble
# =============================================================================
# Runs ON YOUR MAC. It opens ONE ssh session to the device, runs a long
# read-only battery there, and writes everything to a timestamped local file.
#
# It assumes the device has NO internet. Nothing in it reaches outward from the
# device: no curl to the internet, no package fetch, no update check. The only
# network calls are loopback (the vendor :80 UI and QManager's :8080) to prove
# local services are alive.
#
# It changes NOTHING on the device: no AT writes, no service start/stop, no
# file writes. AT commands used are query-form only (AT+COPS?, AT+CFUN?, ...).
#
#   Usage:
#     sh scripts-dev/qm_offline_diag.sh                 # default: greenpacket
#     sh scripts-dev/qm_offline_diag.sh --host 192.168.88.1 --port 22
#     sh scripts-dev/qm_offline_diag.sh --out /tmp/diag.txt
#
#   Then send me the printed path.
# =============================================================================

HOST=greenpacket
PORT=""
OUT=""

while [ $# -gt 0 ]; do
    case "$1" in
        --host) HOST="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --out)  OUT="$2";  shift 2 ;;
        -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

STAMP=$(date +%Y%m%d-%H%M%S)
[ -n "$OUT" ] || OUT="qm-diag-$STAMP.txt"
SSHOPTS="-o ConnectTimeout=25 -o ServerAliveInterval=10 -o ServerAliveCountMax=4 -o BatchMode=yes"
[ -n "$PORT" ] && SSHOPTS="$SSHOPTS -p $PORT"

# --- the on-device battery ---------------------------------------------------
# Written to a temp file with a QUOTED heredoc: nothing expands on the Mac side,
# everything runs on the device. Piped in as `sh -s`.
TMP=$(mktemp "${TMPDIR:-/tmp}/qmd.XXXXXX")
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<'REMOTE_EOF'
say() { printf '\n===== %s =====\n' "$1"; }

say "identity"
echo "date      : $(date)"
echo "host      : $(uname -n)"
echo "machine   : $(uname -m)  kernel: $(uname -r)"
echo "boot_id   : $(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
echo "uptime_s  : $(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null)"
echo "loadavg   : $(cat /proc/loadavg 2>/dev/null)"
echo "cpu_count : $(grep -c ^processor /proc/cpuinfo 2>/dev/null)"

say "memory"
grep -E 'MemTotal|MemAvailable|MemFree|SwapTotal|SwapFree' /proc/meminfo 2>/dev/null

say "disk"
df -h 2>/dev/null | grep -E 'Filesystem|/usrdata|/etc|/data|ubi|overlay|/$'

say "systemd units (QManager + vendor stack)"
for u in qmanager-httpd qmanager-poller qmanager-ping qmanager-dpi qmanager-atd \
         turin_web modemd gp-metricsd gp-radio-handler; do
    printf '%-22s %-10s %s\n' "$u" \
        "$(systemctl is-active "$u" 2>/dev/null || echo -)" \
        "$(systemctl is-enabled "$u" 2>/dev/null || echo -)"
done
echo "--- failed units ---"
systemctl --failed --no-legend --no-pager 2>/dev/null | head -20
echo "--- unit start times (vs uptime) ---"
systemctl show -p ActiveEnterTimestamp --value \
    qmanager-httpd qmanager-poller qmanager-ping 2>/dev/null

say "loopback services (no internet needed)"
echo "vendor :80   -> HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1/ 2>/dev/null)"
echo "qmanager:8080-> HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/ 2>/dev/null)"

say "AT port holders (who has the modem fd open)"
for d in /dev/at_mdm0 /dev/smd7 /dev/smd11; do
    echo "--- $d ---"
    ls -l "$d" 2>/dev/null || echo "  (absent)"
    found=0
    for p in /proc/[0-9]*; do
        pid=${p#/proc/}
        for f in "$p"/fd/*; do
            tgt=$(readlink "$f" 2>/dev/null) || continue
            if [ "$tgt" = "$d" ]; then
                printf '  pid %-7s %s\n' "$pid" "$(cat "$p/comm" 2>/dev/null)"
                found=1
            fi
        done
    done
    [ "$found" = 1 ] || echo "  (no holder)"
done

say "QManager process snapshot"
for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    c=$(cat "$p/comm" 2>/dev/null) || continue
    case "$c" in
        *qmanager*|tpws|qcmd*) 
            echo "pid=$pid comm=$c rss=$(awk '/^VmRSS/{print $2}' "$p/status" 2>/dev/null)kB"
            echo "   cmd: $(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)" ;;
    esac
done

say "atd artefacts (added 2026-10-22 — confirm they are INERT)"
echo "binary   : $(ls -l /usrdata/qmanager/bin/qmanager_atd 2>/dev/null || echo absent)"
echo "shim     : $(ls -l /usrdata/qmanager/atd/qcmd 2>/dev/null || echo absent)"
echo "daemon   : $(pidof qmanager_atd 2>/dev/null || echo 'not running')"
echo "socket   : $(ls -l /var/run/qmanager_atd.sock 2>/dev/null || echo absent)"
echo "poller PATH line:"
grep -n '^Environment=PATH' /etc/systemd/system/qmanager-poller.service 2>/dev/null

say "SIM / registration (query AT only)"
Q=/usrdata/qmanager/bin/qcmd
if [ -x "$Q" ]; then
    for c in 'AT+CPIN?' 'AT+CFUN?' 'AT+COPS?' 'AT+CREG?' 'AT+CEREG?' 'AT+CSQ' \
             'AT+QSIMSTAT?' 'AT+QUIMSLOT?' 'AT+CGDCONT?' ; do
        printf '%-16s -> ' "$c"
        timeout 12 "$Q" "$c" 2>&1 | tr -d '\r' | tr '\n' '|' | cut -c1-300
        echo
    done
else
    echo "qcmd not executable at $Q"
fi

say "serving cell / RF (query AT only)"
if [ -x "$Q" ]; then
    for c in 'AT+QENG="servingcell"' 'AT+QCAINFO' 'AT+QRSRP' 'AT+QNWPREFCFG="mode_pref"' ; do
        printf '%-28s ->\n' "$c"
        timeout 15 "$Q" "$c" 2>&1 | tr -d '\r' | sed 's/^/    /' | head -12
    done
fi

say "poller cache (published values)"
J=/usrdata/qmanager/bin/jq
if [ -x "$J" ] && [ -f /tmp/qmanager_status.json ]; then
    echo "mtime: $(date -r /tmp/qmanager_status.json 2>/dev/null)  now: $(date)"
    "$J" '{model:.device.model, temp:.device.temperature,
           net_type:.network.type, carrier:.network.carrier, apn:.network.apn,
           wan:.network.wan_ipv4, reg:.network.registration_status,
           rsrp:.signal.lte.rsrp, nr_rsrp:.signal.nr5g.rsrp}' \
           /tmp/qmanager_status.json 2>&1 | head -30
else
    echo "status.json absent or jq missing"
    head -c 400 /tmp/qmanager_status.json 2>/dev/null
fi

say "QManager logs (last 60 lines, errors first)"
echo "--- /tmp/qmanager.log tail ---"
tail -60 /tmp/qmanager.log 2>/dev/null
echo "--- WARN/ERROR lines, last 3 min ---"
grep -E 'WARN|ERROR' /tmp/qmanager.log 2>/dev/null | tail -25
echo "--- journal: poller, last 5 min ---"
journalctl -u qmanager-poller --since "-5min" --no-pager 2>/dev/null | tail -40

say "dmesg — modem / SSR / glink / ipa / usb (the recovery trail)"
dmesg 2>/dev/null | grep -iE 'ssr|subsys|mhi|glink|smd|ipa|rmnet|modem|qmi|crash|reset|fatal|watchdog|panic|usb' | tail -120
echo
echo "--- dmesg tail 80 (unfiltered) ---"
dmesg 2>/dev/null | tail -80

say "kernel oops / watchdog evidence"
dmesg 2>/dev/null | grep -icE 'oom|out of memory' | sed 's/^/OOM mentions: /'
dmesg 2>/dev/null | grep -iE 'out of memory|oom-killer' | tail -10
cat /proc/sys/kernel/random/boot_id 2>/dev/null
echo "--- reboot reasons ---"
journalctl --list-boots --no-pager 2>/dev/null | tail -5

say "network state on the device"
ip -4 addr show 2>/dev/null | grep -E 'inet ' 
echo "--- routes ---"
ip route 2>/dev/null | head -15
echo "--- default route WAN ---"
ip route show default 2>/dev/null

say "end of collection"
REMOTE_EOF

# --- run it ------------------------------------------------------------------
printf 'Connecting to %s%s ...\n' "$HOST" "${PORT:+:$PORT}"
if ! timeout 420 ssh $SSHOPTS "$HOST" 'sh -s' < "$TMP" > "$OUT.draft" 2>"$OUT.err"; then
    echo "SSH FAILED — device unreachable, or ssh refused." >&2
    echo "  stderr:" >&2
    sed 's/^/    /' "$OUT.err" >&2
    echo >&2
    echo "Try, in this order:" >&2
    echo "  1. ping the device:            ping -c 3 192.168.0.1" >&2
    echo "  2. find it on your LAN:        arp -an | grep -v incomplete" >&2
    echo "  3. if it is behind the AP:     sh scripts-dev/qm_offline_diag.sh --host <its-wan-ip>" >&2
    echo "  4. if SSH is on another port:  sh scripts-dev/qm_offline_diag.sh --port <port>" >&2
    exit 1
fi

{
    echo "QManager offline diagnostic"
    echo "collected: $(date)"
    echo "target   : $HOST${PORT:+:$PORT}"
    echo "-----------------------------------------------------------"
    cat "$OUT.draft"
} > "$OUT"
rm -f "$OUT.draft" "$OUT.err"

echo
echo "Saved: $OUT"
echo "Lines: $(wc -l < "$OUT" | tr -d ' ')"
echo
echo "Send me that file. The three sections that matter most for a no-signal"
echo "fault are: 'dmesg — modem / SSR / glink / ipa / usb', 'SIM / registration',"
echo "and 'serving cell / RF'."
