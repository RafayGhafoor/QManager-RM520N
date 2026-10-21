#!/bin/sh
# at-cost.sh — CPU cost of one AT round-trip through qcmd, measured.
#
# WHY THIS EXISTS: the poller's CPU is 89 % reaped children, and the dominant term
# turned out to be the shim, not the modem or fork+exec. Measured on the O5A Pro
# 2026-10-22: 80 ms of CPU and 700 ms wall per `qcmd 'AT+CGMM'`, against a 2.4 ms
# fork+exec floor. The gap is atcli_smd11's `cat` readers busy-spinning on
# /dev/at_mdm0 during the drain (0.15 s) and settle (0.12 s).
#
# Any de-fork or shim optimisation must move THIS number, and must be reported
# before/after with the same command. CPU is this script's own cutime+cstime
# (fields 14+15 after stripping "pid (comm) "), so it includes reaped children —
# the same accounting docs/reference/poller-cpu-profile.md mandates.
#
# Usage:  sh at-cost.sh [calls] [command]
#   sh at-cost.sh                 # 10 x AT+CGMM
#   sh at-cost.sh 20 'AT+QENG="servingcell"'
#
# Read-only: send only AT commands whose replies you are willing to discard.
N=${1:-10}
CMD=${2:-AT+CGMM}
QCMD=${QCMD:-/usrdata/qmanager/bin/qcmd}
[ -x "$QCMD" ] || { echo "at-cost: $QCMD not found" >&2; exit 2; }

cpu() { sed 's/^[0-9]* (.*) //' /proc/$$/stat | awk '{print $14+$15}'; }

C0=$(cpu); T0=$(date +%s)
i=0; fail=0
while [ "$i" -lt "$N" ]; do
    "$QCMD" "$CMD" >/dev/null 2>&1 || fail=$((fail + 1))
    i=$((i + 1))
done
C1=$(cpu); T1=$(date +%s)

TICKS=$((C1 - C0)); WALL=$((T1 - T0))
CPU_MS=$((TICKS * 10))
echo "cmd=$CMD calls=$N failures=$fail"
echo "cpu_ms=$CPU_MS wall_s=$WALL"
[ "$N" -gt 0 ] && echo "per-call: cpu=$((CPU_MS / N))ms wall=$(( (WALL * 1000) / N ))ms"
echo "note: a single failure is lock contention, not a modem fault (AGENTS hard rule 3)"
