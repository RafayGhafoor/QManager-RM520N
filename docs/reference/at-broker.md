# The AT broker (`qmanager_atd`, Rust)

> **Scope:** `RG520N` — measured on the GreenPacket O5A Pro (Quectel RG520N-EB,
> SDX6X `sdxlemur`, kernel `5.4.210-perf`, BusyBox 1.36.1). **Not** a claim about
> the RM520N-GL, RG501Q-EU or the Suncomm X75 — see
> [`platform-matrix.md`](./platform-matrix.md) for what a port must re-measure.
> **Status: built, cross-compiled, RUN ON THE DEVICE, then REVERTED.** It works and
> cuts per-AT-call latency ~70x (770 ms → 11 ms), but it did **not** reduce poller
> CPU, so it is **not enabled**. Measured results and the two corrected figures are
> in [`../plans/2026-10-22-x75-sync.md`](../plans/2026-10-22-x75-sync.md) §"After".
> ⚠️ **An operator must not leave the daemon running unattended** — see
> *Operational warning* below.
> **Source of the crate:** the owner's `suncomm-x75-live-neighbours` branch of
> `RafayGhafoor/QManager`, where it is the only AT path. Ported here by
> [`docs/specs/rust-atd-port.md`](../specs/rust-atd-port.md) (option **B**).
> **Work record:** [`docs/plans/2026-10-22-x75-sync.md`](../plans/2026-10-22-x75-sync.md).

---

## Why it exists

On this SoC almost none of a shell daemon's CPU is computation — it is
**process-creation overhead**. Measured here (see
[`poller-cpu-profile.md`](./poller-cpu-profile.md)): the poller spent
**406 ms/cycle at 17.7 % of one core**, and **76 % of that was fork+exec** — about
**26 processes per AT call** and ~80 AT calls a minute.

The shell `qcmd` cannot avoid that: it is `qcmd` → `sh` → `atcli_smd11` → `sh` →
`timeout` → `flock` → `grep`/`jq`, per call. The broker replaces the whole chain
with **one process**: a Rust binary that holds the port, parses in-process, and
serialises on the same lock.

It is **one binary, three names**, dispatched on `argv[0]`:

| Invoked as | Role |
| --- | --- |
| `qmanager_atd` | Daemon: owns the AT device, one request per socket connection |
| `qcmd` | Client: **socket first**, in-process exchange if the socket is absent |
| `qsms` | SMS client (**do not install this name on the O5A** — see *SMS* below) |

The fallback is the reason the broker is *optional*: with no daemon running, the
`qcmd` client still performs the exchange in-process and only the shell's forks
disappear (~26 → 1). Starting the daemon removes the remaining `flock` and
per-call open.

## What it is NOT — the single most important caveat

**It is a transport, not a parser.** Upstream's `parse.rs` covers `QENG`,
`QCAINFO`, `QRSRP`, `servingcell` — and has **zero** occurrences of `QNWCFG`,
`QTEMP`, `QSCAN`, `neighbourcell` or `ssb_beam`. In the shipped binary that code
is compile-dead (`#[allow(dead_code)]`, no `--poll`/`--parse-only` mode exists).

So **our shell parsers stay**: `parse_at.sh`, `phy_metrics.sh`, `qmi_read.sh`,
`cgi_at.sh`. A port that assumed the broker also replaced parsing would be wrong.

Also unchanged: **`qmi_read.sh` and `phy_metrics.sh` are untouched by this port.**
The QMI neighbour reader (~40 ms, `qrtr://3`) is a different transport and remains
the right one for the live aim view.

## What we had to change from upstream

Upstream's device is an **aarch64** OpenWrt box whose AT port is `/dev/smd11`.
Ours is **armv7l**, systemd, and its AT port is `/dev/at_mdm0`. Every change below
is marked in the source with an `O5A PORT:` comment.

