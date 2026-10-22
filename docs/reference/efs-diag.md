# Modem EFS2 over QRTR-DIAG — reading, backing up and restoring the modem's filesystem

> **Scope: `RG520N`** (RG520N-EB, GreenPacket O5A Pro). Every fact here was
> measured on that unit on 2026-10-22 and is **not** a claim about the RM520N-GL;
> a port must re-measure the QRTR node/port and the opcode behaviour below.

**Triggers:** `qcom-efsd`, `efscli`, `deploy/efs/`, `/usrdata/qmanager/tools/efstest/`,
`qm_efs_backup.sh`, `qm_efs_restore.sh`, `/tmp/efsbk/`, `-qrtr 3:19`,
`/nv/item_files/`, `/policyman/`, `/mdb/`, `nv_band_pref`, `lte_bandpref`,
`nr_band_pref`, `nr_nsa_band_pref`, `nr5g_disable_mode`, `cell_lock_list`,
`hardware_band_filtering.xml`, `mcc2bands.mdb`, `plmn2cacombos_nr.mdb`, `qcnchk`,
`rfnv`, `EFS2`, `pull_tree`, `SO_PEERCRED`/`@qcom_efsd`, or any task of the form
"does the modem really have X configured", "back up / restore the modem",
"which bands/combos does this module allow".

Work records: [`../plans/2026-10-22-efs-diag-exploration.md`](../plans/2026-10-22-efs-diag-exploration.md)
(discovery), [`../plans/2026-10-22-jazz-band-ca-tuning.md`](../plans/2026-10-22-jazz-band-ca-tuning.md)
(first real use: backup → change → verify → rollback), spec
[`../specs/jazz-band-ca-tuning.md`](../specs/jazz-band-ca-tuning.md).

## Why this exists

There is **no `/dev/diag`** on this device and `AT+QNVFL` is unsupported, so
before 2026-10-22 the EFS tree could not be listed at all over AT, and the modem's
band masks, policy XMLs and RF calibration were unreadable. `diag-router` exists
but is **export-only** (it feeds `/dev/ffs-diag` for a USB host).

The modem nevertheless publishes its **own** DIAG over QRTR, and the EFS2
subsystem answers there. That is the whole trick.

## Transport — two facts, both load-bearing

| Fact | Detail |
| --- | --- |
| **Discard the 16xxx ports** | Node 2 ports 16403/16405/16406 (33 instances of service 4097) are `diag-router`'s aggregate. `open` against them **times out** ("EFS2 did not answer on subsystem 0x3E or 0x13"). |
| **Use node 3** | The modem's own DIAG is QRTR **node 3, port 19** = `MODEM:CMD` (EFS2 works here); port 109 = `MODEM:DCI_CMD`. `qrtr-lookup` prints these last — grep the whole table, not the head. |
| The AP itself is node 2 | So `qrtr-lookup`'s `Node` column is *not* "the modem" for every 4097 row. A naive "first node advertising 4097" scan picks wrong. |

Helper start: `qcom-efsd -uid 0 -qrtr 3:19` (read-only by default; `-rw` unlocks
writes and the daemon refuses every mutating command until then).

## Tools

| Path | What |
| --- | --- |
| `/usrdata/qmanager/tools/efstest/qcom-efsd` | upstream helper, rebuilt **armv7 musl static** (`zig cc -target arm-linux-musleabihf -Os -static`, 85 KB) |
| `/usrdata/qmanager/tools/efstest/efscli` | one-shot client for the `@qcom_efsd` abstract socket |
| `deploy/efs/qm_efs_backup.sh` | full read-only backup: `pull_tree` per top dir, sha256 manifest, AT/QMI/poller state snapshot, `tar.gz` |
| `deploy/efs/qm_efs_restore.sh` | **dry-run by default**; `--apply` writes, then re-reads every file to verify |

Binaries decision (AGENTS hard rule 9): **neither binary is committed.**
`efscli.c` is ours (`deploy/efs/efscli.c`); `qcom-efsd` is built at deploy time from
[`catxeon/qcom-efs-browser`](https://github.com/catxeon/qcom-efs-browser) (BSD
3-Clause — permissive, and *not* vendored). Do not add either to `dependencies/`
without a fresh decision.

## Measured on this unit (2026-10-22)

| Metric | Value |
| --- | --- |
| Full EFS backup | **1,100 files, 205 dirs, 1.31 MB of content, 920 KiB gz, ~11 s** |
| Restore dry run | 1,099 identical / 0 differing / 1 unreadable (`mcfg/cards/last_iccid.symlink`) |
| `pull_tree` cost | one `efscli` fork per top-level dir (41 forks), one long-lived helper |
| Helper footprint | `VmRSS 356 kB`, `utime+stime 0` ticks across a whole pull — it is idle-waiting on the modem |
| Listed vs declared | a healthy directory returns `stat.size - 2` entries (the 2 are the dot entries) — use this to detect a truncated listing |
| Unlistable, by design | `/nvm`, `/safe`, `/safe_oem`, `/sfs` → "target rejected the command" |
| Whole-fs `image` | **rejected**: `fs-image open failed (handle=-65536, efs errno=131071)` — use `pull_tree` |

