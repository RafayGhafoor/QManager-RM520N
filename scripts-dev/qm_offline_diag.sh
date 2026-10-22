#!/bin/sh
# =============================================================================
# qm_offline_diag.sh — read-only diagnostic for a QManager device in trouble
# =============================================================================
# Runs ON YOUR MAC. Stages a small script to the device's /tmp, runs it there,
# streams the output into a timestamped local file, and deletes the staged copy.
#
# Assumes the device has NO internet. Nothing here reaches outward from the
# device: no curl to the internet, no package fetch, no update check. The only
# HTTP is loopback, proving the vendor :80 UI and QManager's :8080 are alive.
#
# Changes NOTHING about device state: query-form AT only (AT+COPS?, AT+CFUN?,
# AT+QENG="servingcell"), no AT writes, no service start/stop, no config write.
# The only filesystem write is the staged script under /tmp, removed at the end.
#
#   sh scripts-dev/qm_offline_diag.sh
#   sh scripts-dev/qm_offline_diag.sh --host greenpacket --port 2222
#   sh scripts-dev/qm_offline_diag.sh --fast      # skip the slower scans
# =============================================================================

HOST=greenpacket
PORT=""
OUT=""
FAST=0
FIND=0

while [ $# -gt 0 ]; do
    case "$1" in
        --host) HOST="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --out)  OUT="$2";  shift 2 ;;
        --fast) FAST=1; shift ;;
        --find) FIND=1; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

STAMP=$(date +%Y%m%d-%H%M%S)
[ -n "$OUT" ] || OUT="qm-diag-$STAMP.txt"
SSHOPTS="-o ConnectTimeout=25 -o ServerAliveInterval=10 -o ServerAliveCountMax=6 -o BatchMode=yes -o NumberOfPasswordPrompts=0"
[ -n "$PORT" ] && SSHOPTS="$SSHOPTS -p $PORT"

# -----------------------------------------------------------------------------
# --find: the device is alive on ICMP far more often than it is on TCP. When
# "Connecting..." hangs, the useful question is "where IS ssh answering?" rather
# than "try again". Sweeps each active interface's /24 and probes the ports this
# deployment uses.
# -----------------------------------------------------------------------------
if [ "$FIND" = 1 ]; then
    echo "Active interfaces:"
    ifconfig 2>/dev/null | awk '/^[a-z0-9]+:/{i=$1} /inet /{print "  " i " " $2}' | grep -v 127.0.0.1
    echo
    NETS=$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.' | \
           sed 's/\.[0-9]*$/./' | sort -u)
    for n in $NETS; do
        echo "Sweeping ${n}0/24 (icmp)..."
        for i in $(seq 1 254); do
            ( ping -c 1 -W 300 "$n$i" >/dev/null 2>&1 && echo "$n$i" >> "$TMP.hosts" ) &
        done
        wait
    done
    echo
    if [ -s "$TMP.hosts" ]; then
        echo "Live hosts, and which of the QManager ports answer:"
        for ip in $(sort -u "$TMP.hosts"); do
            open=""
            for p in 2222 22 8080 80; do
                nc -z -G 2 "$ip" "$p" 2>/dev/null && open="$open $p"
            done
            [ -n "$open" ] && echo "  $ip  ports:$open"
        done
    else
        echo "No host answered ICMP on any local /24."
    fi
    echo
    echo "Then run:  sh $0 --host <ip> --port <port>"
    exit 0
fi

TMP=$(mktemp "${TMPDIR:-/tmp}/qmd.XXXXXX")
cleanup() { rm -f "$TMP" "$OUT.part" "$OUT.err"; }
trap cleanup EXIT INT TERM

# -----------------------------------------------------------------------------
# On-device script. Quoted heredoc: nothing expands on the Mac side.
#
# RULE FOR EVERY COMMAND IN HERE: append </dev/null. The on-device shell's stdin
# is the ssh channel, and a command that reads it would swallow the rest of this
# script. `timeout` and `qcmd` both inherit stdin, which is how the first version
# of this script hung.
# -----------------------------------------------------------------------------
cat > "$TMP" <<'REMOTE_EOF'
say() { printf '\n===== %s =====\n' "$1"; }
# Always close stdin so nothing can consume the script.
run() { "$@" </dev/null 2>&1; }
q() { timeout 8 /usrdata/qmanager/bin/qcmd "$1" </dev/null 2>&1; }

