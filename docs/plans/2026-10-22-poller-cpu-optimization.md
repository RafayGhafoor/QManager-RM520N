# Plan: poller CPU — where it goes and what to cut

> **Measured:** 2026-10-22 on the O5A Pro (RG520N-EB, SDX6X), firmware
> `LE.UM.6.2.3.r1-03100-SDX65.0`, kernel without `CONFIG_PROC_CHILDREN`.
> **Status:** round 1 BUILT and deployed 2026-10-22 (see *Round 1 — built and measured* at the end); items open are listed there. **Method:** [`profiling.md`](../reference/profiling.md)
> and [`poller-cpu-profile.md`](../reference/poller-cpu-profile.md).

## The complaint

Owner reports CPU consistently above 50 % and 127 MB of RAM in use. Both
observations were checked rather than assumed, and only one of them is a problem.

## System-wide measurement (30 s window, all pids, no CONFIG_PROC_CHILDREN needed)

```
total 1449 ticks / 30 s  =  48 % of one core

qmanager_poller   19.8 % core   ← 41.1 % of ALL busy CPU
tpws               3.7 %        kworker/u2:5-memlat_wq  3.4 %
qmanager_ping      2.5 %        kworker/u2:3+ipawq35    2.5 %
trafficd           2.3 %        sh (transient)          2.2 %
ipacm              2.1 %        systemd                  1.9 %
modemd             1.0 %        ledd                     0.9 %
```

**So: the poller is the single biggest consumer on the box, at 41 % of all busy
CPU.** Everything else in the list is either the vendor stack doing its job
(`tpws`, `trafficd`, `ipacm`, `modemd`) or the kernel (`kworkers`) — not ours to
optimise. `qmanager_ping` at 2.5 % is the other QManager process and is a separate,
later question.

## Memory: not a problem, do not optimise it

| | |
| --- | --- |
| `MemTotal` / `MemAvailable` | 182 532 kB / 50 472 kB |
| Largest process | **smartdns 8 MB** (vendor) |
| `qmanager_poller` | 3 MB |
| Second largest QManager process | `/usr/bin/sh` 3 MB |
| `Cached` + `Buffers` | 33 MB + 9 MB |

The ~127 MB "used" is dominated by cache and buffers, plus many small vendor
processes. **No single process is big and there is no leak.** A 3 MB poller on a
178 MB device is not worth touching, and "free memory" is supposed to be low on
Linux. Exit this thread: nothing to do.

## Inside the poller

```
clean read, 60 s, instrument self 7.1 % (a valid run)
total   21.3 % of one core
own      2.3 %               utime+stime
kids    19.0 %               cutime+cstime
kids:own ratio  8.0 x

WALL     running 2.7 % · waiting on a child 46.4 % · sleeping/nap 50.8 %
         wchan do_wait 240 · other 277 · flock 0
```

**`flock 0` is the important line:** the poller is not blocked on the AT lock. It
spends 46 % of its wall time waiting for its own children and 51 % napping, which
confirms the cost is *inside* the child invocations, not contention.

Earlier runs in this document (18.5 % / 16.6 % / 1.8 %, ratio 8.8×) were taken with a
profiler build whose `--ppidscan` fallback was on by default, which pushed the
instrument to 38-43 % of one core and halved the sample count. **The
`cutime`/`cstime` split is exact either way** and the two runs agree (8.0-8.8×,
~19 % kids), which is why the plan rests on the ratio and the per-call measurement
rather than on any single total.

**89 % of the poller's CPU is spent in its reaped children.** Optimising the
poller's own shell logic can recover at most ~1.8 points. The 16.6 has to be
explained.

### The dominant term: 80 ms of CPU per AT round-trip

Measured directly — ten `qcmd 'AT+CGMM'` calls timed by the wrapper's own
`cutime`+`cstime`:

```
per-call: cpu = 80 ms   wall = 700 ms
```

The poller issues roughly **80 AT calls a minute** across its tiers:

| Tier | Cadence | Calls/min |
| --- | --- | --- |
| Tier 1 (`AT+QENG="servingcell"`, `AT+QCAINFO`) | every 2 s | ~60 |
| Tier 1.5 (per-antenna `AT+QRSRP;+QRSRQ;+QSINR`) | 1 in 5 | ~6 |
| Tier 2 (~6 read-only calls) | 1 in 15 | ~12 |
| Tier 3 (2 compounds, added 2026-10-22) | 1 in 15 | ~4 |

80 calls × 80 ms ≈ **6.4 s of CPU per minute ≈ 11 % of one core** — the bulk of the
16.6 %.

