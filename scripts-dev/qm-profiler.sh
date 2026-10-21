#!/bin/sh
# =============================================================================
# qm-profiler.sh — attribute a QManager daemon's CPU to the child programs it
# forks, and separate "burning CPU" from "blocked".
# =============================================================================
# WHAT IT ANSWERS
#   "idle 12.9 % of one core, 19.5 % with a live lease held, +6.7 points" is not
#   actionable, because 6.7 points is not a thing you can delete. This tool turns
#   it into "jq +3.1, qcmd +1.8, unattributed +1.8" by sampling the daemon's
#   children and summing each child's CPU under the name of the program that was
#   exec'd. That breakdown, plus a wall-clock state split, is what makes a
#   regression in a gated feature readable.
#
# WHY BY PROGRAM NAME AND NOT BY SHELL FUNCTION
#   docs/reference/poller-cpu-profile.md measured that almost none of the
#   poller's CPU is computation: /bin/true costs 2.40 ms (RM520N-GL) / 4.95 ms
#   (RG501Q-EU), and jq costs 4.3x a normal applet. The cost IS process creation,
#   so the only breakdown that points at something deletable is keyed by the
#   exec'd program.
#
# WHY htop IS NOT THE ANSWER
#   htop shows only utime+stime of the parent. Every reaped child's CPU is
#   accumulated into the parent's cutime+cstime, which htop does not display.
#   On the RM520N-GL that under-reported the poller by ~9x. Both halves are
#   printed here, with their ratio.
#
# READ-ONLY
#   Reads /proc only. The single write is the live-neighbour lease with --lease
#   (/tmp/qmanager_neighbours_live), and it is removed again on exit if this run
#   created it. It never starts, stops or restarts a unit, never sends an AT
#   command, never touches /data/gp, and writes nowhere but $TMPDIR.
#
# USAGE
#   sh qm-profiler.sh                             # qmanager_poller, 60 s, table
#   sh qm-profiler.sh --lease --seconds 120       # exercise the lease-gated path
#   sh qm-profiler.sh --pid 4211 --interval 50 --json
#   sh qm-profiler.sh --save /tmp/base.json       # then, later:
#   sh qm-profiler.sh --lease --compare /tmp/base.json
#
# POSIX sh / busybox ash only: no arrays, no [[, no brace expansion. See
# docs/reference/profiling.md for the traps this tool exists to make visible.
# =============================================================================

set -u

SCHEMA="qm-profiler/1"
PROC=${QMPROF_PROC:-/proc}          # overridable only so the tool can be pointed
                                    # at a captured tree off-device; leave it be.
TICK_MS=${QMPROF_TICK_MS:-10}       # USER_HZ=100 on every device measured so far

NEIGHBOURS_LEASE="/tmp/qmanager_neighbours_live"
NEIGHBOURS_LIVE="/tmp/qmanager_neighbours_live.json"
LEASE_RENEW_MS=2000                 # the poller trusts a lease 0..10 s old

BUCKETS="qcmd jq awk sed grep date timeout qmicli other"
BUCKETS_ALL="$BUCKETS unattributed"

SERVICE="qmanager_poller"
PID=""
WANT_S=60
INTERVAL_MS=100
BASELINE_S=5
DO_LEASE=0
SAVE=""
CMP=""
JSON_ONLY=0
THRESHOLD=10
FLOOR_MS=20

