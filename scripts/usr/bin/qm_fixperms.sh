#!/bin/sh
# =============================================================================
# qm_fixperms — make the deployed code tree executable and root-owned
# =============================================================================
# Runs as ExecStartPre for the units that EXECUTE deployed files (poller, httpd).
#
# WHY THIS EXISTS (measured twice in 40 minutes on 2026-10-24)
#   The documented ship step is `tar czf - | ssh ... tar xzf -`, which runs as root
#   and therefore PRESERVES the archive's numeric uid/gid and modes. Built on
#   macOS, every file arrives as uid 501 and mode 0644 — including
#   qmanager_poller and the CGIs. The results were:
#     systemctl status qmanager-poller -> status=203/EXEC (Permission denied)
#     any CGI                          -> 404 from busybox httpd
#     the dashboard                    -> silent stale data
#   The deploy procedure now normalises after extracting (deploy/README.md), but a
#   deploy from another checkout that skips that step re-broke it twice while this
#   service was already running. A service that cannot start because a file lost
#   its exec bit should repair that itself, not wait for an operator to notice a
#   stale dashboard.
#
# WHAT IT DOES NOT DO
#   * It never touches /etc/qmanager (www-data-owned ON PURPOSE — the CGI writes
#     auth.json and profiles there; a blanket chown would take that away).
#   * It never changes file CONTENT. It cannot fix a config error, and it does not
#     try.
#   * It is silent and exit-0 when everything is already correct, so it costs one
#     fork per service start and nothing on the normal path.
#
# Cost: one fork, ~10 ms at service start. Not on any request path.
# =============================================================================
set -u

QM_ROOT=${QM_ROOT:-/usrdata/qmanager}
changed=0

log() { logger -t qm_fixperms "$*" 2>/dev/null || true; }

for d in "$QM_ROOT/bin" "$QM_ROOT/www/cgi-bin"; do
    [ -d "$d" ] || continue

    # Executable, root-owned. `find ... -exec chmod` rather than a glob so a
    # directory named like a script cannot be made executable by accident.
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        chmod 755 "$f" 2>/dev/null || continue
        [ "$(id -u)" -eq 0 ] && chown root:root "$f" 2>/dev/null
        changed=$((changed + 1))
    done <<EOF
$(find "$d" -type f ! -perm -u+x 2>/dev/null)
EOF

    # Ownership drift is reported but only corrected for root-run trees, where the
    # wrong owner can stop an exec on some firmware configurations.
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        [ "$(id -u)" -eq 0 ] || continue
        chown root:root "$f" 2>/dev/null && changed=$((changed + 1))
    done <<EOF
$(find "$d" -type f ! -user root 2>/dev/null)
EOF

    # macOS AppleDouble sidecars: never executable, never useful, and they confuse
    # anyone reading `ls` while debugging.
    find "$d" -name "._*" -type f -delete 2>/dev/null
done

[ "$changed" -gt 0 ] && log "repaired $changed file(s) under $QM_ROOT (a deploy skipped the normalisation step)"
exit 0
