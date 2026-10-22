#!/bin/bash
# =============================================================================
# qm-poller-segprof.sh — per-SEGMENT CPU attribution of qmanager_poller's cycle
# =============================================================================
# WHAT IT ANSWERS
#   qm-profiler.sh says which PROGRAMS the poller's CPU goes to (jq, qcmd, ...).
#   This says which LINES of poll_cycle it goes to (ca_info_read 282 ms/cycle,
#   detect_events 211 ms/cycle, ...) — the breakdown an optimisation is aimed by.
#   It rebuilds the deleted qm_fork_probe.sh method described in
#   docs/reference/poller-cpu-profile.md "Method", with two differences:
#     * it uses the REAL qcmd (no record/replay stub), so the AT transport's own
#       cost lands on the segment that issued it — on the O5A that transport is
#       about half of the poller;
#     * so it must BE the poller for the window: the wrapper below stops
#       qmanager-poller.service and restarts it when the window ends.
#
# HOW
#   Sources the installed poller with `main "$@"` disabled, runs the same boot
#   sequence main() runs, then loops prof_poll_cycle — a COPY of poll_cycle with
#   a probe (_m LABEL) after each step. Probes are builtins only (/proc reads):
#     self = utime+stime of this shell, kids = cutime+cstime of reaped children,
#     wall = /proc/uptime, pid_d = /proc/loadavg last-pid delta (system-wide,
#     directional only). A Tier-N function that runs 1-in-N is amortised per
#     cycle in ms/cycle and shown raw in ms/call.
#   The `main_date_calls` row also carries this script's own report() cost
#   (~25 ms/cycle of self time) — subtract it before quoting a whole-cycle figure.
#
# ⚠️ prof_poll_cycle is a hand copy. When poll_cycle changes, update the copy or
#    the profile describes code that no longer exists.
#
# USAGE (on the device; writes only /tmp)
#   setsid nohup sh -c "systemctl stop qmanager-poller; \
#       bash /tmp/qm-poller-segprof.sh 720 >/tmp/qmprof.log 2>&1; \
#       systemctl start qmanager-poller" </dev/null >/dev/null 2>&1 &
#   cat /tmp/qmprof.txt        # rewritten every cycle; /tmp/qmprof.hb = progress
#   Use >= 600 s so Tier 2 / Tier 3 (1-in-15) are sampled several times.
# =============================================================================
DUR=${1:-600}
export PATH=/usrdata/qmanager/bin:/usr/bin:/bin:/sbin:/usr/sbin
SRC=/usrdata/qmanager/bin/qmanager_poller
OUT=/tmp/qmprof.txt
HB=/tmp/qmprof.hb

sed 's/^main "\$@"$/: main disabled by qmprof/' "$SRC" > /tmp/qmprof_poller.sh
. /tmp/qmprof_poller.sh