# -----------------------------------------------------------------------------
# Output helpers
# -----------------------------------------------------------------------------
say() { printf '%s\n' "$*"; }
err() { printf 'qm-profiler: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

usage() {
    cat <<'EOF'
qm-profiler.sh — per-child-program CPU attribution for a QManager daemon (read-only)

  --pid P            profile the process with this pid
  --service NAME     profile this systemd unit's MainPID (default qmanager_poller)
  --seconds N        measurement window in seconds (default 60)
  --interval MS      sample interval in ms (default 100). The shortest child that
                     can be caught lives about one interval; a 100 ms interval
                     also costs ~10 sleep-forks/s of instrument overhead, which
                     is printed as self_overhead
  --baseline-seconds N
                     measure the system fork rate for N s BEFORE the window
                     (default 5; 0 skips the baseline)
  --lease            hold /tmp/qmanager_neighbours_live fresh for the whole
                     window, so a lease-gated live path is actually exercised
  --save FILE        write the run as JSON (put it under /tmp)
  --compare FILE     diff this run per bucket against a saved JSON
  --ppidscan         find children via /proc/*/stat (no CONFIG_PROC_CHILDREN).
                     MEASURED HARMFUL on the O5A Pro: 40 % self-overhead and still
                     99 % unattributed. Present only so the claim is testable.
  --threshold PCT    --compare: a bucket must move at least this much to get a
                     verdict (default 10, percent)
  --floor-ms N       --compare: buckets below this many ms are not judged
                     (default 20)
  --json             emit machine JSON on stdout instead of the human table
  --help             this text

Exit status is non-zero only on a real failure (target unreachable, /proc
unreadable, a requested file unwritable). A number changing is not a failure.
EOF
}

# pct1 NUM DEN — sets PCT to NUM/DEN as a percentage with one decimal place.
pct1() {
    PCT="0.0"
    [ "${2:-0}" -gt 0 ] 2>/dev/null || return 0
    _pn=${1:-0}
    _psign=""
    if [ "$_pn" -lt 0 ]; then _psign="-"; _pn=$(( 0 - _pn )); fi
    _pt=$(( _pn * 1000 / $2 ))
    PCT="$_psign$(( _pt / 10 )).$(( _pt % 10 ))"
}

# ratio1 NUM DEN — sets RATIO to NUM/DEN with one decimal place, or n/a.
ratio1() {
    RATIO="n/a"
    [ "${2:-0}" -gt 0 ] 2>/dev/null || return 0
    _rn=${1:-0}
    _rsign=""
    if [ "$_rn" -lt 0 ]; then _rsign="-"; _rn=$(( 0 - _rn )); fi
    _rt=$(( _rn * 10 / $2 ))
    RATIO="$_rsign$(( _rt / 10 )).$(( _rt % 10 ))"
}

# sign1 VALUE_X10 — sets SIG1 to a signed tenths value as "+12.3" / "-4.0".
sign1() {
    _v=${1:-0}
    if [ "$_v" -lt 0 ]; then _sg="-"; _v=$(( 0 - _v )); else _sg="+"; fi
    SIG1="$_sg$(( _v / 10 )).$(( _v % 10 ))"
}

# Strip leading zeros so $(( )) never reads a decimal as octal.
strip0() {
    _S=${1:-0}
    while :; do case $_S in 0?*) _S=${_S#0} ;; *) break ;; esac; done
    [ -n "$_S" ] || _S=0
}

# now_ms — wall clock in milliseconds from /proc/uptime, fork-free.
#
# busybox `date` has no %N and its 1 s granularity cannot see a 100 ms interval,
# so /proc/uptime is the clock. Computed with builtins only: this runs once per
# sample, and a `date` fork per sample would cost more CPU than the poller being
# profiled.
now_ms() {
    _up=""
    read -r _up _ < "$PROC/uptime" 2>/dev/null || true
    case "${_up:-}" in ''|*[!0-9.]*) return 1 ;; esac
    _ip=${_up%%.*}
    _fp=${_up#*.}
    [ "$_fp" = "$_up" ] && _fp=""
    case ${#_fp} in
        0) _fp=0 ;;
        1) _fp=${_fp}0 ;;
        2) ;;
        *) _cut=${_fp#??}; _fp=${_fp%$_cut} ;;
    esac
    strip0 "$_ip"; _ip=$_S
    strip0 "$_fp"; _fp=$_S
    # /proc/uptime's fraction is CENTISECONDS ("92580.75"), not milliseconds.
    NOW_MS=$(( _ip * 1000 + _fp * 10 ))
    return 0
}

# json_str STR — sets JS to STR as a JSON string literal.
json_str() {
    _js=$(printf '%s' "${1:-}" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')
    JS="\"$_js\""
}

# =============================================================================
# 1. Arguments
# =============================================================================
need_arg() { [ "$2" -ge 2 ] || die "$1 needs a value"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --pid)                need_arg "$1" $#; PID=$2; shift ;;
        --pid=*)              PID=${1#--pid=} ;;
        --service)            need_arg "$1" $#; SERVICE=$2; shift ;;
        --service=*)          SERVICE=${1#--service=} ;;
        --seconds)            need_arg "$1" $#; WANT_S=$2; shift ;;
        --seconds=*)          WANT_S=${1#--seconds=} ;;
        --interval)           need_arg "$1" $#; INTERVAL_MS=$2; shift ;;
        --interval=*)         INTERVAL_MS=${1#--interval=} ;;
        --baseline-seconds)   need_arg "$1" $#; BASELINE_S=$2; shift ;;
        --baseline-seconds=*) BASELINE_S=${1#--baseline-seconds=} ;;
        --lease)              DO_LEASE=1 ;;
        --ppidscan)           PPIDSCAN=1 ;;
        --save)               need_arg "$1" $#; SAVE=$2; shift ;;
        --save=*)             SAVE=${1#--save=} ;;
        --compare)            need_arg "$1" $#; CMP=$2; shift ;;
        --compare=*)          CMP=${1#--compare=} ;;
        --threshold)          need_arg "$1" $#; THRESHOLD=$2; shift ;;
        --threshold=*)        THRESHOLD=${1#--threshold=} ;;
        --floor-ms)           need_arg "$1" $#; FLOOR_MS=$2; shift ;;
        --floor-ms=*)         FLOOR_MS=${1#--floor-ms=} ;;
        --json)               JSON_ONLY=1 ;;
        --help|-h)            usage; exit 0 ;;
        *)                    err "unknown argument: $1"; usage >&2; exit 2 ;;
    esac
    shift
done

case "$WANT_S" in ''|*[!0-9]*) die "--seconds must be a positive integer" ;; esac
case "$INTERVAL_MS" in ''|*[!0-9]*) die "--interval must be a positive integer (ms)" ;; esac
case "$BASELINE_S" in ''|*[!0-9]*) die "--baseline-seconds must be an integer" ;; esac
case "$THRESHOLD" in ''|*[!0-9]*) die "--threshold must be an integer (percent)" ;; esac
case "$FLOOR_MS" in ''|*[!0-9]*) die "--floor-ms must be an integer" ;; esac
case "$TICK_MS" in ''|*[!0-9]*) die "QMPROF_TICK_MS must be an integer" ;; esac
[ "$WANT_S" -gt 0 ] || die "--seconds must be greater than 0"
[ "$INTERVAL_MS" -ge 10 ] || die "--interval must be at least 10 ms"
[ "$INTERVAL_MS" -le 10000 ] || die "--interval must be at most 10000 ms"

# =============================================================================
# 2. Target selection
# =============================================================================
# systemd's MainPID is exact. The alternatives are traps: `pgrep -f` matches the
# command line of the shell running the pgrep, so it matches itself, and a
# wrapper whose argv names the daemon matches too.
resolve_target() {
    if [ -n "$PID" ]; then
        case "$PID" in *[!0-9]*) die "--pid must be numeric" ;; esac
    else
        if command -v systemctl >/dev/null 2>&1; then
            PID=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null)
        fi
        case "${PID:-}" in ''|*[!0-9]*|0) PID="" ;; esac
        [ -n "$PID" ] || die "cannot resolve --service $SERVICE (unit not running?) — use --pid"
    fi
    [ -r "$PROC/$PID/stat" ] || die "cannot read $PROC/$PID/stat — target gone, or this is not a Linux /proc"
}

resolve_target
T_STAT="$PROC/$PID/stat"
T_STATUS="$PROC/$PID/status"
T_WCHAN="$PROC/$PID/wchan"
T_TASKS="$PROC/$PID/task"

# Identity, for the header and for --compare's comparability gate.
T_COMM=""
read -r T_COMM < "$PROC/$PID/comm" 2>/dev/null || true
T_CMDLINE=""
# argv is NUL-separated with no trailing newline: `read` truncates at the first
# NUL, so the command line is taken with tr (one fork, once, at startup).
T_CMDLINE=$(tr '\000' ' ' < "$PROC/$PID/cmdline" 2>/dev/null)
case "$T_CMDLINE" in
    '') T_SRC="" ;;
    *)  # A shebang script execs as "<interpreter> <script>", so the script is the
        # LAST word; a native daemon's last word is an argument. Prefer the last
        # word that is a readable regular file, else the first.
        T_SRC=""
        set -f
        _saved="$T_CMDLINE"
        set -- $_saved
        set +f
        _last=""
        [ $# -gt 0 ] && _last=$1 && T_SRC=$1
        for _t in "$@"; do _last=$_t; done
        [ -n "$_last" ] && [ -f "$_last" ] && [ -r "$_last" ] && T_SRC=$_last
        ;;
esac
T_MD5=""
if [ -n "$T_SRC" ] && command -v md5sum >/dev/null 2>&1; then
    T_MD5=$(md5sum "$T_SRC" 2>/dev/null | cut -d' ' -f1)
fi

# =============================================================================
# 3. Preflight — what this box will let us measure
# =============================================================================
ATTR_OK=1
_cf_probe=""
for _c in "$T_TASKS"/*/children; do
    [ -r "$_c" ] && { _cf_probe=$_c; break; }
done
# Child discovery. `/proc/<pid>/task/<tid>/children` is the cheap path, but it
# only exists with CONFIG_PROC_CHILDREN — confirmed ABSENT on the GreenPacket O5A
# Pro (RG520N-EB, measured 2026-10-22), where it silently degraded the whole
# per-program table to 100 % unattributed. Falling back to a ppid scan over
# /proc/*/stat costs ~400 builtin `read`s per sample and needs no kernel option,
# which is the difference between the tool answering its one question and not.
if [ -n "$_cf_probe" ]; then
    CHILD_SRC="children"
elif [ -r /proc/self/stat ]; then
    CHILD_SRC="ppidscan"
    err "NOTE: no /proc/<pid>/task/*/children on this kernel (CONFIG_PROC_CHILDREN"
    err "      is off). Discovering children by scanning /proc/*/stat ppid instead:"
    err "      correct, but it costs the instrument more CPU per sample."
else
    CHILD_SRC=""
    ATTR_OK=0
    err "WARNING: no way to discover children on this kernel — child CPU cannot be"
    err "         keyed by program name. Own-vs-children totals are still exact."
fi

# Fractional sleep: busybox needs CONFIG_FEATURE_FANCY_SLEEP, and an unsupported
# `sleep 0.1` fails INSTANTLY — which would turn the sampling loop into a spin
# that burns the very CPU it is measuring. Detected, never assumed.
FRAC_SLEEP=0
if now_ms; then
    _t0=$NOW_MS
    sleep 0.1 2>/dev/null
    if now_ms; then
        _d=$(( NOW_MS - _t0 ))
        [ "$_d" -ge 60 ] && [ "$_d" -le 600 ] && FRAC_SLEEP=1
    fi
fi
if [ "$FRAC_SLEEP" = 0 ]; then
    [ "$INTERVAL_MS" -lt 1000 ] && err "WARNING: fractional sleep unsupported here — interval forced to 1000 ms; attribution will miss most short-lived children"
    INTERVAL_MS=1000
fi
NAP="1"
if [ "$FRAC_SLEEP" = 1 ]; then
    # "0.050", not "0.50": the fractional part has to be zero-padded to three
    # digits or a 50 ms interval naps for 500 ms and every rate in the report is
    # a tenth of the truth.
    strip0 "$INTERVAL_MS"; _imi=$_S
    _f=$(( _imi % 1000 ))
    case ${#_f} in
        1) _f="00$_f" ;;
        2) _f="0$_f" ;;
    esac
    NAP="$(( _imi / 1000 )).$_f"
fi

TMP="${TMPDIR:-/tmp}/qm-profiler.$$"
mkdir -p "$TMP" 2>/dev/null || die "cannot create $TMP"
LEASE_CREATED=0
cleanup() {
    # A root-created file in a sticky /tmp is one a www-data CGI can no longer
    # rewrite where fs.protected_regular is on. If this run created the lease,
    # it takes it away again: the feature is then simply off.
    if [ "$LEASE_CREATED" = 1 ]; then rm -f "$NEIGHBOURS_LEASE" 2>/dev/null; fi
    rm -rf "$TMP" 2>/dev/null
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 130' HUP

# =============================================================================
# 4. Counters (all initialized: the script runs under `set -u`)
# =============================================================================
S_RUN=0; S_WAIT_CHILD=0; S_SLEEP=0; S_DISK=0; S_OTHER=0
W_NONE=0; W_DO_WAIT=0; W_FLOCK=0; W_NAP=0; W_POLL=0; W_READ=0; W_OTHER=0
C_SAMPLES=0; C_RUN=0; C_SLEEP=0; C_DISK=0; C_FLOCK=0
SAMPLES=0
SEEN=""
KEY_COUNT=0
KEY_CAP=20000
ATTR_CAPPED=0
# Which clock the per-child ms came from: schedstat (exact ns) or stat ticks
# (10 ms floor). A run must say which it used, because the two do not agree.
CPU_SOURCE_SS=0
CPU_SOURCE_TICK=0
CHILD_SPAWNS=0
TARGET_GONE=0
RSS_KB=0; RSS_PEAK_KB=0; MEM_TOTAL_KB=0; MA_START_KB=0; MA_END_KB=0; MEM_OK=0
SNAP_OWN=0; SNAP_CHILD=0
FORK_BASE_RATE=0; FORK_WIN_RATE=0; FORK_AT_END=0; FORK_BASE_OK=0
_f0=0; _fw0=0
LEASE_ERROR=0; LIVE_CONFIRMED=0
_epoch_now=0; _next_lease_ms=0; _next_mem_ms=0
_start_epoch=0; _start_up_ms=0

# bucket_of COMM — sets BK. Matching is on `comm`, which the kernel truncates to
# 15 characters, so a longer program name can never match and lands in `other`.
bucket_of() {
    case "$1" in
        qcmd)                     BK=qcmd ;;
        jq)                       BK=jq ;;
        awk|gawk|mawk|nawk)       BK=awk ;;
        sed)                      BK=sed ;;
        grep|egrep|fgrep)         BK=grep ;;
        date)                     BK=date ;;
        timeout)                  BK=timeout ;;
        qmicli|qmicli-static)     BK=qmicli ;;
        *)                        BK=other ;;
    esac
}

