# qmanager_x16 — Rust AT client for the ZLT X16: decision memo

Status: **scaffold only, unverified on device.** Written by the parent agent after
the generating agent timed out; every number below was measured on the device or
read from the code, and anything not measured is labelled as such.

## What this crate is

A starting point for replacing the two shell layers that sit between QManager and
the modem on the X16:

| Layer | File | Cost per call |
|---|---|---|
| vendor AT broker | `/bin/atcmd` | **35 ms** (the modem) |
| Quectel→SIMCom shim | `zlt-x16/deploy-x16/atcli_smd11` (46 KB sh) | **77 ms** (+42) |
| lock + error classification | `scripts/usr/bin/qcmd` (sh) | **93 ms** (+16) |

`main.rs` is a multicall binary (`qcmd`-shaped), `dialect.rs` holds the
translation arms, `inventory.rs` is the machine-readable table of every arm with
its porting status and the test that pins it, `lock.rs` is the AT lock, and
`tests/parity.rs` diffs this crate's stdout against the **real shell shim** so
drift is caught mechanically.

## Is it worth porting? — measured answer: mostly no, with one real exception

**No, for throughput.** The poller issues only **2–3 AT calls per cycle** (one
compound: `AT+QENG="servingcell";+QCAINFO=1;+QCAINFO;+QCAINFO=0`, and the shim
answers `+QCAINFO=0|1` with a bare `OK` without touching the modem). Porting the
shell away saves ~58 ms × 3 ≈ **0.17 s per cycle** against a 10 s budget. Not
worth 4,500 lines of maintained Rust.

**Yes, for the lock tail — and this is the part that changed my mind.** Measured
on device, n=10, 1.5 s apart:

| `qcmd AT+CVERSION` | min | median | **max** | mean |
|---|---|---|---|---|
| pre-fix (`sleep 1` poll) | 129 ms | 270 ms | **11,349 ms** | 1,622 ms |
| post-fix (`sleep 0.1` poll) | 130 ms | 229 ms | **1,190 ms** | 496 ms |

The pre-fix worst case blocked a caller for **11.3 seconds** — eleven 1-second
quantum waits. That is a UI/CGI-visible stall, and it is why the poller blew its
budget. Polling at 100 ms removed 89 % of it, but it cannot remove the rest,
because **`sleep 0.1` on this box costs 120 ms** (busybox forks) — the poll loop
is dominated by the cost of waiting itself.

A native client with a **kernel-blocking lock** would make contention cost ~0
instead of ~1 s, taking the tail from 1.19 s to roughly the 150 ms floor. That is
the only measured justification for this crate.

## Frictions (be sure before starting)

- **aarch64 vs armv7.** The existing Rust in this tree (`native/qmanager_atd`,
  `native/qmanager_traffic`, `ping-daemon`) is aarch64-musl. The X16 is
  **armv7l**. Nothing here runs as-is; a cross toolchain is required.
- **`/dev/smd11` vs `/bin/atcmd`.** `qmanager_atd` owns the serial device
  directly. On the X16 the modem is already owned by the vendor's `atcmd_daemon`
  behind `/bin/atcmd`, so a real client must drive `atcmd` and must not open the
  device.
- **The shim is 46 KB of translations.** This is a port, not a wrapper.

## What the parity harness already found

1. **Phantom `ERROR` on every `QNWPREFCFG` write** (fixed upstream in
   `14bd1e6`). The shell stored the command remainder in `_rest`, which is the
   `;`-compound loop's global, so the loop ran one extra iteration and appended a
   spurious `ERROR`. `qcmd` treats that as `command_failed`, so **every band and
   network-mode write was reported as failed while the modem had applied it.**
   Verdict: **shell was wrong**, and it was invisible to the existing tests
   because they asserted with `grep -m1 OK`.
2. **`AT+QCCID` trailing newline.** The shell pipes through `sed`, which
   terminates the last line with `\n`; the port initially did not.
   Verdict: **must match** — fixed in `dialect.rs`.
3. **Fabricated success for band locks** in this crate: `arm_for` sent every
   `AT+QNWPREFCFG=<key>,…` to `Arm::PrefWrite`, which answers `OK` without
   touching the modem, making `Arm::PrefBandWrite` dead code that the inventory
   nevertheless listed as `Ported`. Verdict: **this crate was wrong** — now
   `PrefBandWrite` is classified first and answers `ERROR`, and the inventory row
   is `Status::Pending`. A fabricated `OK` here would have made the UI believe a
   band lock was applied; an unsupported band can leave the modem on
   `NO SERVICE`.

## Verification status

| Check | Result |
|---|---|
| `cargo check --offline` | clean, 0 errors |
| `cargo test --offline` | **80 pass, 0 fail** (65 unit + 12 cli_contract + 3 parity) |
| parity vs the real shell shim (`X16_SHIM=…`) | **3/3 pass** |
| parity without `X16_SHIM` | skips — a pass there means nothing |
| on-device | **never run.** No device contact was permitted. |

## Recommended order of work

1. Do **not** port `qcmd` for speed. 0.17 s/cycle does not pay for it.
2. If the AT lock tail matters (it does: 11.3 s stalls), implement **only**
   `lock.rs` as a native helper: a kernel-blocking `flock` with a deadline, no
   shell polling. That is a few hundred lines, not a port.
3. Port an arm at a time, driven by `inventory.rs`, with `tests/parity.rs`
   pointed at the real shim in CI.
4. Keep `PrefBandWrite` pending until `AT+CSYSSEL=?` validation is written.

## Do not do this

- Do not open `/dev/smd11` on the X16.
- Do not answer `OK` for anything not actually implemented; a fabricated success
  in a band lock can leave the modem without service.
- Do not trust a parity run that prints `skipped: set X16_SHIM=…`.
- Do not benchmark this on a loaded box: the same `jq -n 1` measured 101 ms under
  load and 18 ms idle, and a 200-iteration `flock` probe self-contended to a
  false "95 % busy". Idle the poller or accept that you are measuring the load.
