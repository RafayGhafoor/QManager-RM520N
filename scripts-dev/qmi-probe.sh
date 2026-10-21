#!/bin/sh
# qmi-probe.sh — READ-ONLY feasibility probe for QMI neighbour reads on the O5A.
#
# Purpose: answer, on the real device, the three questions that decide whether
# QManager can offer a 1 Hz "Live Mode" neighbour view for antenna aiming:
#
#   1. Is the QMI-over-QRTR path present and how fast is it, really?
#   2. What exactly does --nas-get-cell-location-info return, field by field,
#      so the JSON shape can be designed against real bytes instead of a guess?
#   3. Is it safe to poll at 1 Hz forever — jitter, failure rate, CPU cost,
#      and does a second concurrent QMI client break anything?
#
# It writes nothing outside $TMPDIR, sends no AT commands, takes no locks, and
# never modifies /data/gp. It only executes the vendor's qmicli read-only.
#
# Run ON THE DEVICE:
#   sh qmi-probe.sh            # full run, ~45s
#   sh qmi-probe.sh --quick    # single-shot timings only, ~5s
#
# Paste the output back. The VERDICT block at the end is what matters.
#
# Rules this script honours (AGENTS.md): reads /data/gp/*, never writes it;
# no AT port touched; nothing installed; no subscriber identifiers printed
# (IMEI/IMSI/ICCID never requested).

set -u

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