# bucket_add BK MS — add MS of child CPU and one observed fork to a bucket.
bucket_add() {
    eval "B_$1_ms=\$(( \${B_$1_ms:-0} + $2 ))"
    eval "B_$1_forks=\$(( \${B_$1_forks:-0} + 1 ))"
}

# =============================================================================
# 5. Samplers
# =============================================================================
# snap — exact CPU totals for the window: the target's own ticks and the ticks
# of every child it has reaped. Sets SNAP_OWN / SNAP_CHILD.
#
# Field positions: after removing "pid (comm) ", field 3 of /proc/PID/stat is
# field 1, so utime/stime are 12/13 and cutime/cstime are 14/15. The prefix is
# removed with ${line##*)} — the LAST ')' in the line — so a comm containing
# ')' or ') ' cannot shift the fields the way `sed 's/^[0-9]* (.*) //'` can.
snap() {
    _line=""
    read -r _line < "$T_STAT" 2>/dev/null
    [ -n "$_line" ] || { SNAP_GONE=1; return 1; }
    case "$_line" in *'('*')'*) ;; *) SNAP_GONE=1; return 1 ;; esac
    _rest=${_line##*)}
    set -f
    set -- $_rest
    set +f
    [ $# -ge 15 ] || { SNAP_GONE=1; return 1; }
    # ${12}, never $12 — in sh `$12` is `${1}2`. That single character is the
    # difference between "the poller spends 0 ms" and the real answer.
    SNAP_OWN=$(( ${12} + ${13} ))
    SNAP_CHILD=$(( ${14} + ${15} ))
    return 0
}

# sample_once — one tick: the target's own state/wchan, then every live child's
# state, wchan and cumulative CPU. Builtins only. A fork in this loop would be
# charged to the instrument once per sample and would swamp what it measures.
sample_once() {
    set +f
    _files=""
    for _f in "$T_TASKS"/*/children; do
        [ -r "$_f" ] || continue
        _files="$_files $_f"
    done
    set -f

    _line=""
    read -r _line < "$T_STAT" 2>/dev/null
    [ -n "$_line" ] || { TARGET_GONE=1; set +f; return 1; }
    case "$_line" in *'('*')'*) ;; *) TARGET_GONE=1; set +f; return 1 ;; esac
    _rest=${_line##*)}
    set -- $_rest
    _st=$1
    _wchan=""
    read -r _wchan < "$T_WCHAN" 2>/dev/null

    case "$_st" in
        R) S_RUN=$(( S_RUN + 1 )) ;;
        D) S_DISK=$(( S_DISK + 1 )) ;;
        S)
            case "${_wchan:-}" in
                do_wait) S_WAIT_CHILD=$(( S_WAIT_CHILD + 1 )) ;;
                *)       S_SLEEP=$(( S_SLEEP + 1 )) ;;
            esac ;;
        *) S_OTHER=$(( S_OTHER + 1 )) ;;
    esac
    case "${_wchan:-}" in
        '')                            W_NONE=$(( W_NONE + 1 )) ;;
        do_wait)                       W_DO_WAIT=$(( W_DO_WAIT + 1 )) ;;
        *flock*)                       W_FLOCK=$(( W_FLOCK + 1 )) ;;
        *sleep*|*hrtimer*|*nanosleep*) W_NAP=$(( W_NAP + 1 )) ;;
        *poll*|*select*|*epoll*)       W_POLL=$(( W_POLL + 1 )) ;;
        *read*)                        W_READ=$(( W_READ + 1 )) ;;
        *)                             W_OTHER=$(( W_OTHER + 1 )) ;;
    esac

    if [ "$ATTR_OK" = 1 ]; then
        _allkids=""
        if [ "$CHILD_SRC" = "children" ]; then
            for _f in $_files; do
                # /proc/<pid>/task/<tid>/children has NO trailing newline, so busybox
                # `read` returns 1 at EOF while still setting the variable. Gating on
                # its exit status (read ... || continue) silently skips EVERY child —
                # the attribution then reads 0 % named and looks like a tool quirk.
                _kids=""
                read -r _kids < "$_f" 2>/dev/null
                [ -n "$_kids" ] || continue
                _allkids="$_allkids $_kids"
            done
        else
            # ppid scan. Builtins only — a fork here would be charged to the
            # instrument once per sample and swamp what it measures.
            set +f
            for _pd in "$PROC"/*; do
                _pure=${_pd##*/}
                case "$_pure" in ''|*[!0-9]*) continue ;; esac
                _pl=""
                { read -r _pl < "$_pd/stat"; } 2>/dev/null
                [ -n "$_pl" ] || continue
                case "$_pl" in *'('*')'*) ;; *) continue ;; esac
                # Fields restart after the last ')': $1=state, $2=ppid.
                set -- ${_pl##*)}
                [ "${2:-}" = "$PID" ] && _allkids="$_allkids $_pure"
            done
            set -f
        fi
        for _kid in $_allkids; do
            case "$_kid" in ''|*[!0-9]*) continue ;; esac
            if [ "$CHILD_SRC" != "" ]; then :; fi
                _cline=""
                # A child that dies between the list read and this read makes the
                # SHELL print "can't open /proc/N/stat" — the message comes from
                # the redirection, so 2>/dev/null must be on a group, not the read.
                { read -r _cline < "$PROC/$_kid/stat"; } 2>/dev/null
                [ -n "$_cline" ] || continue
                case "$_cline" in *'('*')'*) ;; *) continue ;; esac
                # comm sits between the first '(' and the first ')'; the numeric
                # fields restart after the last ')'.
                _cname=${_cline#*\(}
                _cname=${_cname%%\)*}
                _crest=${_cline##*)}
                set -- $_crest
                [ $# -ge 20 ] || continue
                _cstate=$1
                _cstart=${20}
                _cw=""
                { read -r _cw < "$PROC/$_kid/wchan"; } 2>/dev/null

                # Per-child CPU in ms. Two sources for the same quantity:
                #
                #   /proc/<pid>/schedstat field 1 (sum_exec_runtime, ns) is exact
                #   and fresh. The stat's utime/stime are 10 ms ticks that FLOOR and
                #   lag — a child measured at 20.4 ms of CPU read "1 tick" — so on
                #   ticks alone every 2.4 ms fork+exec applet reads as 0 ms and the
                #   whole per-name table collapses to zero. schedstat is absent on
                #   kernels built without CONFIG_SCHEDSTATS, hence the fallback.
                #
                # A child's OWN reaped children appear only in cutime/cstime (ticks);
                # schedstat does not roll them up. So a caught wrapper (qcmd) carries
                # its subtree coarsely, a caught leaf carries itself exactly.
                _ss=""
                # 2>/dev/null FIRST: redirects are applied left to right, so a
                # failed input redirect would otherwise print before stderr is
                # silenced (a child that exits between the list read and here).
                { read -r _ss _ _; } 2>/dev/null < "$PROC/$_kid/schedstat"
                case "${_ss:-}" in ''|*[!0-9]*) _ss=0 ;; esac
                _own_ms=$(( _ss / 1000000 ))
                _tick_own_ms=$(( ( ${12} + ${13} ) * TICK_MS ))
                [ "$_tick_own_ms" -gt "$_own_ms" ] && _own_ms=$_tick_own_ms
                _ccpu=$(( _own_ms + ( ${14} + ${15} ) * TICK_MS ))
                if [ "$_ss" -gt 0 ]; then CPU_SOURCE_SS=1; else CPU_SOURCE_TICK=1; fi

                C_SAMPLES=$(( C_SAMPLES + 1 ))
                case "$_cstate" in
                    R) C_RUN=$(( C_RUN + 1 )) ;;
                    D) C_DISK=$(( C_DISK + 1 )) ;;
                    *) C_SLEEP=$(( C_SLEEP + 1 )) ;;
                esac
                case "${_cw:-}" in *flock*) C_FLOCK=$(( C_FLOCK + 1 )) ;; esac

                # Key on pid + starttime: a pid reused inside a long window is a
                # different process and must not inherit the earlier one's CPU.
                _key="${_kid}_${_cstart}"
                eval "_prev=\${PCK_$_key:-x}"
                if [ "$_prev" = x ]; then
                    if [ "$KEY_COUNT" -ge "$KEY_CAP" ]; then
                        ATTR_CAPPED=1
                        continue
                    fi
                    eval "PCK_$_key=$_ccpu; PNK_$_key=\$_cname"
                    SEEN="$SEEN $_key"
                    KEY_COUNT=$(( KEY_COUNT + 1 ))
                    CHILD_SPAWNS=$(( CHILD_SPAWNS + 1 ))
                elif [ "$_ccpu" -gt "$_prev" ]; then
                    eval "PCK_$_key=$_ccpu"
                fi
        done
    fi

    set +f
    return 0
}

