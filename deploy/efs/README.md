# `deploy/efs/` — read, back up and restore the modem's EFS2 filesystem

The modem's internal filesystem (EFS2) holds the policy XMLs, the MDB fragments,
the per-band NV items and the RF calibration. On this device it is reachable only
over **DIAG on QRTR** — there is no `/dev/diag`, and `AT+QNVFL` is unsupported, so
the tree cannot be listed over AT at all.

Nothing here is QManager app code; these are operator tools for the deployment.

| File | What it is |
| --- | --- |
| `efscli.c` | one-shot client for the helper's `@qcom_efsd` abstract socket (the device has no Android app and no Python to drive it) |
| `qm_efs_backup.sh` | read-only backup: full `pull_tree`, sha256 manifest, AT/QMI/poller state snapshot, `tar.gz` |
| `qm_efs_restore.sh` | **dry-run by default**; `--apply` writes files/items back and re-reads each one to verify |

## The upstream helper

The transport is [`catxeon/qcom-efs-browser`](https://github.com/catxeon/qcom-efs-browser)'s
`daemon/` — `qcom-efsd`, ~3,200 lines of C, no dependencies. **It is not
committed** (AGENTS hard rule 9): build it, or drop a prebuilt one at
`/usrdata/qmanager/tools/efstest/qcom-efsd`.

```sh
# upstream ships aarch64 + Android bionic. This box is armv7l / glibc 2.31,
# so rebuild statically with musl -- zig needs no separate toolchain:
zig cc -target arm-linux-musleabihf -Os -static \
    -o qcom-efsd daemon/src/util.c daemon/src/diag.c daemon/src/efs2.c daemon/src/main.c
zig cc -target arm-linux-musleabihf -Os -static -o efscli efscli.c
```

## Two device facts the tools encode, both measured 2026-10-22

1. **Pin the modem's DIAG port: `-qrtr 3:19`.** The stock helper scans QRTR for
   service 4097 and connects to the *first* match — node 2 port 16403, which is
   `diag-router`'s aggregate and **never answers EFS2** (`open` times out). The
   modem publishes its own DIAG on node 3: port **19** = `MODEM:CMD` (EFS2 works
   here), port **109** = `MODEM:DCI_CMD`.
   `qrtr-lookup` prints these last — they are not in the 16xxx range the node-2
   instances use.
2. **Never interrupt a listing.** The EFS directory cursor is modem-side and not
   rewindable: kill a client mid-listing (a `timeout`, or `head` closing the pipe)
   and the next `ls` continues from the stale position and returns a *short* set
   that looks like a small tree. A healthy listing returns `stat.size - 2` entries
   per directory (the 2 are the dot entries).

Two more quirks worth knowing: the whole-filesystem `image` opcode is **rejected**
on this firmware (`efs_errno 131071`) — use `pull_tree`; and `/nvm`, `/safe`,
`/safe_oem`, `/sfs` cannot be listed at all ("bad command"), which is expected,
not corruption.

## Usage

```sh
# on the device, from /usrdata/qmanager/tools/efstest
sh qm_efs_backup.sh                      # -> /tmp/efsbk/<ts>.tar.gz   (~920 KiB, 11 s)
ssh greenpacket 'cat /tmp/efsbk/<ts>.tar.gz' > efs-backup-<ts>.tar.gz   # copy off: tmpfs

sh qm_efs_restore.sh /tmp/efsbk/<ts>              # dry run -- prints DIFFERS/MISSING only
sh qm_efs_restore.sh /tmp/efsbk/<ts> --apply      # write everything that differs
sh qm_efs_restore.sh /tmp/efsbk/<ts> --apply /policyman /nv/item_files/modem/mmode
```

The helper defaults to **read-only** and refuses every mutating command; the
restore script restarts it with `-rw` itself and refuses to run if the session did
not come up writable. A dry run ends with a one-line tally, e.g. the run taken
just before the 2026-10-22 band change:

```
checked=1100 same=1099 differs=0 unreadable=1     # 1 = a symlink, read does not apply
```

and the same command *after* that change correctly reported `differs=4` — the
band item plus three files the modem itself rewrites. A diff tool that never
reports a difference is not evidence; that pair of runs is.

Watch two things when restoring: **`/nv/item_files/quectel/bak/`** holds the
vendor's own copies of the band items, and they follow live changes, so restore
the whole tree rather than one path; and item files go back through DIAT PUT
(`"item":true`), which is atomic, while ordinary files use OPEN/WRITE/CLOSE.

## Sensitivity

The tree contains the **IMEI, the module serial and the RF calibration**
(`nv/item_files/rfnv/*`). Keep backups off the device and **out of git** (AGENTS
hard rule 10). The copy taken on 2026-10-22 lives in
`~/Downloads/projects/greenpacket-o5a-backups/`.

## First real use

`docs/plans/2026-10-22-jazz-band-ca-tuning.md` — backup, dry-run restore, then the
`lte_band` change to `1:3:41`, with the measured before/after and the rollback.