say "identity"
run date
echo "host      : $(run uname -n)"
echo "machine   : $(run uname -m)  kernel: $(run uname -r)"
echo "boot_id   : $(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
echo "uptime_s  : $(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null)"
echo "loadavg   : $(cat /proc/loadavg 2>/dev/null)"
echo "cpu_count : $(grep -c ^processor /proc/cpuinfo 2>/dev/null)"
grep -E 'MemTotal|MemAvailable|MemFree' /proc/meminfo 2>/dev/null

# ---- dmesg FIRST: this is the section that answers a no-signal fault ---------
say "dmesg modem / SSR / glink / ipa (the recovery trail)"
run dmesg | grep -iE 'ssr|subsys|mhi|glink|smd|ipa|rmnet|modem|qmi|crash|reset|fatal|watchdog|panic' | tail -100 | sed 's/^/  /'

say "dmesg tail 60 (unfiltered)"
run dmesg | tail -60 | sed 's/^/  /'

say "SIM / registration (query AT only)"
if [ -x /usrdata/qmanager/bin/qcmd ]; then
    for c in 'AT+CPIN?' 'AT+CFUN?' 'AT+COPS?' 'AT+CEREG?' 'AT+CSQ' 'AT+QSIMSTAT?'; do
        printf '  %-16s -> ' "$c"
        q "$c" | tr -d '\r' | tr '\n' '|' | cut -c1-220
        echo
    done
else
    echo "  qcmd missing at /usrdata/qmanager/bin/qcmd"
fi

say "serving cell / RF (query AT only)"
if [ -x /usrdata/qmanager/bin/qcmd ]; then
    for c in 'AT+QENG="servingcell"' 'AT+QCAINFO' 'AT+QNWPREFCFG="mode_pref"'; do
        echo "  --- $c ---"
        q "$c" | tr -d '\r' | sed 's/^/    /' | head -10
    done
fi

say "systemd units"
for u in qmanager-httpd qmanager-poller qmanager-ping qmanager-dpi qmanager-atd; do
    printf '  %-18s %-10s %s\n' "$u" \
        "$(run systemctl is-active "$u")" "$(run systemctl is-enabled "$u")"
done
echo "  --- failed ---"
run systemctl --failed --no-legend --no-pager | head -10 | sed 's/^/  /'

say "loopback services"
echo "  vendor  :80    -> HTTP $(run curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1/)"
echo "  qmanager:8080  -> HTTP $(run curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/)"

say "atd artefacts (confirm they are INERT)"
echo "  binary : $(ls -l /usrdata/qmanager/bin/qmanager_atd 2>/dev/null || echo absent)"
echo "  shim   : $(ls -l /usrdata/qmanager/atd/qcmd 2>/dev/null || echo absent)"
echo "  daemon : $(pidof qmanager_atd 2>/dev/null || echo 'not running')"
echo "  socket : $(ls -l /var/run/qmanager_atd.sock 2>/dev/null || echo absent)"
grep -n '^Environment=PATH' /etc/systemd/system/qmanager-poller.service 2>/dev/null | sed 's/^/  /'

if [ "$1" != "--fast" ]; then
    # One `ls` per PROCESS (not per fd). The first version did a readlink fork
    # per fd across three devices = thousands of forks on a 1-core box.
    say "AT port holders (one ls per process)"
    for d in /dev/at_mdm0 /dev/smd7 /dev/smd11; do
        echo "  --- $d ---"
        real=$(readlink -f "$d" 2>/dev/null); [ -n "$real" ] || real="$d"
        [ -e "$d" ] || { echo "    (absent)"; continue; }
        hit=0
        for p in /proc/[0-9]*; do
            pid=${p#/proc/}
            ls -l "$p"/fd 2>/dev/null | grep -qF "$real" || continue
            echo "    pid $pid $(cat "$p/comm" 2>/dev/null)"
            hit=1
        done
        [ "$hit" = 1 ] || echo "    (no holder)"
    done

    say "QManager processes"
    for p in /proc/[0-9]*; do
        pid=${p#/proc/}
        c=$(cat "$p/comm" 2>/dev/null) || continue
        case "$c" in
            *qmanager*|tpws)
                echo "  pid=$pid comm=$c rss=$(awk '/^VmRSS/{print $2}' "$p/status" 2>/dev/null)kB" ;;
        esac
    done
fi

say "poller cache"
if [ -x /usrdata/qmanager/bin/jq ] && [ -f /tmp/qmanager_status.json ]; then
    echo "  mtime: $(date -r /tmp/qmanager_status.json 2>/dev/null)"
    /usrdata/qmanager/bin/jq -c '{model:.device.model,temp:.device.temperature,
        type:.network.type,carrier:.network.carrier,apn:.network.apn,
        wan:.network.wan_ipv4}' /tmp/qmanager_status.json </dev/null 2>&1 | sed 's/^/  /'
