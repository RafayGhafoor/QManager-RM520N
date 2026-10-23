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

**Where it is** — 81 **glibc anonymous arena-heap segments**, each `0xfd000`
bytes and 1 MB-spaced; sampled `heap_info.ar_ptr` values all point to one arena.
Their RSS+swap-backed pages total **31,228 kB** at census time. Three complete
sampled segments each held 23 allocator chunks of `0xafa0` bytes (44,960 bytes
each including the malloc header), followed by a ~2.1 kB top chunk — 69 matching
allocated chunks in total. These are arena
segments, not 81 application objects. `VmSize` 387,812 kB is 34 × 8 MB thread
stacks plus reservations, not use. At sample time 96 % of the process footprint
was swapped (`VmRSS` 1,388 kB vs `VmSwap` 35,820 kB) because
`vm.swappiness=100` — which is why RSS alone looks like it shrank.

**What the repeated allocated object contains** — three full 1 MB segments were
dumped from `/proc/248/mem` as root. Each has 23 allocated chunks. All 69
sampled 44,952-byte payloads share the same pair of Thumb code addresses
(`0x49c7e1`, `0x49c6f1`), a self pointer at `+8`, a `1` at `+0xaf90`, and
otherwise zero bytes. The code pointers resolve into the deployed stripped `netmgrd`; the
function at file offset `0xb7e0` references STM state-machine APIs, but this
does not identify the object type or allocator caller. `strings` over sampled
payloads: nothing.

**Correction to the previous interpretation:** those bytes are **not** an array
of empty list heads. The repeated `0xfd000` header is glibc `heap_info`; the
self-linked pointers in the first segment belong to allocator state. The
45 kB chunks are marked **allocated**, so this is not just glibc keeping freed
chunks. It is consistent with a growing set of live allocated objects or a growing
pool/cache; whether that growth is a bug or intentional is **not established**. The VMA count is not the object count.

**Cost accounting (corrected)** — netmgrd had 35.8 MB `VmSwap`, about 52 % of
swap slots used at that sample; this contributes to the swap-budget risk. Global
zram `mm_stat` is content-dependent (follow-up: 69.0 MB original, 7.26 MB
compressed, 8.02 MB allocator use, 7,886 same-pages). It cannot attribute
physical zram RAM to netmgrd. The previous ~3.9 MB per-process physical cost
and full-swap extrapolation were unsupported and are retracted. Swap exhausted
on 2026-10-13, and the OOM killer took netmgrd with the data-path cascade
recorded in `greenpacket-o5a` → `plans/2026-10-13-memory-pressure-watch.md:14-36`.

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
   `netmgr_util.c`). Those generic API names do not connect the sampled
   allocations to that library lifecycle or resolve any deployed `netmgrd`
   call site.

Neither the product tree (`o5a/turin/app/data_call`, `webserver-go`) nor this
branch contains a netmgr client call, so the allocating caller cannot be named
from anything we have.

## What was ruled out

| Suspect | Verdict |
| --- | --- |
| QManager leak | no — 4.7 MB, flat, 1.8 % of userland memory |
| fd / thread leak in netmgrd | no — 88 fds (54 pipe, 31 socket) and 34 threads identical across every sample |
| CPU spin / busy loop | no — `voluntary_ctxt_switches` frozen at 4725 for 90 s; the daemon is idle while holding 37 MB |
| XML/message content in sampled payloads | not seen — zero strings in sampled objects; this does not identify their purpose |
| log/message buffering | not seen in sampled payloads; `cmd_logging_config` is disabled (255), but that alone does not prove there is no other buffering |
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
| `netmgrd` arena heap segments | **81 × 0xfd000**, holding `31,228 kB` RSS+swap-backed at census | `smaps` VMA census |
| Device userland total | `71,180 kB` RSS + `54,940 kB` swap = `126,120 kB` | `/proc/*/status` sum |
| QManager total | **4.7 MB** | poller + ping + dpi |
| zram (global; not attributable per process) | follow-up: 69.0 MB original, 7.26 MB compressed, 8.02 MB allocator use, 7,886 same-pages | `/sys/block/zram0/mm_stat` |
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

**Do not extrapolate physical RAM cost from global zram.** At the follow-up
sample, `mm_stat` was `69,005,312 7,258,624 8,019,968 0 8,019,968 7,886 393
153`: about 65.8 MiB original swap pages, 6.9 MiB compressed, 7.65 MiB allocator
memory and 7,886 same-pages. Its ratio is dominated by identical/compressible
pages and cannot be attributed to netmgrd. The earlier claim that a full 91 MB
swap would cost ~9.4 MB RAM, and that netmgrd's share cost ~3.9 MB, were
unsupported and are retracted. Swap exhaustion removes the escape valve; the OOM
comes afterwards, when new anonymous pages must stay resident and `Normal free`
walks toward `min`. That is why netmgrd's swap-slot growth is worth watching.

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

## Can it be fixed?

**Potentially, but not safely by tuning the live allocator or editing our QManager
code.** The sampled glibc chunks are marked allocated; `malloc_trim()` and
`MALLOC_TRIM_THRESHOLD_` only release free top chunks, so they cannot reclaim
these objects. All sampled `heap_info.ar_ptr` fields point to one arena, so
`MALLOC_ARENA_MAX` is not a solution either. Changing the mmap threshold would
only change where future allocations are mapped; it would not make a live
allocation freeable. The source is not available, and the deployed binary is
stripped, so a binary patch without the allocation path would be a radio/network
risk, not a responsible fix.

