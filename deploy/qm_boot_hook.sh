#!/bin/sh
# =============================================================================
# qm_boot_hook.sh — make QManager actually start at boot on the O5A Pro
# =============================================================================
# WHY THIS EXISTS
#
# On this firmware, `systemctl enable` is not sufficient. PID 1 builds its
# initial boot transaction BEFORE the persistent /etc overlay (ubifs, bind-
# mounted over the read-only squashfs) is visible, so units that live in
# /etc/systemd/system are dropped from that transaction: they read as
# `enabled` but their ActiveEnterTimestamp stays empty after a real reboot.
#
# This is a known, documented characteristic of this device, not a QManager bug.
# The sibling product repo (greenpacket-o5a) hit it repeatedly — gp-v2,
# gp-sysctl, gp-led, gp-ttl, gp-pcidb and the /web bind-mount all "sat enabled"
# and never ran. Their conclusion, verbatim from /etc/init.d/turin_web.sh:
#
#     "this firmware drops units from the boot transaction"
#     "...PID 1 builds its initial boot transaction before that overlay's
#      masks and drop-ins are visible, so reload now and rerun cleanup"
#
# The one script confirmed to actually run at boot is /etc/init.d/turin_web.sh
# (ExecStart of turin_web.service, which ships in the read-only squashfs and is
# therefore in PID 1's transaction). Every GP service is started from there via
# the `start_service_async` helper defined in that script.
#
# So QManager joins that proven path. We INSERT a small block instead of
# shipping a whole copy of turin_web.sh: the file is owned and continuously
# edited by the product repo, and overwriting it would silently revert their
# boot work. Insertion is idempotent and anchored on the existing
# `systemctl daemon-reload` line, which must run first so our units are visible
# to systemd before we start them.
#
# USAGE
#   sh qm_boot_hook.sh          # apply (idempotent, backs up once)
#   sh qm_boot_hook.sh --check  # report without changing anything
#
# TOUCHES
#   /etc/init.d/turin_web.sh                    (inserts 3 lines)
#   /etc/init.d/turin_web.sh.pre-qmanager       (one-time backup, kept)
#
# FAILURE MODES
#   * Aborts without writing if the anchor line is absent (a future firmware or
#     product-repo rewrite) — safe: QManager simply stays manual-start.
#   * `sh -n` is run after patching; on failure the backup is restored.
#   * Only proves correct through a REAL reboot. `systemctl restart turin_web`
#     does not exercise the boot transaction.
# =============================================================================
set -u

TURIN=${TURIN:-/etc/init.d/turin_web.sh}
ANCHOR="systemctl daemon-reload"
MODE=${1:-apply}

# Units started at boot. Adding to this list is the ONLY change needed to bring
# a new QManager unit up at boot — the hook is additive, so an already-hooked
# device picks up the new line without losing the existing ones.
UNITS="qmanager-httpd.service qmanager-poller.service qmanager-ping.service
qmanager-dpi.service qmanager-dpi-ensure.timer qmanager-ippt.service"

[ -f "$TURIN" ] || { echo "ERROR: $TURIN not found" >&2; exit 1; }

# Already hooked? Only true when EVERY wanted unit is present. A previously
# hooked device is missing any unit added to $UNITS since, so this must not be a
# plain "does the marker exist" test (that made new units silently never start).
_all_present=true
for _u in $UNITS; do
    grep -q -- "start_service_async $_u\$" "$TURIN" 2>/dev/null || _all_present=false
done

if [ "$_all_present" = "true" ]; then
    echo "already hooked: $TURIN starts all of ($UNITS) at boot"
    exit 0
fi

if [ "$MODE" = "--check" ]; then
    echo "NOT fully hooked: $TURIN is missing one or more of ($UNITS)"
    exit 1
fi

grep -q -- "$ANCHOR" "$TURIN" || {
    echo "ERROR: anchor '$ANCHOR' not found in $TURIN — refusing to patch." >&2
    echo "       The product repo's boot script changed; re-derive the hook." >&2
    exit 1
}

