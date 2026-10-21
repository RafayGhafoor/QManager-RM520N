#!/bin/sh
# =============================================================================
# qm_pathfix.sh — relocate QManager's hardcoded paths for this firmware
# =============================================================================
# Upstream QManager installs to /usr/lib/qmanager and /usr/bin, which on this
# device live on a READ-ONLY squashfs root and therefore cannot be written at
# all. Everything is deployed under /usrdata/qmanager instead (a writable ubifs
# volume, matching how WWW_ROOT already ships upstream).
#
# This rewrites only the paths QManager owns. Third-party binaries the scripts
# legitimately rely on (/usr/bin/timeout, /usr/bin/flock, /usr/bin/env, ...)
# are deliberately NOT touched.
# =============================================================================
set -u

QM_ROOT=/usrdata/qmanager

# QManager's own helper binaries (from scripts/usr/bin of the source tree).
QM_BINS="qcmd qcmd_test atcli_smd11 qmanager_auto_update qmanager_auto_update_arm
qmanager_band_failover qmanager_cell_scanner qmanager_cfun_fix qmanager_console_mgr
qmanager_crash_log_append qmanager_dpi_install qmanager_dpi_run qmanager_dpi_verify
qmanager_email_send qmanager_ethernet_apply qmanager_firewall qmanager_health_check
qmanager_imei_check qmanager_language_install qmanager_language_pack_apply
qmanager_logread qmanager_mtu_apply qmanager_neighbour_scanner qmanager_ping
qmanager_poller qmanager_profile_apply qmanager_reset_password
qmanager_scenario_schedule qmanager_scenario_schedule_arm qmanager_scheduled_reboot
qmanager_scheduled_reboot_arm qmanager_secret_set qmanager_set_ssh_password
qmanager_setup qmanager_sim_registry_apply qmanager_sites qmanager_sms_forward
qmanager_sms_storage qmanager_tailscale_mgr qmanager_timezone_apply
qmanager_tower_failover qmanager_tower_schedule qmanager_tower_schedule_arm
qmanager_update qmanager_watchcat
# Bundled third-party binary QManager calls by fixed path (wraps sms_tool.bin
# and defaults the device to /dev/smd7 — see deploy/sms_tool for why).
sms_tool sms_tool.bin atcli_smd11"

# Build one sed program: -e for the lib dir, then -e per owned binary.
#
# /lib/systemd/system -> /etc/systemd/system matters here: /lib is on the
# read-only squashfs, so no unit can ever be written there. On this firmware
# units live in the (ubifs-backed, writable) /etc/systemd/system, which systemd
# treats as higher priority anyway. Without this rewrite, every QManager feature
# that writes or probes a unit (scheduled reboot, scenarios, SMS forward,
# firewall, health check, console, auto-update) silently fails or reports
# "not installed" against a directory it can never write.
SEDARGS="-e s|/usr/lib/qmanager|$QM_ROOT/lib|g -e s|/lib/systemd/system|/etc/systemd/system|g"
for b in $QM_BINS; do
    SEDARGS="$SEDARGS -e s|/usr/bin/$b|$QM_ROOT/bin/$b|g"
done

patched=0
skipped=0

# Rewrite a file only if it actually is a text script (shebang) — never sed a
# binary such as jq, which would corrupt it.
patch_file() {
    f="$1"
    [ -f "$f" ] || return 0
    [ -L "$f" ] && return 0
    magic=$(head -c 2 "$f" 2>/dev/null)
    if [ "$magic" != "#!" ] && [ "${f##*.}" != "sh" ]; then
        skipped=$((skipped + 1))
        return 0
    fi
    if grep -q -e '/usr/lib/qmanager' -e '/usr/bin/qmanager_' -e '/lib/systemd/system' "$f" 2>/dev/null; then
        # shellcheck disable=SC2086
        sed -i $SEDARGS "$f" 2>/dev/null && patched=$((patched + 1))
    fi
}

echo "  rewriting backend libraries..."
for f in "$QM_ROOT"/lib/*.sh; do patch_file "$f"; done

echo "  rewriting helper binaries..."
for f in "$QM_ROOT"/bin/*; do patch_file "$f"; done

echo "  rewriting CGI endpoints..."
for f in $(find "$QM_ROOT/www/cgi-bin" -type f 2>/dev/null); do patch_file "$f"; done

echo "  patched=$patched skipped=$skipped"

# ---------------------------------------------------------------------------
# Ensure the relocated bin dir is on PATH so `jq`, `qcmd` and the helpers
# resolve for both CGI (inherits httpd env) and systemd-run services.
# PATH exports in the tree are of the form: export PATH="..."
# ---------------------------------------------------------------------------
for f in "$QM_ROOT"/lib/cgi_base.sh "$QM_ROOT"/lib/downloader.sh \
         "$QM_ROOT"/www/cgi-bin/quecmanager/at_cmd/speedtest_servers.sh \
         "$QM_ROOT"/www/cgi-bin/quecmanager/at_cmd/speedtest_start.sh; do
    [ -f "$f" ] || continue
    case "$(grep -m1 'export PATH=' "$f" 2>/dev/null)" in
        *"$QM_ROOT/bin"*) : ;;
        *'export PATH="'*)
            sed -i "s|export PATH=\"|export PATH=\"$QM_ROOT/bin:|" "$f" \
                && echo "  PATH -> $f"
            ;;
    esac
done

# ---------------------------------------------------------------------------
# State dirs QManager expects (created by the upstream installer).
# ---------------------------------------------------------------------------
for d in locales sites data; do
    mkdir -p "$QM_ROOT/$d"
done
echo "  state dirs ready"

# Make the web tree readable/traversable, CGI executable.
chmod -R a+rX "$QM_ROOT/www" 2>/dev/null
find "$QM_ROOT/www/cgi-bin" -type f -exec chmod 755 {} + 2>/dev/null
chmod 755 "$QM_ROOT"/lib/*.sh 2>/dev/null
chmod 755 "$QM_ROOT"/bin/* 2>/dev/null

echo "  done"