### ⚠️ CORRECTION — the first diagnosis was wrong, and it was wrong by 3×

The paragraph that stood here blamed `cat` **busy-spinning** on `/dev/at_mdm0`.
That was an inference, not a measurement. Measuring it properly (fork-counter delta
around 10 calls, minus the measured idle fork rate) gives a different answer:

```
one qcmd call:  cpu 83 ms,  forks 26
fork floor:     26 x 2.4 ms = 62 ms   ->  76 % of the cost IS fork+exec
residual:                     21 ms   ->  24 % is everything else
```

So the cost is **fork count**, not spinning. `qcmd` (a shell) + `flock` + the shim
(a shell) + two `cat`s + three to eight `sleep 0.25`s in the retry loop + `grep` +
`kill`/`wait` — that is ~26 processes for one `AT+CGMM`.

**Consequence for A1: the original target ("80 ms → under 20 ms, ~8 points") is
unreachable.** 21 ms of residual exists no matter what the fork count is, and every
remaining fork costs 2.4 ms. A1's realistic band is **3–5.5 points**, not 8. The
target line below has been corrected accordingly.

## Ranked actions

### A1 — Stop the shim burning CPU while it waits (biggest single win)

`deploy/atcli_smd11` spends ~0.27 s of two spinning `cat` processes per call. At 80
calls/min that is ~21 cpu-seconds/min of reader time; even at a modest duty cycle it
dominates.

- Replace the drain/capture `cat` with a bounded, non-spinning read (`dd bs=… count=1
  iflag=nonblock`, or a `timeout`-limited read that exits on first byte), so an idle
  port costs a syscall block instead of a spin.
- Or drop the drain entirely when the previous call ended on a terminator — it exists
  to clear *stale* bytes, and the shim already knows when it consumed a full response.
- **Target (corrected):** forks/call 26 → ~13, i.e. per-call CPU 80 ms → ~50 ms.
  That is **3–5.5 points** of one core, realistically **~4**. Removing two `cat`s and
  using one bounded read instead of the `sleep`-and-check loop is where the forks
  are; the 21 ms residual sets a floor the fork work cannot cross.
- **Before starting, count forks per component** — 19 of the 26 may be inherent to
  `qcmd`'s design, in which case A1 lands near the 3-point end and A2 becomes the
  real lever.
- **Risk:** the drain is what prevents the truncated-reply bug (`AGENTS.md` hard rule
  3). Any change must keep the "no stale bytes" guarantee and be proved by the same
  five-consecutive-`AT+CGMM` test plus a `+QENG` parse check.

### A2 — Fewer calls, by batching (the lever Tier 3 already proved)

Tier 3 replaced eleven separate `qcmd` calls with **two compounds**. Tier 1 and 2
still make one call per command.

- Merge Tier 1's `AT+QENG="servingcell"` and `AT+QCAINFO` into one compound.
- Merge Tier 2's six reads into two compounds, as Tier 3 does.
- **Constraint that shapes this:** `qcmd` rejects an *entire* compound response on
  `*ERROR*`, so group by "commands known to answer" — never put a command that can
  error in with ones that must survive.
- **Target:** ~80 → ~30 calls/min, another ~6 points.

### A3 — `jq` → `awk` on the hot path

`jq` costs **4.3× a normal applet** (`poller-cpu-profile.md`). The poller has 13 `jq`
sites. Only the ones on the per-cycle path matter; single-field extraction in `jq` is
the classic case for `awk` or pure-shell parameter expansion.
- **Target:** remove 3–5 per-cycle `jq` invocations.

### A4 — Consider the cadence last, and only as a product decision

Halving the poll rate halves the cost of everything above, and also halves the
dashboard's freshness. **Do not reach for this before A1–A3**, which remove cost
without changing behaviour. If it is still needed, `TIER2_EVERY` is the safer knob
than `POLL_INTERVAL`, because Tier 2 carries the slowest-moving data.

### Explicitly not worth doing

- **Memory work.** Nothing above 8 MB; see above.
- **Touching `tpws`, `trafficd`, `ipacm`, `modemd`, `kworkers`.** Vendor stack and
  kernel; 3.7 % or less each, and not ours.
- **Replacing the shell poller with Go.** `poller-cpu-profile.md` measures a Go
  equivalent at 2.39 ms/cycle and 6.3 MB, but that is a rewrite with a new binary to
  ship, sign and maintain (hard rules 1 and 9). A1+A2 should land first and may make
  it unnecessary.

## How to prove each step

Per `AGENTS.md` → *Measure it, then prove the edges*:

```sh
# baseline MUST be captured before the change
PID=$(systemctl show -p MainPID --value qmanager-poller)
sed 's/^[0-9]* (.*) //' /proc/$PID/stat | awk '{print $14+$15}'   # before
# ... deploy ...
#   after, same 60 s window, same lease state, same target md5
sh scripts-dev/qm-profiler.sh --pid $PID --seconds 60 --save /tmp/after.json
```

Record: total CPU as a share of one core, `own` vs `kids`, RSS, and **per-call qcmd
CPU** (the `/tmp/atcost.sh` measurement above) so A1's claim is falsifiable on its
own.

**Success looks like:** poller from 19.8 % → under 12 % of one core, with the
dashboard's refresh cadence unchanged and no new `poll_cycle exceeded budget`
warnings. Follow-up #2 in
`.orchestra/runs/2026-10-22-o5a-neighbours-and-detailed-metrics.md` — measure the
Tier-1 cycle duration properly under Tier 3 — should be folded into the same run,
since A2 changes exactly that.

## Porting note

The 80 ms per AT round-trip is **a property of this shim on this device**, not a
universal truth. `poller-cpu-profile.md` records RM520N-GL and RG501Q-EU fork costs;
neither was measured with this shim. **Re-measure per device before assuming A1's
target.** The structural finding — that a busy-waiting reader costs more than the
work it waits for — does generalise.

---

## Can this reach 25 % of one core? (owner question, 2026-10-22)

Measured attribution of the 48 % total:

| Owner | Points | Detail |
| --- | --- | --- |
| **QManager** | **~26** | poller 19.8 · `tpws` 3.7 · `qmanager_ping` 2.5 · transient `sh` |
| Vendor / kernel | **~22** | kworkers 7.0 · trafficd 2.3 · ipacm 2.1 · systemd 1.9 · modemd 1.0 · ledd 0.9 · ~180 small procs 4.6 |

**`tpws` is OURS, not vendor** — verified: pid 9876 is `qmanager-dpi.service`'s
MainPID. That 3.7 points belongs to the Traffic Engine.

### The floor is ~22 points

Vendor and kernel are not ours to move. **QManager must fall from ~26 points to
~3–5** to hit 25 % — a 5–8× cut, not a 2× one.

| Option | Poller | tpws | ping | **Box** | Verdict |
| --- | --- | --- | --- | --- | --- |
| today | 19.8 | 3.7 | 2.5 | **48 %** | — |
| A1 | ~14 | 3.7 | 2.5 | ~43 % | not close |
| A1+A2+A3 | ~10 | 3.7 | 2.5 | ~39 % | not close |
| + A4 (2 s → 4 s) | ~5.5 | 3.7 | 2.5 | ~33 % | halves freshness |
| + (4 s → 8 s) | ~3 | 3.7 | 2.5 | ~30 % | visibly stale |
| + trim tpws/ping | ~3 | ~1 | ~1 | ~27 % | loses Traffic Engine fidelity |
| **compiled poller** | **~0.5** | 3.7 | 2.5 | ~30 % | one lever, no staleness |
| **compiled + trimmed** | ~0.5 | ~1 | ~1 | **~24–25 %** | reaches the target |

**Conclusion: shell optimisation alone cannot reach 25 %.** Best case with the shell
poller and every non-essential feature trimmed is ~30 %, and the dashboard would
refresh every 8 s.

25 % needs one of:
1. **A compiled poller.** `poller-cpu-profile.md` measures a Go equivalent at
   **2.39 ms/cycle, 0 forks** → ~0.1 % at a 2 s interval, i.e. 19.8 → ~0.5. The only
   change that removes ~19 points *without* touching freshness. Cost: a new binary to
   build, ship and maintain (hard rules 1 and 9), and a rewrite.
2. **Interval 2 s → 8 s** on the shell poller: ~30 %, still short, and stale.
3. **Drop features**: Traffic Engine off (−3.7), ping to one target (−1.5).

### The decision this needs — not yet answered

- **25 % is a hard requirement** (thermal, battery, vendor SLA) ⇒ **A1/A2 are the
  wrong work**; do not start them. Go straight to the compiled poller.
- **"Get it down as far as is sane"** ⇒ **target ~33 %** via A1+A2+A3+A4. That is
  48 → 33 with no feature loss and no new binary, and 25 % costs a rewrite for 8
  further points nobody would perceive on a single-core box that already idles 52 %
  of the time.

**Recommendation: 33 %, not 25 %.** A1 and A2 are only worth doing under the second
reading.

---

## Round 1 — built and measured (2026-10-22)