# mem_sample — VmRSS plus MemTotal/MemAvailable.
#
# Read at 1 Hz, not at the sample interval: /proc/PID/status is ~40 lines and
# busybox `read` is byte-at-a-time, so this is real CPU at 100 ms while RSS moves
# on a scale of seconds.
mem_sample() {
    _rss=""
    while read -r _k _v _x; do
        case "${_k:-}" in VmRSS:) _rss=${_v:-0}; break ;; esac
    done < "$T_STATUS" 2>/dev/null
    case "${_rss:-}" in ''|*[!0-9]*) _rss=0 ;; esac
    RSS_KB=$_rss
    [ "$RSS_KB" -gt "$RSS_PEAK_KB" ] && RSS_PEAK_KB=$RSS_KB

    _mt=0; _ma=0
    while read -r _k _v _x; do
        case "${_k:-}" in
            MemTotal:)     _mt=${_v:-0} ;;
            MemAvailable:) _ma=${_v:-0}; break ;;
        esac
    done < "$PROC/meminfo" 2>/dev/null
    case "${_mt:-}" in ''|*[!0-9]*) _mt=0 ;; esac
    case "${_ma:-}" in ''|*[!0-9]*) _ma=0 ;; esac
    MEM_TOTAL_KB=$_mt
    [ "$MA_START_KB" -eq 0 ] && MA_START_KB=$_ma
    MA_END_KB=$_ma
    MEM_OK=1
    return 0
}

# fork_count — the system-wide `processes` counter from /proc/stat.
#
# That counter cannot be attributed to the target: a cheaper cycle yields the CPU
# sooner, other processes get scheduled inside the window and their forks land in
# the same number (poller-cpu-profile.md records exactly that failure). It is
# reported as a rate against a measured pre-window baseline and labelled
# directional; the exact figure is cutime+cstime, not this.
fork_count() {
    _n=""
    while read -r _k _v _x _y _z; do
        case "${_k:-}" in processes) _n=${_v:-}; break ;; esac
    done < "$PROC/stat" 2>/dev/null
    case "${_n:-}" in ''|*[!0-9]*) return 1 ;; esac
    FORK_NOW=$_n
    return 0
}

