#!/bin/sh
# =============================================================================
# qm_schedule_units.sh — install the units the scheduled features fire into
# =============================================================================
# Run ON THE DEVICE, from the directory holding these files (see
# deploy/README.md step 5e).
#
# WHY THIS IS A STEP OF ITS OWN
#
# Tower Lock Schedule, Scheduled Reboot, Connection Scenario schedules and the
# unattended update check share one mechanism: at save time a root helper
# (`qmanager_*_arm`) generates a `.timer` and starts it. Each of those helpers
# first checks that the oneshot `.service` it activates is present, and answers
# {"armed":false,"reason":"unit_absent"} if it is not — which the UI renders as
# "the scheduling service isn't installed on this device yet — update to the
# latest firmware". Until 2026-10-25 this deployment shipped none of those
# services, so all four features saved their config, reported that warning, and
# never fired. Measured on the live install: a save returned
# `{"success":true,"armed":false,"reason":"unit_absent"}` for both the tower
# schedule and the scheduled reboot.
#
# The units land in /etc/systemd/system, not the upstream /lib/systemd/system,
# because / is a read-only squashfs (Hard rule 1). Their ExecStart already
# points at /usrdata/qmanager/bin — qm_pathfix.sh cannot rewrite these files,
# since it only patches the deployed /usrdata tree.
#
# Idempotent: rewrites the same bytes every run. Safe to re-run after every
# redeploy.
# =============================================================================
set -u

DEST=/etc/systemd/system
SRC=${SRC:-$(dirname "$0")}

UNITS="qmanager-tower-schedule-apply.service
qmanager-tower-schedule-clear.service
qmanager-scheduled-reboot.service
qmanager-scenario-schedule.service
qmanager-auto-update.service
qmanager-auto-update.timer
qmanager-schedule-rearm.service"

rc=0
for u in $UNITS; do
    if [ ! -f "$SRC/$u" ]; then
        echo "  MISSING src: $SRC/$u" >&2
        rc=1
        continue
    fi
    cp -f "$SRC/$u" "$DEST/$u" || { rc=1; continue; }
    chmod 644 "$DEST/$u"
done

# The rearm script runs as ExecStart of qmanager-schedule-rearm.service.
if [ -f "$SRC/qm_schedule_rearm.sh" ]; then
    cp -f "$SRC/qm_schedule_rearm.sh" /usrdata/qmanager/bin/qm_schedule_rearm.sh &&
        chmod 755 /usrdata/qmanager/bin/qm_schedule_rearm.sh || rc=1
else
    echo "  MISSING src: $SRC/qm_schedule_rearm.sh" >&2
    rc=1
fi

systemctl daemon-reload 2>/dev/null || true

# Verify what systemd can actually see — a unit that is present but unparseable
# is worse than a missing one, because the arm helper's presence test passes and
# the timer then fails to fire.
for u in $UNITS; do
    if systemctl cat "$u" >/dev/null 2>&1; then
        echo "  ok  $u"
    else
        echo "  FAIL systemd cannot read $u" >&2
        rc=1
    fi
done

[ "$rc" -eq 0 ] && echo "schedule units installed" || echo "schedule units INCOMPLETE" >&2
exit "$rc"
