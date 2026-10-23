# netmgrd — unbounded memory growth in the vendor network manager

**Scope:** RG520N (GreenPacket O5A Pro, `LE.UM.6.2.3.r1-03100-SDX65.0`, SDX6X)
· all numbers measured 2026-10-23 on this unit · nothing here is a claim about
the RM520N-GL or the RG501Q-EU, where the same daemon is a different build.

Read this when you touch **`netmgrd`, `/usr/bin/netmgrd`, `/usr/lib/libnetmgr*`,
`/etc/data/netmgr_config.xml`, `netmgrd.service`, the `data` opkg package,
`/data/gp/memwatch-trend.csv` and its `top=` column, the `oom_kill` counter in
`/proc/vmstat`, or `/sys/block/zram0/mm_stat`** — and before proposing anything
that "frees memory" on this device.

## What it is, and what it is not

`netmgrd` is Qualcomm's network-manager daemon: the QMI `netmgr` service that
programs links, addresses and routes for the vendor data path. On this unit it is
pid **248**, started at boot, `34` threads, `88` open fds (`54` pipe, `31`
socket, `3` `/dev/null`).

It is **not QManager's**, and QManager does not drive it. The only QMI in this
tree is read-only PHY (`lib/phy_metrics.sh`, `lib/qmi_read.sh` via `qmicli`),
which never requests the netmgr service. The netmgr clients are vendor daemons
(`QCMAP_ConnectionManager`, `ql_netd`, `qwesd`) — see
[`qmi-transport.md`](./qmi-transport.md) for the QMI paths this branch does own.

### There is no source. Do not go looking again.

Recorded as a negative result because the hunt costs half a day:

| Looked in | Result |
| --- | --- |
| `/root/o5a-src` on `petros1` — the 24 GB O5A SDK (`o5a-912.001.604.008.tgz`, extracted `o5a/{rg500q,turin,webserver-go,web-vew}`) | **no `netmgr*.c`, no `datamgr`, no `dsutils` implementation, no recipe, no patch** — headers only |
| `/root`, `/home`, `/opt`, every tarball on that box | nothing |
| opkg metadata | `data` `Version: git-r26`, `License: Qualcomm-Technologies-Inc.-Proprietary`, `Source: data_git.bb`; `libnetmgr-nr-fusion0` / `libnetmgr-rmnet-ext0` `License: CLOSED` |

`netmgrd` ships **inside the `data` opkg package** (`var/lib/opkg/info/data.list`
→ `usr/bin/netmgrd`). It is a prebuilt, **stripped** ELF.

**The SDK binary is not the deployed binary** — this matters, because it means
the SDK cannot symbolicate live memory:

| | Size | Date | md5 | Symbols |
| --- | --- | --- | --- | --- |
| Device `/usr/bin/netmgrd` | 750,344 | 2023-10-20 | `301b845bed135314d722bbd8ad9499c9` | `nm: no symbols` |
| SDK `ql-ol-rootfs/usr/bin/netmgrd` | 705,532 | 2021-12-10 | `21decb26a62fc56527c2dc810859d49c` | `nm: no symbols` |
| `targetfiles_yettel.zip` → `SYSTEM/usr/bin/netmgrd` | 750,344 | 2023-05-15 | (same size/era as the device) | stripped |

The **only** source-level visibility available anywhere is DWARF on the SDK's
netmgr **library** (`ql-sysroots/usr/lib/.debug/libnetmgr.so.0.0.0`, 282,712 B,
3,008 `DW_AT_name` entries across `netmgr_client.c`, `netmgr_netlink.c`,
`netmgr_unix.c`, `netmgr_util.c`). It names the lifecycle a leak would sit in —
`netmgr_client_alloc` / `netmgr_client_register` / `netmgr_client_release`,
`netmgr_client_start_listener` / `stop_listener`, `netmgr_nl_alloc_msg`,
`netmgr_nl_decode_rtm_{link,addr,prefix}`, and `netmgr_daemonize` — but it is a
**different build** from the deployed library (75,312 B vs 75,048 B), so it
cannot be used to resolve a live address.

## The growth: monotonic, ~2.1 MB/hour, reset only by restart