else
    echo "  status.json or jq absent"
    head -c 300 /tmp/qmanager_status.json 2>/dev/null | sed 's/^/  /'
fi

say "QManager logs"
echo "  --- last 40 lines ---"
tail -40 /tmp/qmanager.log 2>/dev/null | sed 's/^/  /'
echo "  --- WARN/ERROR, last 20 ---"
grep -E 'WARN|ERROR' /tmp/qmanager.log 2>/dev/null | tail -20 | sed 's/^/  /'

say "device network state"
run ip -4 addr show | grep 'inet ' | sed 's/^/  /'
run ip route | head -10 | sed 's/^/  /'

say "end of collection"
REMOTE_EOF

# -----------------------------------------------------------------------------
# Stage to /tmp on the device and run it there, so the on-device shell's stdin
# is NOT this script. Stream through tee: if the run is cut short, everything
# collected so far still lands in the file.
# -----------------------------------------------------------------------------
printf 'Connecting to %s%s ...\n' "$HOST" "${PORT:+:$PORT}"

REMOTE_CMD='cat > /tmp/.qmd.sh && sh /tmp/.qmd.sh '"$([ $FAST = 1 ] && echo --fast)"' </dev/null; rc=$?; rm -f /tmp/.qmd.sh; exit $rc'

set -- $SSHOPTS

# BatchMode is deliberate: without it, ssh PROMPTS when the key needs an agent
# that is not visible, and because stdin is this script it waits forever with no
# message -- the "stuck on Connecting" symptom. BatchMode turns that into an
# immediate, explainable failure.
#
# Output is streamed through tee so sections appear as they are collected: this
# run legitimately takes 30-90 s, and with no streaming it is indistinguishable
# from a hang.
printf 'Collecting (sections print as they arrive; ~30-90s)...\n\n'
timeout 240 ssh "$@" "$HOST" "$REMOTE_CMD" < "$TMP" 2>"$OUT.err" | tee "$OUT.part"
RC=0

grep -viE 'warning: connection is not using|vulnerable to "store now|openssh\.com/pq' "$OUT.err" 2>/dev/null | sed 's/^/  ssh: /' >&2

{
    echo "QManager offline diagnostic"
    echo "collected : $(date)"
    echo "target    : $HOST${PORT:+:$PORT}"
    echo "-----------------------------------------------------------"
    cat "$OUT.part" 2>/dev/null
} > "$OUT"

LINES=$(wc -l < "$OUT" 2>/dev/null | tr -d ' ')
echo
if [ "${LINES:-0}" -lt 20 ]; then
    echo "Almost nothing came back (${LINES} lines) — the device did not answer." >&2
    echo "Try:" >&2
    echo "  ping -c 3 $HOST" >&2
    echo "  arp -an | grep -v incomplete" >&2
    echo "  sh $0 --host <its-lan-ip> --port 2222" >&2
    exit 1
fi

echo "Saved: $OUT  ($LINES lines)"
if [ "${LINES:-0}" -lt 20 ]; then
    echo
    echo "Only $LINES lines came back. If the run printed nothing at all, the cause" >&2
    echo "is almost always ssh auth, not the device. Check:" >&2
    echo "  ssh -o BatchMode=yes $HOST 'echo OK'    # must print OK with no prompt" >&2
    echo "  ssh-add -l                              # is a key loaded in the agent?" >&2
    echo "  ssh -v $HOST   # if it asks for a passphrase, the script cannot use it" >&2
fi
[ "$RC" = 0 ] || echo "NOTE: ssh exited $RC (timeout or non-zero) — the report may be partial."
echo
echo "Most useful for a no-signal fault, in order:"
echo "  'dmesg modem / SSR / glink / ipa'  - subsystem restarts, modem reboot"
echo "  'SIM / registration'               - CPIN, CFUN, COPS, CEREG, CSQ"
echo "  'serving cell / RF'                - QENG servingcell, QCAINFO"
echo "  'AT port holders'                  - anything holding the modem fd"
