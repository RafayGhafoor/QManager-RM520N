# SPEC: Go AT collector (`qmanager_atd`)

**Status:** Proposal for approval, 2026-10-22. Lightweight spec — falsifiable
requirements, in/out of scope explicit, acceptance as pass/fail.
**Plan it serves:** [`docs/plans/2026-10-22-poller-cpu-optimization.md`](../plans/2026-10-22-poller-cpu-optimization.md)

**Background.** The poller is 41 % of all busy CPU on this box. Measured: **406 ms
CPU per cycle**, of which **76 % is fork+exec** — ~26 processes for one `AT+CGMM`,
~8 AT calls per cycle, 10 cycles/minute. Shell optimisation (A1–A4 in the plan) tops
out at ~33 % of one core and only by halving the refresh rate. The owner wants CPU
down **with every feature intact**.

**The key observation.** A full 2883-line / 32-function / 13-lib rewrite is not
needed. The forks are almost entirely in **the AT transport**, not in the poller's
logic:

| Piece | Share of poller CPU | Where it lives |
| --- | --- | --- |
| AT transport (`qcmd` → `atcli_smd11` → `/dev/at_mdm0`) | ~90 % | `deploy/atcli_smd11`, `bin/qcmd` |
| Poller logic — alerts, events, state machines, data counters | ~10 % (own ≈ 2.3 % of core) | `scripts/usr/bin/qmanager_poller` |

A shell script **cannot** call a socket or a daemon without forking a client, so
"Go helper invoked by the shell" saves nothing. But a **Go collector that owns the
port and writes the same `/tmp` files** removes every AT fork, while the existing
shell logic keeps reading those files exactly as it does today.

**Goal:** poller CPU from ~406 ms/cycle to under ~30 ms/cycle, with **byte-identical
state files and no feature removed**.

## In Scope

1. **`qmanager_atd`** — a Go binary that opens `/dev/at_mdm0`, takes
   `/tmp/qmanager_at.lock` before each command, runs the existing tier schedule, and
   writes the same `/tmp` files with the same schemas.
2. **Poller** — its AT functions become file reads. All 32 functions and 13 libs stay;
   the alert/event/state logic is untouched.
3. **Fallback** — if `qmanager_atd` is absent, dead or unhealthy, the poller uses
   `qcmd` exactly as today.

## Out of Scope (explicit, with reasoning)

- **Rewriting the poller's logic in Go.** 2883 lines across 32 functions and 13
  sourced libs, for ~2.3 points. Reason: the cost/benefit is inverted; the logic is
  the cheap part and the risky part.
- **Replacing `qcmd` for CGI use.** 37 files call it, at user-initiated frequency
  (a page load, a lock apply). Those forks are not the problem and changing them
  would widen the blast radius enormously.
- **Any new field or feature.** This is a transport change. Same fields, same
  cadence, same files.
- **Changing the refresh cadence.** A1–A4's interval trade is what this avoids.
- **Touching the vendor stack or `modemd`.** The vendor's own poller keeps `/dev/smd7`.
- **A general-purpose AT library.** Only the commands the poller already issues.

## The hard problem: reproducing the shim's read discipline

`deploy/atcli_smd11` is not a thin wrapper. It encodes hard-won correctness that a
naive Go reader will regress. **All of this must be reproduced**, and each item has a
recorded failure behind it:

| Discipline | Why | Where |
| --- | --- | --- |
| **Drain stale bytes** before each command (currently `cat` + `sleep 0.15`) | A reply left in the buffer makes the *next* command read the wrong line — the original "missing information in the UI" bug | `atcli_smd11:67-78` |
| **Settle** before writing (currently `sleep 0.12`) | The port drops echo bytes if written too soon after opening | `atcli_smd11:82` |
| **Terminator set**, not a fixed sleep | `OK\r\n`, `ERROR\r\n`, `+CME ERROR:` … a command that never terminates must time out, not hang | `atcli_smd11:108` |
| **Per-command timeout** | `TICKS=48` (~12 s) default, **`240` (~60 s) for `QSCAN`/`QSCANFREQ`/`QFOTADL`** | `atcli_smd11:46-47` |
| **Read-only retry allowlist** | A missing reply does **not** prove a setter had no effect. Only query-shaped commands may be retried; setters are never replayed | `atcli_smd11:132-156` |
| **Same flock, same path** | 37 other files serialize on `/tmp/qmanager_at.lock`. Taking a different lock means two writers on one port | `bin/qcmd` |

