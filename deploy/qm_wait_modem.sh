#!/bin/sh
# =============================================================================
# qm_wait_modem.sh — gate the QManager poller on real modem AT readiness
# =============================================================================
# WHY THIS EXISTS
#
# The poller collects device identity (model, firmware, IMEI, ...) ONCE at
# startup and caches it in /tmp/qmanager_status.json. If it starts before the
# modem's AT channel is live, the capture yields the boot-time unsolicited
# result code "RDY" instead of a model string, and that bogus value is then
# baked into the cache for the rest of the boot.
#
# Observed after a real reboot: `device.model` = "RDY", while a manual
# `atcli_smd11 AT+CGMM` a minute later correctly returned "RG520N-EB". So the
# device node existing is NOT sufficient evidence that the modem will answer —
# hence this gate, which waits for an actual parseable answer.
#
# USAGE
#   qm_wait_modem.sh [budget_seconds]     # default 150
#   exit 0 = modem answered; exit 1 = budget exhausted (systemd retries)
#
# Used as ExecStartPre= of qmanager-poller.service.
#
# FAILURE MODES
#   * Only checks the AT channel, not SIM state — QManager handles SIM states
#     itself, and a missing SIM is a normal, reported condition rather than a
#     reason to refuse to start.
#   * Goes through qcmd so the shared AT flock is honoured. Any manual
#     debugging of the modem on this device must do the same — calling
#     atcli_smd11 directly while the poller runs WILL corrupt its polls.
#   * Each AT call can take up to ~12s (the shim's own budget), so the wall
#     clock is checked every iteration rather than counting iterations.
#   * Exiting 1 after the budget is deliberate: the unit's Restart=on-failure
#     retries, and StartLimitBurst makes a genuinely dead modem fail loudly
#     instead of silently caching garbage.
# =============================================================================
set -u

BUDGET=${1:-${QM_MODEM_WAIT:-150}}
AT_DEV=${AT_DEV:-/dev/at_mdm0}
# Use qcmd, NOT atcli_smd11 directly. qcmd takes the shared AT flock
# (/tmp/qmanager_at.lock), so this gate serializes against the poller and CGI
# instead of stealing their response bytes. Calling atcli_smd11 directly here
# was measured corrupting live polls: syslog showed
#   qcmd_exec failed: cmd=AT+QENG="servingcell" exit=1
#   poll_cycle exceeded budget: 14s > 10s
# every time an out-of-band direct call overlapped a poll cycle.
ATCLI=${ATCLI:-/usrdata/qmanager/bin/qcmd}

deadline=$(( $(date +%s) + BUDGET ))

while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -c "$AT_DEV" ] && [ -x "$ATCLI" ]; then
        out=$("$ATCLI" 'AT+CGMM' 2>/dev/null | tr -d '\r')

        # Keep only a line that looks like a real modem answer. Drop blanks,
        # terminators and unsolicited result codes (URCs start with '+' or are
        # bare status words like RDY), all of which can appear before the modem
        # is ready to service commands.
        model=$(printf '%s\n' "$out" \
            | grep -v -e '^[[:space:]]*$' \
                      -e '^OK$' -e '^ERROR$' \
                      -e '^RDY$' -e '^CFUN:' -e '^SYSSTART$' \
                      -e '^+' \
            | head -1)

        # A usable model token contains at least one letter and one digit
        # (e.g. RG520N-EB). "Quectel" alone does not qualify, so we keep
        # waiting for the actual model line.
        case "$model" in
            *[0-9]*)
                if printf '%s' "$model" | grep -q '[A-Za-z]'; then
                    echo "modem ready: $model"
                    exit 0
                fi
                ;;
        esac
    fi

    sleep 2
done

echo "modem did not answer AT+CGMM within ${BUDGET}s (last: '${model:-none}')" >&2
exit 1