# =============================================================================
# 6. Lease (--lease)
# =============================================================================
# The poller reads /tmp/qmanager_neighbours_live once per cycle and ticks while
# it holds an epoch 0..10 s old. Renewing every 2 s keeps it inside that window.
# The epoch is the start clock plus the /proc/uptime delta, so a 60 s run renews
# 30 times without a `date` fork (2.4 ms each on the RM520N-GL — more than the
# renewal itself costs).
lease_write() {
    [ "$DO_LEASE" = 1 ] || return 0
    [ $(( NOW_MS - _next_lease_ms )) -ge 0 ] || return 0
    _next_lease_ms=$(( NOW_MS + LEASE_RENEW_MS ))
    printf '%s\n' "$_epoch_now" > "$NEIGHBOURS_LEASE" 2>/dev/null || LEASE_ERROR=1
    return 0
}
lease_begin() {
    [ "$DO_LEASE" = 1 ] || return 0
    if [ -e "$NEIGHBOURS_LEASE" ]; then
        LEASE_PREEXISTED=1
    else
        LEASE_PREEXISTED=0
    fi
    : > "$NEIGHBOURS_LEASE" 2>/dev/null || die "cannot write $NEIGHBOURS_LEASE for --lease"
    chmod 0666 "$NEIGHBOURS_LEASE" 2>/dev/null
    [ "$LEASE_PREEXISTED" = 1 ] || LEASE_CREATED=1
    _epoch_now=$_start_epoch
    _next_lease_ms=$NOW_MS
    lease_write
    return 0
}
# Warm-up: the poller only consults the lease at a cycle boundary (~3.8 s), so a
# window that started immediately would spend its first cycle measuring the
# NON-live path. Wait until the poller's published live file changes under us.
lease_warmup() {
    [ "$DO_LEASE" = 1 ] || return 0
    [ -r "$NEIGHBOURS_LIVE" ] || return 0
    _sig1=""
    read -r _sig1 < "$NEIGHBOURS_LIVE" 2>/dev/null || true
    _waited=0
    while [ "$_waited" -lt 12000 ]; do
        sleep 1
        now_ms || return 1
        _epoch_now=$(( _start_epoch + (NOW_MS - _start_up_ms) / 1000 ))
        lease_write
        _waited=$(( _waited + 1000 ))
        _sig2=""
        read -r _sig2 < "$NEIGHBOURS_LIVE" 2>/dev/null || true
        if [ -n "$_sig2" ] && [ "$_sig2" != "$_sig1" ]; then
            LIVE_CONFIRMED=1
            return 0
        fi
    done
    return 1
}

# =============================================================================
# 7. Run
# =============================================================================
now_ms || die "cannot read $PROC/uptime"
_start_up_ms=$NOW_MS
_start_epoch=$(date +%s 2>/dev/null || echo "")
case "$_start_epoch" in ''|*[!0-9]*) _start_epoch=0 ;; esac
if [ "$DO_LEASE" = 1 ] && [ "$_start_epoch" = 0 ]; then
    die "--lease needs a working clock (date +%s returned nothing), so the lease epoch would always be stale"
fi
_epoch_now=$_start_epoch

snap || die "cannot parse $T_STAT"
SELF_OWN0=$SNAP_OWN
SELF_CHILD0=$SNAP_CHILD

# --- baseline fork rate: measured BEFORE the window --------------------------
if [ "$BASELINE_S" -gt 0 ] && fork_count; then
    _f0=$FORK_NOW
    now_ms; _u0=$NOW_MS
    sleep "$BASELINE_S"
    now_ms; _u1=$NOW_MS
    if fork_count; then
        _el=$(( _u1 - _u0 ))
        [ "$_el" -gt 0 ] || _el=1
        FORK_BASE_RATE=$(( (FORK_NOW - _f0) * 1000 / _el ))
        FORK_BASE_OK=1
    fi
fi

lease_begin
if [ "$DO_LEASE" = 1 ] && ! lease_warmup; then
    err "WARNING: --lease is held but $NEIGHBOURS_LIVE did not change in 12 s —"
    err "         the gated path may not be running. Is the target the poller,"
    err "         and does this install have the live block?"
fi

mem_sample
if fork_count; then _fw0=$FORK_NOW; fi
now_ms; _w0=$NOW_MS
WINDOW_TARGET_MS=$(( WANT_S * 1000 ))
_next_mem_ms=$(( NOW_MS + 1000 ))
_next_lease_ms=$NOW_MS
_epoch_now=$(( _start_epoch + (NOW_MS - _start_up_ms) / 1000 ))
lease_write

# --- the window --------------------------------------------------------------
while :; do
    sample_once || break
    SAMPLES=$(( SAMPLES + 1 ))

    now_ms || die "cannot read $PROC/uptime"
    _epoch_now=$(( _start_epoch + (NOW_MS - _start_up_ms) / 1000 ))
    lease_write
    if [ $(( NOW_MS - _next_mem_ms )) -ge 0 ]; then
        mem_sample
        _next_mem_ms=$(( NOW_MS + 1000 ))
    fi
    [ $(( NOW_MS - _w0 )) -ge "$WINDOW_TARGET_MS" ] && break
    sleep "$NAP"
done

now_ms; _w1=$NOW_MS
_epoch_now=$(( _start_epoch + (_w1 - _start_up_ms) / 1000 ))
lease_write
[ "$TARGET_GONE" = 1 ] && die "target pid $PID disappeared during the window"

snap || die "cannot parse $T_STAT at window end"
WIN_OWN=$(( SNAP_OWN - SELF_OWN0 ))
WIN_CHILD=$(( SNAP_CHILD - SELF_CHILD0 ))
WINDOW_MS=$(( _w1 - _w0 ))
[ "$WINDOW_MS" -gt 0 ] || WINDOW_MS=$WINDOW_TARGET_MS
OWN_MS=$(( WIN_OWN * TICK_MS ))
CHILD_MS=$(( WIN_CHILD * TICK_MS ))
TOTAL_MS=$(( OWN_MS + CHILD_MS ))
WINDOW_S10=$(( WINDOW_MS / 100 ))

