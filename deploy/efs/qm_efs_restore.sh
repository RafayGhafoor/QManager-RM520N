#!/bin/sh
# qm_efs_restore.sh -- write EFS files/items back from a qm_efs_backup.sh tree.
#
# USAGE
#   qm_efs_restore.sh /tmp/efsbk/<ts>            # DRY RUN: diff only, no writes
#   qm_efs_restore.sh /tmp/efsbk/<ts> --apply    # write every file that differs
#   qm_efs_restore.sh /tmp/efsbk/<ts> --apply /nv/item_files/modem/mmode /policyman
#
# A dry run is the default on purpose: this is the tool you reach for when the
# modem is deaf, and a restore that runs blind is worse than no restore.
#
# SAFETY
#   * The helper refuses every write until it is started with -rw. This script
#     restarts it that way and says so, and refuses to continue if the session
#     did not come up writable.
#   * Item files (mode 0xE000) go back through PUT (`"item":true`, atomic);
#     ordinary files use OPEN/WRITE/CLOSE with the recorded mode.
#   * Every write is READ BACK and compared, so a silent modem-side rollback
#     (the EFS journal does that) is not mistaken for success.
#   * The file list is read from a temp file, not a pipe: a piped `while` runs in
#     a subshell and its counters vanish. (The first version of this script did
#     exactly that AND mis-parsed its own arguments, so its "0 differences" was
#     vacuous -- see docs/plans/2026-10-22-jazz-band-ca-tuning.md.)
set -u

BASE=${BASE:-/usrdata/qmanager/tools/efstest}
QJ=${QJ:-/usrdata/qmanager/bin/jq}
QRTR=${QRTR:-3:19}

SRC=${1:-}
[ -n "$SRC" ] || { echo "usage: $0 <backup-dir> [--apply] [path-filter...]" >&2; exit 2; }
shift
APPLY=0
if [ "${1:-}" = "--apply" ]; then APPLY=1; shift; fi
FILTER="$*"

[ -d "$SRC/tree" ] || { echo "$SRC has no tree/ -- not a backup dir" >&2; exit 2; }
command -v "$QJ" >/dev/null 2>&1 || QJ=jq
cd "$BASE" || exit 3

api() { ./efscli "$1"; }
ok()  { echo "$1" | $QJ -e '.ok == true' >/dev/null 2>&1; }

pidof qcom-efsd >/dev/null 2>&1 && kill "$(pidof qcom-efsd)" 2>/dev/null && sleep 1
if [ "$APPLY" = 1 ]; then
    nohup ./qcom-efsd -uid 0 -qrtr "$QRTR" -rw >/tmp/efsd.log 2>&1 &
    echo "helper started READ-WRITE (-rw) -- writes are live"
else
    nohup ./qcom-efsd -uid 0 -qrtr "$QRTR" >/tmp/efsd.log 2>&1 &
    echo "helper started read-only -- dry run"
fi
sleep 2

r=$(api '{"cmd":"open"}')
ok "$r" || { echo "EFS2 did not answer: $r" >&2; exit 4; }
echo "transport: $(echo "$r" | $QJ -r '.transport')  readonly: $(echo "$r" | $QJ -r '.readonly')"
if [ "$APPLY" = 1 ] && [ "$(echo "$r" | $QJ -r '.readonly')" != "false" ]; then
    echo "REFUSING: helper came up read-only, no write will be attempted" >&2
    exit 5
fi
[ -n "$FILTER" ] && echo "filter: $FILTER"

LIST=/tmp/.efs_restore_list.$$
COUNT=/tmp/.efs_restore_count.$$
( cd "$SRC/tree" && find . -type f 2>/dev/null | sort ) > "$LIST" 2>/dev/null
: > "$COUNT"

while read -r f; do
    efs="/${f#./}"
    case "$efs" in */.efs/*|*/.efs_private/*) continue ;; esac
    if [ -n "$FILTER" ]; then
        keep=0
        for p in $FILTER; do case "$efs" in "$p"|"$p"/*) keep=1 ;; esac; done
        [ "$keep" = 1 ] || continue
    fi

    cur=$(api "{\"cmd\":\"read\",\"path\":\"$efs\"}")
    # An empty file is a legitimate 0-byte read: `.data` is "" but `.ok` is true.
    # Testing for a non-empty .data would report every empty file as missing.
    if ! echo "$cur" | $QJ -e '.ok == true' >/dev/null 2>&1; then
        echo "UNREADABLE $efs :: $(echo "$cur" | head -c 120)"
        echo "unreadable" >> "$COUNT"
        continue
    fi
    curb64=$(echo "$cur" | $QJ -r '.data // ""' 2>/dev/null)
    locb64=$(base64 < "$SRC/tree/$f" | tr -d '\n')
    if [ "$curb64" = "$locb64" ]; then
        echo "same" >> "$COUNT"
        continue
    fi
    echo "DIFFERS $efs"
    echo "differs" >> "$COUNT"
    [ "$APPLY" = 1 ] || continue

    st=$(api "{\"cmd\":\"stat\",\"path\":\"$efs\"}")
    type=$(echo "$st" | $QJ -r '.type // "file"' 2>/dev/null)
    if [ "$type" = "item" ]; then
        res=$(api "{\"cmd\":\"write\",\"path\":\"$efs\",\"data\":\"$locb64\",\"item\":true}")
    else
        mode=$(echo "$st" | $QJ -r '.mode // 420' 2>/dev/null)
        res=$(api "{\"cmd\":\"write\",\"path\":\"$efs\",\"data\":\"$locb64\",\"mode\":$mode}")
    fi
    if ok "$res"; then
        back=$(api "{\"cmd\":\"read\",\"path\":\"$efs\"}" | $QJ -r '.data // empty' 2>/dev/null)
        if [ "$back" = "$locb64" ]; then
            echo "  wrote + verified $efs"
            echo "wrote" >> "$COUNT"
        else
            echo "  wrote but READ-BACK DIFFERS $efs"
            echo "verify-failed" >> "$COUNT"
        fi
    else
        echo "  WRITE FAILED $efs :: $(echo "$res" | head -c 160)"
        echo "write-failed" >> "$COUNT"
    fi
done < "$LIST"

same=$(grep -c '^same$' "$COUNT" 2>/dev/null)
differs=$(grep -c '^differs$' "$COUNT" 2>/dev/null)
unreadable=$(grep -c '^unreadable$' "$COUNT" 2>/dev/null)
wrote=$(grep -c '^wrote$' "$COUNT" 2>/dev/null)
wf=$(grep -c '^write-failed$' "$COUNT" 2>/dev/null)
vf=$(grep -c '^verify-failed$' "$COUNT" 2>/dev/null)
rm -f "$LIST" "$COUNT"

echo
echo "checked=$((same+differs+unreadable)) same=${same:-0} differs=${differs:-0} unreadable=${unreadable:-0}"
if [ "$APPLY" = 1 ]; then
    echo "wrote+verified=${wrote:-0} write-failed=${wf:-0} verify-failed=${vf:-0}"
    echo "then: systemctl restart qmanager-poller   # pick up the restored band/NV state"
else
    echo "dry run only. Re-run with --apply to write, or add path filters to narrow it."
fi