`/data/gp/gp-memwatch.sh` records its `top=` column as **`VmRSS + VmSwap`**, not
RSS (`gp-memwatch.sh:359` — `printf "%d %s\n", rs + sw`). That is the right
metric for this daemon, whose resident set swings by 5 MB depending on how
recently the kernel swapped it. Footprint this boot:

| Time | netmgrd (RSS+swap) |
| --- | --- |
| 22:38 (boot) | 5 MB |
| 01:09 | 11 MB |
| 06:09 | 20 MB |
| 08:40 | 24 MB |
| 11:50 | 29 MB |
| 13:40 | 36 MB |
| 13:45 (direct `/proc` read) | **37.2 MB** |
| 14:17 (direct `/proc` read) | **38.0 MB** |

**+32 MB in 15.3 h = 2.1 MB/h.** Across the 30 consecutive 10-minute samples
from 08:50 to 13:40 it never decreased. Only a restart resets it — the 5 MB at
22:38 is the reboot, and the 2026-10-13 OOM kill reset it the same way. Baselines
for comparison: **5.7 MB** on the sibling's 2026-08-25 measurement
(`plans/2026-08-25-memory-pressure-reduction.md:33`) and **13.5 MB** in
`memory.md:4952`.

### Where the 37 MB is

Direct census of `/proc/248/smaps`, one VMA at a time:

| Region | Count | Holds |
| --- | --- | --- |
| `~1 MB` anonymous VMAs (`0xfd000`-ish, 1 MB-aligned, consecutive addresses) | **81** | **31,228 kB** — 85 % of the footprint |
| `[heap]` | 1 | 664 kB |
| Thread stacks (8 MB virtual each) | 34 | a few kB each resident |

`VmSize` is 387,812 kB — that is 34 × 8 MB of stack reservation plus arena
reservation, **not** memory in use. Do not quote `VmSize` for this process.

At 13:45 the process was **96 % swapped**: `VmRSS` 1,388 kB, `VmSwap` 35,820 kB.
That is expected with `vm.swappiness=100`: its cold pages are evicted within
minutes, so an RSS sample of this daemon is nearly meaningless and will look like
"it shrank" when nothing was freed.

## What the leaked blocks actually are (read out of the live process)

Dumped from `/proc/248/mem` as root (`bs=4096 skip=$((addr/4096))`, read-only,
~1 MB page-in). Three blocks sampled — `0xa2700000` (the fullest), `0x91800000`,
`0x8f600000` — share a fixed header:

```
+0x00  10 00 70 a2   → 0xa2700010, identical in ALL sampled blocks
+0x04  <block base>  → own base (newest block: 0x00000000)
+0x08  00 d0 0f 00   → 0x000fd000 = 1,036,288 = the chunk size
+0x0c  00 d0 0f 00   → same value again
+0x18  …             → a list head initialised to point at itself (+0x20 = self+0x18)
+0x40  …             → (( newest chunk )) a long run of {self, self} pointer pairs
```

The newest block is ~100 % touched (`32 kB` resident + `980 kB` swapped = the
whole chunk) and its body from `+0x40` on is an array of **self-referential
`{next, prev}` pairs** — empty doubly-linked list heads — stepping by 8 bytes.
`strings -n 5` over 64 kB of it returns **nothing**: no XML, no log text, no
message payload.

**Conclusion (evidence-backed):** this is a **growable administrative table/pool
carved in ~1 MB chunks and initialised as empty lists**, not a data buffer, not a
libxml parse tree, and not log accumulation. One new chunk is committed roughly
every 25–30 minutes. Which netmgr operation allocates one is **not** established
— the callers are closed vendor daemons and the daemon is stripped.

## Why it matters even though its real RAM cost is small

This is the part that is easy to get wrong in either direction.

- netmgrd owns **61 % of the zram swap budget**: `61,348 kB` used of `91,264 kB`.
- But zram holds `68,841,472` bytes of swapped pages compressed into `6,632,564`
  (≈ **10.4 : 1**), so the entire swap in use costs ~7.4 MB of physical RAM and
  netmgrd's share is roughly **3.9 MB**. The leak is **not** eating RAM at the
  rate of its footprint.