# Self overhead: the instrument's own CPU over the whole run, children included
# (the `sleep` it forks once per sample is the bulk of it). Reported so the
# contamination is a number the reader can subtract, not a guess.
SELF_MS=0
_self_stat=""
read -r _self_stat < "$PROC/$$/stat" 2>/dev/null || true
case "$_self_stat" in *'('*')'*)
    _rest=${_self_stat##*)}
    set -f; set -- $_rest; set +f
    [ $# -ge 15 ] && SELF_MS=$(( ( ${12} + ${13} + ${14} + ${15} ) * TICK_MS ))
    ;;
esac

if fork_count; then
    FORK_AT_END=$FORK_NOW
    FORK_WIN_RATE=$(( ( FORK_AT_END - _fw0 ) * 1000 / WINDOW_MS ))
fi

# --- bucket aggregation ------------------------------------------------------
for _b in $BUCKETS; do eval "B_${_b}_ms=0; B_${_b}_forks=0"; done
ATTR_MS=0
for _key in $SEEN; do
    eval "_v=\${PCK_$_key:-0}"
    eval "_n=\${PNK_$_key:-other}"
    bucket_of "$_n"
    bucket_add "$BK" "$_v"
    ATTR_MS=$(( ATTR_MS + _v ))
done
UNATTR_MS=$(( CHILD_MS - ATTR_MS ))
OVER_ATTR_MS=0
if [ "$UNATTR_MS" -lt 0 ]; then
    # A child still running when the window closed has CPU counted here that the
    # parent has not reaped into cutime yet. Report it rather than hide it.
    OVER_ATTR_MS=$(( 0 - UNATTR_MS ))
    UNATTR_MS=0
fi
B_unattributed_ms=$UNATTR_MS
B_unattributed_forks=0
[ "$ATTR_OK" = 1 ] || { ATTR_MS=0; OVER_ATTR_MS=0; }

CPU_SOURCE="none"
if [ "$CPU_SOURCE_SS" = 1 ] && [ "$CPU_SOURCE_TICK" = 1 ]; then
    CPU_SOURCE="schedstat+ticks"
elif [ "$CPU_SOURCE_SS" = 1 ]; then
    CPU_SOURCE="schedstat"
elif [ "$CPU_SOURCE_TICK" = 1 ]; then
    CPU_SOURCE="ticks"
fi

pct1 "$ATTR_MS" "$CHILD_MS";    COVERAGE_PCT=$PCT
pct1 "$OWN_MS" "$WINDOW_MS";    OWN_PCT=$PCT
pct1 "$CHILD_MS" "$WINDOW_MS";  CHILD_PCT=$PCT
pct1 "$TOTAL_MS" "$WINDOW_MS";  TOTAL_PCT=$PCT
ratio1 "$CHILD_MS" "$OWN_MS";   RATIO_CO=$RATIO
pct1 "$SELF_MS" "$WINDOW_MS";   SELF_PCT=$PCT
pct1 "$SELF_MS" "$TOTAL_MS";    SELF_TGT_PCT=$PCT
ratio1 "$(( CHILD_SPAWNS * 1000 ))" "$WINDOW_MS"; SPAWNS_PS=$RATIO

LEASED="off"
[ "$DO_LEASE" = 1 ] && LEASED="held"
[ "$DO_LEASE" = 1 ] && [ "$LIVE_CONFIRMED" = 1 ] && LEASED="held+confirmed"

# =============================================================================
# 8. --compare
# =============================================================================
CMP_JSON=""
CMP_HUMAN=""
CMP_OK=0

compare_run() {
    [ -r "$CMP" ] || die "--compare: cannot read $CMP"
    command -v jq >/dev/null 2>&1 || die "--compare needs jq on PATH (deploy ships a static ARMv7 one under /usrdata/qmanager/bin)"

    _cf="$TMP/cmp.txt"
    # One jq call: a fork each, and this runs after the window so it is at least
    # not inside the measurement.
    jq -r '
        "meta schema \(.schema // "unknown")",
        "meta interval_ms \(.window.interval_ms // 0)",
        "meta seconds \(.window.seconds // 0)",
        "meta lease \(if (.lease.held // .lease // false) == true then "held" else "off" end)",
        "meta md5 \(.target.script_md5 // "")",
        "meta children_ms \(.cpu.children_ms // 0)",
        "meta own_ms \(.cpu.own_ms // 0)",
        ( (.buckets // {}) | to_entries[] |
          "bucket \(.key) \(.value.ms // 0) \(.value.pct // 0) \(.value.forks // 0)" )
    ' "$CMP" > "$_cf" 2>/dev/null || die "--compare: $CMP is not JSON this tool can read (check its .schema)"

    P_SCHEMA="unknown"; P_INTERVAL=0; P_SECONDS=0; P_LEASE="unknown"; P_MD5=""
    P_CHILDREN=0; P_OWN=0
    for _b in $BUCKETS; do eval "PB_${_b}_ms=0"; done
    PB_unattributed_ms=0

    while read -r _kind _a _c _d _e; do
        case "$_kind" in
            meta) case "$_a" in
                      schema)      P_SCHEMA=${_c:-unknown} ;;
                      interval_ms) P_INTERVAL=${_c:-0} ;;
                      seconds)     P_SECONDS=${_c:-0} ;;
                      lease)       P_LEASE=${_c:-unknown} ;;
                      md5)         P_MD5=${_c:-} ;;
                      children_ms) P_CHILDREN=${_c:-0} ;;
                      own_ms)      P_OWN=${_c:-0} ;;
                  esac ;;
            bucket)
                # The name comes from a file, so it is matched against the known
                # list before it is ever used as a shell variable name.
                case " $BUCKETS_ALL " in
                    *" $_a "*) eval "PB_${_a}_ms=\${_c:-0}" ;;
                esac ;;
        esac
    done < "$_cf"

    # Comparability gate. Every item here makes the two runs measure different
    # quantities, not a change — see docs/reference/profiling.md.
    _reasons=""
    [ "$P_SCHEMA" = "$SCHEMA" ] || _reasons="$_reasons schema($P_SCHEMA)"
    [ "${P_INTERVAL:-0}" = "$INTERVAL_MS" ] || _reasons="$_reasons interval(${P_INTERVAL}ms)"
    if [ "${P_SECONDS:-0}" -gt 0 ]; then
        _lo=$(( P_SECONDS * 9 / 10 )); _hi=$(( P_SECONDS * 11 / 10 ))
        if [ "$WANT_S" -lt "$_lo" ] || [ "$WANT_S" -gt "$_hi" ]; then
            _reasons="$_reasons window(${P_SECONDS}s)"
        fi
    fi
    [ "$P_LEASE" = "$LEASED" ] || _reasons="$_reasons lease($P_LEASE)"
    if [ -n "$P_MD5" ] && [ -n "$T_MD5" ] && [ "$P_MD5" != "$T_MD5" ]; then
        _reasons="$_reasons target_md5($P_MD5)"
    fi
    [ -n "$_reasons" ] || _reasons="none"

    _comparable="true"
    [ "$_reasons" = none ] || _comparable="false"
    CMP_JSON="\"baseline\": $(json_str "$CMP"), \"comparable\": $_comparable,"
    CMP_JSON="$CMP_JSON \"reasons\": $(json_str "$_reasons"), \"threshold_pct\": $THRESHOLD, \"floor_ms\": $FLOOR_MS,"
    CMP_JSON="$CMP_JSON \"buckets\": {"

    CMP_HUMAN="COMPARE  baseline=$CMP  (schema $P_SCHEMA)
  comparable: $([ "$_comparable" = true ] && echo yes || echo NO)
  reason:     $_reasons
  threshold:  ${THRESHOLD} % change, floor ${FLOOR_MS} ms
  bucket          before ms   after ms     delta   d %kids    verdict"

    _movers=""
    _nmov=0
    _first=1
    _curden=$CHILD_MS;  [ "$_curden" -gt 0 ] || _curden=1
    _befden=$P_CHILDREN; [ "$_befden" -gt 0 ] || _befden=1
    for _b in $BUCKETS_ALL; do
        eval "_cur=\$B_${_b}_ms"
        eval "_before=\$PB_${_b}_ms"
        _delta=$(( _cur - _before ))
        _chg=0
        [ "$_before" -gt 0 ] && _chg=$(( _delta * 100 / _before ))
        # Delta in points of child CPU, to one decimal: the unit the
        # "+6.7 points" figure was originally quoted in.
        _curx10=$(( _cur * 1000 / _curden ))
        _befx10=$(( _before * 1000 / _befden ))
        sign1 $(( _curx10 - _befx10 )); _dp=$SIG1

        _verdict="unchanged"
        if [ "$_before" -lt "$FLOOR_MS" ] && [ "$_cur" -lt "$FLOOR_MS" ]; then
            _verdict="small"
        elif [ "$_before" -le 0 ] && [ "$_cur" -ge "$FLOOR_MS" ]; then
            _verdict="new"
        elif [ "$_before" -ge "$FLOOR_MS" ] && [ "$_cur" -le 0 ]; then
            _verdict="gone"
        else
            _abs=$_chg; [ "$_abs" -lt 0 ] && _abs=$(( 0 - _abs ))
            if [ "$_abs" -ge "$THRESHOLD" ]; then
                if [ "$_delta" -gt 0 ]; then _verdict="regressed"; else _verdict="improved"; fi
            fi
        fi
        case "$_verdict" in
            regressed|improved|new|gone)
                _nmov=$(( _nmov + 1 ))
                _movers="$_movers $_b($_delta"ms")"
                ;;
        esac

        _dv=$_delta
        _dvs="+"; [ "$_dv" -lt 0 ] && { _dvs="-"; _dv=$(( 0 - _dv )); }
        _row=$(printf '  %-14s %9s %10s %9s %9s    %s' "$_b" "$_before" "$_cur" "$_dvs$_dv" "$_dp" "$_verdict")
        CMP_HUMAN="$CMP_HUMAN