| Upstream | O5A | Why |
| --- | --- | --- |
| `const SMD_PATH = "/dev/smd11"`, no override | `AT_DEV` env, default `/dev/at_mdm0` | `/dev/smd11` is `modemd`'s; `/dev/smd7` is polled by the vendor's `gp-metricsd` every ~0.4 s and steals reply bytes (hard rule 3). `AT_DEV` is the name `deploy/atcli_smd11` already uses — one convention, both AT paths |
| `/var/lock/qmanager.lock` | `/tmp/qmanager_at.lock` | `qcmd`, the poller, the scanners and every CGI serialise on `/tmp/qmanager_at.lock` (~40 callers). Two locks on one port is the corruption hard rule 3 prevents. **`/var/lock` *is* writable here (probed) — this is a serialisation requirement, not a filesystem one** |
| `/var/lock/qmanager.pid` | `/tmp/qmanager_at.pid` | The pid file is written under the lock, so it moves with it |
| lock created `0644` | `0666` | The shell `qcmd` creates it 0666 so a `www-data` CGI can take the same lock; a narrower mode is the direction that breaks those callers |
| `LOCK_WAIT_SHORT/LONG` = 5 s / 10 s | **20 s / 45 s** | Matches `scripts/usr/bin/qcmd`, which raised them deliberately: one poller command can hold the lock for several seconds here, and the old values made a CGI arriving mid-poll answer `at_failed` instead of waiting. An empty panel is a bug; a spinner is not |
| `BUILTIN_LONG` = QSCAN, QSCANFREQ, QFOTADL, **COPS=2, COPS=0** | the first three only | "Long" also sets `/tmp/qmanager_long_running`, and every short call queued behind it then answers `scan_in_progress` for up to 300 s. The shell `qcmd` classifies only these three, so adding COPS would change device-wide behaviour for no measured gain |
| restart via `/etc/init.d/qmanager_atd` (procd) | `systemctl restart qmanager-atd.service` | No procd here. The `O_EXCL` marker, 120 s rate limit and `setsid` are unchanged |
| target `aarch64-unknown-linux-musl` | **+ `armv7-unknown-linux-musleabihf`** | `uname -m` = `armv7l`; the other binaries on this box (`atcli_smd11`, `sms_tool`) are ELF 32-bit ARM EABI5 |

Unchanged on purpose: `SHORT/LONG/SLOW_DEADLINE` (20/300/60 s), the socket at
`/var/run/qmanager_atd.sock` (tmpfs, verified writable), the `SO_PEERCRED`
uid-0 gate (every CGI on this box runs as root, so it is a no-op rather than a
barrier), and the release profile (`opt-level="s"`, LTO, `codegen-units=1`,
`panic="abort"`, `strip`) — `panic="abort"` is load-bearing for its EPIPE
handling, so do not "fix" it to unwind.

## The exit-code contract — read this before pointing anything new at it

This is the one place upstream and this deployment genuinely disagree, and it
decides which callers may use which client.

| | shell `qcmd` (this deployment) | Rust `qcmd` (upstream) |
| --- | --- | --- |
| `ERROR` reply | **rc 1**, empty stdout, `ERROR: command_failed` on stderr | **rc 0**, `ERROR` in stdout |
| Caller must | test `$?` | match the text |

Consequence: **do not repoint the ~40 CGI callers at the Rust client en masse**
(spec option A). A caller that tests `$?` would report a rejected write as
applied.

The **poller is safe**: `qcmd_exec()` (`scripts/usr/bin/qmanager_poller:587`)
tests `$?` for non-zero *and* empty output first, then matches `*ERROR*` in the
text for its rc-2 branch — so the Rust client's rc 0 + `ERROR` text lands on
exactly the same branch the shell client's rc 1 + `ERROR` text does. That is what
makes option B (poller only) correct rather than merely convenient.

## Measured behaviour on this device

Baseline captured **2026-10-22, before any deploy** (method:
`sh -s -- 60 qmanager`, see the plan doc for the harness):

| Metric | O5A (1 core) | Suncomm X75 (2 cores), for scale |
| --- | --- | --- |
| Box busy | 66.16 % of one core | 41.27 % of total capacity (≈ 82.6 % of one core) |
| `qmanager_poller` | **16.90 %** of one core | 26.82 % |
| `qmanager_ping` | 2.27 % | 1.23 % |
| `qmanager_atd` | — (not installed) | **0.10 %** |
| Forks/second | **113 /s** | 48 /s |
| QManager RSS total | 3.4 MB | 2.4 MB (excl. `sh` wrappers) |
| Device memory used | 133 MB of 182 MB | 106.4 MB of 231 MB |

Two things to take from that table, and one trap:

