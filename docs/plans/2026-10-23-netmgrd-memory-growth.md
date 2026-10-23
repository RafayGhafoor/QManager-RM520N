# 2026-10-23 — netmgrd memory growth: diagnosis, no fix yet

**Status:** diagnosis complete · **no change made to the device or the deployed
code** · mitigation decision still open with the owner.

Scope note: the subject is the **vendor** daemon `netmgrd`, not QManager. Nothing
in this plan is a QManager defect, and no QManager process is implicated.

## What was asked

Owner: "its taking up ram I think" (dmesg showing the `gp-*` health timers), then
"diagnose netmgrd whats the issue", then "ssh petros1 we should have sourcecode
there". So the work was: attribute the memory, diagnose the culprit, look for
vendor source, and — if the source does not exist — find out what the daemon is
holding without it.

## What was measured

Method is the established one ([`../reference/netmgrd-growth.md`](../reference/netmgrd-growth.md)
carries the commands): `VmRSS + VmSwap` from `/proc/<pid>/{status,smaps_rollup}`,
a per-VMA census of `smaps`, and `/sys/block/zram0/mm_stat`. Device:
`LE.UM.6.2.3.r1-03100-SDX65.0`, uptime 14.9 h, no browser attached.

**Device totals** — 81 userland processes, `71,180 kB` RSS + `54,940 kB` swap =
**126,120 kB**, which matches `free`'s "126 MB used" of `182,532 kB` exactly.
`MemAvailable` 48–55 MB; zram `61,348 / 91,264 kB` used; `oom_kill=0` this boot.

**Attribution** — `netmgrd` (pid 248) is the largest tenant: **37.2 MB = 6.0 MB
RSS + 30.7 MB swap**, 29 % of all userland memory. QManager is **4.7 MB** total
(poller 2.9, ping 0.8, dpi 0.7) and flat. `smartdns` 10.7 MB. The `sh`/`nc`/`sleep`
glue of the vendor loops is ~10.9 MB across 18 processes, none stuck.

**The trend** — the `top=` column of `/data/gp/memwatch-trend.csv` is RSS+swap
(`gp-memwatch.sh:359`), so it is a footprint series: netmgrd went **5 MB at boot
→ 11 (01:09) → 20 (06:09) → 24 (08:40) → 29 (11:50) → 36 (13:40) → 37.2 measured
(13:45)**. **+32 MB in 15.3 h = 2.1 MB/h**, monotonic across 30 consecutive
samples, reset only by a restart.

**Where it is** — 81 anonymous VMAs in the ~1 MB class (`0xfd000`, 1 MB-aligned,
consecutive) holding **31,228 kB**; 664 kB in `[heap]`; `VmSize` 387,812 kB is
34 × 8 MB thread stacks and arena reservation, not use. At sample time 96 % of it
was swapped (`VmRSS` 1,388 kB vs `VmSwap` 35,820 kB) because `vm.swappiness=100`
— which is why an RSS-only sample of this daemon reads as if it shrank.

**What the blocks contain** — dumped three from `/proc/248/mem` as root. Shared
header: constant word `0xa2700010`, own base, **`0x000fd000` twice** (the chunk
size), a self-referential list head. The fullest block is ~100 % touched and its
body is an array of self-referential `{next, prev}` pairs — **empty doubly-linked
list heads**, 8 bytes apart. `strings` over 64 kB: nothing. So it is a **growable
administrative table/pool in ~1 MB chunks**, one new chunk per ~25–30 min — not
data buffers, not XML, not logs.

**Cost accounting** — zram compresses `68,841,472` → `6,632,564` (10.4 : 1), so
all 61 MB of swap costs ~7.4 MB of RAM and netmgrd's share is ~3.9 MB. The leak is
a **swap-budget** problem, not a RAM-hog: swap exhausted on 2026-10-13, and the
OOM killer took netmgrd (largest process) with the data-path cascade recorded in
`greenpacket-o5a` → `plans/2026-10-13-memory-pressure-watch.md:14-36`.

## What was NOT found — the negative result

**There is no `netmgrd` source.** `netmgrd` ships in the `data` opkg package
(`data.list` → `usr/bin/netmgrd`), `License: Qualcomm-Technologies-Inc.-Proprietary`,
`Source: data_git.bb`; the netmgr libraries are `License: CLOSED`. The 24 GB O5A
SDK on `petros1` (`/root/o5a-src`, from `o5a-912.001.604.008.tgz`) has **headers
only** — no implementation, no recipe, no patch, and nothing in the other
tarballs or directories on that box.