$_row"

        [ "$_first" = 1 ] || CMP_JSON="$CMP_JSON, "
        _first=0
        CMP_JSON="$CMP_JSON $(json_str "$_b"): {\"before_ms\": $_before, \"after_ms\": $_cur, \"delta_ms\": $_delta, \"delta_pct_kids\": $_dp, \"change_pct\": $_chg, \"verdict\": $(json_str "$_verdict")}"
    done
    CMP_JSON="$CMP_JSON }, \"children_ms\": {\"before\": $P_CHILDREN, \"after\": $CHILD_MS, \"delta\": $(( CHILD_MS - P_CHILDREN ))}, \"own_ms\": {\"before\": $P_OWN, \"after\": $OWN_MS, \"delta\": $(( OWN_MS - P_OWN ))}"

    if [ "$_nmov" -gt 0 ]; then
        CMP_VERDICT="$_nmov bucket(s) moved at least ${THRESHOLD} % (floor ${FLOOR_MS} ms):${_movers}"
    else
        CMP_VERDICT="no bucket moved as much as ${THRESHOLD} % (floor ${FLOOR_MS} ms)"
    fi
    CMP_HUMAN="$CMP_HUMAN

  VERDICT: $CMP_VERDICT"
    CMP_JSON="$CMP_JSON, \"verdict\": $(json_str "$CMP_VERDICT")"
    CMP_OK=1
}

# =============================================================================
# 9. Emission
# =============================================================================
LOADAVG=""
read -r _l1 _l2 _l3 _lrest < "$PROC/loadavg" 2>/dev/null || true
LOADAVG="${_l1:-?}/${_l2:-?}/${_l3:-?}"
UP_S=""
read -r _up_s _lrest < "$PROC/uptime" 2>/dev/null || true
UP_S="${_up_s%%.*}"
BOOT_ID=""
read -r BOOT_ID < "$PROC/sys/kernel/random/boot_id" 2>/dev/null || true
CONDITIONS="target=$T_COMM pid=$PID lease=$LEASED seconds=$WANT_S interval=${INTERVAL_MS}ms samples=$SAMPLES loadavg=$LOADAVG uptime=${UP_S}s md5=${T_MD5:-none}"

emit_json() {
    _lease_bool="false"; [ "$DO_LEASE" = 1 ] && _lease_bool="true"
    _attr_bool="false";  [ "$ATTR_OK" = 1 ] && _attr_bool="true"
    _mem_bool="false";   [ "$MEM_OK" = 1 ] && _mem_bool="true"
    _caps_bool="false";  [ "$ATTR_CAPPED" = 1 ] && _caps_bool="true"
    _base_bool="false";  [ "$FORK_BASE_OK" = 1 ] && _base_bool="true"

    json_str "$T_COMM";         _comm_j=$JS
    json_str "$T_CMDLINE";      _cmd_j=$JS
    json_str "${T_MD5:-}";      _md5_j=$JS
    json_str "$CONDITIONS";     _cond_j=$JS
    json_str "${BOOT_ID:-}";    _boot_j=$JS

    # Pre-computed so no command substitution runs inside the printf argument
    # lists (each one is a subshell).
    pct1 "$S_RUN" "$SAMPLES";        _w_run=$PCT
    pct1 "$S_WAIT_CHILD" "$SAMPLES"; _w_wait=$PCT
    pct1 "$S_SLEEP" "$SAMPLES";      _w_sleep=$PCT
    pct1 "$S_DISK" "$SAMPLES";       _w_disk=$PCT
    pct1 "$S_OTHER" "$SAMPLES";      _w_other=$PCT

    printf '{\n'
    printf '  "schema": "%s",\n' "$SCHEMA"
    printf '  "generated_at": %s,\n' "$_start_epoch"
    printf '  "conditions": %s,\n' "$_cond_j"
    printf '  "boot_id": %s,\n' "$_boot_j"
    printf '  "target": {"service": "%s", "pid": %s, "comm": %s, "cmd": %s, "script_md5": %s},\n' \
        "$SERVICE" "$PID" "$_comm_j" "$_cmd_j" "$_md5_j"
    printf '  "window": {"seconds": %s, "interval_ms": %s, "samples": %s, "measured_ms": %s, "tick_ms": %s},\n' \
        "$WANT_S" "$INTERVAL_MS" "$SAMPLES" "$WINDOW_MS" "$TICK_MS"
    _conf_bool="false"; [ "$LIVE_CONFIRMED" = 1 ] && _conf_bool="true"
    printf '  "lease": {"held": %s, "confirmed": %s, "state": "%s"},\n' \
        "$_lease_bool" "$_conf_bool" "$LEASED"
    printf '  "cpu": {"own_ms": %s, "children_ms": %s, "total_ms": %s, "own_pct": %s, "children_pct": %s, "total_pct": %s, "children_per_own": "%s"},\n' \
        "$OWN_MS" "$CHILD_MS" "$TOTAL_MS" "$OWN_PCT" "$CHILD_PCT" "$TOTAL_PCT" "$RATIO_CO"
    printf '  "attribution": {"available": %s, "cpu_source": "%s", "covered_ms": %s, "coverage_pct": %s, "observed_spawns": %s, "spawns_per_s": %s, "interval_ms": %s, "over_attributed_ms": %s, "capped": %s},\n' \
        "$_attr_bool" "$CPU_SOURCE" "$ATTR_MS" "$COVERAGE_PCT" "$CHILD_SPAWNS" "$SPAWNS_PS" \
        "$INTERVAL_MS" "$OVER_ATTR_MS" "$_caps_bool"
    printf '  "buckets": {\n'
    _first=1
    for _b in $BUCKETS_ALL; do
        eval "_bm=\$B_${_b}_ms"
        eval "_bf=\$B_${_b}_forks"
        pct1 "$_bm" "$CHILD_MS";   _bp=$PCT
        pct1 "$_bm" "$WINDOW_MS";  _bc=$PCT
        [ "$_first" = 1 ] || printf ',\n'
        _first=0
        printf '    "%s": {"ms": %s, "pct": %s, "pct_core": %s, "forks": %s}' \
            "$_b" "$_bm" "$_bp" "$_bc" "$_bf"
    done
    printf '\n  },\n'
    printf '  "wall": {"samples": %s, "running": %s, "waiting_on_child": %s, "sleeping": %s, "disk_wait": %s, "other": %s, "running_pct": %s, "waiting_on_child_pct": %s, "sleeping_pct": %s, "disk_wait_pct": %s, "other_pct": %s},\n' \
        "$SAMPLES" "$S_RUN" "$S_WAIT_CHILD" "$S_SLEEP" "$S_DISK" "$S_OTHER" \
        "$_w_run" "$_w_wait" "$_w_sleep" "$_w_disk" "$_w_other"
    printf '  "wchan": {"none": %s, "do_wait": %s, "flock": %s, "nap": %s, "poll": %s, "read": %s, "other": %s},\n' \
        "$W_NONE" "$W_DO_WAIT" "$W_FLOCK" "$W_NAP" "$W_POLL" "$W_READ" "$W_OTHER"
    printf '  "children_wall": {"samples": %s, "running": %s, "sleeping": %s, "disk_wait": %s, "flock": %s},\n' \
        "$C_SAMPLES" "$C_RUN" "$C_SLEEP" "$C_DISK" "$C_FLOCK"
    printf '  "mem": {"available": %s, "rss_kb": %s, "rss_peak_kb": %s, "mem_total_kb": %s, "mem_available_start_kb": %s, "mem_available_end_kb": %s, "mem_available_delta_kb": %s},\n' \
        "$_mem_bool" "$RSS_KB" "$RSS_PEAK_KB" "$MEM_TOTAL_KB" "$MA_START_KB" "$MA_END_KB" \
        "$(( MA_END_KB - MA_START_KB ))"
    printf '  "forks": {"baseline_seconds": %s, "baseline_ok": %s, "baseline_per_s": %s, "window_per_s": %s, "delta_per_s": %s, "system_counter_at_end": %s, "observed_target_per_s": %s},\n' \
        "$BASELINE_S" "$_base_bool" "$FORK_BASE_RATE" "$FORK_WIN_RATE" \
        "$(( FORK_WIN_RATE - FORK_BASE_RATE ))" "$FORK_AT_END" "$SPAWNS_PS"
    printf '  "self_overhead": {"ms": %s, "pct_of_window": %s, "pct_of_target_total": %s}' \
        "$SELF_MS" "$SELF_PCT" "$SELF_TGT_PCT"
    if [ "$CMP_OK" = 1 ]; then
        printf ',\n  "compare": {%s}\n' "$CMP_JSON"
    else
        printf '\n'
    fi
    printf '}\n'
}