Aimed by a **per-segment** profile rather than the per-program one above:
[`scripts-dev/qm-poller-segprof.sh`](../../scripts-dev/qm-poller-segprof.sh) runs
the real poller code with a probe after every step of `poll_cycle`. Full tables
and the edge-case evidence are in
[`poller-cpu-profile.md` → O5A profile](../reference/poller-cpu-profile.md#o5a-profile-rg520n-eb-2026-10-22).

### What the segment profile showed (before, 60 cycles / 505 s)

`ca_info_read` 282 ms/cycle · `detect_events` 211 · `parse_ca_info` 157 ·
`poll_tier2` 147 (amortised) · `poll_serving_cell` 117 · per-antenna 92 · Tier 3 68 ·
`update_data_used` 53 · `write_cache` 46. Whole cycle ~1334 ms, period 8.36 s,
**16.0 % of one core**.

Two of the top three were not on this plan's list: **`detect_events`** (an
SCC-handoff check gated on a JSON string that changes every cycle, ~11 `jq` per
cycle) and **`parse_ca_info`** (~55 processes per cycle). The QCAINFO read itself
was three AT calls.

### What was built (maps onto A1–A3)

| Plan item | Change | File |
| --- | --- | --- |
| A1 (shim) | drain → `/dev/null`, builtin terminator poll, `tr` + expansion instead of `tr\|sed`; retry allowlist gains the CA compound | `deploy/atcli_smd11` |
| A1 (qcmd) | `chmod 666` on the lock only when created | `scripts/usr/bin/qcmd` |
| A1 (logging) | filtered DEBUG lines no longer fork (`_qlog_lvl`, early return in `qlog_at_cmd`, no `$(dirname)`) — every CGI benefits | `scripts/usr/lib/qmanager/qlog.sh` |
| A2 (batching) | `AT+QCAINFO=1` / read / `=0` → one compound; `=0` re-sent alone if the compound fails | `scripts/usr/bin/qmanager_poller` `ca_info_read` |
| A3 (jq) | SCC check gated on `t2_scc_sig` (tech:band:pci); event state written only when its content changes | `scripts/usr/lib/qmanager/events.sh` |
| A3 (parse) | `parse_ca_info` → one awk pass + the unchanged jq; byte-identical on 8 fixtures | `scripts/usr/lib/qmanager/parse_at.sh` |
| — | main-loop cycle timer from `/proc/uptime` instead of 2 × `date` | `scripts/usr/bin/qmanager_poller` `main` |

### Measured after (112 cycles / 722 s, same harness and conditions)

| | Before | After |
| --- | ---: | ---: |
| Whole cycle CPU | ~1334 ms | **~771 ms (−42 %)** |
| Cycle period | 8.36 s | **6.39 s** |
| Poller, % of one core (harness) | 16.0 % | **12.1 %** |
| Poller, % of one core (live, 60 s) | 13.4 % | **10.8 %** |
| Box fork rate | 111 /s | **90 /s** |
| Per AT call (`AT+CGMM`) | 78–86 ms CPU, 411–739 ms wall | **53 ms CPU, ~345 ms wall** |
| Poller RSS | 2.5 MB | 2.5 MB |

The −42 % per cycle shows up as only −24 % CPU share because the cycle also got
2 s shorter and runs 31 % more often — exactly the effect that made the broker A/B
look like "no win" (see the note added to `at-broker.md`). The "under 12 %" success
line in *How to prove each step* is met on the live daemon (10.8 %).

### Deployed

2026-10-22 03:03 UTC, files replaced atomically (`.new` + `mv`) and the poller
restarted once. Pre-change copies: `/usrdata/qmanager/backup/pre-poller-opt-20261022-030314.tgz`
(rollback = extract over `/usrdata/qmanager` and restart the poller). Verified after:
all four units active, `:80` 200, `:8080` 200, status JSON live (RG520N-EB, 5G-NSA,
Jazz, 3 carriers, NR SCC RSRP present — i.e. the `=1` leg of the compound took).

### Still open (ranked by after-profile ms/cycle)

1. `poll_tier2` — 1890 ms per call, ~1774 processes; batch its reads (A2).
2. `poll_per_antenna_signal` — 452 ms per call; per-line greps + `jq -n` append.
3. `update_data_used` — 53 ms every cycle: `grep` + 2 `awk` + `date` + a jq write.
4. `poll_serving_cell` 94 / Tier 3 50 / `write_cache` 45 / `read_ping_data` 33.
5. Cadence (A4) is still a product decision; nothing here changed `POLL_INTERVAL`.