Two facts worth keeping, because both cost time to rediscover:

1. The daemon is **stripped** (`nm: no symbols`).
2. **The SDK binary is a different build from the deployed one** — SDK 705,532 B
   / 2021-12-10 / md5 `21decb26…` vs device 750,344 B / 2023-10-20 / md5
   `301b845b…` — so the SDK cannot symbolicate live memory. The only DWARF
   anywhere is on the SDK's **library** (`ql-sysroots/usr/lib/.debug/libnetmgr.so.0.0.0`,
   3,008 symbols, `netmgr_client.c` / `netmgr_netlink.c` / `netmgr_unix.c` /
   `netmgr_util.c`), and it names the lifecycle a leak would live in
   (`netmgr_client_alloc`/`_register`/`_release`, `netmgr_client_start_listener`/
   `stop_listener`, `netmgr_nl_alloc_msg`) without resolving to a deployed address.

Neither the product tree (`o5a/turin/app/data_call`, `webserver-go`) nor this
branch contains a netmgr client call, so the allocating caller cannot be named
from anything we have.

## What was ruled out

| Suspect | Verdict |
| --- | --- |
| QManager leak | no — 4.7 MB, flat, 1.8 % of userland memory |
| fd / thread leak in netmgrd | no — 88 fds (54 pipe, 31 socket) and 34 threads identical across every sample |
| CPU spin / busy loop | no — `voluntary_ctxt_switches` frozen at 4725 for 90 s; the daemon is idle while holding 37 MB |
| libxml parse-tree accumulation | no — zero strings in the dumped blocks |
| log/message buffering | no — same dump, and `cmd_logging_config` is disabled (255) |
| `df`'s 110 MB "tmpfs" row | no — busybox mislabels the ubifs mount; that is disk, not RAM (`memory.md:224`) |
| the `gp-*` timer services | no — they fork and exit; per-run cost is CPU (linecheck 17–23 s per 10-min run), not retained memory |

## Benchmark

No change was made, so there is no before/after pair and none is claimed
(rule 1a: an after-number without a before-number is not a result). What this
batch produces is the **baseline a future change must be measured against**:

| Metric | Value (O5A, 2026-10-23, uptime 14.9 h, no browser) | Source |
| --- | --- | --- |
| `netmgrd` footprint (RSS+swap) | **37.2 MB** (6.0 RSS + 30.7 swap) | `/proc/248/smaps_rollup` |
| `netmgrd` growth rate | **2.1 MB/h**, monotonic, resets only on restart | `memwatch-trend.csv` `top=` |
| `netmgrd` ~1 MB chunks | **81**, holding `31,228 kB` | `smaps` VMA census |
| Device userland total | `71,180 kB` RSS + `54,940 kB` swap = `126,120 kB` | `/proc/*/status` sum |
| QManager total | **4.7 MB** | poller + ping + dpi |
| zram | `61,348 / 91,264 kB` used, `68.8 MB → 6.6 MB` (10.4 : 1) | `/proc/swaps`, `mm_stat` |
| Pressure counters | `oom_kill=0`, `allocstall_normal=401`, `pgmajfault=21363` | `/proc/vmstat` |

Any future restart/cap change must be reported against these rows, same unit,
same conditions.

## Addendum, same session — is the box actually at risk?

After the diagnosis the open question was whether to act. Two short read-only
measurements settled it, and one of them retracted advice from my own first reply.

**The gauge is the `Normal` zone watermark, not `MemAvailable`.** On this unit
(`managed` 45,633 pages) `min` = 1,450 pages (5,800 kB), `low` = 1,556, `high` =
1,662 (6,648 kB). Over a 5-minute window `Normal free` read **1,669 → 2,827
pages** — at or above `high`, i.e. kswapd holding it in its healthy band. The
10-13 kill happened at `Normal free:1656kB vs min:1704kB`, below `min`.
`MemAvailable` read **44 MB** minutes before that kill and reads 48–56 MB now, so
it is not evidence of safety in either direction.

