# Poller CPU Profile

> **Applies to:** RM520N-GL (SDX6X) · RG501Q-EU (SDX55) — **both measured live**
> Serials: `61368cd2` (RM520N-GL) · `b7e3d6f1` (RG501Q-EU)
> **Baseline profiled** 2026-09-01 · **de-fork pass measured** 2026-09-02
> **O5A Pro (RG520N-EB) section** — [O5A profile](#o5a-profile-rg520n-eb-2026-10-22): measured 2026-10-22, scope `RG520N` only

`qmanager_poller` is the single largest CPU consumer on both devices — **85% of all busy CPU** on the RM520N-GL before the de-fork pass. This document records what it actually spends that CPU on, measured rather than estimated, so that any optimisation effort (further de-forking, helper binaries, or a full rewrite) is aimed at the right functions.

The headline is counter-intuitive and worth stating up front:

> ⚠️ **Almost none of the poller's CPU is computation.** It is process-creation overhead. "Fork+exec" is what a shell does every time it runs an external program: it clones itself (`fork`), then replaces the clone with the new program (`execve`). On these SoCs that costs more than the program's actual work. A `/bin/true` — a program that does nothing — costs **2.40 ms of CPU** on the RM520N-GL and **4.95 ms** on the RG501Q-EU. The poller forked roughly **220 times per cycle**. Multiply those and you have essentially the entire measured cost. Optimising the *logic* of these functions achieves nothing; only removing `$(...)`, pipes, and exec sites moves the needle.

> ⚠️ **htop under-reports the poller by ~9×.** See [The htop trap](#the-htop-trap). Never quote htop's poller `CPU%` or `TIME+` as the cost.

**What has already been done.** A de-fork pass (commits `931b32e..a95c098`, 2026-09-02) rewrote four functions with no behaviour change, taking their combined static fork sites from **251 to 8**, and cutting attributed child CPU by **41% / 44%**. See [The 2026-09-02 de-fork pass](#the-2026-09-02-de-fork-pass) for the paired measurements, and [Ranked remediation](#ranked-remediation) for what is left.

---

## Quick Reference

| Item | Value |
|------|-------|
| Daemon | `qmanager_poller` (`scripts/usr/bin/qmanager_poller`, installed `/usr/bin/qmanager_poller`) |
| Poller share of one core | **30% → 23%** (RM520N-GL) · **31% → 26%** (RG501Q-EU) after the de-fork pass |
| Attributed child CPU per cycle | **595 → 351 ms** (RM520N-GL, −41%) · **877 → 487 ms** (RG501Q-EU, −44%) |
| Same, incl. unattributed residual | 769 → 500 ms (RM520N-GL) · 1079 → 664 ms (RG501Q-EU) |
| Measured cycle cadence | **3.39 → 3.18 s** (RM520N-GL) · **5.00 → 4.01 s** (RG501Q-EU) — **not** the 2 s `POLL_INTERVAL` |
| Fork sites removed | `parse_serving_cell` 184→3 · `update_system_health` 37→4 · `update_proc_metrics` 22→0 · `qcmd_exec` 8→1 |
| System-wide CPU busy (baseline) | 38.3% (RM520N-GL) · 39.1% (RG501Q-EU) — kernel time **1.6× user time** |
| Go equivalent, same work | **2.39 ms/cycle** (RM520N-GL) · 2.84 ms (RG501Q-EU), **0 forks**, 6.3 MB RSS |
| Proof | No harness or gates — `scripts/test/` was deleted 2026-09-03 (it held `qm_fork_probe.sh`, `poller-defork-forkcount.sh` and `poller-defork-equivalence.sh`; see [The 2026-09-02 de-fork pass](#the-2026-09-02-de-fork-pass) for what they used to check). Re-measure on the device and byte-compare output by hand |

> ℹ️ **NOTE:** the "before" figures above come from the de-fork pass's own paired baseline runs (pinned AT fixtures, 2026-09-02), **not** from the original 2026-09-01 profiling run. The two used different durations and different device conditions, so their absolute numbers differ — 595 ms/cycle here against the original run's 815 ms, for instance. Never mix a number from one run with a number from the other. The original run's per-function figures are preserved below as the historical baseline they were.

---

## O5A profile (RG520N-EB, 2026-10-22)

> **Scope: `RG520N`** — GreenPacket O5A Pro, Quectel RG520N-EB, SDX6X, BusyBox
> 1.31.1 ash, bash 3.2.57, CONFIG_HZ 100. Nothing in this section is a claim about
> the RM520N-GL or RG501Q-EU, and the O5A's AT transport (`deploy/atcli_smd11` on
> `/dev/at_mdm0`) does not exist on either of them.
> **Harness:** [`scripts-dev/qm-poller-segprof.sh`](../../scripts-dev/qm-poller-segprof.sh)
> — per-segment `cutime`+`cstime`, real `qcmd`, poller unit stopped for the window.
> **Work record:** [`../plans/2026-10-22-poller-cpu-optimization.md`](../plans/2026-10-22-poller-cpu-optimization.md).

The one thing that differs from the table above: on this device **the AT
transport is half the poller.** Every `qcmd` call is `qcmd` (sh) → `flock` → the
`atcli_smd11` shim (sh) → two `dd` readers, `sleep`s, a `grep` poll loop and a
`tr | sed` cleanup. One call measured **78–86 ms of CPU and ~0.4–0.7 s wall**.

### Before / after — same harness, same unit, idle device, no scan, no live lease

Both runs: `qm-poller-segprof.sh`, real AT, 5G-NSA on Jazz (PCC B1 + SCC B3 + NR
N41). Before = 60 cycles / 505 s; after = 112 cycles / 722 s. `ms/cycle` is
amortised (a 1-in-15 tier divided over every cycle). Whole-cycle figures exclude
the harness's own report cost (~26 ms/cycle, carried by `main_date_calls`).

| Segment | Before ms/cycle | After ms/cycle | Change |
| --- | ---: | ---: | --- |
| `ca_info_read` | **282** | **86** | 3 AT calls → 1 compound + cheaper transport |
| `detect_events` | **211** | **14** | SCC check gated on a signature; state file written on change only |
| `parse_ca_info` | **157** | **40** | one awk pass + the same jq (was ~55 processes) |
| `poll_tier2` (1-in-15) | 147 *(2217/call)* | 135 *(1890/call)* | transport only |
| `poll_serving_cell` | 117 | 94 | transport only |
| `poll_per_antenna_signal` (1-in-5) | 92 *(462/call)* | 92 *(452/call)* | untouched — open |
| `poll_tier3` (1-in-15) | 68 | 50 | transport only |
| `update_data_used` | 53 | 53 | untouched — open |
| `write_cache` | 46 | 45 | untouched — open |
| main-loop timing *(+ harness report)* | 37 | 29 | `date +%s` ×2 → `/proc/uptime`: ~10 → ~3 ms real; the other ~26 is the harness in both runs |
| everything else | 151 | 159 | — |
| **Whole cycle** (rows sum to this incl. harness: 1361 / 797) | **~1334 ms** | **~771 ms** | **−42 % per cycle** |
| **Cycle period (wall)** | **8.36 s** | **6.39 s** | −24 % (fresher data) |
| **Poller, % of one core** | **16.0 %** | **12.1 %** | −3.9 points |

Live daemon, same 60 s method as `memory.md` (not the harness): **13.4 % → 10.8 %
of one core; box fork rate 111/s → 90/s; poller RSS 2.5 MB (unchanged).**

> ⚠️ **Per-cycle CPU fell 42 %, CPU share only 24 %** — because the cheaper cycle
> also finishes 2 s sooner, so there are 31 % more cycles per minute. The
> `poll_cycle exceeded budget` warnings that fired every Tier-2 cycle (24–27 s)
> came from the same wall time. Quoting either number without the other is
> misleading. Converting the rest of the per-cycle win into CPU share is a cadence
> decision (`POLL_INTERVAL`), not an optimisation, and has not been made.

### The AT transport, per call (A/B, 15 × `AT+CGMM`, poller stopped)

| | CPU ms/call | wall ms/call |
| --- | ---: | ---: |
| before (installed shim) | 86 / 78 | 739 / 411 |
| after | **53 / 53** | **349 / 344** |

Two runs each, interleaved old/new/old/new. Output parity checked on `AT+CGMM`,
`ATI`, `AT+QENG="servingcell"`, `AT+QCAINFO`, `AT+CFUN?`, plus the error paths
`AT+FOOBAR` and `AT+QTEMP`: same exit code, same stderr, same `-j` JSON, same
stdout (digits masked for the live RF values).

What changed, all behaviour-preserving:

1. **`qlog.sh` — DEBUG lines cost processes even when discarded.** `_qlog_write`
   ran `$(_qlog_level_num …)` twice per call (two subshells) before deciding to
   drop the line, and `qlog_at_cmd` built its truncated copy (`printf|cut`,
   `echo|tr|tr`) before calling a DEBUG logger that then dropped it. `qcmd` logs
   two DEBUG lines per AT call. Now: level mapping sets a variable, `qlog_at_cmd`
   returns before building anything when DEBUG is filtered, `qlog_init` uses
   `${QLOG_FILE%/*}` not `$(dirname)`. **This library is sourced by every CGI too.**
2. **`qcmd` — `chmod 666` ran on every call.** Now only when it creates the lock.
3. **`atcli_smd11`** — drain straight to `/dev/null` (no temp file, no `rm`); the
   terminator poll is a builtin `read` loop instead of a `grep` per tick; the
   final `tr | sed '/./,$!d'` is one `tr` plus parameter expansion. The drain,
   the read-before-write order, the `dd` writer and the retry allowlist are
   unchanged (the allowlist gained the new read-only CA compound).

### Negative / non-obvious results

- **The QCAINFO toggle is not removable here.** `AT+QCAINFO` after `=0` returns
  the NR SCC as `"NR5G BAND 41",47` — no RSRP/RSRQ/SNR. With `=1` it is
  `"NR5G BAND 41",47,-67,-11,2529`. `AT+QCAINFO=?` answers
  `"5g_signal_ext",(0,1)`. The fix kept the toggle and folded it into one
  compound, `AT+QCAINFO=1;+QCAINFO;+QCAINFO=0`, which returned the same lines.
- **`detect_events`' cost was not event handling.** The SCC-handoff check is gated
  on "carrier list changed", and since QCAINFO moved to every cycle that JSON
  changes every cycle (it carries RSRP/SINR). So ~11 `jq` processes ran every
  cycle to compare tech/band/PCI that had not moved.
- **`parse_ca_info` rewrite is byte-identical** to the shell version on 8 fixtures
  (live NSA, NSA without NR signal, SA long-form with `-32768` and a non-numeric
  SNR, `NRDCBAND`, unknown band, short line, trailing commas, empty input, `OK`
  only, a zero-padded `06` RB count). Measured in isolation: **130–136 → 33–35
  ms/call**.

### Round 2 (same day) — Tier 2, Tier 1.5, Data Used, and a 12.9 s AT read

A per-function micro-bench (each parser × 5 on captured AT replies) and per-command
AT timings located the remaining cost:

| Found | Measured | Fix |
| --- | --- | --- |
| **`AT+CGCONTRDP` took 12.9 s every Tier-2 pass** | reply cut at 254 B, no `OK`, shim waited its full budget | shim reader `bs=256` → `bs=4096`: 0.34 s, full 288 B + `OK` ([platform-matrix](./platform-matrix.md) "PACKET device") |
| `parse_temperature` → `read_temperature_sysfs` | **402 ms/call**, 163 processes: `$(cat)` over 42 thermal zones | `read` builtins |
| `parse_qrsrp/qrsrq/qsinr` | **~300 ms per Tier-1.5 pass**: ~15 processes per antenna line | `_ant_pick` / `_ant_json`, zero forks; identical output on 7 fixtures incl. garbage lines |
| `update_data_used` | **58 ms every cycle**: `grep` + 2 `awk` + a `jq` + `mv` to **flash** | builtin `/proc/net/dev` read; state persisted every ≥ 30 s (was every cycle, ~14k ubifs rewrites/day) — health check's < 60 s freshness still met (observed 31–33 s) |

Same harness, same conditions, 164 cycles / 723 s:

| | Baseline | Round 1 | **Round 2** |
| --- | ---: | ---: | ---: |
| Whole cycle CPU (excl. harness) | ~1334 ms | ~771 ms | **~592 ms (−56 %)** |
| Cycle period | 8.36 s | 6.39 s | **4.35 s** |
| Poller, % of one core (harness) | 16.0 % | 12.1 % | 13.6 % |
| Poller, % of one core (live, 60 s) | 13.4 % | 10.8 % | 13.5 % |
| Box fork rate (live) | 111 /s | 90 /s | **63 /s** |
| `poll_tier2` per call | 2217 ms CPU / ~18 s wall | 1890 ms / ~18 s | **1168 ms / ~5 s** |
| `poll_per_antenna_signal` per call | 462 ms | 452 ms | **114 ms** |
| `update_data_used` per cycle | 53 ms | 53 ms | **17 ms** |
| `poll_cycle exceeded budget` warnings | every Tier-2 pass (22–27 s) | every Tier-2 pass | **none since deploy** |

> ⚠️ **Read the share row with the period row.** Each cycle now costs 56 % less,
> and the poller finally runs at the cadence its code describes (body + 2 s sleep
> ≈ 4 s; the O5A was at 8.4 s only because AT calls were slow and one of them
> timed out every Tier-2 pass). At the OLD 8.36 s period the new cycle would be
> **~7 % of one core**; at the NEW 4.35 s period the OLD cycle would have been
> **~31 %**. The share stays ~13 % because the saving was spent on 1.9× fresher
> data. Turning it into idle CPU is a cadence decision — see the plan doc.

### Round 3 — the whole box: spikes, the ping daemon, the CGIs, and a fixed period

Asked "the box swings 38–80 %, why", so this round measured **every process, every
second** with [`scripts-dev/qm-spike-sampler.sh`](../../scripts-dev/qm-spike-sampler.sh)
(300 samples, idle device, no browser on the QManager UI). ⚠️ The sampler costs
**~14 % of one core** itself (a `cat` of ~220 `/proc/*/stat` + one awk per second);
it is a separate `sh` row, subtracted below. The per-second busy histogram
**includes** it.

**Who was on the CPU (before round 3, 398 s window):** `qmanager_poller` 11.9 % ·
kworkers (ipawq/memlat) ~4.3 % · `qmanager_ping` 2.4 % · `trafficd` 2.2 % ·
`modemd` 1.5 % · `ledd` 1.3 % · `tpws` 1.3 % · `gp-wanmon.sh` 1.1 % · `systemd`
1.1 % · rest small. Box busy excluding the sampler **45.3 %**.

**Periodic bursts found** (vendor ones recorded, not changed — hard rule 2):

| Burst | Size / period | Owner | Action |
| --- | --- | --- | --- |
| poller cycle | ~0.5 s CPU every 3.7–4.4 s | QManager | fixed period (below) |
| `qmanager_ping` | ~120 ms every 5 s | QManager | de-forked (below) |
| `modemd` | **~30 % of a second every ~22 s** | vendor | none — `gp-metricsd` only polls modemd while the vendor UI is open, so this is modemd's own timer |
| `systemd` | 21–57 ticks every 60 s | `qmanager-dpi-ensure.timer` (ours) + vendor timers | ensure measured at **190 ms CPU per run**; left as is |
| dashboard CGIs | 3 requests / 2 s while the QManager UI is open | QManager | base cost halved (below) |

**Changes:**

| Change | File | Measured |
| --- | --- | --- |
| Serving cell + CA in ONE compound `AT+QENG="servingcell";+QCAINFO=1;+QCAINFO;+QCAINFO=0` (340 B reply, 0.6 s); falls back to the two-call sequence on any failure | `qmanager_poller` `poll_tier1_at` | one AT transport (~53 ms) + one 0.1 s sleep fewer per cycle |
| Fixed cycle period `POLL_PERIOD=5` (start-to-start), `POLL_INTERVAL` kept as the minimum gap; old short gap while a live-neighbour lease is held | `qmanager_poller` `main` | period 3.66 s → **5.17 s**; poller **12.9 % → 8.9 %** (live, 150 s windows) |
| `qmanager_ping`: clock via `read`, not `$(cut\|cut)` ×4; RTT/address in one awk instead of ~12 processes | `qmanager_ping` | **2.4 % → 1.4 %**; identical results on 7 ping-output fixtures (iputils, BusyBox, IPv6, 100 % loss, 0.0 ms, empty) |
| CGI base: `tz.posix` via `read`; uid from `/proc/self/status`; `timeout` probe cached in `/tmp/qmanager_timeout_probe` (only the two known binaries accepted — `/tmp` is world-writable); cookie/token/session checks in shell builtins | `cgi_base.sh`, `platform.sh`, `cgi_auth.sh` | `fetch_data.sh` **40 → 21 ms**, `modem-subsys.sh` **60 → 40 ms** per request |
| `data_used.sh`: one jq (with jq `now`) instead of `date` + 3 jq | `network/data_used.sh` | **84 → 34 ms** per request |

CGI parity: 6 endpoints × 8 cookie cases (valid, among others, `=x` suffix, empty,
short, expired session, upper-case hex, no space after `;`) → byte-identical old vs
new, including the 401 bodies and the expired-session file being removed.
Dashboard open (3 CGIs / 2 s): **~184 → ~95 ms per 2 s, i.e. ~9.2 % → ~4.8 % of a
core** on top of the figures below.

**After (all of round 3, 300 samples, same tool, same idle conditions):**

| | Before round 3 | After |
| --- | ---: | ---: |
| Box busy, sampler excluded | **45.3 %** | **32.0 %** |
| `qmanager_poller` | 11.9 % | **9.1 %** |
| `qmanager_ping` | 2.4 % | **1.4 %** |
| Seconds ≥ 70 % busy (sampler included) | 65 / 300 | **20 / 300** |
| Seconds ≥ 80 % busy (sampler included) | 23 / 300 | **9 / 300** |
| Mean busy (sampler included) | 58.6 % | 46.0 % |

`trafficd`, `modemd`, `ledd`, kworkers and `systemd` were flat between the runs
(vendor/kernel, ±0.3 points). What is left of the ~32 % is roughly a third
QManager (poller 9, ping 1.4, tpws/DPI traffic-dependent) and two thirds vendor
and kernel.

### Still open on this device (round-2 profile, ms/cycle)

| # | Target | ms/cycle | Note |
| --- | --- | ---: | --- |
| 1 | `poll_serving_cell` | 96 | one AT call (~53 ms) + parse |
| 2 | `ca_info_read` | 92 | one AT call; parse is separate |
| 3 | `poll_tier2` | 78 *(1168/call)* | remaining small parsers (`parse_cgcontrdp` 64, `sim_registry_refresh_active` 60, `parse_carrier` 40 ms/call) |
| 4 | `write_cache` | 47 | the one big `jq` — probably the floor |
| 5 | `parse_ca_info` | 42 | the kept `jq` (byte-identity) is most of it |
| 6 | `read_ping_data` | 32 | |
| 7 | `poll_tier3` | 24 *(404/call)* | jq-heavy PHY snapshot |
| — | the AT transport itself | ~53/call | two shells + `dd` + `sleep`s per call. The remaining structural lever is a resident transport (the broker), not more shell trimming |

---

## The htop trap

htop shows only the parent bash process's `utime` + `stime`. Every helper the poller forks is reaped, and a reaped child's CPU is accumulated into the parent's **`cutime`/`cstime`** (fields 16 and 17 of `/proc/<pid>/stat`), which htop does not display.

Measured over 59 s on the RM520N-GL, before the de-fork pass:

| | ticks/59 s | % of one core |
|---|---:|---:|
| Poller's own time (**what htop shows**) | 211 | 3.6% |
| Poller's reaped children (**hidden**) | 1713 | **29.0%** |
| **Poller tree total** | 1924 | **32.6%** |
| All other processes combined | 341 | 5.7% |

The poller tree was **85% of all busy CPU on the device**. A `TIME+` of 38:34 over 19 h of uptime is the *parent only* and is ~3.4% — consistent with the 3.6% above, and ~9× too low as a measure of what the daemon costs.

**To read the real number:**

```bash
awk '{print "own:", $14+$15, "children:", $16+$17}' /proc/$(pgrep -f /usr/bin/qmanager_poller | head -1)/stat
```

The trap does not go away after de-forking. In relative terms it eases — the pass removed child forks, so more of what remains is parent time htop can see — but the residual children are still invisible.

---

## The cost of one fork+exec

200 samples per binary, stdin pinned to `/dev/null`, CPU measured via `cutime`+`cstime` delta. These are device constants and are unaffected by the de-fork pass.

| binary | RM520N-GL (SDX6X) | RG501Q-EU (SDX55) |
|---|---:|---:|
| `/bin/true` — **pure fork+exec floor** | **2.40 ms** | **4.95 ms** |
| `cut` / `date` / `stat` / `sed` | ~2.6 ms | ~5.1 ms |
| `awk` / `head` / `cat` / `tr` / `wc` | ~2.7 ms | ~5.1 ms |
| `grep` | 3.55 ms | 4.85 ms |
| **`jq`** | **11.10 ms** | **13.75 ms** |
| subshell `$( )`, no exec | 0.65 ms | 0.85 ms |

Three things follow:

1. **`/bin/true` costing 2.4 ms while doing nothing is the whole story.** That is `fork` + `execve` + ELF load + dynamic-linker relocation + libc init. The work the applet then performs is nearly free by comparison.
2. **`jq` is 4.3× a normal applet.** Every `jq` call for a single-field extraction costs as much as four other forks. Batch or eliminate it first.
3. **The SDX55 pays ~2× per exec.** The same script hurts the RG501Q-EU roughly twice as much, which is also why de-forking helps it more (−44% against −41%).

A useful sanity check on the baseline: 815 ms ÷ ~220 forks ≈ **3.7 ms average**, which is exactly what a mix of ~2.6 ms applets and 11.1 ms `jq` calls predicts. The CPU accounting and the fork accounting agree independently, so neither is an artifact.

---

## Per-function attribution (baseline, 2026-09-01)

**This table is history, kept deliberately.** It is the measurement the de-fork pass was aimed by and argued from, and it describes the poller as it was *before* commits `931b32e..a95c098`. Rows marked ✅ have since been rewritten — see the next section for their post-change figures.

Amortised across **every** cycle (so a Tier-1.5 function that runs 1-in-5 shows its true contribution to the average cycle). `ms/cycle` is exact — it comes from per-process `cutime`+`cstime` deltas. `forks/call` is a system-wide counter delta and carries ~96/s of background noise; treat it as indicative, not exact.

| function | RM520N ms/cycle | share | RG501Q ms/cycle | forks/call (RM/RG) | cadence | status |
|---|---:|---:|---:|---:|---|---|
| `poll_serving_cell` | **200** | 25% | **238** | 83 / 86 | every cycle | ✅ de-forked |
| `read_ping_data` | **154** | 19% | 126 | 62 / 42 | every cycle | ⚠️ figures stale — see below |
| CA block *(unattributed)* | ~98 | 12% | **~278** | — | every cycle | ❌ estimate was wrong — see below |
| `update_system_health` | 78 | 10% | 105 | 34 / 37 | every cycle | ✅ de-forked |
| `poll_per_antenna_signal` | 66 | 8% | 81 | 132 / 137 | 1-in-5 | open |
| `update_proc_metrics` | 66 | 8% | 86 | 25 / 26 | every cycle | ✅ de-forked |
| `update_data_used` | 51 | 6% | 63 | 19 / 19 | every cycle | open |
| `poll_tier2` | 44 | 5% | 55 | 268 / 257 | 1-in-15 | open |
| `write_cache` | 31 | 4% | 40 | 7 / 7 | every cycle | open |
| `detect_events` | 15 | 2% | **55** | 5 / **15** | every cycle | not a usable control — see below |
| `check_alerts` | 6 | <1% | 9.5 | 3 / 3 | every cycle | open |
| `append_ping_history` | 5 | <1% | 6 | 8 / 8 | 1-in-5 | open |
| `read_sim_state` | 0.5 | <1% | 0.8 | 4 / 4 | 1-in-15 | open |
| `crash_watcher_check` | **0** | — | 0 | 0 | every cycle | already free |
| `determine_service_status` | **0** | — | 0 | 0 | every cycle | already free |
| `update_conn_uptime` | **0** | — | 5.7 | 0 / 2 | every cycle | already free (RM520N) |
| `read_watchcat_state` | **0** | — | 0 | 0 | 1-in-5 | already free |

The four functions that already cost **zero** (`crash_watcher_check`, `determine_service_status`, `update_conn_uptime`, `read_watchcat_state`) were the proof of what was achievable: they are pure builtin/sysfs reads with no subprocesses, and they are free. `update_proc_metrics` has since joined them at a measured literal zero.

### Two corrections to this table

- **The CA block figure (~98 / ~278 ms) was arithmetic, and the arithmetic was loose.** It is the unattributed residual — whole-cycle cost minus everything the harness wrapped — and the original subtraction did not remove the harness's one-time PART 1 microbenchmark, which alone is ~835 ticks of a run. Done properly, the residual is **174 ms/cycle** (RM520N-GL) and **202 ms** (RG501Q-EU) before the de-fork pass, falling to **149 ms** and **176 ms** after it. So the CA block is *larger* than the old estimate on the RM520N-GL, not smaller, and it is the **single biggest remaining per-cycle cost** on that device. See the note below on what that bucket actually contains.
- **`read_ping_data`'s 154 / 126 ms was measured against code that no longer exists.** Per-function md5 comparison found the repo copy and the two device copies are **three different versions**. Fresh measurement against the current repo copy: **105–109 ms** (RM520N-GL) and **159 ms** (RG501Q-EU). That stale baseline is why it was dropped from the pass.

### RG501Q-EU deltas worth investigating on their own

These are behavioural differences, **not** explained by the SDX55's 2× slower exec:

- **`detect_events` forks 15×/call against 5×** on the RM520N-GL (3.6× the CPU: 55 ms against 15 ms). Something in the event-detection path takes a different branch on SDX55.
- **`update_conn_uptime` forks twice per call** on the RG501Q-EU and zero times on the RM520N-GL.

---

## The 2026-09-02 de-fork pass

Four functions were rewritten to remove process launches. **No emitted value changed** — that was the pass's whole contract, pinned by `scripts/test/poller-defork-equivalence.sh`, which byte-compared a golden dump against a fresh run over raw AT-response fixtures. `scripts/test/` (and that harness with it) was deleted 2026-09-03 — see [Method](#method) below for how it worked, since re-measuring means rebuilding it from that description.

Static fork-site counts came from `scripts/test/poller-defork-forkcount.sh`. That scanner summed command substitutions, pipeline segments and applet calls independently, so a single `x=$(df -P /usrdata)` scored **2** — one substitution plus one applet. Ceilings are derived floors, not round numbers.

| function | fork sites | ceiling | RM520N ms/cycle | RG501Q ms/cycle |
|---|---:|---:|---:|---:|
| `parse_serving_cell` (in `parse_at.sh`) | 184 → **3** | 3 | 164 → **24** (−85%) | 239 → **32** (−87%) |
| `update_system_health` | 37 → **4** | 4 | 66 → **7** (−89%) | 107 → **8** (−93%) |
| `update_proc_metrics` | 22 → **0** | 0 | 62 → **0** (−100%) | 84 → **0** (−100%) |
| `qcmd_exec` | 8 → **1** | 1 | *(folded into the callers above)* | |

- **Whole-cycle attributed child CPU: 595 → 351 ms (−41%) RM520N-GL · 877 → 487 ms (−44%) RG501Q-EU.**
- Including the unattributed residual: 769 → 500 ms and 1079 → 664 ms.
- Poller share of one core: 30% → 23% and 31% → 26%.
- Cadence: 3.39 → 3.18 s and 5.00 → 4.01 s.
- **`update_proc_metrics` records a literal zero** attributed child ticks over 95 calls (RM520N-GL) and 75 calls (RG501Q-EU). Not "rounds to zero" — zero.

`qcmd_exec` runs for **every** AT command the poller issues, so its saving spreads across every caller rather than showing as its own line. The unattributed residual — which is where `AT+QCAINFO` lives — improved by ~14% for free on that basis alone: **174 → 149 ms/cycle** (RM520N-GL) and **202 → 176 ms** (RG501Q-EU).

> ℹ️ **NOTE: that residual is a bucket, not a function.** The harness attributes only the functions `poll_cycle` calls **by name**, and `AT+QCAINFO` is invoked inline in `poll_cycle`'s own body. So the 149 / 176 ms figure covers the CA block **and** everything else `poll_cycle` does inline. It is an **upper bound** on the CA block, not a measurement of it. Anyone targeting it next should wrap it into a named function first and re-run, to get a clean number. Every other row in the ranked table below is measured per-function and is exact.
>
> The residual is derived as `(unattributed_ticks − PART 1 microbenchmark) ÷ cycles`, at 10 ms per tick. On the RM520N-GL after-run that is `(2254 − 835) ÷ 95 = 14.9 ticks = 149 ms`. Forgetting to subtract the one-time microbenchmark is what made the earlier estimate wrong. The independent check is that attributed plus residual must equal the whole-cycle figure: `351 + 149 = 500 ms`, which it does.

The surviving fork sites are each load-bearing and were argued individually:

- `parse_serving_cell`: one `awk` pass, its command substitution, and its pipeline segment (3).
- `update_system_health`: `df` is the only source of the `/usrdata` figures; `jq` is the schema boundary on the modem crash log. Each scores 2, hence a ceiling of 4.
- `qcmd_exec`: `result=$(qcmd "$cmd")` — the AT transport itself (1).

### Portability findings that made the rewrite possible

Both devices run BusyBox `awk`, not GNU `awk`. Two findings were load-bearing, and one nearly derailed the pass:

- ⚠️ **BusyBox `awk` has no `strtonum()`** on either device — both answer `awk: Call to undefined function`. Hex decoding therefore goes through a **manual base-16 loop** over `toupper` / `index` / `substr`. Verified exact for the 36-bit NR cell identity (NCI): `0x2FCB04A0F` decomposes to `12829346319 / 783041 / 2575` on both devices. (A 36-bit integer is exact in awk's double-precision float, but it must be printed with `%.0f`, never `%d`.)
- Verified **present** on both devices: `toupper`, `tolower`, `split` (empty fields preserved), `gsub`, `sub`, `substr`, `index`, `length`, and multiple `-v` assignments.
- ⚠️ **`printf '%(%s)T'` works on the RG501Q-EU and fails on the RM520N-GL.** The RG501Q-EU ships bash 4.4.23; the RM520N-GL ships bash 3.2.57, which predates that format. So `date +%s` **cannot** be eliminated on the reference target — and a portability check run only on the newer device would pass a real defect. Test bash-version-gated builtins on the *older* shell, always.

> ⚠️ **Git Bash / MSYS `grep` treats CRLF as a line terminator; real GNU grep does not.**
>
> ```sh
> printf 'a\r\nOK\r\n' | grep -v '^OK$'
> ```
>
> On Git Bash this outputs `a` plus a bare newline — it both matches `^OK$` against `OK` followed by a carriage return, **and strips the carriage return from the surviving line**. Real GNU grep on Linux, and BusyBox grep on the devices, keep both lines and both CRs. MSYS's `awk` and `sed` normalise CR the same way.
>
> AT responses are CRLF-terminated (verified by octal dump), so **any workstation harness that shells out to `grep`/`awk`/`sed` to model device text handling gives the opposite answer on carriage returns.** During this pass that nearly produced a false defect report against a correct rewrite. **WSL is the honest oracle** — the differential that cleared the rewrite was run there, with a BusyBox 1.36.1 multi-call binary shimmed in as `awk`/`grep`/`sed`/`cut`/`tr`/`head`.

The rewrite deliberately **reproduces** the old code's uneven carriage-return stripping field for field rather than normalising it, so old and new agree whether or not a CR is on the wire. Do not "fix" that asymmetry inside a refactor whose contract is byte-identical output.

---

## Ranked remediation

Items 1, 3 and 4 of the original list landed in the 2026-09-02 pass. **What follows is the ranking against today's code**, amortised per cycle on the RM520N-GL — the order changed substantially once the cheap wins were gone.

| # | target | status | RM520N ms/cycle | RG501Q ms/cycle | approach |
|---|---|---|---:|---:|---|
| **A** | **CA block + `poll_cycle` body** *(bucket)* | **open — largest remaining** | **149** | **176** | `AT+QCAINFO` / `parse_ca_info`, invoked inline. **Wrap it in a named function and re-profile first** — 149 ms is an upper bound on the bucket, not a measurement of the CA block. |
| **B** | **`read_ping_data`** | **open — second largest** | **105–109** | **159** | Ten `printf`-piped-to-`cut` idioms, **not** the two `jq` calls. Reconcile its three drifted copies first. See the corrected analysis below. |
| **C** | `poll_per_antenna_signal` | open | 55 *(275 per call, 1-in-5)* | 81 *(405 per call)* | 132/137 forks per call: `parse_qrsrp`/`qrsrq`/`qsinr` plus `append_signal_history`'s `jq -n -c`. One `awk`, drop the `jq`. |
| **D** | `update_data_used` | open | 46 | 63 | Not yet analysed at fork-site level. |
| **E** | `poll_tier2` | open | 38 *(567 per call, 1-in-15)* | 54 *(808 per call)* | **The biggest per-call cost in the daemon** at 268/257 forks, but it runs 1-in-15 so it amortises low. Attack as a batch of AT reads plus one parse rather than field by field. |
| **F** | `write_cache` | open | 30 | 40 | Not yet analysed at fork-site level. |
| **G** | `detect_events` | open | 25 | *(see RG501Q deltas)* | Cost tracks how many events fire, so it varies run to run by up to 77%. Measure over a long window before believing any figure. |
| 1 | `poll_serving_cell` / `parse_at.sh` | ✅ **done** | 24 | 32 | Was one AT response shredded by 184 fork sites; now a single BusyBox-`awk` pass, walked in pure bash. Realised ~140 / ~207 ms. |
| 3 | `update_system_health` | ✅ **done** | 7 | 8 | `cat`/`tr`/`find`/`nproc`/`awk`/`jq` → `read` builtins, globs, and one conditional `jq`. Realised ~59 / ~99 ms. |
| — | `check_alerts` | open | 5 | 9.5 | Small. |
| — | `append_ping_history` | open | 4.6 *(23 per call, 1-in-5)* | 6 | Small. |
| 4 | `update_proc_metrics` | ✅ **done** | **0** | **0** | `/proc/stat`, `/proc/meminfo`, `/proc/uptime` via `read` plus parameter expansion. Zero forks. Realised 62 / 84 ms. |
| — | `qcmd_exec` | ✅ **done** | folded in | folded in | Three `grep -v` filters → a pure-bash line walk. Reaches **every** AT caller, so its ~11 / ~14 ms per call is spread across all of them. |

The RM520N-GL column sums to ~493 ms against the measured whole-cycle 500 ms — the ~7 ms gap is rounding across twelve rows. That sum is the check that the attribution hangs together; if a future edit of this table stops summing to the whole-cycle figure, one of the numbers is wrong.

### Correcting item 2: where `read_ping_data`'s cost actually is

The previous edition of this document said `read_ping_data`'s 62 forks were "~10 `jq`, that alone is 111 ms" and prescribed batching the `jq` calls. **That was wrong**, and acting on it would have optimised the cheap half.

Read the function: it contains **exactly two** `jq` invocations (a metadata read and an eight-field `@tsv` read), ≈24 ms combined. Its real cost is **ten instances of this idiom**:

```sh
conn_internet_available=$(printf '%s' "$_pdata" | cut -f1)
```

Each one is ~3 fork sites — the command substitution's subshell, the pipeline segment, and the `cut` exec — so ten of them is ≈30 fork sites and **≈78 ms**, three times what the `jq` calls cost. The fix is to split the TSV in pure bash with the same suffix/prefix-trim walk `parse_serving_cell` and the history parser already use, and to leave the two `jq` calls alone.

> ⚠️ **Re-measure before optimising it.** `read_ping_data` was dropped from the 2026-09-02 pass because its baseline is stale in the strongest sense: **the repo copy and the two device copies are three different versions**, confirmed by per-function md5. The 154 / 126 ms in the historical table was measured against code that no longer exists anywhere in the repo. `scripts/test/poller-defork-forkcount.sh` (deleted with the rest of `scripts/test/` on 2026-09-03) deliberately asserted **no** ceiling on it for the same reason — a ceiling on a function whose baseline is unknown would have been red forever and told nobody anything.

### The zero-fork idioms

```sh
# WRONG — 3 forks
cpu_line=$(head -1 /proc/stat)
cur_idle=$(echo "$cpu_line" | awk '{print $5}')

# RIGHT — 0 forks
read -r _ user nice system idle _ < /proc/stat

# WRONG — 1 fork          # RIGHT — 0 forks
x=$(cat /proc/uptime)      read -r x < /proc/uptime
y=$(echo "$x" | cut -d. -f1)   y=${x%%.*}
```

Two more the pass added, both bash-3.2 safe:

```sh
# Splitting a delimited record with no forks (the parse_serving_cell idiom).
rest="$record"
field1="${rest%%|*}"; rest="${rest#*|}"
field2="${rest%%|*}"; rest="${rest#*|}"

# Case-insensitive compare without `tr` — bash 3.2 has no ${var,,}.
case "$state" in
    [Oo][Nn][Ll][Ii][Nn][Ee]) ... ;;
esac
```

> ⚠️ **`set -- $line` is not a drop-in replacement for `awk '{print $2}'`.** Unquoted `set --` performs word splitting **and** pathname expansion; the `awk` it replaces only ever split. Disable globbing across the split (`set -f`, restoring the prior state afterwards), or a filesystem name containing a glob metacharacter shifts every positional parameter. Fixed in `a2b367a`.

> ⚠️ **A vertical bar inside a `case` pattern reads as a pipeline to a lexical fork-site scanner.** `scripts/test/poller-defork-forkcount.sh` counted this way before it was deleted along with the rest of `scripts/test/` on 2026-09-03; there is no gate left to keep honest, but the lesson holds if this kind of scanner is ever rebuilt: write alternations as separate `case` branches rather than one alternation. It costs nothing at runtime.

---

## Method

The harness was **`scripts/test/qm_fork_probe.sh`**. **It is deleted** — the whole of `scripts/test/` was removed from the repo on 2026-09-03 — so what follows is the record of how it worked, not a script you can run. Re-measuring means rebuilding it from this description. It was **read-only with respect to production state**: everything it wrote landed in `/tmp/qmprobe/` or `/tmp/qm_fork_attribution.txt`.

> ℹ️ **NOTE:** it first existed only as a copy in `/tmp` on each device, which made this document's own "gate a redeploy on `device_md5 == local_md5`" rule unsatisfiable — there was no local copy to compare against. A power outage mid-project then wiped both devices' `/tmp`, destroying the on-device copies and the original attribution reports. It was moved into the repo for that reason, and went with `scripts/test/` when that directory was deleted.

It worked by:

1. Sourcing a **copy** of the poller with `main "$@"` disabled, so every function and every sourced lib is defined exactly as in production.
2. Redirecting every writable path constant (`CACHE_FILE`, `DATA_USED_FILE`, `EVENTS_FILE`, `_CRASH_LOG`, …) into `/tmp/qmprobe`, and stubbing the outbound dispatchers (`email_alert_send`, `sms_alert_send`, `_ae_dispatch`).
3. Replacing `qcmd` with a **record-once / replay** stub: the first call for a given AT command hits the real modem through `/usr/bin/qcmd` and its own flock; every later call replays from cache. Faithful parse input, no lock contention with the live poller, no extra AT traffic.
4. Wrapping each function `poll_cycle` calls **directly** (nested callees roll up into their caller, so nothing is double-counted) and sampling two kernel counters around each:
   - `/proc/self/stat` `cutime`+`cstime` — **exact, per-process** CPU of reaped children.
   - `/proc/stat` `processes` — system-wide fork count; noisy, reported with a measured noise floor.
5. Both samplers use **only bash builtins**, so the instrument forks zero times and does not contaminate what it measures.

**Validation:** the harness measured 27–31% of a core against the live daemon's independently measured 32.6%. The small gap is the stubbed AT transport. It reproduces the real workload closely enough to trust.

bash 3.2 compatible — the RM520N-GL ships **bash 3.2.57**, so no associative arrays. (The RG501Q-EU has 4.4.23.)

### Arguments

```bash
# $1  duration in seconds        (default 3600)
# $2  poller source to profile   (default /usr/bin/qmanager_poller)
# QMFP_KEEP_FX=1  reuse the AT fixtures recorded by the previous run
setsid nohup bash /tmp/qm_fork_probe.sh 3600 </dev/null >/tmp/qmfp.log 2>&1 &
```

An argument-free run is unchanged from the published baseline: it profiles the installed daemon and captures fresh fixtures. The report header records `poller_src`, `poller_md5`, and whether fixtures were reused, so two reports are never indistinguishable after the fact.

Checkpoints land every 25 cycles, so partial data accrues within minutes. Progress is observable at `/tmp/qmfp_heartbeat`.

### The before/after protocol

This is subtle, and getting any of it wrong produces a confident wrong answer.

**1. Build the candidate in `/tmp`, and rewrite its lib paths.** The poller sources its libraries by **absolute path**:

```sh
. /usr/lib/qmanager/parse_at.sh
```

So profiling a `/tmp` copy of the poller still loads the *installed* library — and `parse_serving_cell`, the largest single target, lives in that library. A candidate must therefore be assembled in `/tmp` with that source line rewritten to point at the candidate lib. Done properly, this is how the entire 2026-09-02 pass was measured **without a single write to `/usr/bin` or `/usr/lib` on either production device**.

**2. Pin the fixtures, then check what got captured.** The `qcmd` stub is **record-once/replay**, so the captured response decides which branch of the parser executes and therefore what the run costs. An attached 20-field LTE response drives the full field-by-field shred; a two-field

```
+QENG: "servingcell","SEARCH"
```

falls through to a near-free branch. Those are wildly different workloads, and a modem that reselects between a baseline run and a candidate run yields a "speedup" or a "regression" that is really just a different AT response. This is not theoretical: the RM520N-GL sat at RSRP −121 and was observed in SEARCH during this work.

`QMFP_KEEP_FX=1` carries the fixture directory across runs so the comparison is pinned. **Validity gate: inspect the captured fixture before trusting a run.** A pinned SEARCH fixture pins the *wrong* workload just as firmly as a good one does the right one.

**3. Trust `child_ticks`, not `fork_delta`.**

> ⚠️ **`fork_delta` degrades as a metric on a faster poller.** It is a system-wide counter, and a cheaper cycle yields the CPU sooner — so the live daemon and other background processes get scheduled inside more of the measurement window, and their forks land in the count. `read_ping_data`, which was **not modified by the pass**, went from 38 to 51 forks/call across it with completely flat `child_ticks`. Treat fork columns as directional; `child_ticks` is exact, because it is per-process.

**4. `detect_events` is not a usable control.** Two baseline runs on the same device under identical pinned fixtures differed by **77%** (22 ms against 39 ms). Its cost tracks how many events actually fire, and pinning the AT fixtures does not pin that. Use an untouched *pure-read* function as the control, or no control at all.

### Harness gotchas that cost real time

> ⚠️ **BusyBox `tr` ignores a FILE argument and reads stdin — it hangs forever, it does not error.** `tr -d x /proc/uptime` wedges the script *and* the SSH channel. Always redirect (`< file`), and pin `</dev/null` on every exec inside a benchmarking loop.

> ⚠️ **`pkill -f` / `pgrep -f` self-match.** A `-f` pattern is matched against process command lines — *including the command line of the shell running the `pkill`/`pgrep`*. `pkill -f qm_fork_probe.sh` kills its own shell; `pgrep -f qm_fork_probe.sh` always reports a match and therefore always reports "running". Kill by PID file, and check liveness with `kill -0 "$(cat /tmp/qmfp.pid)"`.

> ⚠️ **Verify the deployed md5 *against local*, not just that one exists.** A self-killed `pkill` shell skipped a `: > file` truncation, so nine `>>` appends stacked onto the previous base64 payload. `base64 -d` decoded both streams, `bash -n` passed (two valid scripts in sequence), and an entire hour was wasted running a concatenated script. The device file had **2 shebangs** and was 26965 bytes against 13662 locally. Gate the launch on `device_md5 == local_md5` — now actually possible, since the harness has a local copy.

---

## Known gaps

Four items were found during the de-fork pass and deliberately left unfixed. Each is recorded here so it is findable rather than rediscovered.

### 1. `df -P /usrdata` reports a tmpfs, not the `/usrdata` volume

On **both** devices, `df -P /usrdata` resolves to a tmpfs mount (`/etc/machine-id`) and answers something like:

```
tmpfs   126624   30036   96588   24%   /etc/machine-id
```

So System Health's `sh_storage_*` fields report the size and usage of a tmpfs rather than of the persistent `/usrdata` volume the user cares about. This is **pre-existing** — it predates the de-fork pass, which preserved it deliberately so the refactor stayed byte-identical. Fixing it is a behaviour change and needs its own change with its own validation.

### 2. `/tmp/qmanager_ping.json` carries no `last_target` on the deployed devices

`read_ping_data` reads a `last_target` field so it can name **the leg that actually answered**, falling back to `targets[0]` when it is absent. On both live devices the file carries no such key, so the fallback is always taken and the "name the winning leg" behaviour is inert — the reported target is whatever is configured first, even on a link where that target never replies.

The repo's `scripts/usr/bin/qmanager_ping` **does** emit `last_target`, so what was observed is producer/consumer version drift on the *installed* copies, not a missing feature in the tree. **Re-verify after the next install before assuming it is still inert.** See [`connection-quality.md`](./connection-quality.md) for the producer's full key contract.

### 3. `qcmd_exec` has a dead `*ERROR*` branch, and a dead caller path behind it

```sh
case "$result" in
    *ERROR*)
        qlog_debug "qcmd_exec AT ERROR: cmd=${cmd}"
        echo "$result"
        return 2
        ;;
esac
```

`qcmd` reports failure by **exit code and stderr**; it never writes `ERROR` to stdout. So this branch cannot fire, `qcmd_exec` never returns 2 — and `poll_serving_cell`'s `if [ $rc -eq 0 ] || [ $rc -eq 2 ]` guard tests against a value that never arrives, making that half of the condition dead too. Same family as the sites swept repo-wide in `b4d87ef`; see [`at-command-transport.md`](./at-command-transport.md) for how `qcmd` actually signals failure. Left in place by the de-fork pass because removing it is a behaviour change, not a refactor.

### 4. `read_ping_data` has drifted three ways, and is the largest remaining *measured* cost

The repo copy, the RM520N-GL copy and the RG501Q-EU copy are **three different versions** (confirmed by per-function md5). At 105–109 ms (RM520N-GL) and 159 ms (RG501Q-EU) against the current repo copy, it is second only to the CA-block bucket — and it is the largest cost that is measured per-function rather than inferred from a residual. Reconcile the three copies before optimising, and target the ten `printf`-piped-to-`cut` idioms rather than the two `jq` calls — see [Correcting item 2](#correcting-item-2-where-read_ping_datas-cost-actually-is).

---

## The compiled-language comparison

A Go equivalent was built and run **on both devices** doing genuinely comparable work: the same `/proc` and sysfs reads, the same 8 real AT responses parsed field-by-field from the fixtures captured off each device, and an atomic JSON write.

| | shell poller (baseline) | shell poller (de-forked) | Go equivalent |
|---|---:|---:|---:|
| CPU per cycle, RM520N-GL | 815 ms | ~500 ms | **2.39 ms** |
| CPU per cycle, RG501Q-EU | 1150 ms | ~664 ms | **2.84 ms** |
| forks per cycle | ~220 | four functions de-forked (`parse_serving_cell` alone 184→3 sites) | **0** |
| RSS | — | — | 6.3 MB |

**Caveat, stated plainly:** the benchmark emits a 1012-byte JSON against the real 5234-byte cache and omits the events, alerts, history, and data-counter state machines. It is a lower bound, not the finished article. But even assuming the real port is **10× more work**, that is ~24 ms/cycle — still **under 1% of a core**.

### Binary size (Go 1.26.2, `GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0`, `-trimpath -ldflags="-s -w"`)

| build | stripped |
|---|---:|
| bare `main` (runtime floor) | 1408 K |
| + `regexp` | 1664 K |
| + `encoding/json` | 1728 K |
| **realistic poller skeleton, hand-rolled JSON** | **1728 K** |
| same + `fmt` + `encoding/json` | 2112 K |
| **+ `net/http`** | **6016 K** |

> ⚠️ **`net/http` is the size trap, not `regexp`.** `regexp` costs +256 K and is fine to use; `net/http` adds ~3.9 MB on its own. `encoding/json` (+320 K, drags in `reflect`) is affordable but avoidable — hand-rolling JSON emission with `strconv.AppendInt` into a byte slice is ~40 lines and keeps the binary at the floor.

`-ldflags="-s -w"` is worth a consistent ~30% and is not optional. A full port adds *code* but no new runtime, so it projects to **~2.0–2.5 MB stripped** — inside a 3 MB budget on devices with ~20 MB of writable `/opt`.

**RAM, not disk, is the real cost.** 6.3 MB RSS against 182 MB total (RM520N-GL) / 230 MB (RG501Q-EU). Go's runtime and GC baseline is heavier than bash's; tune with `GOGC`/`GOMEMLIMIT` and measure against the bash poller's RSS before claiming a win. Hard-float is confirmed fine on both SoCs.

---

## Recommendation

**Continue the shell de-fork pass.** The 2026-09-02 pass took the four cheapest wins and realised 41–44% for a few days of low-risk work that stays reviewable and debuggable on-device.

The next step is **item A, the CA block** — but the first move there is *not* a rewrite. Wrap `AT+QCAINFO` and `parse_ca_info` into a named function so the harness attributes them, and re-profile. Until that is done, 149 ms is the cost of a bucket that also contains `poll_cycle`'s own inline body, and nobody knows how it splits. **Item B (`read_ping_data`)** is the largest cleanly-measured cost and needs its three drifted copies reconciled before any optimisation; **item C (`poll_per_antenna_signal`)** is the same kind of mechanical change the pass has already done four times. Those three are worth roughly another 60% of what remains.

A rewrite's case rests on **where the architecture should go** — a resident AT transport, event-driven rather than polling — not on whether the CPU is recoverable. It plainly is, and the de-fork pass has now demonstrated that on hardware. At 1.7 MB measured, binary size is not the obstacle either.

Whichever path is taken, a port must reproduce these contracts exactly, and they — not the coding — are the real cost:

- the `/tmp/qmanager_status.json` schema every CGI reads as a thin cache
- the cross-UID `/tmp` ownership rules (see [`tmp-file-ownership.md`](./tmp-file-ownership.md))
- `flock` serialisation against the CGI layer (see [`at-command-transport.md`](./at-command-transport.md)) — bit-identical, or AT responses corrupt
- events, alerts, the persistent Data Used counter, crash watcher, SIM registry
- the 1970 boot window (see [`scheduled-timers.md`](./scheduled-timers.md))
