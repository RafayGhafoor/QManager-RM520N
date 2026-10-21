# SPEC: port upstream's Rust `qmanager_atd` to the O5A

**Status:** Proposal, 2026-10-22. **Blocked on two owner decisions** (§Decisions).
**Supersedes:** [`go-at-collector.md`](./go-at-collector.md) — writing a Go collector
next to an existing tested Rust one is duplicate effort.
**Coverage companion:** [`go-at-collector-coverage.md`](./go-at-collector-coverage.md)
— still valid; it describes **output parity**, not language.

## Background

Measured on this device 2026-10-22: the box averages **57 % of one core**; the poller
is **17.7 %** of that (30 % of all busy CPU) at **406 ms/cycle**, and **76 % of that
cost is fork+exec** — ~26 processes per AT call, ~80 AT calls a minute.

Upstream (`dr-dolomite/QManager`, branch `development-home`) already ships
`native/qmanager_atd`: a Rust AT broker, `libc` as its only dependency,
`opt-level="s"`, LTO, `panic="abort"`, `strip`. ~200 KB across 13 modules with a
`tests/parity` corpus (`expected.txt`, 799 KB).

**Its design is better than the Go plan it replaces**, because it is **dual-mode by
`argv[0]`**:

| Invoked as | Behaviour |
| --- | --- |
| `qmanager_atd` | Broker: owns the AT device, serves one request per unix-socket connection |
| `qcmd` | Client: **socket first**, and if the socket is absent or fails at the transport level, runs the exchange **in-process** — so AT never depends on the daemon being up |
| `qsms` | SMS client, same transport |

One static binary, symlinked three ways. The fallback is designed in, not bolted on.

**Licence: MIT + Commons Clause** — the same as this repo's own. Vendoring adds no
obligation beyond the notice already carried. It is not sellable as a product
substantially derived from it.

## What does NOT transfer — measured, not assumed

`parse.rs` does **not** cover our commands:

| Token | Occurrences in `parse.rs` |
| --- | --- |
| `QENG`, `servingcell`, `QCAINFO`, `QRSRP` | 4, 2, 1, 2 |
| **`QNWCFG`, `QTEMP`, `QSCAN`, `neighbourcell`, `ssb_beam`** | **0** |

So the daemon is a **transport, not a parser**. Our shell libs (`parse_at.sh`,
`phy_metrics.sh`, `qmi_read.sh`) keep parsing. That is correct separation and cheap:
the cost was never the parsing, it was the 26 forks.

## Device gaps to close

| Gap | Current | Needed |
| --- | --- | --- |
| AT device | `const SMD_PATH: &str = "/dev/smd11"` — hardcoded, no env override | `/dev/at_mdm0`, configurable |
| Lock file | `/var/lock/qmanager.lock` | Must **match** whatever the other callers use, or nothing serialises |
| Our lock users | `/tmp/qmanager_at.lock`, referenced by **15 deployed files** | One lock, or two writers on one port |
| Socket | `/var/run/qmanager_atd.sock` | Fine — unix socket, no TCP port collision; `/var/run` → `/run` is writable (verified) |
| Toolchain | Homebrew `cargo 1.98.1`, **no `rustup`** | armv7 musl target, or a musl cross-toolchain |

## Decisions (owner)

**D1 — which callers move to the broker?** The "keep our flock and run both" option
is **not** on the list, because the broker locks `/var/lock/qmanager.lock` while our
15 callers lock `/tmp/qmanager_at.lock`; two writers on one port is exactly the
corruption hard rule 3 exists to prevent. So:

| Option | What moves | Win | Blast radius |
| --- | --- | --- | --- |
| **B — surgical (recommended)** | The **poller** calls the Rust `qcmd`; CGIs keep the shell `qcmd`; both take the **same** lock | 26 → 1 fork on the 80 calls/min = the entire measured cost | Poller only |
| **A — full** | Rust binary installed as `qcmd`; all 15 callers become socket clients | Zero-fork AT everywhere, plus `qsms` for SMS | Device-wide `qcmd` behaviour |
| **C — status quo** | nothing | — | — |

**Recommend B first.** It captures the whole measured win (the poller makes ~80 of the
~85 AT calls a minute) while leaving 14 CGI callers on a path that already works.
Option A becomes a cheap follow-up once B has proven the transport.

**D2 — is a native armv7 Rust binary acceptable as a deploy-time payload?** ~1–2 MB
static, never committed (hard rule 9), same pattern as `jq`, `speedtest`,
`sms_tool.bin`. Precedent exists: `atcli_smd11` upstream is itself a Rust build.

## In Scope

1. Vendor the upstream `qmanager_atd` source under `native/qmanager_atd/` with its
   licence notice, **or** build it in place and ship only the binary — D2 decides.