**A full swap is not a memory event.** zram accounting: 68.7 MB of swapped pages
currently occupy 7.77 MB `mem_used` / 7.05 MB compressed (ratio drifting 9.7:1 →
10.4:1 across samples). A completely full 91 MB swap would cost ≈9.4 MB of RAM —
about **+1.6 MB over today**. Swap exhaustion removes the escape valve; the OOM
comes afterwards, when new anonymous pages must stay resident and `Normal free`
walks toward `min`. That is why netmgrd's 2.1 MB/h is the thing to watch.

**Runway, measured:** a clean 5-minute window (no `/proc/<pid>/mem` reads) moved
`SwapFree` 23,476 → 22,604 kB — **-872 kB, all in the first two minutes, then
flat**. Bursty, not a march. At 22.6 MB free there is no imminent exhaustion.

**Verdict: no action on the device.** No restart, no cap, no config change. The
box is inside its normal operating band, and the one cheap "reset" that suggests
itself is a trap:

> **`swapoff -a && swapon -a` is NOT safe here, and the first reply in this work
> called it "zero risk" — that was wrong.** `swapoff` must fault ~68 MB of
> swapped anonymous memory back in with `MemFree` at 6–11 MB and `Normal free`
> 2.5 MB above the OOM watermark. It would very likely kill `netmgrd` — the exact
> 2026-10-13 outage, self-inflicted. Retracted in
> [`../reference/netmgrd-growth.md`](../reference/netmgrd-growth.md#do-not-swapoff-to-reset-zram).

## Why the attribution sampler was not built

Option 1 from the list below was the 60 s sampler that would correlate a ~1 MB
step with a caller. Deliberately **not** built this session: the allocating
caller is closed vendor code, so the result would be a correlation with **no
fixable target** — a measurement that costs an hour of device load and changes no
decision. It becomes worth building the moment either a vendor channel opens (they
will ask which operation) or a real mitigation candidate appears. Recorded so the
judgement is not mistaken for an oversight.

## Still broken / open

- The leak itself is **not fixed** and cannot be fixed from source. Only a
  restart reclaims it, at the cost recorded on 2026-10-13.
- **Which netmgr operation allocates a chunk is not established.** The next
  measurement that would move it: a 60 s sampler recording
  `RSS+swap` and the ~1 MB chunk count alongside the 5- and 10-minute timers, so
  a step can be attributed to a caller. Steps are ~1 MB, so they are visible
  within an hour.
- **Not done deliberately:** editing `/etc/data/netmgr_config.xml` to enable
  netmgrd's command log. It is a vendor-owned rootfs file, outside this branch's
  write set (Hard rule 1) — it needs an explicit owner exception first.
- The gated-restart and cgroup-cap options are written up in
  [`../reference/netmgrd-growth.md`](../reference/netmgrd-growth.md) with their
  costs; **neither is implemented**, and the owner's own team previously disabled
  a `netmgrd_reset()` in `turin/feeds/conf/files/common/script/check_conn.sh`,
  which should be weighed before reviving it.

## Next step

Recommended order, given the calibration above:

1. **Nothing urgent.** Re-run the one-line `Normal free` gauge if the box ever
   feels slow; treat a reading below 1,450 pages, or a rising `allocstall_normal`
   rate, as the signal — not `free`'s "used" and not `MemAvailable`.
2. **Vendor report** with the numbers here (2.1 MB/h, 81 × ~1 MB chunks, resets
   only on restart, the `{next,prev}` empty-list structure). This is the only
   route that ends the leak rather than managing it.
3. **If swap free ever drops below ~8 MB**, revisit the measurement-gated
   restart — gated on footprint + swap floor + idle traffic, never a bare timer,
   because the restart *is* the 10-13 outage.
4. Vendor command-log enablement (`/etc/data/netmgr_config.xml`) only with an
   explicit owner exception: it is a vendor rootfs file outside this branch's
   write set.

`memory.md` was deliberately **not** edited: nothing on the install changed.

## Files touched

| File | Change |
| --- | --- |
| `docs/reference/netmgrd-growth.md` | **new** — the reference doc |
| `docs/reference/README.md` | one router row |
| `docs/reference/platform-matrix.md` | one O5A subsection of per-device facts |
| `docs/plans/2026-10-23-netmgrd-memory-growth.md` | **new** — this record |

No code, no device change, no service touched.
