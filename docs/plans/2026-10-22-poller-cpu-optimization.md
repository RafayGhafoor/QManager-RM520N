# Plan: poller CPU — where it goes and what to cut

> **Measured:** 2026-10-22 on the O5A Pro (RG520N-EB, SDX6X), firmware
> `LE.UM.6.2.3.r1-03100-SDX65.0`, kernel without `CONFIG_PROC_CHILDREN`.
> **Status:** proposed, not started. **Method:** [`profiling.md`](../reference/profiling.md)
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
total   18.5 % of one core   (independent run; 19.8 % above — same ballpark)
own      1.8 %               utils+stime
kids    16.6 %               cutime+cstime
kids:own ratio  8.8 x
```

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

**It is not the modem and it is not fork cost.** A fork+exec floor is ~2.4 ms; the
missing ~78 ms is the shim's own `cat` readers **busy-spinning** on
`/dev/at_mdm0`: `deploy/atcli_smd11` runs a drain (`cat` + `sleep 0.15`) and a
capture (`cat` + `sleep 0.12`) per call, and a `cat` on a silent tty is a tight
`read()` loop that burns CPU for as long as it lives.

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
- **Target:** per-call CPU 80 ms → **under 20 ms**. That is ~8 points of one core.
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
