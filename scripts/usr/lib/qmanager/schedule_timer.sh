#!/bin/sh
# schedule_timer.sh — Shared OnCalendar line generator + input validation for
# the runtime-armed systemd timers that replace RM520N's dead crond.
#
# RM520N-GL ships a crond BINARY but no daemon runs it (no unit, no boot
# symlink, empty world-writable /var/spool/cron/crontabs/) — so any feature
# that used to printf a cron line was silently a no-op. Scheduled Reboot and
# the Tower Lock schedule both need a single fixed "day-mask + HH:MM,
# recurring weekly" trigger — simpler than the Connection Scenario schedule's
# multi-block/default-restore timeline (see scenario_mgr.sh's
# _scenario_generate_oncalendar_lines, which solves a materially different
# problem and is intentionally NOT reused here — see the arm helpers' headers
# for why duplicating that algorithm would be over-fitting a one-line need).
#
# Sourced by the arm helpers (validation/generation) AND by the fire workers
# (fire guard) — qmanager_scheduled_reboot_arm, qmanager_tower_schedule_arm
# for validation/generation, and qmanager_scheduled_reboot,
# qmanager_tower_schedule, qmanager_scenario_schedule, qmanager_auto_update
# for the fire guard below. Never sourced by a CGI script directly. The arm
# helpers are sudo-reachable from www-data, so every value passed to
# _qm_oncalendar_line MUST be validated with _qm_validate_hhmm /
# _qm_validate_days FIRST — this library does not re-validate internally.

[ -n "$_SCHEDULE_TIMER_LOADED" ] && return 0
_SCHEDULE_TIMER_LOADED=1

# _qm_validate_hhmm <value>
# Charset-gate THEN shape-check a caller-supplied time-of-day value before it
# is ever interpolated into a generated .timer unit's OnCalendar= line.
#
# TWO gates, in order:
#   1. Charset reject: '*[!0-9:]*' rejects ANY byte outside [0-9:] anywhere
#      in the value — including whitespace, shell metacharacters, and a
#      NEWLINE. This bracket-negation form matches across the whole string
#      (case pattern matching, not line-based regex), so a value whose FIRST
#      line looks like "04:00" but carries a smuggled newline + extra
#      OnCalendar=/ExecStart=/etc. directive on a second line is still
#      caught — an anchored regex (`grep -Eq '^...$'`) would not catch it.
#   2. Shape check: strict HH:MM, hour 00-23 then minute 00-59.
# Returns 0 (valid) or 1 (reject).
_qm_validate_hhmm() {
    case "$1" in
        ''|*[!0-9:]*) return 1 ;;
    esac
    case "$1" in
        [01][0-9]:[0-5][0-9]|2[0-3]:[0-5][0-9]) return 0 ;;
        *) return 1 ;;
    esac
}

# _qm_validate_days <csv>
# Same two-gate treatment for a comma-separated day mask (0=Sun..6=Sat).
#   1. Charset reject: '*[!0-9,]*' — anything outside digits and commas,
#      including a newline, is rejected outright.
#   2. Shape check: every comma-split token must be a single digit 0-6.
# Returns 0 (valid) or 1 (reject).
_qm_validate_days() {
    case "$1" in
        ''|*[!0-9,]*) return 1 ;;
    esac
    local d
    for d in $(printf '%s' "$1" | tr ',' ' '); do
        case "$d" in
            0|1|2|3|4|5|6) ;;
            *) return 1 ;;
        esac
    done
    return 0
}

# _qm_oncalendar_line <days_csv> <HH:MM>
# Renders "OnCalendar=<Dow[,Dow...]> HH:MM:00" for a single recurring weekly
# trigger. Caller MUST have already passed both arguments through
# _qm_validate_days / _qm_validate_hhmm — this function does not re-validate.
# Prints nothing (empty result) if the day list resolves to zero valid days,
# so callers can treat an empty return as "no schedule" and tear down instead
# of arming a .timer with a config-error empty OnCalendar= line.
_qm_oncalendar_line() {
    local days="$1" time="$2" hh mm d n names
    hh=$(printf '%s' "$time" | cut -d: -f1)
    mm=$(printf '%s' "$time" | cut -d: -f2)
    names=""
    for d in $(printf '%s' "$days" | tr ',' ' '); do
        n=""
        case "$d" in
            0) n="Sun" ;;
            1) n="Mon" ;;
            2) n="Tue" ;;
            3) n="Wed" ;;
            4) n="Thu" ;;
            5) n="Fri" ;;
            6) n="Sat" ;;
        esac
        [ -z "$n" ] && continue
        case ",$names," in
            *",$n,"*) ;;                          # already present — de-dupe
            *) names="${names:+$names,}$n" ;;
        esac
    done
    [ -z "$names" ] && return 0
    printf 'OnCalendar=%s %s:%s:00\n' "$names" "$hh" "$mm"
}