There are two real routes:

1. **Permanent fix:** obtain a newer vendor `netmgrd` build or source/patch. The
   ready-to-send report below describes the actual glibc heap segments and
   repeated ~45 kB allocated objects, not the previous incorrect “empty-list”
   interpretation.
2. **Identify the allocation path:** in an owner-approved maintenance window,
   instrument a controlled netmgrd restart with a temporary allocator trace
   (`LD_PRELOAD`/malloc backtrace or an equivalent vendor debug build), capture
   allocation size + call stack for requests matching ~44,952 bytes, then remove
   the instrumentation and restore the original service config. This restarts
   netmgrd and can drop the data path; it is **not** approved or run yet.

A measurement-only 60 s heap-count sampler cannot identify historical callers.
Pair a future allocation trace with the restart; otherwise the sampler costs
radio/network churn without identifying a fixable allocation path.

## Still broken / open

- The growth is **not fixed**. Source is unavailable in the SDK and the deployed
  binary is stripped; only a vendor build/patch or allocator trace can identify
  the allocation path safely.
- **Which netmgr operation allocates a 45 kB chunk is not established.** The
  previous 60 s heap-count sampler would correlate arena growth but not identify
  the caller, so it is not being built alone. A malloc-backtrace trace around a
  controlled restart is the diagnostic step, but it requires owner approval and
  will interrupt the data path.
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
2. **Vendor report** with corrected evidence (2.1 MB/h, 81 glibc heap segments,
   69 matching allocated ~45 kB chunks across three sampled segments, unknown
   object and caller).
   A vendor fixed build/source is the only route to a permanent fix.
3. If the zone approaches `min` or pressure counters rise, discuss a
   measurement-gated restart — footprint + swap floor + idle traffic, never a
   bare timer, because the restart *is* the 10-13 outage.
4. An allocator backtrace would require owner-approved instrumentation and a
   netmgrd restart; do not do it on the live box without scheduling the brief
   data-path interruption.
5. Vendor command-log enablement (`/etc/data/netmgr_config.xml`) only with an
   explicit owner exception: it is a vendor rootfs file outside this branch's
   write set.

`memory.md` was deliberately **not** edited: nothing on the install changed.

## Follow-up sample (14:17 UTC, uptime 56,037 s)

netmgrd still pid 248, **38,000 kB** (RSS+swap): +0.8 MB in 32 min since the
13:45 reading, in line with 2.1 MB/h. `SwapFree` 22,472 kB, `MemAvailable`
49,604 kB, `Normal free` 3,008 pages (above `high` = 1,662), `oom_kill=0`.
No change in the verdict.

Unrelated observation, not investigated here: `tailscaled` (9 MB) has entered
`memwatch`'s top-3 since ~13:50. It is a new resident on this box and adds to the
same swap budget; whoever deployed it should record its footprint.

## Appendix — vendor defect report (ready to send)

Written for the module/firmware vendor. Contains no subscriber identifiers.

> **Subject:** `netmgrd` heap grows monotonically on
> `LE.UM.6.2.3.r1-03100-SDX65.0` (RG520N-EB), leading to OOM-kill of netmgrd
>
> **Build:** `/usr/bin/netmgrd` 750,344 bytes, dated 2023-10-20, md5
> `301b845bed135314d722bbd8ad9499c9`, from the `data` package (`git-r26`).
> Kernel `5.4.210-perf`, armv7l, 178 MB RAM, 91 MB zram swap,
> `vm.swappiness=100`.
>
> **Observed:** netmgrd's resident + swapped footprint grows from 5 MB at boot
> to 38 MB after 15.6 h (**~2.1 MB/h**), with no decrease across 30
> consecutive 10-minute samples. The observed process footprint reset only on restart.
>
> **Shape:** `/proc/248/smaps` shows **81 glibc anonymous arena-heap segments**
> of `0xfd000` bytes, 1 MB-spaced, holding 31.2 MB of RSS+swap-backed pages at
> census. Three full sampled segments each contain 23 malloc chunks of `0xafa0`
> bytes (44,960 B including allocator header), each marked allocated. All 69
> sampled 44,952 B payloads share the same pair of code pointers, a self pointer
> at `+8`, and a `1` at `+0xaf90`; otherwise zero in the sample. They are not
> empty-list arrays; the object type and allocating caller are unknown. The
> daemon has 88 fds and 34 threads and was idle (no context switches over 90 s)
> while holding memory.
>
> **Impact:** netmgrd ends up holding most of the swap. When swap runs out, the
> kernel OOM-kills netmgrd as the largest process (observed 2026-10-13:
> `Free swap = 0kB`, netmgrd at 30 MB RSS + ~69 MB swap). That re-programs the
> data path: `ql-netd` exits 255, `dnsmasq` restarts twice, and LAN services
> stop answering for ~2 minutes.
>
> **Request:** please identify the allocation path creating repeated ~44,952-byte
> objects and whether this is an intended pool/cache or a leak. We can provide
> `/proc/<pid>/smaps` captures, sample chunk dumps and disassembly-derived code
> addresses on request. Please provide a fixed build or supported setting to
> bound growth if this is a defect.

## Files touched

| File | Change |
| --- | --- |
| `docs/reference/netmgrd-growth.md` | **new** — the reference doc |
| `docs/reference/README.md` | one router row |
| `docs/reference/platform-matrix.md` | one O5A subsection of per-device facts |
| `docs/plans/2026-10-23-netmgrd-memory-growth.md` | **new** — this record |

No code, no device change, no service touched.