Known-good cross-checks against AT (same value read two ways): `lte_bandpref`
`05 00…` ↔ `AT+QNWPREFCFG="lte_band"` `1:3`; `cell_lock_list`
`01 00 00 00 68 00 00 00 fa 00 00 00` ↔ `AT+QNWLOCK="common/4g"` `1,250,104`;
`mcs/trm/*` ↔ `AT+QNVFR` (`FF`, `02`×9 `00`×5).

## What the tree contains (operational map)

| Path | What it is |
| --- | --- |
| `policyman/*.xml` (7) | carrier policy, `generic_band_restrictions`, **`hardware_band_filtering`** (the SA gate: ships `disable_sa_mmwave`, `<nr5g_sa_bands> 0-511 </nr5g_sa_bands>`), `lte_feature_restrictions` (`L2NR_FDD`/`L2NR_TDD` are MCC-gated, MCC 410 is **not** listed), `device_config`, `global_defines`, `policies`, `pre` |
| `policyman/persisted_items/` | policyman's cache of the above (`rat_mask`, `limited_bands`, `rat_order`, …). Editing a policy XML requires deleting this directory — the XML's own header says so |
| `policyman/ignore_mcc2bands_mdb` | `"1"` on this unit → the compiled MCC→bands table is **ignored** |
| `mdb/**` (10 files) | Qualcomm MDB container (`\x01<len>Qualcomm…`) wrapping **zlib**. Decompressed `mdb/nr/plmn2cacombos_nr.mdb` yields literal combo strings (`b1AA-b3A-b7A-b8A-n78AA-n78A;…`) — the per-PLMN NR combo table, without a QMDL capture. `mcc2bands.mdb` / `mcc2arfcn.mdb` carry rows for MCC 310–316/460/440 and **no 410**. |
| `nv/item_files/modem/mmode/` | `lte_bandpref` (+ `_extn_65_256`), `nr_band_pref`, `nr_nsa_band_pref` (identical; **AT cannot read them** — `nr5g_sa_band` → ERROR), `nr5g_disable_mode` |
| `nv/item_files/modem/lte/rrc/efs/` | `cell_lock_list` (`count`,`104`,`250`), `lte_feature_enable` (32 B), `lte_3gpp_release_ver`, RRC efs |
| `nv/reg_files/` (43 files) | `lte/rrc/nr5g_mgr/endc_db` (11.5 KB), `nr5g/rrc/csp/{acq_db,scell_acq_db}` (14.6 KB each) |
| `nv/item_files/rfnv/` (32) | **908 KiB of RF calibration** — restore material only, never a target |
| `nv/item_files/quectel/` | `qefsver` (`RG520NEBDF_VA`), `module_sn`, `ecc_default`, `cpms_memory`, `qcnchk/qcnchk.txt` (55-entry QCN manifest: `EFS;<path>;<dest>` / `NV;<id>;<path>`), `bak/` (the vendor's own copies of the band items + `flag.txt` ledger) |
| `nv/item_files/conf/` (121) | mostly **path pointers**, e.g. `ant_switch_band_info.conf` is one line naming the real item. Several point at items that do not exist on this unit (`asdiv_ca_band_combo`, `ca_dynamic_band_cfg`) |
| `sms/nv_gw_msg_data`, `nv_cd_msg_data` | the modem-side SMS store, **not** the inbox QManager reads (see [`sms.md`](./sms.md#two-sources-one-inbox)) |
| `policyman/hardware_band_filtering.xml` + `mdb/` | the two places a band/SA question usually resolves |

## Gotchas — each cost real time

1. **The directory cursor is modem-side and not rewindable.** Abort a listing
   (client killed by `timeout`, or `head` closing the pipe) and the next `ls`
   continues from the stale position and returns a *short* set that looks like a
   small tree. Never interrupt a listing. Check completeness with
   `entries == stat.size - 2`.
2. **Killing the helper mid-operation can leave the modem's EFS session desynced**;
   the first read after a restart can come back empty/garbled. Re-read before
   concluding a file changed.
3. **A write is not one file.** Changing `lte_bandpref` also rewrote
   `quectel/bak/lte_bandpref` and `quectel/bak/flag.txt`. Restore the **whole
   tree**, never one path.
4. **`bc_info_db` and the `quectel/bak` ledger drift on their own.** A restore
   diff will show them; that is not a fault.
5. **A diff tool that only says "identical" is not evidence.** The first version of
   `qm_efs_restore.sh` reported 0 differences because an argument-parsing bug
   turned the backup path into a path filter that matched nothing, and it counted
   empty files as unreadable. Fixed; the record keeps both runs so the next person
   does not repeat it.
6. **The tree holds the IMEI, module serial and RF calibration.** Backups live
   outside git (`~/Downloads/projects/greenpacket-o5a-backups/`) — AGENTS hard
   rule 10.
7. **`/tmp` is tmpfs**: copy a backup off before rebooting.

## Writing to EFS — the standing order

Read freely. Writes are **RF-calibration-adjacent, consumed at boot, and there is
no firmware fallback on this device** (no firehose, no vendor image). Before any
write: take a backup, verify it by dry run, write one reversible item, verify
through the *other* transport, then prove it survives a reboot. `rfnv`, MCFG/PDC
payloads and the compiled MDBs are never write targets. Worked example that
followed this order and rolled back cleanly:
[`../plans/2026-10-22-jazz-band-ca-tuning.md`](../plans/2026-10-22-jazz-band-ca-tuning.md).