# One-time backup: keep the PRISTINE pre-QManager script. Re-running the hook
# must not overwrite it with an already-hooked copy, or the rollback target
# silently becomes "the version with our lines in it".
if [ ! -f "$TURIN.pre-qmanager" ]; then
    cp -a "$TURIN" "$TURIN.pre-qmanager" || {
        echo "ERROR: could not back up $TURIN" >&2
        exit 1
    }
fi

# Buffer the file and emit with a single insertion point in END. An earlier
# version appended at the first matching line it saw, which meant `present[]`
# was only partly populated at that moment and every unit after the first got
# emitted a second time — measured on the device as duplicate
# start_service_async lines. Buffering makes the decision use the WHOLE file.
awk -v units="$UNITS" -v anchor="$ANCHOR" '
    BEGIN { n = split(units, want, " ") }

    {
        lines[NR] = $0
        if (index($0, "start_service_async qmanager-") == 1) {
            last_qm = NR
            for (i = 1; i <= n; i++)
                if ($0 == "start_service_async " want[i]) present[want[i]] = 1
        }
        if ($0 ~ ("^[[:space:]]*" anchor "[[:space:]]*$")) anchor_at = NR
    }

    END {
        if (!last_qm && !anchor_at) exit 3

        for (i = 1; i <= NR; i++) {
            print lines[i]

            if (last_qm) {
                # Re-run: append only the missing units, after the last existing
                # QManager line, so the block stays contiguous.
                if (i == last_qm)
                    for (j = 1; j <= n; j++)
                        if (!present[want[j]])
                            print "start_service_async " want[j]
            } else if (i == anchor_at) {
                # First run: systemd has already re-read the late-mounted /etc
                # overlay, so our units are visible before we start them.
                print ""
                print "# QManager (GreenPacket O5A Pro). This firmware drops units from PID 1"
                print "# boot transaction (see the notes inside /etc/init.d/turin_web.sh, and the"
                print "# greenpacket-o5a-qmanager repo), so enabled QManager units never start on"
                print "# their own. Join the one script confirmed to run at boot, exactly like"
                print "# gp-v2/gp-sysctl/gp-led above."
                for (j = 1; j <= n; j++)
                    print "start_service_async " want[j]
            }
        }
    }
' "$TURIN" > "$TURIN.new" || {
    _rc=$?
    rm -f "$TURIN.new"
    if [ "$_rc" = "3" ]; then
        echo "ERROR: anchor '$ANCHOR' not found in $TURIN — refusing to patch." >&2
        echo "       The product repo's boot script changed; re-derive the hook." >&2
    else
        echo "ERROR: awk insertion failed" >&2
    fi
    exit 1
}

if ! sh -n "$TURIN.new" 2>/dev/null; then
    echo "ERROR: patched script fails 'sh -n' — restoring backup" >&2
    rm -f "$TURIN.new"
    exit 1
fi

chmod 755 "$TURIN.new"
mv "$TURIN.new" "$TURIN"
echo "hooked: $TURIN now starts ($UNITS) at boot"
echo "        backup: $TURIN.pre-qmanager"
echo "        validating 'sh -n': OK"

if grep -q -- "start_service_async qmanager-ping.service" "$TURIN"; then
    echo "        (qmanager-ping = the Latency Monitor / reachability daemon)"
fi
if grep -q -- "start_service_async qmanager-dpi.service" "$TURIN"; then
    echo "        (qmanager-dpi + its ensure timer = Traffic Engine / QUIC rules;"
    echo "         the timer re-asserts the rules after QCMAP re-dials)"
fi
echo
echo "NOTE: only a real reboot proves this. After reboot, check:"
echo "  systemctl show -p ActiveEnterTimestamp --value qmanager-httpd qmanager-poller"
echo "and confirm it lands after the boot time (compare /proc/uptime)."