LABELS=""
_snap() {
    local l rest
    read -r l < /proc/$$/stat
    rest=${l##*) }
    set -f; set -- $rest; set +f
    _S=$(( ${12} + ${13} )); _K=$(( ${14} + ${15} ))
    read -r l < /proc/uptime; l=${l%% *}; _W=$(( ${l%.*} * 100 + 10#${l#*.} ))
    read -r l < /proc/loadavg; _P=${l##* }
}
_m_begin() { _snap; _s0=$_S; _k0=$_K; _w0=$_W; _p0=$_P; }
# _m LABEL — charge everything since the previous mark to LABEL, then re-mark.
_m() {
    _snap
    local L=$1
    case " $LABELS " in *" $L "*) ;; *) LABELS="$LABELS $L"; eval "S_$L=0 K_$L=0 W_$L=0 P_$L=0 N_$L=0" ;; esac
    eval "S_$L=\$((S_$L + _S - _s0)); K_$L=\$((K_$L + _K - _k0)); W_$L=\$((W_$L + _W - _w0)); P_$L=\$((P_$L + _P - _p0)); N_$L=\$((N_$L + 1))"
    _snap; _s0=$_S; _k0=$_K; _w0=$_W; _p0=$_P
}

report() {
    local L s k w p n tot_s=0 tot_k=0 tot_w=0
    for L in $LABELS; do eval "tot_s=\$((tot_s+S_$L)); tot_k=\$((tot_k+K_$L)); tot_w=\$((tot_w+W_$L))"; done
    {
    echo "qmprof: src=$SRC cycles=$cycle_count window_s=$(( (_W - RUN_W0) / 100 ))"
    echo "totals: self=${tot_s} kids=${tot_k} ticks (10ms)  wall=${tot_w}cs"
    echo "whole-run CPU of one core: $(( (tot_s+tot_k) * 1000 / ((_W - RUN_W0) > 0 ? (_W - RUN_W0) : 1) ))/1000"
    printf '%-26s %6s %8s %8s %9s %9s %9s %8s\n' label calls self_t kids_t ms/cycle ms/call wall_s pid_d/call
    for L in $LABELS; do
        eval "s=\$S_$L k=\$K_$L w=\$W_$L p=\$P_$L n=\$N_$L"
        printf '%-26s %6d %8d %8d %9d %9d %9d %8d\n' "$L" "$n" "$s" "$k" \
            $(( (s+k)*10 / (cycle_count>0?cycle_count:1) )) $(( (s+k)*10 / (n>0?n:1) )) $(( w/100 )) $(( p/(n>0?n:1) ))
    done
    } > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
}

# ---- mirror of poll_cycle with probes (logic identical to the installed one) ----
prof_poll_cycle() {
    if [ -f "$LONG_FLAG" ]; then
        local _lf_mtime _lf_now _lf_age
        _lf_mtime=$(stat -c %Y "$LONG_FLAG" 2>/dev/null || echo 0)
        _lf_now=$(date +%s)
        _lf_age=$((_lf_now - _lf_mtime))
        if [ "$_lf_age" -gt "$LONG_FLAG_MAX_AGE" ] 2>/dev/null; then
            rm -f "$LONG_FLAG"
        fi
    fi
    _m longflag_guard
    update_proc_metrics;            _m update_proc_metrics
    update_system_health;           _m update_system_health
    read_ping_data;                 _m read_ping_data
    read_dns_data;                  _m read_dns_data
    detect_data_connection_events;  _m detect_data_conn_events
    check_alerts;                   _m check_alerts

    if [ -f "$LONG_FLAG" ]; then
        system_state="scan_in_progress"
        if [ $((cycle_count % TIER1_5_EVERY)) -eq 0 ]; then append_ping_history; fi
        update_conn_uptime
        write_cache
        _m scan_in_progress_path
        return
    fi
    errors=""
    system_state="normal"

    poll_serving_cell;              _m poll_serving_cell
    sleep "$SIP_DELAY";             _m sip_sleep

    local ca_result
    ca_result=$(ca_info_read)
    local ca_rc=$?;                 _m ca_info_read
    if [ $ca_rc -eq 0 ] && [ -n "$ca_result" ]; then
        parse_ca_info "$ca_result"
    else
        t2_ca_active=false; t2_ca_count=0; t2_nr_ca_active=false; t2_nr_ca_count=0
        t2_total_bandwidth_mhz=0; t2_bandwidth_details=""; t2_carrier_components="[]"
    fi
    _m parse_ca_info
    sleep "$SIP_DELAY";             _m sip_sleep

    crash_watcher_check;            _m crash_watcher_check
    update_data_used;               _m update_data_used

    if [ $((cycle_count % TIER1_5_EVERY)) -eq 0 ]; then
        poll_per_antenna_signal;    _m poll_per_antenna_signal
        sleep "$SIP_DELAY";         _m sip_sleep
        read_watchcat_state;        _m read_watchcat_state
    fi

    force_tier2=false
    if [ -f "$TIER2_REFRESH_FLAG" ]; then force_tier2=true; rm -f "$TIER2_REFRESH_FLAG"; fi
    if [ "$force_tier2" = "true" ] || [ $((cycle_count % TIER2_EVERY)) -eq 0 ]; then
        poll_tier2;                 _m poll_tier2
        read_sim_state;             _m read_sim_state
        [ "$force_tier2" = "true" ] && read_sim_identity
        local cfun_result
        cfun_result=$(qcmd 'AT+CFUN?' 2>/dev/null)
        if [ -n "$cfun_result" ]; then
            local cfun_val
            cfun_val=$(printf '%s\n' "$cfun_result" | grep '+CFUN:' | head -1 | tr -d '\r' | awk -F': ' '{print $2}' | tr -d ' ')
            [ -n "$cfun_val" ] && t1_cfun="$cfun_val"
        fi
        _m cfun_query
        sleep "$SIP_DELAY";         _m sip_sleep
    fi

    if [ $((cycle_count % TIER1_5_EVERY)) -eq 0 ]; then
        append_ping_history;        _m append_ping_history
    fi
    update_conn_uptime;             _m update_conn_uptime
    determine_service_status;       _m determine_service_status
    detect_events;                  _m detect_events
    write_cache;                    _m write_cache
    cycle_count=$((cycle_count + 1))
}

# ---- boot (same order as main), unmeasured ----
orientation=$(detect_orientation_from_soc)
if [ "$orientation" = "reversed" ]; then orientation_dl_field=10; orientation_ul_field=2
else orientation_dl_field=2; orientation_ul_field=10; fi
collect_boot_data
update_proc_metrics
update_system_health
cq_thresholds_refresh
alert_engine_init
restore_event_state
crash_watcher_init
write_cache

_snap; RUN_W0=$_W; END_W=$(( _W + DUR * 100 ))
_m_begin
while :; do
    read -r _u _ur < /proc/uptime; c0=${_u%%.*};  _m main_date_calls
    prof_poll_cycle
    read -r _u _ur < /proc/uptime; c1=${_u%%.*};  _m main_date_calls
    if [ "$cycle_count" -gt 0 ] && [ $((cycle_count % TIER3_EVERY)) -eq 0 ]; then
        poll_tier3;                 _m poll_tier3
    fi
    neighbours_live_service;        _m neighbours_live_service
    sleep "$POLL_INTERVAL";         _m poll_interval_sleep
    report
    echo "$cycle_count $_W" > "$HB"
    [ "$_W" -ge "$END_W" ] && break
done
report
echo done >> "$HB"