QMI_BIN=${QMI_BIN:-/data/gp/qmi/bin/qmicli}
QMI_DEV=${QMI_DEV:-qrtr://3}
TMPD=${TMPDIR:-/tmp}/qm-qmi-probe.$$
SOAK_TICKS=30
SOAK_SLEEP=1

cleanup() { rm -rf "$TMPD"; }
trap cleanup EXIT INT TERM HUP
mkdir -p "$TMPD" || { echo "FATAL: cannot create $TMPD"; exit 1; }

hr() { printf '%s\n' "------------------------------------------------------------"; }
say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
# Clock: /proc/uptime is always present and has centisecond resolution, which
# is what we need — busybox `date` has no %N on this firmware and its 1s
# granularity cannot measure a 40ms call.
# ---------------------------------------------------------------------------
now_cs() { awk '{printf "%d", $1 * 100}' /proc/uptime; }

# Field-safe CPU accounting: strip "pid (comm) " first, because comm may
# contain spaces and would shift every following field.
cpu_ticks_of() {
    [ -r "/proc/$1/stat" ] || { echo 0; return; }
    sed 's/^[0-9]* (.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $14 + $15}' 2>/dev/null || echo 0
}

# ---------------------------------------------------------------------------
# 0. Preconditions
# ---------------------------------------------------------------------------
hr
say "QMI PROBE — $(uname -n 2>/dev/null) — $(date 2>/dev/null)"
hr
say "qmicli   : $QMI_BIN"
say "device   : $QMI_DEV"

fatal=0
if [ ! -f "$QMI_BIN" ]; then
    say "MISSING  : $QMI_BIN does not exist"
    fatal=1
elif [ ! -x "$QMI_BIN" ]; then
    say "MISSING  : $QMI_BIN is not executable"
    fatal=1
else
    say "binary   : present, $(wc -c <"$QMI_BIN" 2>/dev/null | tr -d ' ') bytes"
fi

# QRTR control nodes tell us whether the transport exists at all.
qcnt=0
for _q in /dev/qrtr* /sys/bus/qrtr/devices/*; do
    [ -e "$_q" ] && qcnt=$((qcnt + 1))
done
say "qrtr     : $qcnt node(s) visible"

if [ "$fatal" -eq 1 ]; then
    say ""
    say "VERDICT: QMI path UNAVAILABLE on this box. Live Mode must use the AT"
    say "         path (slower: 3-6s per scan, contends with the poller)."
    exit 1
fi

# Build QMICLI invocation. A private libqmi build may rely on rpath, but if it
# does not, LD_LIBRARY_PATH next to the binary is the documented layout.
QMI_LIBDIR=$(dirname "$(dirname "$QMI_BIN")")/lib
if [ -d "$QMI_LIBDIR" ]; then
    LD_LIBRARY_PATH="$QMI_LIBDIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export LD_LIBRARY_PATH
    say "libdir   : $QMI_LIBDIR (added to LD_LIBRARY_PATH)"
fi

# run_qmi -> prints "<rc> <ms>" on stdout. It CANNOT set globals: it is always
# invoked as `x=$(run_qmi ...)`, which is a subshell, so an assigned $_rc would
# silently not propagate. The command's own output goes to $TMPD/out.
run_qmi() {
    _t0=$(now_cs)
    timeout 8 "$QMI_BIN" -d "$QMI_DEV" "$@" 2>"$TMPD/err" >"$TMPD/out"
    _rc=$?
    _t1=$(now_cs)
    printf '%d %d\n' "$_rc" "$(( (_t1 - _t0) * 10 ))"
}

# ---------------------------------------------------------------------------
# 1. Can it talk at all? A version call proves binary + libs + transport
#    before we spend time on the interesting one.
# ---------------------------------------------------------------------------
hr
say "1. TRANSPORT CHECK"
hr
res=$(run_qmi --dms-get-operating-mode)
_rc=${res%% *}
t_ms=${res##* }
if [ "$_rc" -ne 0 ]; then
    say "result   : FAILED (rc=$_rc, ${t_ms}ms)"
    sed -n '1,5p' "$TMPD/err" 2>/dev/null | sed 's/^/  stderr: /'
    say ""
    say "VERDICT: qmicli exists but cannot reach $QMI_DEV."
    say "         Try: ls -l /dev/qrtr* ; ps | grep -i qmi"
    exit 1
fi
say "result   : OK in ${t_ms}ms"
sed -n '1,3p' "$TMPD/out" | sed 's/^/  /'

# ---------------------------------------------------------------------------
# 2. The neighbour call — the whole point of this probe.
# ---------------------------------------------------------------------------
hr
say "2. --nas-get-cell-location-info"
hr
i=1
while [ "$i" -le 3 ]; do
    res=$(run_qmi --nas-get-cell-location-info)
    _rc=${res%% *}
    t_ms=${res##* }
    say "run $i   : rc=$_rc  ${t_ms}ms  $(wc -c <"$TMPD/out" 2>/dev/null | tr -d ' ') bytes"
    [ "$i" -eq 3 ] && cp "$TMPD/out" "$TMPD/neigh.txt"
    i=$((i + 1))
done

# Count what the parser will actually have to chew on.
say ""
say "sections found:"
# NOTE: `grep -c` prints 0 AND exits 1 when nothing matches, so `|| echo 0`
# yields "0\n0". Assign with `|| _n=0` and then normalise instead.
for _sec in "Intrafrequency LTE Info" "Interfrequency LTE Info" \
            "LTE Info Neighboring" "5GNR"; do
    _n=$(grep -c "^$_sec" "$TMPD/neigh.txt" 2>/dev/null) || _n=0
    [ -n "$_n" ] || _n=0
    say "  $_sec : $_n"
done
_cells=$(grep -c 'Physical Cell ID:' "$TMPD/neigh.txt" 2>/dev/null) || _cells=0
[ -n "$_cells" ] || _cells=0
_meas=$(grep -c 'RSRP:' "$TMPD/neigh.txt" 2>/dev/null) || _meas=0
[ -n "$_meas" ] || _meas=0
say "  neighbour rows (Physical Cell ID) : $_cells"
say "  rows with an RSRP measurement     : $_meas"

say ""
say "raw output (first 45 lines — this is the parser contract):"
sed -n '1,45p' "$TMPD/neigh.txt" | sed 's/^/  /'

# ---------------------------------------------------------------------------
# 3. Signal + registration. Both are needed: signal alone lies.
# ---------------------------------------------------------------------------
hr
say "3. SIGNAL + REGISTRATION (signal alone is NOT proof of attachment)"
hr
res=$(run_qmi --nas-get-signal-info)
_rc=${res%% *}
t_ms=${res##* }
say "signal   : rc=$_rc ${t_ms}ms"
grep -E '^(LTE:|5G:)|RSRP:|RSRQ:|RSSI:|SNR:' "$TMPD/out" 2>/dev/null | sed 's/^/  /'

res=$(run_qmi --nas-get-serving-system)
_rc=${res%% *}
t_ms=${res##* }
say "serving  : rc=$_rc ${t_ms}ms"
grep -iE 'registration state|registration_state|mcc|mnc|description' "$TMPD/out" 2>/dev/null \
    | sed -n '1,6p' | sed 's/^/  /'

reg_state=$(grep -i 'registration state' "$TMPD/out" 2>/dev/null | head -1)
say ""
say "  >>> $reg_state"

if [ "$QUICK" -eq 1 ]; then
    hr
    say "QUICK MODE — skipping 1 Hz soak."
    exit 0
fi

# ---------------------------------------------------------------------------
# 4. 1 Hz soak. This is the question that actually decides Live Mode:
#    can we poll this every second, forever, without falling over?
# ---------------------------------------------------------------------------
hr
say "4. 1 Hz SOAK — $SOAK_TICKS ticks, ~${SOAK_TICKS}s"
hr
say "  (do NOT run a cell scan or speed test during this — we want clean numbers)"
say ""

cpu0=$(cpu_ticks_of $$)
min_ms=999999
max_ms=0
tot_ms=0
fails=0
ticks=0
i=1
while [ "$i" -le "$SOAK_TICKS" ]; do
    res=$(run_qmi --nas-get-cell-location-info)
    _rc=${res%% *}
    t_ms=${res##* }
    ticks=$((ticks + 1))
    tot_ms=$((tot_ms + t_ms))
    [ "$t_ms" -lt "$min_ms" ] && min_ms=$t_ms
    [ "$t_ms" -gt "$max_ms" ] && max_ms=$t_ms
    if [ "$_rc" -ne 0 ]; then
        fails=$((fails + 1))
        printf '  tick %2d: FAIL rc=%d %sms\n' "$i" "$_rc" "$t_ms"
    elif [ $((i % 5)) -eq 0 ]; then
        printf '  tick %2d: %sms\n' "$i" "$t_ms"
    fi
    i=$((i + 1))
    sleep "$SOAK_SLEEP"
done

cpu1=$(cpu_ticks_of $$)
avg_ms=$((tot_ms / ticks))
cpu_ticks=$((cpu1 - cpu0))
wall_s=$((ticks * SOAK_SLEEP))
[ "$wall_s" -gt 0 ] || wall_s=1
# HZ is 100 on this SoC, so one second of wall time = 100 CPU ticks. Percent is
# therefore just cpu_ticks / wall_s; no extra scaling.
cpu_pct=$((cpu_ticks / wall_s))

say ""
say "results  : $ticks ticks, $fails failure(s)"
say "latency  : min ${min_ms}ms / avg ${avg_ms}ms / max ${max_ms}ms"
say "cpu      : ~${cpu_pct}% of one core (child CPU ${cpu_ticks} ticks over ${wall_s}s)"

# ---------------------------------------------------------------------------
# 5. Concurrency. QManager would be a SECOND QMI client alongside the vendor's
#    radio-handler. Does QRTR multiplex cleanly, or do they collide?
# ---------------------------------------------------------------------------
hr
say "5. CONCURRENCY — 3 simultaneous clients"
hr
timeout 15 "$QMI_BIN" -d "$QMI_DEV" --nas-get-cell-location-info >"$TMPD/c1" 2>&1 &
p1=$!
timeout 15 "$QMI_BIN" -d "$QMI_DEV" --nas-get-cell-location-info >"$TMPD/c2" 2>&1 &
p2=$!
timeout 15 "$QMI_BIN" -d "$QMI_DEV" --nas-get-signal-info >"$TMPD/c3" 2>&1 &
p3=$!
wait "$p1"; r1=$?
wait "$p2"; r2=$?
wait "$p3"; r3=$?
okc=0
[ "$r1" -eq 0 ] && okc=$((okc + 1))
[ "$r2" -eq 0 ] && okc=$((okc + 1))
[ "$r3" -eq 0 ] && okc=$((okc + 1))
say "parallel : $okc/3 succeeded (rc: $r1 $r2 $r3)"
if [ "$okc" -lt 3 ]; then
    say "  chunk 1: $(wc -c <"$TMPD/c1" | tr -d ' ') bytes"
    say "  chunk 2: $(wc -c <"$TMPD/c2" | tr -d ' ') bytes"
    say "  chunk 3: $(wc -c <"$TMPD/c3" | tr -d ' ') bytes"
fi

# The vendor's own wrapper gives ready-made JSON — proves we can consume a
# parsed result instead of writing a new parser.
if [ -x /data/gp/gp-qmi.sh ] || [ -f /data/gp/gp-qmi.sh ]; then
    hr
    say "6. VENDOR WRAPPER (ready-made JSON, read-only invocation)"
    hr
    _t0=$(now_cs)
    timeout 10 sh /data/gp/gp-qmi.sh --neighbors >"$TMPD/pn" 2>"$TMPD/pnerr"
    _rc=$?
    _t1=$(now_cs)
    say "gp-qmi --neighbors : rc=$_rc $(( (_t1 - _t0) * 10 ))ms, $(wc -c <"$TMPD/pn" | tr -d ' ') bytes"
    head -c 600 "$TMPD/pn" 2>/dev/null | sed 's/^/  /'
    say ""
    timeout 10 sh /data/gp/gp-qmi.sh --signal >"$TMPD/ps" 2>/dev/null
    say "gp-qmi --signal    : $(wc -c <"$TMPD/ps" | tr -d ' ') bytes"
    head -c 400 "$TMPD/ps" 2>/dev/null | sed 's/^/  /'
fi

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
hr
say "VERDICT"
hr
if [ "$avg_ms" -le 150 ] && [ "$fails" -eq 0 ]; then
    say " 1 Hz Live Mode: VIABLE."
    say "   avg ${avg_ms}ms leaves ~87% of each second idle. Even 2 Hz fits."
    say "   No AT lock, no poller pause, no vendor contention."
elif [ "$avg_ms" -le 500 ] && [ "$fails" -eq 0 ]; then
    say " 1 Hz Live Mode: VIABLE but tight (avg ${avg_ms}ms)."
    say "   Ship at 1 Hz with a 2s cache; do not promise 2 Hz."
elif [ "$fails" -gt 0 ]; then
    say " 1 Hz Live Mode: NOT SAFE AS-IS — $fails/$ticks ticks failed."
    say "   Investigate before building on this path."
else
    say " 1 Hz Live Mode: TOO SLOW (avg ${avg_ms}ms)."
    say "   Consider 0.5 Hz, or narrow to --nas-get-signal-info only."
fi

if [ "$max_ms" -gt $((avg_ms * 4)) ]; then
    say ""
    say " WARNING: max ${max_ms}ms is >4x the average — heavy jitter."
    say "   A UI at 1 Hz would visibly stutter. Use the cached-file pattern"
    say "   (modem writes to JSON, browser polls the file) to absorb it."
fi

say ""
say " Next: send the section-2 raw output — the parser gets built from those"
say "       exact bytes, not from an assumption about the format."
hr
