# Profiling a QManager daemon

> **Applies to:** RG520N-EB on the GreenPacket O5A Pro (SDX6X) · measured 2026-10-22
> **RM520N-GL / RG501Q-EU:** unverified — see [`platform-matrix.md`](./platform-matrix.md).
> **Tool:** `scripts-dev/qm-profiler.sh` · **Method of record:**
> [`poller-cpu-profile.md`](./poller-cpu-profile.md) — this doc extends it, it does not replace it.

> For the paper trail behind these numbers — the feature that prompted the tool, its
> before/after pair and the edge cases — see
> [`docs/specs/neighbour-live-aim.md`](../specs/neighbour-live-aim.md) and
> [`docs/plans/2026-10-22-o5a-greenpacket-parity.md`](../plans/2026-10-22-o5a-greenpacket-parity.md).

---

## The question it exists to answer

A whole-tree CPU number ("the poller costs 15 % of one core", "+6.7 points while
live") says nothing about what to optimise. `poller-cpu-profile.md` established that
on these SoCs **almost none of a shell daemon's CPU is computation — it is
process-creation overhead**, with `/bin/true` costing 2.40 ms (RM520N-GL) / 4.95 ms
(RG501Q-EU) and `jq` costing 4.3× a normal applet.

So the profiler answers, in order of reliability on this device:

| Question | Answerable here? |
| --- | --- |
| How much of the cost is the process vs its reaped children? | **Yes, exactly** |
| Where does *wall* time go — running, waiting on a child, napping, flock? | **Yes, exact** |
| RSS, peak RSS, `MemAvailable` delta | **Yes** |
| System fork rate, directional | Yes, with a measured noise floor |
| **CPU per child program name** (`qcmd`, `jq`, `awk`…) | **No on this device** — see below |

```sh
sh scripts-dev/qm-profiler.sh                      # qmanager_poller, 60 s
sh scripts-dev/qm-profiler.sh --seconds 30 --lease # exercise a lease-gated path
sh scripts-dev/qm-profiler.sh --save /tmp/a.json && ... --compare /tmp/a.json
```

## The htop trap, now measured on this box

`htop` shows only the parent's `utime+stime`. Every reaped child's CPU is folded into
the parent's `cutime`/`cstime` (stat fields 16/17 after `pid (comm) ` is stripped),
which `htop` does not display. Measured here over 30 s:

```
own   utime+stime     680 ms    2.2 % of one core
kids  cutime+cstime  5030 ms   16.6 % of one core
kids:own ratio                   7.3 x
```

**A parent-only view understates this daemon by ~7×.** Any optimisation aimed at the
parent's shell logic is aimed at 12 % of the cost.

## ⚠️ This kernel has no `CONFIG_PROC_CHILDREN`

`/proc/<pid>/task/<tid>/children` does not exist on the O5A Pro — confirmed
2026-10-22. The per-program table therefore reports `unattributed 100 %` and says so.

**A fallback was implemented and then measured harmful, and is kept only so the claim
is testable.** `--ppidscan` enumerates children by scanning `/proc/*/stat` for a
matching ppid. On this box it drove the instrument to **40.5 % of one core** and
halved the sample count from 261 to 86 in the same window — it contaminates the very
measurement it performs — and attribution was **still 99.3 % unattributed**. It is
off by default and the tool tells you not to reach for it.

**Why attribution cannot work here by sampling at all:** the children are far shorter
than any interval busybox can produce. `qcmd`'s fork+exec floor is ~2.4 ms and a `jq`
call ~11 ms; `sleep 0.1` needs `CONFIG_FEATURE_FANCY_SLEEP` and is detected, not
assumed. A 100 ms sampler sees a child only if it happens to be alive at the tick.
Per-program attribution on this device needs **instrumentation**
(`set -x`-style tracing or a tracing wrapper), not sampling — that is a different
tool, and nobody has built it.

What follows from that: the `kids:own ratio` is the actionable number. It says "the
cost is forks" without saying which forks, and that is enough to justify de-forking —
which is what `poller-cpu-profile.md` already did (251 → 8 fork sites, −41 %/−44 %).

## Reading the output

| Line | Means | Watch for |
| --- | --- | --- |
| `own` / `kids` / `total` | Exact, from `/proc/<pid>/stat` | `kids:own` ≥ 5 ⇒ fork-bound |
| `WALL … running / waiting on child / sleeping` | Time-weighted sample of `state` + `wchan` | `flock` here is **lock wait, not CPU** — a completely different problem |
| `wchan do_wait` | Parent blocked reaping a child | normal for a shell daemon |
| `CHILD CPU BY PROGRAM NAME` | Exact **only** with `CONFIG_PROC_CHILDREN` | on the O5A Pro it is `UNAVAILABLE`, by design |
| `FORKS` | System-wide counter, minus a measured idle baseline | directional only; the noise floor is printed |
| `instrument self` | The profiler's own CPU | **if this is a large share of the target, the run is invalid** |

## Rules for using it as evidence

1. **Capture the baseline before the change.** After deploying, the "before" is gone.
2. **Same window, interval, lease state and target md5.** The tool prints all four in
   the `WINDOW` block precisely so a pasted run can be checked. `poller-cpu-profile.md`
   records the same code measuring 595 vs 815 ms/cycle under different conditions —
   never mix two runs.
3. **Check `instrument self` first.** A run where the tool cost a large fraction of the
   target is not a measurement of the target.
4. **Report the number, not the adjective.** "kids:own 7.3×, wall 58 % waiting on a
   child" is reusable; "fork-bound" alone is not.
5. **Never compare against `poller-cpu-profile.md`'s per-function figures** — those are
   RM520N-GL/RG501Q-EU numbers from a different daemon generation.
6. **The profiler is read-only and unprivileged beyond reading `/proc`.** It writes
   nothing outside `/tmp`, and `--lease` removes the lease it created (and leaves a
   pre-existing one alone).

## Porting notes

| Fact | Portable? |
| --- | --- |
| `cutime`/`cstime` carry reaped-child CPU | Universal Linux |
| `htop` understates a forking shell daemon ~7× | Universal |
| `/proc/<pid>/task/*/children` needs `CONFIG_PROC_CHILDREN` | **Check per kernel** — absent on the O5A Pro |
| `schedstat` needs `CONFIG_SCHEDSTATS`; the tool falls back to 10 ms ticks and says so | Check per kernel |
| Fractional `sleep` needs `CONFIG_FEATURE_FANCY_SLEEP` | Check per BusyBox build |
| `--ppidscan` contaminating the measurement | A consequence of scanning ~400 `/proc` entries per sample; expect it on any small SoC |
