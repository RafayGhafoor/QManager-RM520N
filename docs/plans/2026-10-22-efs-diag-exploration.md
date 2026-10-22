# EFS over QRTR-DIAG on the O5A Pro — feasibility, backup, and what is in it

**Date:** 2026-10-22  **Lane:** ad-hoc probe (owner asked "can we use
qcom-efs-browser to back up and modify on our CPE over ssh?")
**Risk class:** read-only on the modem; **no EFS/NV write was performed**.
**Tool:** [`catxeon/qcom-efs-browser`](https://github.com/catxeon/qcom-efs-browser)
v1.4.6, `daemon/` only (the Android app is irrelevant here).

**Status: reads work and a full backup was taken. Writes are reachable but
untested and are *not* authorised by this record.**

---

## Background — two prior conclusions this supersedes

1. `plans/2026-10-09-qcante-and-qrtr-diag.md` concluded that DIAG on this device
   is **export-only**: `diag-router` feeds `/dev/ffs-diag` for a USB host and
   nothing local can consume it, so "on-device BLER/RB-count stay unobtainable".
   That is still true for the *log-mask stream*, and **wrong for EFS2**: the
   modem publishes its own DIAG CNTL/DATA on QRTR, and the EFS2 subsystem
   answers there without any `/dev/diag`.
2. `plans/2026-10-09-modem-firmware-antenna-recon.md` concluded the EFS tree
   "cannot be enumerated" because `AT+QNVFL` is unsupported. True over AT. Over
   EFS2 the whole tree enumerates — 1,305 entries — and every item is readable by
   path.

## Why the stock tool does not run here

| Blocker | Detail | Fix |
| --- | --- | --- |
| Architecture | upstream ships an **aarch64** helper linked against Android bionic (`daemon/build.sh` is deliberately not `-static` because of the bionic TLS segment rule) | rebuild for `armv7` with **zig**: `zig cc -target arm-linux-musleabihf -Os -static -o qcom-efsd src/util.c src/diag.c src/efs2.c src/main.c` (85 KB, ELF 32-bit ARM EABI5 static). No new toolchain, no glibc-2.31 dependency — same trick as `atcli_smd11`/`btop`. |
| Interface | the daemon is a root helper that listens on the **abstract unix socket `@qcom_efsd`** and speaks one JSON line per request; the app is the only client upstream, and there is no Python on this device | 50-line C client, same cross-build: connect the abstract socket with the **exact** sockaddr length (`offsetof(sun_path)+1+strlen`), write one request line, read **one** line and exit. Reading to EOF hangs: the daemon keeps the session open after replying. |
| Transport | the helper's own bus scan picks the **first** node advertising service 4097 — on this device that is **node 2, port 16403**, which is `diag-router`'s aggregate and **never answers EFS2** (`open` → "EFS2 did not answer on subsystem 0x3E or 0x13") | pin the modem's own DIAG CNTL with `-qrtr 3:19`. `qrtr-lookup` shows it only if you print the whole table — the node-3 rows are at the end and are **ports 19 (`MODEM:CMD`) and 109 (`MODEM:DCI_CMD`)**, not in the node-2 16xxx range. |

Working invocation:

```sh
nohup ./qcom-efsd -uid 0 -qrtr 3:19 -verbose > /tmp/efsd.log 2>&1 &
./efscli '{"cmd":"open"}'      # {"ok":true,"transport":"qrtr 3:19","subsys":19,"readonly":true}
```

`readonly` defaults to on, and the helper refuses every mutating command until
`-rw` / `{"cmd":"readonly","on":false}`.

## Measured

On the live unit, WAN up, 2026-10-22. Binaries and logs under
`/usrdata/qmanager/tools/efstest/` on the device (not committed; see Next steps).

| Check | Result |
| --- | --- |
| `{"cmd":"open"}` | `ok`, transport `qrtr 3:19`, EFS2 via subsystem `0x13` |
| `ls /` | 45 entries, stable across repeats |
| Enumeration completeness | every dir returns **`stat.size - 2`** entries (the 2 are the dot entries) — e.g. `/nv` 5→3, `/nv/item_files` 19→17, `/policyman` 16→14, `/` 47→45. This is the health check to use. |
| `read` a file | `ok`; XML/conf files return clean text |
| `read` an **item** file | `ok` — falls back to `GET` automatically |
| `nv_read` item 550 | `status 0` + payload (IMEI; not reproduced here) |
| `{"cmd":"image","path":"/","out":"/tmp/efs.tar"}` | **FAILS** — `fs-image open failed (handle=-65536, efs errno=131071)`. The whole-fs "modem tar" opcode is not supported on this firmware. Do not use it; use `pull_tree`. |
| `pull_tree` per top-level dir | **11 s**, 1,100 files / 205 dirs, 1,314,466 bytes of EFS content → 906 KB `tar.gz` |
| Failures during the pull | 1 file (`/nv/item_files/modem/uim/remote/uim_remote_service_enable`) and 4 unlistable dirs (`/nvm`, `/safe`, `/safe_oem`, `/sfs` → "target rejected the command"). Expected: those are EFS's special volumes. |
| Helper cost | `VmRSS 356 kB`, `utime+stime 0` ticks over the whole pull (the modem does the work; the helper is idle-waiting) |
| Device headroom at the time | `MemTotal 182532 kB`, `MemAvailable 38264 kB` |

### Cross-checks against the paths we already trust (AT)

Same values read two ways — this is what makes the EFS read usable as a second
opinion on a device fact:

| Fact | EFS2 read | AT read |
| --- | --- | --- |
| `trm_ant_port_override_mode` | `FF` | `AT+QNVFR` → `FF` |
| `ant_div_switch_master` | `02`×9 `00`×5 | `AT+QNVFR` → `0202020202020202020000000000` |
| LTE band preference | `/nv/item_files/modem/mmode/lte_bandpref` = `05 00…` → **B1+B3** | `AT+QNWPREFCFG="lte_band"` → **`1:3`** |
| 4G cell lock | `/nv/item_files/modem/lte/rrc/efs/cell_lock_list` = `01000000 68000000 fa000000` → count 1, then **104** and **250** | `AT+QNWLOCK="common/4g"` → `1,250,104` |

Field *order* in `cell_lock_list` was not determined (both numbers match the AT
answer; which is EARFCN and which is PCI is still open — EARFCN 104 would be B1,
which agrees with the `lte_bandpref` finding, but that is inference, not proof).
`AT+QNWPREFCFG="nr5g_sa_band"` / `"nr5g_nsa_band"` return **ERROR** on this
firmware, so the EFS read is the *only* source for the NR band masks.

### Gotcha found while enumerating

The EFS2 directory cursor is **modem-side and not rewindable**. If a listing is
aborted halfway (a client killed by `timeout`, SIGPIPE from `head`), the next
`ls` continues from the stale position and returns a *different, shorter* set —
which looks exactly like "the tree is small". Symptom seen: `ls /` returned only
`Data_Profiles` after an aborted walk. Rule: **never interrupt a listing**, and
walk breadth-first with a file worklist (shell recursion inside a piped `while`
also loses the parent stream under this `ash`).

## What is actually in this EFS (read) — findings worth knowing

Full inventory: 201 dirs, 411 files, 692 items, 1 link, ~1.31 MB.

| Path | Size | Why it matters |
| --- | --- | --- |
| `/policyman/hardware_band_filtering.xml` | 741 B | `<nr5g_sa_bands> 0-511 </nr5g_sa_bands>` — the shipped policy is the `disable_sa_mmwave` variant, i.e. **NR SA bands are filtered out wholesale**. This is a *policy* gate, not an NV one: `nr_band_pref` lists SA/NSA identically. If SA is ever wanted, this file (+ deleting `/policyman/persisted_items/`, as the file's own comment says) is the lever — **not** an NV item, and not a band mask write. Not exercised. |
| `/nv/item_files/modem/mmode/{nr_band_pref,nr_nsa_band_pref}` | 64 B each | identical, and unreadable over AT: **n1, n3, n5, n7, n8, n20, n28, n38, n40, n41, n71, n75, n76, n77, n78** |
| `/nv/item_files/modem/mmode/lte_bandpref` (+ `_extn_65_256`, 24 B) | 8 B | **B1+B3 only** — the persisted LTE band restriction behind `AT+QNWPREFCFG="lte_band"` |
| `/nv/item_files/modem/mmode/nr5g_disable_mode` | 1 B | `00` (NR not disabled) — the persistent flag the NSA/APN boot-race plan suspected |
| `/nv/item_files/quectel/qcnchk/qcnchk.txt` | 4.5 KB | Quectel's own **QCN backup manifest**: `EFS;<path>;<dest>` and `NV;<id>;<path>` lines — the vendor's list of what a real QCN backup contains |
| `/nv/item_files/quectel/bak/` + `bak.txt` + `bak/flag.txt` | — | the vendor's own backup of the band prefs and friends (`lte_bandpref`, `nr_band_pref`, `nr_nsa_band_pref`, `uim_hw_config`, `gnss_config`, `thin_ui`) with a per-run ledger — a second, known-good copy to diff against |
| `/nv/item_files/rfnv/*` | 34 files, up to 141 KB | RF calibration NV (`00030016` 140,931 B, `00029650` 94,156 B, …). This is the part a backup actually protects; content is binary/opaque |
| `/nv/reg_files/modem/lte/rrc/nr5g_mgr/endc_db` | 11.5 KB | the **EN-DC database** — directly relevant to the open EN-DC combo question in `plans/2026-09-02-endc-combination-table.md` |
| `/nv/reg_files/modem/nr5g/rrc/csp/{acq_db,scell_acq_db}` | 14.6 KB | NR acquisition DBs |
| `/nv/item_files/modem/lte/ML1/{dc_offsets,asdiv_ca_band_combo,ant_switch_band_info}` | 23 KB / … | DC offsets and antenna-switch CA combos (the AI-smart-antenna thread) |
| `/nv/item_files/conf/*.conf` (123 entries) | — | `mmode.conf`, `lte_rrc.conf`, `data_config_info.conf`, … — these are **path pointers**, e.g. `ant_switch_band_info.conf` is one line: `/nv/item_files/modem/lte/ML1/ant_switch_band_info` |
| `/policyman/{carrier_policy,generic_band_restrictions,lte_feature_restrictions,device_config,global_defines,policies,pre}.xml` | 0.4–2.5 KB | readable policy. Notable: `L2NR_FDD` / `L2NR_TDD` are enabled only for MCC `460`/`232` or PLMN list — **MCC 410 (Pakistan) is not in the list**, so LTE→NR handover features are off here unless `pm:l2nr_*_feature_enabled` is set |
| `/nv/item_files/quectel/qefsver` | 116 B | `RG520NEBDF_VA` — module image identity, straight from NV |
| `/sms/nv_gw_msg_data` 45,390 B, `/sms/nv_cd_msg_data` 38,610 B | | the modem-side SMS store (a *different* store from `/data/turin/mifi_config.sqlite:sms_config`; see `docs/reference/sms.md`) |
| `/nv/item_files/modem/utils/cafi/cafi_cell_db` | 17.6 KB | the modem's own cell database |
| `/mdb/policyman/location_polygons.mdb`, `/mdb/policyman/mcc2bands.mdb`, `/mdb/nr/plmn2cacombos_nr.mdb` | 9 KB / 559 B / 134 B | the MDB fragments that decide band/CA per MCC — the vendor data behind `generic_band_restrictions.xml` |
| `/.efs/api_debug/logs/{efs_counters,efs_sync_api_calls}` | 976 B / 1,632 B | EFS's own API counters (`CTRS`/`SYNC` magic, per-task call tallies) |

## The backup that was taken

```
ssh greenpacket 'cat /tmp/efs-backup.tar.gz' > …     # 906,284 bytes, 1,305 entries
```
Stored **outside the repo**, at
`~/Downloads/projects/greenpacket-o5a-backups/efs-2026-10-22/efs-backup-2026-10-22.tar.gz`.
It contains the IMEI, the module serial and the RF cal — **never commit it, never
paste it** (AGENTS hard rule 10). Device-side scratch (`/tmp/efsbackup`, the
tarball, the walk scripts) was removed after the copy; the helper and client are
left in `/usrdata/qmanager/tools/efstest/` and the helper was stopped.

## Writes — reachable, not tested, not authorised

- The helper supports `write`/`put` (item files), `nv_write`, `mkdir`, `chmod`,
  `rename`, `unlink`, `rmtree`, `symlink`, and the whole `spc` + `0x26/0x27`
  NV path, plus a `raw` hex-packet escape hatch. Reads of the DIAG access level
  aside, **nothing in this record exercised any of it.**
- The standing rule from the sibling product still applies: **EFS/NV writes are
  RF-calibration inputs**; the readable antenna items are one opaque byte and 14
  opaque bytes (`plans/2026-10-09-modem-firmware-antenna-recon.md`), boot-time
  consumption means a change needs an RF re-init, and the documented RF-deaf
  stuck state does not clear with CFUN cycles.
- If a write is ever authorised, the order is: full `pull_tree` backup (11 s) →
  one reversible item (`trm_ant_port_override_mode` back to `FF`) → verify with
  the AT read-back → reboot test. `raw` is the last resort, not the first.

## What did NOT work / is still open

- `image` (fs-image → whole-EFS tar): rejected, `efs_errno 131071`. `pull_tree`
  is the working replacement (11 s, 5 MB on disk).
- `/nvm`, `/safe`, `/safe_oem`, `/sfs`: not listable ("bad command") — unknown
  whether they hold anything, and the `image` opcode failing may be related.
- `cell_lock_list` field order (EARFCN vs PCI) unresolved.
- Whether the `disable_sa_mmwave` policy actually blocks SA end to end — the XML
  says yes, no SA attempt was made to prove it.
- The helper reads `nv_read 550` fine but no `nv_read` of the `0x4B 0x30`
  indexed form was tried.

## Next steps (if this becomes a feature)

1. Commit the two build inputs (a `zig cc` one-liner + the 50-line client) under
   `deploy/` or `tools/`, with the `-qrtr 3:19` default derived from a bus scan
   instead of hardcoded — that needs a "list ports per node" step the upstream
   scan does not do.
2. Turn `pull_tree` + sha256 manifest into a `qm_efs_backup.sh`, and document it
   in `docs/reference/efs-diag.md` with a router row.
3. Only then consider a write path, behind the AT-lock-free but still serialised
   single-client rule.

## Files touched

- this file
- device: `/usrdata/qmanager/tools/efstest/{qcom-efsd,efscli}` (armv7 musl, not in git)
- host: `~/Downloads/projects/greenpacket-o5a-backups/efs-2026-10-22/efs-backup-2026-10-22.tar.gz`
- **no** change to the app layer, no service, no EFS/NV write, `/web` and
  `/data/gp` untouched; vendor `:80` → 200 and QManager `:8080` → 200 afterwards,
  `qmanager-{httpd,poller,ping,dpi}` all active.