- The damage is to the **swap budget**, which is what decides whether the OOM
  killer fires. On 2026-10-13 it did: `Free swap = 0kB`, and the kernel killed
  **netmgrd** because it was the largest process (`30 MB RSS + ~69 MB swapped`).
  Losing it re-programs the cellular data path: `ql-netd` exit 255, `dnsmasq`
  restarted twice, both dashboards accepting TCP and answering nothing for ~2
  minutes at load 22–32 with the CPU 82 % idle. Full record:
  `greenpacket-o5a` → `plans/2026-10-13-memory-pressure-watch.md:14-36`.
- Current state at the time of writing: `oom_kill=0` this boot,
  `allocstall_normal=401`, `pgmajfault=21363`, `MemAvailable` 48–55 MB. The
  last `oom_kill` increment was 2026-10-13, before the current boot.

So: **a swap-budget problem with an OOM-victim consequence, not a RAM-hog.**

## How to re-measure (port this, do not quote ours)

```sh
# Footprint — RSS+swap, never RSS alone for this daemon
awk '/^Rss:|^Swap:/{s+=$2} END{print s" kB"}' /proc/<netmgrd-pid>/smaps_rollup

# Chunk census — the 81 blocks, by size class
# (busybox awk on this device has no strtonum: do the hex maths in the shell)
# zram economics and the swap budget
cat /sys/block/zram0/mm_stat          # orig compr mem_used …
cat /proc/sys/vm/swappiness           # 100 here — why its pages are always cold
grep -E '^(pswpin|pgmajfault|allocstall_normal|oom_kill)' /proc/vmstat

# The trend already exists; the top= column is the process you want
awk -F, 'NR>1 && $16 ~ /netmgrd=/' /data/gp/memwatch-trend.csv | tail -20
```

Judge pressure by `allocstall_normal` / `pgmajfault` **rates** and
`/sys/block/zram0/mm_stat`, never by `free`'s "used" — `free` on this device
reports 126 MB "used" of 178 MB, of which ~55 MB is swapped-out anon and ~46 MB
is kernel slab. (`busybox df` also mislabels the `/usrdata` ubifs mount as
`/etc/machine-id` and prints a bogus 110 MB "tmpfs" row; trust `statfs`, not
`df`.)

## Mitigations, with their real costs

Nothing here is implemented. Each is a decision for the owner, and the curve
above is the input the sibling's 2026-10-13 plan said was missing.