1. The X75 does **2.4× fewer forks** than the O5A — the broker's win is real and
   visible in the fork rate.
2. The X75's *per-core* poller CPU is nevertheless **higher** than ours, because
   v0.1.33's poller does substantially more work (watchdog, sites, scenarios).
   **The fork rate is the honest transport metric; aggregate CPU mixes in feature
   growth.** Do not quote one as the other.
3. **Do not carry upstream's headline numbers across.** Upstream measures one
   `jq` at 150–200 ms; here it is **11.1 ms**. Their "1096 → 66 ms" is really
   "≈35 → ≈5 ms" on this box. The direction transfers; the magnitude does not.

## Binary facts

| | |
| --- | --- |
| Size | **513,000 B** |
| Type | ELF 32-bit LSB, ARM EABI5, **statically linked, stripped, no `INTERP`** |
| Version line | `qmanager_atd 0.2.0 proto=2` |
| Build | `cargo build --release --target armv7-unknown-linux-musleabihf`, linker `rust-lld`, `-C target-feature=+crt-static` — no cross gcc |
| Dependencies | `libc` only |
| Licence | MIT + Commons Clause, same licensor as this repo — vendoring adds no new obligation, but the notice must travel |

**Host `cargo test` does not run on macOS**: the crate uses Linux-only
`libc::SO_PEERCRED`/`ucred`. Upstream ran its tests on WSL/Linux. The gate here is
therefore a cross-build plus an on-device smoke test, not `cargo test`.

The crate's `tests/parity/expected.txt` corpus (799 KB, 2184 device-captured
cases) **is not usable as the acceptance test on this port**: it exercises
`parse.rs`, which never runs, and the device leg needs a `--parse-only` mode the
shipped binary does not have. Parity here means *output parity of `qcmd`*, proved
by a before/after command table — not the upstream corpus.

## Enabling it on the O5A

Nothing below has been run yet. Do it in this order; steps 1–4 are the whole
technical risk and step 4 is the gate.

```sh
# 0. Ship the binary + unit (never scp — stream with tar):
tar czf - -C stage/qmanager_atd . | ssh root@greenpacket 'tar xzf - -C /usrdata/qmanager/bin'
tar czf - -C deploy qmanager-atd.service | ssh root@greenpacket 'tar xzf - -C /etc/systemd/system'

# 1. Smoke it BY HAND, as `qcmd`, with NO daemon running (in-process fallback).
#    Record rc/stdout/stderr for each — this is the parity table.
ln -sf qmanager_atd /tmp/qcmd
AT_DEV=/dev/at_mdm0 /tmp/qcmd 'AT'
AT_DEV=/dev/at_mdm0 /tmp/qcmd 'ATI'
AT_DEV=/dev/at_mdm0 /tmp/qcmd -j 'ATI'
AT_DEV=/dev/at_mdm0 /tmp/qcmd 'AT+FOOBAR' ; echo "rc=$?"   # expect rc 0 + ERROR text
/usrdata/qmanager/bin/qcmd 'AT+FOOBAR'     ; echo "rc=$?"   # shell: expect rc 1

# 2. Prove the lock is shared: the broker must NOT create a second file.
: > /tmp/qmanager_at.lock
AT_DEV=/dev/at_mdm0 /tmp/qcmd 'AT+CGMM'
ls -l /var/lock/qmanager.lock 2>/dev/null && echo "REGRESSION: second lock file exists"

# 3. Start the daemon.
systemctl daemon-reload
systemctl start qmanager-atd.service
systemctl is-active qmanager-atd.service
ls -l /var/run/qmanager_atd.sock            # expect srw------- root
cat /var/run/qmanager_atd.proto             # expect proto=2

# 4. GATE — a real exchange through the socket, and a concurrent CGI.
AT_DEV=/dev/at_mdm0 /tmp/qcmd 'AT+CGMM'
curl -s -b <cookie> http://127.0.0.1:8080/cgi-bin/quecmanager/cellular/network_priority.sh | head -c 200
#   during a poller cycle, the CGI must WAIT (20 s budget), not answer at_failed.

# 5. Only after 4 passes: point the POLLER at it, poller only.
#    CGIs keep the shell qcmd (option B).
systemctl restart qmanager-poller.service
```