**Go must hold the flock for the duration of each command**, exactly as `qcmd` does,
so a CGI's `qcmd` and the collector interleave safely rather than racing.

## Requirements

### R1 — `qmanager_atd` binary

- **Acceptance:**
  - [ ] Static Go binary, armv7, no cgo, **shipped as a deploy-time payload, never
        committed** (hard rule 9 — same pattern as `jq`, `speedtest`, `sms_tool.bin`).
  - [ ] Opens `/dev/at_mdm0` only. Never `/dev/smd7`, never `/dev/smd11` (hard rule 3).
  - [ ] Takes `flock` on **`/tmp/qmanager_at.lock`** around every command, blocking
        with the same 20 s / 45 s ceilings `qcmd` uses.
  - [ ] Reproduces every row of the discipline table above.
  - [ ] **Configures no termios at all** — confirmed `ENOTTY` on this port. Any
        `tcgetattr`/`tcsetattr` attempt must be skipped, not merely tolerated.
  - [ ] Idles at **under 0.5 % of one core** with the port open and no commands
        pending.

### R2 — Same files, same schemas

- **Acceptance:**
  - [ ] Writes `/tmp/qmanager_status.json`, `qmanager_signal_history.json`,
        `qmanager_ping_history.json`, `qmanager_events.json`, `qmanager_pci_state.json`,
        `qmanager_neighbours_live.json` with **identical key sets and value types**.
  - [ ] Proven by a schema diff: capture each file from the current shell poller, run
        the collector for 5 minutes, and diff the key paths and types. **No key may
        appear or disappear.**
  - [ ] The `.phy` block from `phy_metrics.sh` is preserved, including
        `lte.tx_power` and `nr.pathloss` remaining **absent** (they do not exist on
        RG520N-EB).
  - [ ] Writes stay atomic (temp + rename) as they are today.

### R3 — Tier schedule parity

- **Acceptance:**
  - [ ] Tier 1 every 2 s, Tier 1.5 every 5th, Tier 2 every 15th, Tier 3 every 15th —
        the same cadences, so the data a consumer sees is unchanged.
  - [ ] The lease-gated live neighbour tick keeps its 10 s lease semantics and its
        "no lease ⇒ one `[ -f ]` test" cost.
  - [ ] `AT+QNWCFG="lte_tx_pwr"` and `"nr5g_pathloss"` are **never sent** (they answer
        `ERROR` on this device).

### R4 — Fallback, and it must be visible

- **Acceptance:**
  - [ ] If `qmanager_atd` is missing, fails to start, or its cache file is older than
        3 Tier-1 cycles, the poller falls back to `qcmd` and **logs one warning per
        60 s** naming the fallback reason.
  - [ ] Fallback restores today's behaviour exactly, including its cost.
  - [ ] No configuration change is needed to fall back — it is automatic on failure.
  - [ ] A `systemctl status qmanager-atd` failure is not silent: the poller surfaces
        it in the health-check output.

### R5 — Feature parity, proven

- **Acceptance:**
  - [ ] Every feature currently fed by the poller still works, checked one by one:
        dashboard fields, signal history chart, ping history, events/Recent Activity,
        alerts (SMS/email/Discord), data-used counter, cell distance (NR only), CA,
        per-antenna signal, neighbour live view, Detailed Metrics `.phy` block.
  - [ ] **A 24-hour soak** shows the same file sizes, same row cadence, and no gaps.
  - [ ] Nothing is removed from the UI.

### R6 — Benchmark and boot

- **Acceptance:**
  - [ ] Before/after measured per `AGENTS.md`: per-call AT CPU, per-cycle CPU, poller
        total (share of one core), RSS, and box total. Baseline captured **before** the
        deploy.
  - [ ] Target: per-cycle **406 ms → under 30 ms**; poller **17.7 % → < 2 %** of one
        core average; box **57 % → ~40 %**, measured over a **5-minute** window, not a
        30 s snapshot.
  - [ ] New unit `qmanager-atd.service`, added via `deploy/qm_boot_hook.sh` (hard rule
        7) — never by editing `/etc/init.d/turin_web.sh` directly.
  - [ ] **Proven by a real reboot** (`boot_id` before/after, `ActiveEnterTimestamp` vs
        `/proc/uptime`) — hard rule 6. A `systemctl restart` proves nothing here.
  - [ ] Rollback is one line: disable `qmanager-atd.service` and the poller falls back.

## Benchmark — the corrected baseline (5-minute average, 2026-10-22)

Two earlier readings were wrong and this is the one to trust:

| Reading | Box | Poller | Verdict |
| --- | --- | --- | --- |
| 30 s snapshot | 48 % | 19.8 % | a burst — too short |
| cumulative-since-start estimate | — | ~6.6 % | **wrong**: I guessed the poller's start time |
| **299 s average, 60 samples** | **57 %** | **17.7 %** | **use this** |

```
box    avg 57 % of one core   peak(5 s) 84 %
poller avg 17.7 %             peak(5 s) 36.3 %
poller share of busy: 30 %
```

The averaging script itself had a permille/percent bug that printed "177 %"; corrected
value is 17.7 %. Recorded because a 10× arithmetic slip is exactly the kind of thing
that gets believed later.

**Projection against the correct baseline:**

| | Box | Poller |
| --- | --- | --- |
| today | **57 %** | 17.7 % |
| Go collector | **~40 %** | ~0.2 % |
| + trim ping and tpws | ~34 % | ~0.2 % |

**25 % is not reachable with features intact**: vendor + kernel is ~22 points of the
57, so the floor with every QManager feature trimmed is ~34 %.

## Feasibility — checked on the device 2026-10-22, not assumed

| Check | Result | Consequence |
| --- | --- | --- |
| `/dev/at_mdm0` permissions | `crw-r----- radio:radio` | Collector runs as root (as the poller does) or joins `radio`. |
| `stty -F /dev/at_mdm0` | **`Inappropriate ioctl for device` (ENOTTY)** | **The port has no termios.** Open it as a plain file descriptor and configure nothing. This removes the only genuinely fiddly part of a serial client — and it explains why the shell shim is just `cat`/`printf`. |
| `/tmp/qmanager_at.lock` | mode `0666`, exists | Shared lock is usable by root and www-data as today. |
| `qcmd` lock ceilings | `20 s` normal / `45 s` long | Reproduce exactly. |
| Cross-compile | Go 1.26.5 available locally | `CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build` → static armv7. |
| Status schema to match | **18 top-level keys**: `connectivity, data_used, device, errors, last_successful_poll, lte, modem_reachable, network, nr, phy, signal_per_antenna, sim, sim_failover, sim_swap, system_health, system_state, timestamp, watchcat` | This is R2's diff target. |

**ENOTTY is the important one.** It means the collector is a `read`/`write` loop on an
fd plus a terminator matcher — no serial configuration, no `tcsetattr`, no rate
negotiation. That is a few hundred lines of Go, not a serial-stack port.

## The decision this needs first — hard rule 3

Rule 3 says *"every call goes through `qcmd`"*, and its stated purpose is that **only
`qcmd` holds the shared flock**. A collector that opens the port itself is a direct
exception to the letter of that rule.

It can be honoured in substance — the collector takes the **same lock file**, so
serialization with the 37 other callers is preserved — but the letter changes. Options:

| Option | Effect |
| --- | --- |
| **A. Amend rule 3** for `qmanager_atd` only, naming the lock file it must take | Collector owns the port; `qcmd` keeps serving CGIs. **Only path that removes the forks.** |
| **B. Leave rule 3 alone** | The collector must shell out to `qcmd` → the forks remain → **no CPU win.** This idea dies. |
| **C. Collector takes the port, `qcmd` is retired** | Larger blast radius: 37 files must move to the new path. Not recommended for a first pass. |

**This spec is blocked on option A.** Nothing should be written until the owner
amends rule 3, because the whole value of the idea rests on it.

## Routing (`qm-orchestrate`)

**Lane: Full.** Cross-layer, a new binary, a new unit, and a boot change.

| Flag | Agent | When |
| --- | --- | --- |
| New systemd unit / `/usrdata` layout / deploy payload | `installer-safety-auditor` **pre-gate**, and post-verify; lockstep: install + uninstall + deploy docs move together | Before code |
| Reads modem state | `modem-investigator` already satisfied — the 80 ms and 26 forks are measured, not hypothesised | — |
| Shell **and** Go | Conductor runs both on the device first | Before merge |
| Frontend | **does not fire** — no UI change at all | — |

## Open questions for the owner

1. **Amend rule 3 (option A)?** Nothing proceeds without it.
2. Is a **native armv7 Go binary** acceptable as a deploy-time payload? It is ~2–3 MB,
   statically linked, consistent with the existing `jq`/`speedtest`/`sms_tool.bin`
   pattern — but it is a new binary class for this deployment.
3. Is **~30 % of one core** the target, or does 25 % still matter? At 30 % this spec
   suffices with every feature intact; 25 % additionally needs the Traffic Engine
   trimmed, which *would* remove a feature.