print_human() {
    pct1 "$S_RUN" "$SAMPLES";        _w_run=$PCT
    pct1 "$S_WAIT_CHILD" "$SAMPLES"; _w_wait=$PCT
    pct1 "$S_SLEEP" "$SAMPLES";      _w_sleep=$PCT
    pct1 "$S_DISK" "$SAMPLES";       _w_disk=$PCT
    pct1 "$S_OTHER" "$SAMPLES";      _w_other=$PCT

    say "qm-profiler ($SCHEMA) — $T_COMM (pid $PID)"
    say ""
    say "WINDOW"
    say "  requested      ${WANT_S} s at ${INTERVAL_MS} ms interval"
    say "  measured       $(( WINDOW_S10 / 10 )).$(( WINDOW_S10 % 10 )) s, $SAMPLES samples"
    say "  conditions     lease=$LEASED  loadavg=$LOADAVG  uptime=${UP_S}s"
    say "  target         ${T_SRC:-$T_CMDLINE}  md5=${T_MD5:-none}"
    say "  instrument     self ${SELF_MS} ms = ${SELF_PCT} % of one core (${SELF_TGT_PCT} % of the target's total)"
    say ""
    say "CPU  ($TICK_MS ms/tick; htop shows only the first line)"
    printf '  own   utime+stime   %6s ticks %9s ms %8s %% of one core\n' "$WIN_OWN" "$OWN_MS" "$OWN_PCT"
    printf '  kids  cutime+cstime %6s ticks %9s ms %8s %% of one core\n' "$WIN_CHILD" "$CHILD_MS" "$CHILD_PCT"
    printf '  total                        %9s ms %8s %% of one core\n' "$TOTAL_MS" "$TOTAL_PCT"
    printf '  kids:own ratio                   %5s x\n' "$RATIO_CO"
    say ""
    say "CHILD CPU BY PROGRAM NAME  (per-child clock: $CPU_SOURCE)"
    printf '  %-14s %9s %10s %10s %7s\n' "bucket" "ms" "%of kids" "%of core" "forks"
    for _b in $BUCKETS; do
        eval "_bm=\$B_${_b}_ms"
        eval "_bf=\$B_${_b}_forks"
        pct1 "$_bm" "$CHILD_MS";  _bp=$PCT
        pct1 "$_bm" "$WINDOW_MS"; _bc=$PCT
        printf '  %-14s %9s %9s %% %9s %% %7s\n' "$_b" "$_bm" "$_bp" "$_bc" "$_bf"
    done
    pct1 "$B_unattributed_ms" "$CHILD_MS";  _bp=$PCT
    pct1 "$B_unattributed_ms" "$WINDOW_MS"; _bc=$PCT
    printf '  %-14s %9s %9s %% %9s %% %7s\n' "unattributed" "$B_unattributed_ms" "$_bp" "$_bc" "-"
    say ""
    if [ "$ATTR_OK" = 1 ]; then
        say "  named ${COVERAGE_PCT} % of child CPU: ${CHILD_SPAWNS} spawns observed (${SPAWNS_PS}/s)"
        say "  over $SAMPLES samples at ${INTERVAL_MS} ms. A child that lives for less"
        say "  than the interval is invisible here and lands in 'unattributed'. That"
        say "  is a sampling limit, not a mystery."
        [ "$OVER_ATTR_MS" -gt 0 ] && say "  NOTE: attributed ${OVER_ATTR_MS} ms more than the parent had reaped — a child was still running at window close."
        [ "$ATTR_CAPPED" = 1 ] && say "  NOTE: the attribution table hit its ${KEY_CAP}-process cap; use a longer --interval or a shorter window."
    else
        say "  UNAVAILABLE: no /proc/<pid>/task/*/children on this kernel — only the"
        say "  own/children split above is exact."
    fi
    say ""
    say "WALL  ($SAMPLES samples, time-weighted by the sample interval)"
    printf '  running              %8s %%    waiting on a child   %8s %%\n' "$_w_run" "$_w_wait"
    printf '  sleeping (nap/poll)  %8s %%    disk wait (D)        %8s %%\n' "$_w_sleep" "$_w_disk"
    printf '  other                %8s %%\n' "$_w_other"
    printf '  wchan  do_wait %s  nap %s  poll %s  read %s  flock %s  none %s  other %s\n' \
        "$W_DO_WAIT" "$W_NAP" "$W_POLL" "$W_READ" "$W_FLOCK" "$W_NONE" "$W_OTHER"
    if [ "$C_SAMPLES" -gt 0 ]; then
        pct1 "$C_RUN" "$C_SAMPLES";   _c_run=$PCT
        pct1 "$C_SLEEP" "$C_SAMPLES"; _c_sleep=$PCT
        pct1 "$C_DISK" "$C_SAMPLES";  _c_disk=$PCT
        say "  children ($C_SAMPLES samples)  running ${_c_run} %  sleeping ${_c_sleep} %  disk-wait ${_c_disk} %  flock ${C_FLOCK}"
    fi
    say ""
    say "MEMORY"
    if [ "$MEM_OK" = 1 ]; then
        say "  VmRSS ${RSS_KB} kB (peak ${RSS_PEAK_KB} kB)   MemTotal $(( MEM_TOTAL_KB / 1024 )) MB"
        say "  MemAvailable $(( MA_START_KB / 1024 )) MB -> $(( MA_END_KB / 1024 )) MB  ($(( (MA_END_KB - MA_START_KB) / 1024 )) MB)"
    else
        say "  UNAVAILABLE: $T_STATUS or $PROC/meminfo unreadable"
    fi
    say ""
    say "FORKS  (system-wide counter — directional only, never attributable)"
    if [ "$FORK_BASE_OK" = 1 ]; then
        printf '  window %s/s   baseline %s/s over %s s   delta %s/s\n' \
            "$FORK_WIN_RATE" "$FORK_BASE_RATE" "$BASELINE_S" "$(( FORK_WIN_RATE - FORK_BASE_RATE ))"
    else
        printf '  window %s/s   baseline not measured\n' "$FORK_WIN_RATE"
    fi
    say "  target spawns ${SPAWNS_PS}/s observed (lower bound: only children still"
    say "  alive when the sampler looks are visible)."
    if [ "$CMP_OK" = 1 ]; then
        say ""
        printf '%s\n' "$CMP_HUMAN"
    fi
    say ""
    say "Read docs/reference/profiling.md before comparing this with any other run:"
    say "window, interval, lease state and target md5 all change these numbers."
}

if [ -n "$CMP" ]; then compare_run; fi

if [ "$JSON_ONLY" = 1 ]; then
    emit_json
    if [ -n "$SAVE" ]; then emit_json > "$SAVE" || die "cannot write $SAVE"; fi
else
    print_human
    if [ -n "$SAVE" ]; then
        emit_json > "$SAVE" || die "cannot write $SAVE"
        say ""
        say "saved: $SAVE"
    fi
fi

exit 0