| Option | Reclaims | Cost |
| --- | --- | --- |
| **Scheduled restart, gated on measurement** — restart netmgrd when footprint > ~20 MB *and* `swap_free` below a floor *and* wanmon reports idle traffic | the full 31 MB of chunks | It **is** the 2026-10-13 outage: data-path rebuild, `ql-netd` bounce, `dnsmasq` restarts, tunnel drop. Never on a bare timer. |
| **cgroup `MemoryMax` on `netmgrd`** | bounds it | The leak is monotonic, so this only converts "OOM at an arbitrary moment" into "kill at a chosen moment". Pair with the restart, do not ship alone. |
| Lower `vm.swappiness` | nothing — makes it worse | Would pull 30 MB back into **resident** RAM to save ~4 MB of compression. Do not. |
| Shrink `smartdns` `cache-size` | ~2.5 MB | Already rejected on the sibling (`plans/2026-10-13-memory-pressure-watch.md`): trades a cold-path DNS fault for noise. |
| Vendor ask | the bug | Needs the numbers above; there is no source to patch. A ready-to-send report is the appendix of [`../plans/2026-10-23-netmgrd-memory-growth.md`](../plans/2026-10-23-netmgrd-memory-growth.md#appendix--vendor-defect-report-ready-to-send). |

Prior art in the product's own tree: `turin/feeds/conf/files/common/script/check_conn.sh`
defines `netmgrd_reset()` (`/etc/init.d/netmgrd restart` + `/etc/init.d/ipqcm
restart`), and the call site is **deliberately commented out** (`# D5A …`) in
favour of `wan_reset`. Their own team already decided restarting netmgrd is not a
first-line remedy — weigh that before proposing it as one.

## Reading the risk on this box (and the `swapoff` trap)

`MemAvailable` is **not** the gauge here. At the 2026-10-13 kill it read 44 MB
minutes before the OOM, and it reads 48–56 MB now. The gauge the kernel actually
uses on this device is the **`Normal` zone watermark**, because that is the zone
whose free pages feed every allocation once swap is full:

| `Node 0, zone Normal` (2026-10-23, `managed` 45,633 pages) | Pages | kB |
| --- | --- | --- |
| `min` — the emergency watermark; **crossing it is what OOM-kills** | 1,450 | 5,800 |
| `low` — kswapd wakes | 1,556 | 6,224 |
| `high` — kswapd stops | 1,662 | 6,648 |
| `pages free`, observed over a 5-min window | **1,669 – 2,827** | 6.7 – 11.3 MB |

The 10-13 kill happened at **`Normal free:1656kB vs min:1704kB`** — below `min`.
Today `free` sits at or above `high` (it touched 1,669 pages once, then recovered
to 2,048–2,827), which is kswapd doing its job, not pressure. The absolute margin
is thin — ~2.5 MB above `min` — but the zone is being held in its healthy band.

**What filling the swap would actually cost.** zram's own accounting
(`/sys/block/zram0/mm_stat`) shows 68.7 MB of swapped pages occupying
**7.77 MB `mem_used` / 7.05 MB compressed** — a ratio that drifts between
~9.7:1 and ~10.4:1 across samples. Extrapolated, a **completely full 91 MB swap
would cost ≈9.4 MB of RAM**, i.e. about **+1.6 MB over today**. So swap
*exhaustion* is not itself a memory event: what it removes is the **escape
valve**, after which every new anonymous page has to stay resident and `Normal
free` starts walking toward `min`. That is the actual failure path, and it is why
netmgrd's 2.1 MB/h matters — it is what keeps pushing the valve closed.

Runway, measured rather than extrapolated: a clean 5-minute window (no
`/proc/<pid>/mem` reads) took `SwapFree` from 23,476 to 22,604 kB — **-872 kB,
all of it in the first two minutes, then flat** — with `Normal free` oscillating
1,669 → 2,827 pages. So the slope is bursty, not a steady march, and at 22.6 MB
of free swap there is no imminent exhaustion. Watch it, do not act on it.

```sh
# The one-liner that answers "is this box about to OOM"
awk '/^Node 0, zone/{z=$NF} z=="Normal" && $1=="pages" && $2=="free"{printf "Normal free %d pages (min=1450 high=1662)\n", $3}' /proc/zoneinfo
```

### Do not `swapoff` to reset zram

Do not do it, and do not suggest it (this doc's first draft did — recorded here
as a retraction, because it is a plausible-looking trap). `swapoff` must fault
**every swapped page back into RAM before it can detach the device**: that is
~68 MB of anonymous memory with `MemFree` at 6–11 MB and `Normal free` 2.5 MB
above the OOM watermark. The reset would very likely OOM-kill the largest
process — `netmgrd` — which is precisely the 2026-10-13 outage, self-inflicted.
There is no cheap way to defragment or reclaim zram on a live box of this size.

## Gotchas

- **`memwatch`'s `top=` is RSS+swap, its alert body is not a footprint table.**
  Read the column, not the SMS text.
- **Never edit `/etc/data/netmgr_config.xml`** to turn on its command log
  (`cmd_logging_config`, `disabled_log_options=255`, target
  `/data/netmgr_cmd_log.txt`). It is a vendor-owned rootfs file and outside this
  branch's write set (Hard rule 1). Reading it is fine and informative.
- **`/proc/<pid>/mem` reads work as root here** and are the only way to see what
  a closed daemon is holding. Each read pages the region back in (~1 MB), so read
  one block, not eighty.
- **Do not use `busybox ash` arithmetic on addresses** — it is 32-bit and
  `$((0xa2700000/4096))` silently returns a negative number. Compute hex block
  offsets outside the shell.
- **`/proc/248/io` does not exist** on this kernel (no `CONFIG_TASK_IO_ACCOUNTING`);
  use `/proc/<pid>/stat` fields 14/15 and `voluntary_ctxt_switches` instead.
- **Do not read `/proc/<pid>/mem` casually.** Each read pages the region back in;
  ten blocks pulled ~1 MB in and the swap-free figure moved by several MB, which
  then looks like a trend. Read one block, or accept that you perturbed the
  metric you are about to quote.
- **`free`'s "used" and `MemAvailable` both under-report danger here.** 126 MB
  "used" of 178 MB is normal on this unit, and `MemAvailable` read 44 MB at the
  2026-10-13 kill. Use `Normal free` vs `min`/`high`, plus the
  `allocstall_normal` / `pgmajfault` **rates**.