**Rollback** is one command: `systemctl stop qmanager-atd.service` — the client's
in-process fallback keeps AT working, and nothing else in the deployment changed.

To make it survive a reboot, add `qmanager-atd.service` to `deploy/qm_boot_hook.sh`
(hard rule 7) **and** prove it with a real reboot (hard rule 6: `boot_id` before
and after, then `systemctl show -p ActiveEnterTimestamp --value qmanager-atd`
against `/proc/uptime`). `systemctl enable` alone is not evidence on this
firmware.

## SMS — deliberately not enabled

Upstream's `qsms` uses **the same device as AT** and holds the lock for a whole
session. This deployment's hard rule 3 requires SMS on **`/dev/smd7`**, wrapped in
the **vendor radio lock** (`bin/sms_tool` takes it itself), because SMS storage is
not visible on `at_mdm0`.

So `qsms` **cannot be enabled here by configuration** — it needs a second channel
path plus vendor-lock participation, which the crate does not have. Do **not**
create a `qsms` symlink on this device. SMS stays on `bin/sms_tool`.

## Known risk that only a device can settle

Two upstream channel assumptions are **unverified on `/dev/at_mdm0`** and are the
reason step 4 above is a gate, not a formality:

1. The broker holds **one fd for the daemon's whole lifetime**, closing it only
   on an I/O error. Our `deploy/atcli_smd11` deliberately does the opposite —
   reopen and drain per call — because the vendor's stack shares this port.
2. The crate **never retries**. Our shim retries a **read-only allowlist** once
   after an empty reply. Hard rule 3 forbids replaying arbitrary setters, so the
   crate's stance is compatible in principle, but the read-only retry is
   resilience this deployment currently has and the broker does not.

If either assumption fails on this port, the fix is a `channel.rs` change
(reopen per exchange / restore the allowlisted retry) — **not** a config change.
That is the one place this deployment is currently better than upstream.

## Operational warning — the mistake made while testing this

The daemon was started with `setsid` for a latency test and **left running**. It
held one long-lived fd on `/dev/at_mdm0` for hours, which is the unverified
assumption recorded under *Known risk* above. That session later ended with the
unit in a no-signal state and a reboot was needed.

**The broker is not proven to have caused it** — after the reboot the broker was
verified absent (`pidof qmanager_atd` empty, no socket, poller PATH back to the
shell `qcmd`) and the modem was still unresponsive, which the follow-up diagnosis
traced to a wedged modem AT cop (see
[`platform-matrix.md`](./platform-matrix.md) §"recovering a wedged modem"). But
it cannot be excluded either, and the lesson stands:

- Start it, measure it, **stop it** — in one session, never left for a later
  session to clean up.
- Never start it without a unit, so it cannot outlive the test unnoticed.
- If it is ever enabled for real, it goes in `deploy/qm_boot_hook.sh` with a proven
  reboot (hard rule 6), so its lifetime is bounded by systemd.

## Open items

- [x] On-device smoke test and the parity table (steps 1–4) — **done**: the armv7
      binary runs on the O5A, `AT+CGMM` → `RG520N-EB`, `qcmd -j` matches the `jq`
      shape, and **no second lock file was created** (`/var/lock/qmanager.lock`
      stayed absent), which is hard rule 3 satisfied.
- [x] Contract parity confirmed by hand: shell `qcmd AT+FOOBAR` → **rc 1, empty
      stdout**; Rust `qcmd AT+FOOBAR` → **rc 0, `ERROR` in stdout**. The inversion
      is real and is why CGIs must not be repointed at it.
- [x] After-benchmark — **taken, and it is a negative result for CPU**: per-call
      770 ms → 11 ms wall, cycles 6 → 10 per 30 s, but poller 20.07 % → 21.82 %.
      Reverted. `../plans/2026-10-22-x75-sync.md` §"After" has the table.
- [ ] Decision for hard rule 9: commit the 513 KB binary (upstream's choice) or
      fetch it at deploy time (this repo's choice for `jq`/`speedtest`). Not yet
      decided — see the plan doc. **The binary currently lives on the device at
      `/usrdata/qmanager/bin/qmanager_atd` and is inert; remove it if this is
      abandoned.**
- [ ] If the daemon is adopted: `deploy/qm_boot_hook.sh` entry + a proven reboot.