2. Make the AT device configurable (env override, default preserved).
3. Align the lock file so every writer serialises.
4. Cross-compile armv7 static; add it to the deploy payload list.
5. Point the poller's AT calls at the Rust `qcmd` (option B), keeping the shell
   `qcmd` for CGIs.
6. Run upstream's `tests/parity` corpus as the acceptance test.

## Out of Scope (explicit, with reasoning)

- **Rewriting the poller's logic in Rust.** Its own CPU is 2.3 %; the transport is the
  cost. Reason: inverted cost/benefit.
- **Moving SMS to `qsms` in the first pass.** It is a real win but a separate surface
  with its own storage quirks (`/dev/smd7`, vendor radio lock). Follow-up.
- **Any field or feature change.** Output parity is the acceptance criterion.
- **Changing cadence.** The point is to spend less on the same schedule.
- **Touching `/data/gp/*` or `modemd`.** The vendor keeps `/dev/smd7`.

## Requirements

### R1 — build and vendor

- [ ] Builds `armv7-unknown-linux-musleabihf`, `--release`, `CGO`-free equivalent
      (`panic="abort"`, stripped, as its `Cargo.toml` already sets).
- [ ] Runs on the device: a smoke run of its own `--version`/help path succeeds.
- [ ] **Not committed to git** if built (hard rule 9); source vendoring, if chosen,
      carries the MIT + Commons Clause notice verbatim.

### R2 — device path

- [ ] AT device comes from an env var (e.g. `QMATD_DEV`), defaulting to the current
      constant so upstream behaviour is unchanged.
- [ ] Set to `/dev/at_mdm0` on this deployment.
- [ ] `stty` on that port returns **ENOTTY** (measured) — the daemon must not depend
      on termios.

### R3 — one lock, every writer

- [ ] Every process that can touch the AT port locks **the same file**.
- [ ] Verified by a concurrency probe: the broker busy with a long command, a `qcmd`
      issued concurrently, both serialised, no truncated replies.
- [ ] The chosen path is recorded in `AGENTS.md` hard rule 3 (currently states
      `/tmp/qmanager_at.lock`).

### R4 — poller integration (option B)

- [ ] The poller's AT path calls the Rust `qcmd`; the shell `qcmd` remains for CGIs.
- [ ] **Per-call CPU: 80 ms → target ≤ 10 ms.** Proved with
      `scripts-dev/at-cost.sh`, same command, same window.
- [ ] On any transport error the poller falls back to the shell `qcmd` and logs one
      warning per 60 s.
- [ ] No change to the poller's outputs: `status.json` byte-comparable except values.

### R5 — output parity

- [ ] [`go-at-collector-coverage.md`](./go-at-collector-coverage.md) sections A–F all
      checked with evidence. It is language-neutral by design.
- [ ] Section E in particular: `phy.lte.tx_power`, `phy.nr.pathloss`, LTE cell
      distance and any subscriber identifier must **stay absent**.

### R6 — benchmark and boot

- [ ] Before/after per `AGENTS.md`: per-call AT CPU, per-cycle CPU, poller share, RSS,
      box share — baseline captured **before** the deploy.
- [ ] Target: poller **17.7 % → ~3 %**, box **57 % → ~42 %**.
- [ ] If a unit is added, `qmanager-atd.service` goes into the payload **and**
      `deploy/qm_boot_hook.sh` (hard rule 7), and is **proven by a real reboot**
      (hard rule 6) — `boot_id` before/after, `ActiveEnterTimestamp` vs `/proc/uptime`.
- [ ] Rollback: stop the unit, poller falls back to the shell `qcmd`.

## Why the projection is 26 → 1, not 26 → 0

The poller still `exec`s one binary per AT call, so option B leaves **one fork** where
there were 26. 80 ms → ~5–8 ms per call is therefore the realistic band, giving AT
cost ~10.7 % → ~1 %, poller 17.7 % → ~3 %, box 57 % → ~42 %.

**25 % is not reachable with features intact** — vendor + kernel is ~22 points of the
57. Reaching 25 % would require trimming the Traffic Engine, which removes a feature.

## Routing (`qm-orchestrate`)

**Lane: Full.** A new binary, a new unit, a lock-path change, and a boot change.

| Flag | Agent | When |
| --- | --- | --- |
| Installer / unit / `/usrdata` layout / deploy payload | `installer-safety-auditor` pre-gate + post-verify; install, uninstall and deploy docs move together | Before code |
| Reads modem state | satisfied — the 80 ms / 26 forks / 57 % figures are measured | — |
| Rust **and** shell | Conductor runs both on the device first | Before merge |
| Frontend | does not fire | — |

## Decisions needed before any code

1. **D1: option B or A?** Recommendation: **B**.
2. **D2: native Rust payload acceptable?** Precedent: `atcli_smd11` upstream is Rust.
3. Does the owner want the upstream **source** vendored into this repo (with its
   notice), or only the built binary shipped as a deploy-time payload?
