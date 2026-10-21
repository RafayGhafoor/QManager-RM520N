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
MARK="qmanager-httpd.service"
ANCHOR="systemctl daemon-reload"
MODE=${1:-apply}

[ -f "$TURIN" ] || { echo "ERROR: $TURIN not found" >&2; exit 1; }

if grep -q -- "$MARK" "$TURIN" 2>/dev/null; then
    echo "already hooked: $TURIN starts QManager at boot"
    exit 0
fi

if [ "$MODE" = "--check" ]; then
    echo "NOT hooked: $TURIN has no QManager start lines"
    exit 1
fi

grep -q -- "$ANCHOR" "$TURIN" || {
    echo "ERROR: anchor '$ANCHOR' not found in $TURIN — refusing to patch." >&2
    echo "       The product repo's boot script changed; re-derive the hook." >&2
    exit 1
}

cp -a "$TURIN" "$TURIN.pre-qmanager" || {
    echo "ERROR: could not back up $TURIN" >&2
    exit 1
}

# Insert immediately AFTER the daemon-reload line, so systemd has re-read the
# late-mounted /etc overlay (and therefore knows our units) before we start
# them. start_service_async is defined earlier in the same script.
awk -v mark="$MARK" '
    { print }
    !done && $0 ~ /^[[:space:]]*systemctl daemon-reload[[:space:]]*$/ {
        print ""
        print "# QManager (GreenPacket O5A Pro). This firmware drops units from PID 1"
        print "# boot transaction (see the notes inside /etc/init.d/turin_web.sh, and the"
        print "# greenpacket-o5a-qmanager repo), so enabled QManager units never start on"
        print "# their own. Join the one script confirmed to run at boot, exactly like"
        print "# gp-v2/gp-sysctl/gp-led above."
        print "start_service_async qmanager-httpd.service"
        print "start_service_async qmanager-poller.service"
        done = 1
    }
' "$TURIN.pre-qmanager" > "$TURIN.new" || {
    echo "ERROR: awk insertion failed" >&2
    rm -f "$TURIN.new"
    exit 1
}

if ! sh -n "$TURIN.new" 2>/dev/null; then
    echo "ERROR: patched script fails 'sh -n' — restoring backup" >&2
    rm -f "$TURIN.new"
    exit 1
fi

chmod 755 "$TURIN.new"
mv "$TURIN.new" "$TURIN"
echo "hooked: $TURIN now starts qmanager-httpd + qmanager-poller at boot"
echo "        backup: $TURIN.pre-qmanager"
echo "        validating 'sh -n': OK"
echo
echo "NOTE: only a real reboot proves this. After reboot, check:"
echo "  systemctl show -p ActiveEnterTimestamp --value qmanager-httpd qmanager-poller"
echo "and confirm it lands after the boot time (compare /proc/uptime)."