# --- Timezone: local time-of-day -> UTC OnCalendar line ----------------------
# systemd evaluates OnCalendar= in the SYSTEM timezone, and on this device that
# is **UTC**: QManager's only timezone channel here is the POSIX TZ string in
# /etc/qmanager/tz.posix (mirrored to /etc/TZ), which affects PROCESSES only.
# systemd reads /etc/localtime, and there is no tzdata on this firmware to
# install one from (see docs/reference/timezone.md), so `timedatectl` reports
# `Time zone: UTC` while the UI and the logs are on the configured zone.
#
# Consequence, measured 2026-10-25: a Tower Lock schedule saved as 08:00 (local,
# PKT-5) was armed as `OnCalendar=… 08:00:00` and fired at 13:00 local. So every
# LOCAL time-of-day that reaches a timer is translated to UTC here before it
# becomes an OnCalendar= line, and the fire guard below compares against LOCAL
# now — the two must agree or the guard denies a fire that did happen.
#
# The offset is read live from libc (`TZ=<posix> date +%z`) instead of being
# parsed out of the POSIX string, so DST zones get the offset in force now. That
# offset is baked into the generated .timer, so a DST transition leaves an armed
# schedule one hour off until its next save or reboot; the arm helpers report
# `tz_offset_min` so the armed offset is visible. Fixed-offset zones (the normal
# case here, e.g. PKT-5) are exact indefinitely.

# _qm_posix_tz — the configured POSIX TZ string, or empty if unset.
# QM_TZ_POSIX overrides (test hook, like QM_TEST_NOW_HHMM below).
_qm_posix_tz() {
    if [ -n "$QM_TZ_POSIX" ]; then
        printf '%s' "$QM_TZ_POSIX"
        return 0
    fi
    cat /etc/qmanager/tz.posix 2>/dev/null
}

# _qm_local_date <date-format> — the configured zone's clock (NOT UTC).
_qm_local_date() {
    local tz
    tz=$(_qm_posix_tz)
    if [ -n "$tz" ]; then
        TZ="$tz" date +"$1"
    else
        date +"$1"
    fi
}

# _qm_utc_offset_minutes — local minus UTC, in minutes, east positive.
# Prints 0 when the offset cannot be established (fails safe to the old
# UTC-as-local behaviour rather than arming nothing).
_qm_utc_offset_minutes() {
    local tz z
    tz=$(_qm_posix_tz)
    if [ -n "$tz" ]; then
        z=$(TZ="$tz" date +%z 2>/dev/null)
    else
        z=$(date +%z 2>/dev/null)
    fi
    case "$z" in
        [+-][0-9][0-9][0-9][0-9]) ;;
        *) printf '0'; return 0 ;;
    esac
    printf '%s' "$z" | awk '{
        s = (substr($0,1,1) == "-") ? -1 : 1
        print s * ((substr($0,2,2) + 0) * 60 + (substr($0,4,2) + 0))
    }'
}

