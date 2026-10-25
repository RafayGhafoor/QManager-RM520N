#!/bin/sh
# =============================================================================
# qm_schedule_rearm.sh — bring the scheduled-feature timers back after a reboot
# =============================================================================
# WHY THIS EXISTS
#
# The Tower Lock schedule, the scheduled reboot, Connection Scenario schedules
# and the unattended update check all work the same way: a root arm helper
# (qmanager_*_arm) writes a systemd `.timer` into /etc/systemd/system at the
# moment the user saves, symlinks it into
# /etc/systemd/system/timers.target.wants/, and starts it for the current boot.
#
# On the O5A Pro that symlink does NOT survive into the boot transaction: same
# root cause as Hard rule 6 in AGENTS.md (PID 1 builds its initial transaction
# before the ubifs /etc overlay is visible). Measured 2026-10-25 on the live
# install: gp-tls-renew.timer has a symlink in
# /etc/systemd/system/timers.target.wants and reads **inactive** after boot,
# while every timer that turin_web.sh starts reads active with an
# ActiveEnterTimestamp equal to the boot second. So a schedule armed once would
# silently stop firing at the next reboot — the exact failure class
# docs/reference/scheduled-timers.md was written to kill (the crontab no-op),
# one layer down.
#
# So QManager re-arms from this script at boot, through the one path that is
# proven to run (deploy/qm_boot_hook.sh inserts it into turin_web.sh).
#
# WHAT COUNTS AS "ARMED"
#
# The symlink in timers.target.wants/, not the existence of the .timer: an
# auto-update "off" removes the symlink but leaves the unit behind, and a
# schedule turned off also leaves its generated timer on flash. Starting every
# timer that merely exists would resurrect schedules the user turned off.
#
# Idempotent, silent, never fails the boot: a timer that does not exist, or that
# systemd refuses to start, is skipped. Nothing here is on a hot path.
#
# TOUCHES: nothing writes; it only starts already-installed timers.
# =============================================================================
set -u

UNIT_DIR=/etc/systemd/system
WANTS_DIR=$UNIT_DIR/timers.target.wants

# Every runtime-armed QManager timer. Keep in step with the .timer names written
# by scripts/usr/bin/qmanager_{tower_schedule_arm,scheduled_reboot_arm,
# scenario_schedule_arm,auto_update_arm}.
TIMERS="qmanager-tower-schedule-apply.timer
qmanager-tower-schedule-clear.timer
qmanager-scheduled-reboot.timer
qmanager-scenario-schedule.timer
qmanager-auto-update.timer"

rearmed=
for _t in $TIMERS; do
    [ -f "$UNIT_DIR/$_t" ] || continue
    # Symlink present == the user has this feature armed.
    [ -L "$WANTS_DIR/$_t" ] || continue
    systemctl --no-block start "$_t" >/dev/null 2>&1 || continue
    rearmed="$rearmed $_t"
done

if [ -n "$rearmed" ]; then
    logger -t qmanager "schedule rearm: started$rearmed"
fi
exit 0
