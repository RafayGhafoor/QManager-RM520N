#!/bin/sh
# qm_efs_backup.sh -- read-only backup of the modem's EFS2 tree over QRTR-DIAG.
#
# WHY THIS EXISTS
#   The modem's filesystem holds the policy XMLs, the MDB fragments and the
#   per-band NV items that decide which bands and CA/EN-DC combinations this
#   device may use, plus the RF calibration (rfnv). Nothing on the router could
#   read it until 2026-10-22: there is no /dev/diag, and AT+QNVFL is unsupported
#   so the tree cannot be listed over AT. The modem publishes DIAG on QRTR node
#   3 port 19 (MODEM:CMD) and EFS2 answers there.
#
#   This script only READS. Restoring is qm_efs_restore.sh, which needs the
#   helper started with -rw.
#
# OUTPUT (on the device, /tmp is tmpfs -- copy it off promptly)
#   /tmp/efsbk/<ts>/tree/         every EFS file, directory-shaped
#   /tmp/efsbk/<ts>/manifest.sha256
#   /tmp/efsbk/<ts>/state/        AT + QMI + poller-cache snapshots
#   /tmp/efsbk/<ts>.tar.gz
#
# SENSITIVE: the tree contains the IMEI, the module serial and the RF
# calibration. Never commit it, never paste it (AGENTS.md hard rule 10).
set -u

BASE=${BASE:-/usrdata/qmanager/tools/efstest}
QJ=${QJ:-/usrdata/qmanager/bin/jq}
QCMD=${QCMD:-/usrdata/qmanager/bin/qcmd}
QMI=${QMI:-/usrdata/qmanager/lib/qmi}
QRTR=${QRTR:-3:19}
TS=${1:-$(date +%Y%m%d-%H%M%S)}
OUT=/tmp/efsbk/$TS

[ -x "$BASE/efscli" ] || { echo "no efscli in $BASE -- see deploy/efs/README.md" >&2; exit 2; }
command -v "$QJ" >/dev/null 2>&1 || QJ=jq

mkdir -p "$OUT/tree" "$OUT/state" || exit 3
cd "$BASE" || exit 3

# The helper holds one DIAG session; reuse it if a previous run left it up.
if ! pidof qcom-efsd >/dev/null 2>&1; then
    nohup ./qcom-efsd -uid 0 -qrtr "$QRTR" >/tmp/efsd.log 2>&1 &
    sleep 2
fi

if [ "$(./efscli '{"cmd":"open"}' | $QJ -r '.ok' 2>/dev/null)" != "true" ]; then
    echo "helper is up but EFS2 does not answer (pinned $QRTR)" >&2
    exit 4
fi

echo "== EFS backup $TS (read-only, qrtr $QRTR) =="

# Enumerate "/" first. NOTE: the modem's directory cursor is not rewindable --
# never interrupt a listing, or the next one continues from the stale position
# and returns a short set that looks like a small tree.
./efscli '{"cmd":"ls","path":"/"}' > "$OUT/state/root.ls.json"
$QJ -r '.entries[]? | select(.type=="dir") | .name' "$OUT/state/root.ls.json" \
    | grep -v '^\.efs' > "$OUT/state/topdirs"

pulled=0
failed=0
while read -r d; do
    [ -n "$d" ] || continue
    r=$(./efscli "{\"cmd\":\"pull_tree\",\"path\":\"/$d\",\"out\":\"$OUT/tree/$d\",\"max_file\":8388608}")
    case "$r" in
        *'"ok":true'*) pulled=$((pulled+1)); printf '  /%s %s\n' "$d" "$(echo "$r" | $QJ -r '"files=\(.files) dirs=\(.dirs) bytes=\(.bytes) errors=\(.errors)"' 2>/dev/null)" ;;
        *) failed=$((failed+1)); printf '  /%s FAILED %s\n' "$d" "$(echo "$r" | head -c 160)" ;;
    esac
done < "$OUT/state/topdirs"

# Some EFS volumes legitimately cannot be listed (/nvm /safe /safe_oem /sfs
# answer "bad command"); that is why a non-zero `failed` is reported, not fatal.

( cd "$OUT/tree" && find . -type f 2>/dev/null | sort | xargs sha256sum > "$OUT/manifest.sha256" 2>/dev/null )
files=$(find "$OUT/tree" -type f 2>/dev/null | wc -l)
bytes=$(du -sk "$OUT/tree" 2>/dev/null | cut -f1)

# ---- state snapshot: what the modem says about itself right now -------------
{
    echo "# captured $TS"
    echo "## AT+QNWPREFCFG=\"lte_band\"";      $QCMD 'AT+QNWPREFCFG="lte_band"' 2>&1
    echo "## AT+QNWPREFCFG=\"ue_capability_band\""; $QCMD 'AT+QNWPREFCFG="ue_capability_band"' 2>&1
    echo "## AT+QNWLOCK=\"common/4g\"";        $QCMD 'AT+QNWLOCK="common/4g"' 2>&1
    echo "## AT+QNWLOCK=\"common/5g\"";        $QCMD 'AT+QNWLOCK="common/5g"' 2>&1
    echo "## AT+QCAINFO";                     $QCMD 'AT+QCAINFO' 2>&1
    echo "## AT+QENG=\"servingcell\"";        $QCMD 'AT+QENG="servingcell"' 2>&1
    echo "## AT+CGMM / CGMR";                 $QCMD 'AT+CGMM' 2>&1; $QCMD 'AT+CGMR' 2>&1
} > "$OUT/state/at.txt" 2>&1

{
    echo "## --nas-get-serving-system"
    LD_LIBRARY_PATH=$QMI/lib $QMI/bin/qmicli -d qrtr://3 --nas-get-serving-system 2>&1
    echo "## --nas-get-rf-band-info"
    LD_LIBRARY_PATH=$QMI/lib $QMI/bin/qmicli -d qrtr://3 --nas-get-rf-band-info 2>&1
    echo "## --nas-get-signal-info"
    LD_LIBRARY_PATH=$QMI/lib $QMI/bin/qmicli -d qrtr://3 --nas-get-signal-info 2>&1
} > "$OUT/state/qmi.txt" 2>&1

cp /tmp/qmanager_status.json "$OUT/state/qmanager_status.json" 2>/dev/null
{
    uname -a
    cat /proc/sys/kernel/random/boot_id
    uptime
    df -h /usrdata /tmp 2>/dev/null
} > "$OUT/state/system.txt" 2>&1

# ---- pack ------------------------------------------------------------------
( cd /tmp/efsbk && tar czf "$TS.tar.gz" "$TS" ) || exit 5

echo
echo "top-level dirs pulled=$pulled failed=$failed"
echo "files=$files size=${bytes}KiB"
echo "manifest: $(wc -l < "$OUT/manifest.sha256") hashed file(s)"
echo "archive : /tmp/efsbk/$TS.tar.gz  ($(du -k "/tmp/efsbk/$TS.tar.gz" | cut -f1)KiB)"
echo
echo "Copy it off the device now (tmpfs, and it holds the IMEI):"
echo "  ssh greenpacket 'cat /tmp/efsbk/$TS.tar.gz' > efs-backup-$TS.tar.gz"