# _qm_local_to_utc <days_csv> <HH:MM>
# Prints "<utc-days-csv> <HH:MM>", or fails if the offset is unusable.
# The day mask ROTATES when the boundary crosses midnight: local 02:00 in a
# UTC+5 zone is 21:00 the PREVIOUS day, so "Mon 02:00" must become
# "OnCalendar=Sun 21:00:00". Missing that is the subtle half of this fix — the
# timer would fire on the right clock time on the wrong day.
_qm_local_to_utc() {
    local days="$1" time="$2" off total shift udays d nd
    case "$time" in
        [01][0-9]:[0-5][0-9]|2[0-3]:[0-5][0-9]) ;;
        *) return 1 ;;
    esac
    off=$(_qm_utc_offset_minutes)
    case "$off" in
        ''|*[!0-9-]*) return 1 ;;
    esac
    total=$(printf '%s' "$time" | awk -F: -v off="$off" '{print $1*60+$2-off}')
    case "$total" in
        ''|*[!0-9-]*) return 1 ;;
    esac
    shift=0
    if [ "$total" -lt 0 ]; then
        total=$((total + 1440)); shift=-1
    elif [ "$total" -ge 1440 ]; then
        total=$((total - 1440)); shift=1
    fi
    udays="$days"
    if [ "$shift" -ne 0 ]; then
        udays=""
        for d in $(printf '%s' "$days" | tr ',' ' '); do
            case "$d" in
                0|1|2|3|4|5|6) ;;
                *) return 1 ;;
            esac
            nd=$(( (d + shift + 7) % 7 ))
            case ",$udays," in
                *",$nd,"*) ;;
                *) udays="${udays:+$udays,}$nd" ;;
            esac
        done
        [ -z "$udays" ] && return 1
    fi
    printf '%s %02d:%02d' "$udays" $((total / 60)) $((total % 60))
}

# _qm_utc_oncalendar_line <days_csv> <local HH:MM>
# Translate then render — the drop-in replacement for _qm_oncalendar_line at
# every arm-helper call site. Empty output keeps the "no schedule" contract.
_qm_utc_oncalendar_line() {
    local conv
    conv=$(_qm_local_to_utc "$1" "$2") || return 0
    [ -z "$conv" ] && return 0
    _qm_oncalendar_line "${conv%% *}" "${conv##* }"
}

# _qm_utc_oncalendar_rewrite — reads rendered "OnCalendar=<days> HH:MM:00"
# lines on stdin and writes the UTC equivalents. Used for the Connection
# Scenario generator, whose timeline maths is a per-weekday jq reduce and must
# stay in local time; the device offset is a constant, so rotating each
# rendered line afterwards is equivalent to converting before the reduce.
#
# The day names are mapped to 0-6 first and back afterwards, because
# _qm_local_to_utc speaks the numeric mask — feeding it "Tue" silently matched
# nothing and the line came back unchanged (caught 2026-10-25 by the
# `Tue 02:00` case, which is the one that needs a day rotation).
_qm_utc_oncalendar_rewrite() {
    local line rest days hms hhmm conv d nd nums out
    while IFS= read -r line; do
        case "$line" in
            OnCalendar=*) ;;
            *) printf '%s\n' "$line"; continue ;;
        esac
        rest=${line#OnCalendar=}
        case "$rest" in
            *" "*) ;;
            *) printf '%s\n' "$line"; continue ;;
        esac
        days=${rest%% *}
        hms=${rest##* }
        hhmm=${hms%:*}
        nums=""
        for d in $(printf '%s' "$days" | tr ',' ' '); do
            case "$d" in
                Sun) nd=0 ;; Mon) nd=1 ;; Tue) nd=2 ;; Wed) nd=3 ;;
                Thu) nd=4 ;; Fri) nd=5 ;; Sat) nd=6 ;;
                *) nums=""; break ;;
            esac
            nums="${nums:+$nums,}$nd"
        done
        [ -z "$nums" ] && { printf '%s\n' "$line"; continue; }
        conv=$(_qm_local_to_utc "$nums" "$hhmm") || { printf '%s\n' "$line"; continue; }
        [ -z "$conv" ] && { printf '%s\n' "$line"; continue; }
        out=""
        for d in $(printf '%s' "${conv%% *}" | tr ',' ' '); do
            case "$d" in
                0) nd=Sun ;; 1) nd=Mon ;; 2) nd=Tue ;; 3) nd=Wed ;;
                4) nd=Thu ;; 5) nd=Fri ;; 6) nd=Sat ;; *) nd="" ;;
            esac
            [ -z "$nd" ] && continue
            case ",$out," in
                *",$nd,"*) ;;
                *) out="${out:+$out,}$nd" ;;
            esac
        done
        [ -z "$out" ] && { printf '%s\n' "$line"; continue; }
        printf 'OnCalendar=%s %s:00\n' "$out" "${conv##* }"
    done
}

# --- Fire guard (issue #9: 1970 clock-step spurious fire) --------------------
# See docs/reference/scheduled-timers.md ("The 1970 boot window"). Test hooks:
# QM_TIMER_GUARD_BYPASS, QM_TEST_YEAR, QM_TEST_UPTIME, QM_TEST_NOW_HHMM, QM_TEST_DOW.

# _qm_clock_sane
# 0 iff the wall-clock year is numeric and >= 2025; fails closed otherwise.
# Read in the CONFIGURED zone: on 31 Dec a UTC year is already next year.
_qm_clock_sane() {
    local y
    if [ -n "$QM_TEST_YEAR" ]; then
        y="$QM_TEST_YEAR"
    else
        y=$(_qm_local_date %Y)
    fi
    case "$y" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$y" -ge 2025 ]
}

# _qm_boot_settled
# 0 iff uptime >= ${QM_TIMER_SETTLE_SECS:-300}s — past the ~24-29s misfire window.
_qm_boot_settled() {
    local up
    if [ -n "$QM_TEST_UPTIME" ]; then
        up="$QM_TEST_UPTIME"
    else
        up=$(awk '{print int($1)}' /proc/uptime)
    fi
    case "$up" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$up" -ge "${QM_TIMER_SETTLE_SECS:-300}" ]
}

# _qm_today_in_days <days_csv> (0=Sun..6=Sat, honours QM_TEST_DOW)
# Fails closed on a non-numeric/missing "today".
# LOCAL weekday, because the arm helper rotated the day mask into UTC when it
# rendered OnCalendar= — the worker still holds the user's LOCAL mask.
_qm_today_in_days() {
    local days="$1" today d
    if [ -n "$QM_TEST_DOW" ]; then today="$QM_TEST_DOW"; else today=$(_qm_local_date %w); fi
    case "$today" in ''|*[!0-9]*) return 1 ;; esac
    for d in $(printf '%s' "$days" | tr ',' ' '); do
        [ "$d" = "$today" ] && return 0
    done
    return 1
}

# _qm_now_matches_hhmm <HH:MM> [tolerance-min]
# 0 iff now is within tolerance (default 10min) of HH:MM, wrapping midnight;
# uses awk (not $(( )) — zero-padded HH:MM parses as octal in ash).
# "now" is the CONFIGURED zone's clock: the .timer fires at the UTC equivalent
# (the arm helpers translate it), while the value passed in here is the user's
# local HH:MM.
_qm_now_matches_hhmm() {
    local sched="$1" tol="${2:-10}" now sched_min now_min d
    case "$sched" in
        [01][0-9]:[0-5][0-9]|2[0-3]:[0-5][0-9]) ;;
        *) return 1 ;;
    esac
    if [ -n "$QM_TEST_NOW_HHMM" ]; then
        now="$QM_TEST_NOW_HHMM"
    else
        now=$(_qm_local_date %H:%M)
    fi
    case "$now" in
        [01][0-9]:[0-5][0-9]|2[0-3]:[0-5][0-9]) ;;
        *) return 1 ;;
    esac
    sched_min=$(printf '%s' "$sched" | awk -F: '{print $1*60+$2}')
    now_min=$(printf '%s' "$now" | awk -F: '{print $1*60+$2}')
    case "$sched_min" in ''|*[!0-9]*) return 1 ;; esac
    case "$now_min" in ''|*[!0-9]*) return 1 ;; esac
    d=$((now_min - sched_min))
    [ "$d" -lt 0 ] && d=$((-d))
    [ "$d" -gt 720 ] && d=$((1440 - d))
    [ "$d" -le "$tol" ]
}

# _qm_timer_fire_allowed <HH:MM-or-empty> [days_csv]
# Allowed iff clock is sane AND uptime has settled AND (no schedule minute
# given, or now matches it) AND (no day mask given, or today is in it). An
# empty sched still passes — scenario/auto-update legitimately have none.
# QM_TIMER_GUARD_BYPASS=1 short-circuits to allow (test/manual only).
_qm_timer_fire_allowed() {
    local sched="$1" days="$2"
    [ "$QM_TIMER_GUARD_BYPASS" = "1" ] && return 0
    _qm_clock_sane || return 1
    _qm_boot_settled || return 1
    if [ -n "$days" ]; then
        _qm_today_in_days "$days" || return 1
    fi
    if [ -z "$sched" ]; then
        return 0
    fi
    _qm_now_matches_hhmm "$sched"
}
