# AGENTS.md — working on the GreenPacket O5A Pro deployment

This branch (`greenpacket`) carries the deployment layer for running QManager on
the **GreenPacket O5A Pro**. Read this before touching anything that talks to the
device. `memory.md` records the current state of the live install.

Scope: this branch is **deployment-only**. The application code (`app/`,
`components/`, `lib/`, `types/`, `hooks/`) tracks upstream QManager and should
not be modified here — the product-specific work lives in `deploy/`.

**One recorded exception:** the speedtest favourite-server control
(`components/dashboard/speedtest-dialog.tsx`, `hooks/use-speedtest.ts`,
`types/speedtest.ts`, `public/locales/en/dashboard.json`). A favourite needs a
control in the UI, so it could not live in `deploy/` alone. Treat this as the
only app-layer change on this branch: keep it minimal, and prefer extending the
backend if a future need can be met without touching app code.

## Sibling project — the source of truth for device conventions

`/Users/emumba/Downloads/projects/greenpacket-o5a` (repo `greenpacket-o5a`,
branch `master`) is the **current production product**: its own UI (Svelte `v2/`),
its `/data/gp/*` backend, and its boot wiring. It has years of hard-won device
knowledge. Read its `AGENTS.md`, `CLAUDE.md` and `memory.md` before changing
anything boot-related or radio-related here, and inherit these rules:

1. **No `scp`/`rsync`/`sftp` on this device** — there is no `sftp-server`. Stream
   with `tar czf - ... | ssh ... tar xzf -` (this repo's deploy steps already do).
2. **Never take port 80, 8083, 8090, 8091, 8092, 11080 or 18080.** Those belong to
   the vendor UI, `turin_web`, `gp-pcidb`, the radio handler, the metrics stream
   and nanoproxy. QManager's **8080 is free** — keep it.
3. **All AT access must be serialized.** The product convention is
   `acquire_atlock`/`release_atlock` in `/data/gp/radio-handler.sh`. QManager's
   general AT path sidesteps that contention with its own port plus `qcmd`'s
   flock — **Hard rule 3** below is the authority on how; nothing here overrides
   it.
4. **Back up before touching `/web` or `/data/gp`** — timestamped tarball into
   `backup/<ts>/`. This branch does not modify either; if that changes, back up.

Boot wiring, `/etc/init.d/turin_web.sh` ownership, the poller readiness gate and
the secrets/binary rules are each stated **once**, in Hard rules below — do not
restate them here.

## Target hardware — assume nothing from upstream

Upstream QManager targets an **RM520N-GL** reference image. The O5A Pro is a
different module on different firmware, and every one of the following has
already caused a failed install:

| Fact | Consequence |
| --- | --- |
| Module is **Quectel RG520N-EB**, SDX6X / `sdxlemur`, `LE.UM.6.2.3.r1-03100-SDX65.0` | Upstream `--force` is needed for its firmware check, and AT parsers written for RM520N occasionally miss |
| `/` is a **read-only squashfs** | `/usr/lib`, `/usr/bin`, `/bin`, `/lib` are **physically unwritable**; `mount -o remount,rw /` fails. Never plan an install there |
| Writable storage is the ubifs volume `ubi2_0`, bind-mounted at `/etc`, `/usrdata`, `/data`, `/cache`, `/persist`, `/systemrw`, `/web` | All install state goes under `/usrdata/qmanager` + `/etc/qmanager` + `/etc/systemd/system` |
| No `lighttpd`, `jq`, `sudo`, node, python, or compiler; `/opt` cannot be created | The stock installer's package stage cannot run. Use the shims in `deploy/` — `jq`, `sudo`, `speedtest` and `sms_tool` are all provided that way |
| Port 80 is the vendor UI (`busybox httpd -f -p 80 -h /web/v2`) | QManager goes on **8080**. Never bind 80 |
| `/dev/smd11` is owned by `modemd`; `atcli_smd11` does **not exist** | Use `deploy/atcli_smd11`, which talks to `/dev/at_mdm0` |

## Hard rules

1. **Never write outside `/usrdata`, `/etc/qmanager`, `/etc/systemd/system`.**
   The rootfs is immutable; attempts fail or, worse, half-succeed.
2. **Do not disturb the vendor stack.** `/data/gp/*` (radio-handler, metricsd,
   QMI helpers), the `:80` UI, and `modemd` must keep working. Verify
   `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/` still returns 200
   after any change.
3. **AT goes through `/dev/at_mdm0`, and every call goes through `qcmd`.**
   Do not switch to `/dev/smd7` for general AT: the vendor's `gp-metricsd.sh`
   polls it every ~0.4 s and steals response bytes, which silently truncates
   replies to a bare `OK`. Do not use `/dev/smd11` (modemd). And **never call
   `bin/atcli_smd11` directly while the poller runs** — only `qcmd` holds the
   shared flock (`/tmp/qmanager_at.lock`), so a direct call corrupts concurrent
   polls. Symptom: `qcmd_exec failed: cmd=AT+QENG... exit=1` plus
   `poll_cycle exceeded budget` in syslog, which can be lock contention and is
   NOT proof of a modem fault (each command returns in 0-1 s when called alone).
   The shim drains stale bytes and only retries a read-only allowlist; never
   retry/replay arbitrary setters after an empty response. SMS is the one
   exception: `bin/sms_tool` wraps the vendored binary, defaults
   the device to `/dev/smd7`, and takes the vendor radio lock itself, because
   SMS storage is not visible on at_mdm0.
4. **Do not "fix" the remaining health-check failures.** `perm.smd11`,
   `perm.www_dialout`, `sudo.list`, `svc.lighttpd`, `net.lighttpd_listen`,
   `svc.console`/`bin.ttyd`, `svc.firewall` and `svc.setup` are expected
   deviations of this deployment (root-run CGI, at_mdm0, no lighttpd, console
   blocked by the 8080 requirement). See `memory.md` before chasing any of them.
5. **Never `pkill -f "httpd -p 8080"` over SSH.** The pattern matches the SSH
   command line itself and kills your own session. Use
   `/usrdata/qmanager/bin/qm_serve.sh {start|stop|restart|status}`.
6. **Boot changes are only proven by a real reboot** — poll
   `/proc/sys/kernel/random/boot_id` before and after; `systemctl restart` proves
   nothing. **`systemctl enable` is not enough either:** this firmware drops units
   from PID 1's boot transaction (see `qm_boot_hook.sh`'s header), so a unit in
   `/etc/systemd/system` reads `enabled` and never runs. Always confirm
   `ActiveEnterTimestamp` against `/proc/uptime` afterwards.
7. **Never overwrite `/etc/init.d/turin_web.sh`** — the product repo owns it and
   edits it continuously. QManager joins the boot path by *inserting*
   `start_service_async` lines via `deploy/qm_boot_hook.sh` (currently httpd,
   poller, ping, dpi and the dpi-ensure timer; idempotent and additive, anchored
   on `systemctl daemon-reload`, one-time backup kept as `.pre-qmanager`). Add
   new boot-started units there, not by shipping a copy of the script.
8. **Gate the poller on a real modem answer, not the device node.** Device
   identity is cached once at poller start; a modem still booting answers with
   the `RDY` URC, which was observed baking `"model": "RDY"` into the cache for a
   whole boot. `deploy/qm_wait_modem.sh` is the `ExecStartPre` for that reason,
   and it calls `qcmd` (not `atcli_smd11`) so it honours the AT flock.
9. **Do not ship third-party binaries in git.** `deploy/.gitignore` excludes the
   static `jq`; it is fetched at deploy time (see `deploy/README.md`). The Ookla
   `speedtest` binary and `sms_tool.bin` are likewise deploy-time payloads, not
   repo content.
10. **Do not commit secrets or subscriber identifiers.** No IMEI/IMSI/ICCID, no
    passwords, no `auth.json` copies. The device is left in `setup_required`
    state so the owner sets their own password.

## Documentation is a deliverable

This branch is the **porting reference** for other modems. A device fact learned
here and not written down is lost when the next module arrives, and the cost of
rediscovering it is paid again. So a change is not finished until its docs are
written — not "when there is time".

The repository already has the structure; use it instead of inventing a new one.
Each artefact has one job:

| Artefact | Holds | Written |
| --- | --- | --- |
| `docs/specs/<feature>.md` | A **proposed** feature: falsifiable requirements | Before code |
| `docs/reference/<feature>.md` + router row | **Built** subsystem knowledge, operational | With the code |
| `docs/plans/YYYY-MM-DD-<slug>.md` | Dated work record: intended, measured, built, still broken, next | During the work |
| `.orchestra/runs/<date>-<slug>.md` | The live ledger for a Full-lane run | Per `qm-orchestrate` |
| `memory.md` | What exists where on the live install | When the install changes |
| `AGENTS.md` | How to work | Rarely |

1. **Search for the precedent before designing anything.** Half of a bad design is
   re-inventing something this repo already solved, or re-adding something it
   shipped and deliberately removed. Grep `docs/reference/` for the subsystem (the
   router's *Triggers* column tells you which doc), read it, then design. A
   proposal that re-adds a rejected mechanism is a regression, not a feature — two
   live examples are recorded at `docs/reference/latency-monitor.md:71` (two ranges
   dropped because they produced two points and one) and `:74` (a separate live
   band, shipped then reverted because it disagreed with the cards below it).
2. **A proposed feature gets `docs/specs/<feature>.md` before any code**, in the
   shape already used by `docs/specs/system-health-card.md`: status, background,
   numbered In Scope, **Out of Scope with reasoning**, and falsifiable requirements
   as `- [ ]` acceptance criteria. The out-of-scope list is the important half — it
   is what stops the next agent re-inventing a rejected idea. Copy that format; do
   not invent a new one.
3. **A built feature or subsystem gets `docs/reference/<feature>.md`** plus a row
   in `docs/reference/README.md`. The row lists **triggers** (the concrete routes,
   scripts, binaries, config keys, `/tmp` files that tell a reader *when* to open
   the doc), never a summary of what the doc says. Declare the **Scope** — which
   device the facts were measured on (`RM520N`, `RG501Q`, `RG520N`, `Both`).
4. **Every piece of work spanning more than one session gets
   `docs/plans/YYYY-MM-DD-<slug>.md`, and Full-lane work also gets its
   `.orchestra/runs/` ledger** per `.claude/skills/qm-orchestrate`. The plan carries
   what was intended, what was measured, what was built, what is still broken and
   the next step; update it as the work moves rather than leaving it describing an
   abandoned plan.
5. **Record the measurement, not the conclusion.** "40 ms, measured 2026-07-20 on
   this unit" is reusable; "QMI is faster" is not. Name the exact file:line a fact
   came from, and mark anything not first-hand-verified rather than presenting it
   as confirmed.
6. **Record what did NOT work.** A negative result ("`AT+QENG="nr5g_neighbourcell"`
   returns nothing on this firmware", "QMI gives no NR neighbours") is worth more
   than the positive one, because it stops the next person repeating it.
7. **Per-device facts go in `docs/reference/platform-matrix.md`, not scattered in
   prose.** Anything that differs by modem, SoC or firmware — path, binary,
   command availability, byte layout, sentinel values — belongs in that matrix so
   a port can read one file instead of grepping three repos.
8. **Say what a port must re-measure.** When a fact is device-specific, label it
   so. Anything measured only on the O5A is not a claim about the RM520N-GL.
9. **Docs ship with the change they describe.** A commit that adds behaviour and
   not its spec or reference note is incomplete, even if the code works.

## Measure it, then prove the edges

Two rules, in this order. Both exist because a claim without a number or a
counter-example is an opinion, and this branch is a reference for ports.

### 1. Every feature ships a before/after benchmark — CPU and memory

Method is not negotiable and is already established by
[`docs/reference/poller-cpu-profile.md`](./docs/reference/poller-cpu-profile.md):

```sh
# Total CPU INCLUDING reaped children. htop shows only the parent's utime+stime,
# which is ~9x too low for a shell daemon that forks. Strip "pid (comm) " first, then
# awk fields 14+15 are cutime+cstime (stat fields 16+17).
sed 's/^[0-9]* (.*) //' /proc/<pid>/stat | awk '{print $14+$15}'

# Memory: per-process RSS, plus device headroom.
grep VmRSS /proc/<pid>/status     # kB
grep -E 'MemTotal|MemAvailable' /proc/meminfo
```

Rules that make the pair meaningful:

1. **Capture the baseline BEFORE the deploy.** After the change is live the "before"
   is gone; this is the one measurement you cannot reconstruct later. A feature with
   no baseline is unmeasured, not fast.
2. **Same conditions both runs** — duration, cadence, and what the device was doing
   (idle vs live lease held, with or without a scan). Record them in one line beside
   the numbers.
3. **Never mix a number from two runs.** `poller-cpu-profile.md` carries an explicit
   warning about this: two runs with different durations and conditions produced
   595 ms/cycle and 815 ms/cycle for the same code. State which run a figure came from.
4. **Report CPU as a share of one core, memory in kB or MB, and the delta.**
   "Faster" is not a result; "82 ms avg, 4 % of one core, +0 MB RSS" is.
5. **Record it in the spec's benchmark table and repeat it in the plan.** If a later
   change makes it worse, it is a regression against a recorded number, not a
   matter of opinion.
6. **A new dependency that forks pays for itself or it does not ship.** The device
   constants are measured: `/bin/true` costs 2.40 ms (RM520N-GL) / 4.95 ms
   (RG501Q-EU), and `jq` costs 4.3x a normal applet. At 1 Hz, 30 extra forks/second
   is a real cost — say what it is.

### 2. Edge cases are validated at close-out, not up front

Write the edge-case list with the spec, but **exercise it last** — after the feature
works end to end. Running a matrix of hypotheticals before the happy path exists
wastes the time it is meant to save.

The list is part of the spec, as a table, and each row is checked off with what was
actually observed:

| Edge case | How it was exercised | Observed |
| --- | --- | --- |
| Binary missing / call fails | point the path variable at a non-existent file | last-good data kept, one warning, no crash |
| Empty response | stub returning nothing | distinct status, never an empty array presented as "none found" |
| Field absent from a row | captured fixture with a missing RSRP | `null`, row still emitted, renders `—` |
| Stale data | hold the file mtime back past its TTL | age shown, value not presented as fresh |
| Clock at 1970 (no RTC) | boot with WAN down | TTL logic does not treat everything as fresh |
| Device busy / lock held | a scan running concurrently | one failure, no cascade, no retry storm |

**This is a checklist, not a harness.** Hard rail 8 in
`.claude/skills/qm-orchestrate/SKILL.md` forbids `scripts/test/`, `*.test.*` and
assertion scripts, and that ban stands: the evidence is a run with its output
pasted into the commit body, and `scripts/test/` stays deleted. "Validate the edge
cases" never means "add a test framework".

**One exception, and it is a safety one.** Edge cases that can lose data, brick the
radio, or leave the modem offline are checked **at the gate, before merge**, not at
close-out — a radio write that fails mid-sequence is not a late-found nit. Everything
else waits for the end.

## Build & deploy

Full procedure: `deploy/README.md`. Summary:

```bash
bun install --frozen-lockfile
bun run build            # static export -> out/   (no SSR; the device cannot run node)

# assemble payload -> stage/{www,lib,bin} per deploy/README.md, fetch static jq,
# ship with tar over ssh, then:
sh deploy/qm_pathfix.sh       # rewrite /usr/lib/qmanager -> /usrdata/qmanager/lib
sh deploy/qm_boot_hook.sh     # insert the boot start-lines into turin_web.sh
qm_serve.sh start             # busybox httpd on :8080
systemctl restart qmanager-httpd qmanager-poller qmanager-ping qmanager-dpi
```

`deploy/qm_pathfix.sh` must be re-run after **every** redeploy of the backend,
because the source tree still hardcodes upstream paths. It only rewrites paths
QManager owns; `/usr/bin/timeout`, `flock`, `env` etc. must stay untouched.
`qm_boot_hook.sh` is idempotent — safe to re-run, and it reports "already hooked".

## Verification (do this after every change)

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/         # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/setup/   # 200
curl -s http://127.0.0.1:8080/cgi-bin/quecmanager/public/overview.sh    # JSON
systemctl is-active qmanager-httpd qmanager-poller qmanager-ping qmanager-dpi   # all active
systemctl is-active qmanager-dpi-ensure.timer                                  # active
jq '.device.model, .device.temperature, .network.type, .network.carrier, .network.apn, .network.wan_ipv4' /tmp/qmanager_status.json
# RG520N-EB, temperature C, 5G-NSA, Jazz, internet, assigned WAN IPv4
jq '{reachable,last_rtt_ms}' /tmp/qmanager_ping.json                    # true + measured RTT
# Use qcmd (full path — a plain ssh session does not have bin/ on PATH), NOT
# atcli_smd11: only qcmd takes the shared AT flock.
/usrdata/qmanager/bin/qcmd 'AT+CGMM'                                     # RG520N-EB + OK

# Feature-level checks (these are the ones that broke before):
#   Speed Test -> GET  /cgi-bin/quecmanager/at_cmd/speedtest_servers.sh   (needs Ookla;
#                 returns `favourite` too — POST {action:"set_favourite"|"clear_favourite"}
#                 pins a server, and speedtest_start.sh reuses it when no server_id is sent)
#   SMS        -> GET  /cgi-bin/quecmanager/cellular/sms.sh               (needs sms_tool;
#                 multipart rows carry parts_received/parts_total, and got<total is
#                 normal because the modem drops segments)
#   Priority   -> GET  /cgi-bin/quecmanager/cellular/network_priority.sh
#   Languages  -> GET  /cgi-bin/quecmanager/system/language-packs/list.sh?manifest_url=...
#   Traffic    -> POST /cgi-bin/quecmanager/network/video_optimizer.sh {"action":"install"}
#   Engine     -> GET  .../video_optimizer.sh?action=status   (want status=running,
#                 domains_loaded>0, force_tcp_active=true)
#   Clock      -> GET  .../system/settings.sh  (want timezone_applied=true and a
#                 non-UTC effective_offset; see the tz note in deploy/README.md)
# Every endpoint above needs a session cookie; log in via
# POST /cgi-bin/quecmanager/auth/login.sh first.

# The vendor stack must still be healthy after any change:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/              # 200 (vendor UI)

# After a reboot, confirm the units really ran at boot (not just enabled):
systemctl show -p ActiveEnterTimestamp --value qmanager-httpd qmanager-poller qmanager-ping qmanager-dpi
```

A response missing its payload line (just `OK`) is the signature of AT port
contention — check which `AT_DEV` the shim is using.

## Gotchas

- Run shell loops over multiple dirs explicitly: the device's `ash` has **no
  brace expansion** (`mkdir -p a/{b,c}` creates a literal `{b,c}` directory).
- `qmanager_poller.service` deliberately waits for `/dev/at_mdm0`; upstream waits
  for `/dev/smd11`, which never appears for CGI.
- `/tmp/qmanager_status.json` is tmpfs — it is the poller cache and is
  regenerated on poller start. Never treat it as durable state.
- **LTE Cell Distance is intentionally blank on this firmware.** The modem reports
  `lte_time_advance=1968` (stable across samples) while `nr5g_time_advance=25600`
  -> ~2.0 km, and the owner confirms the tower is at most 2.5 km away. Under 3GPP
  the LTE figure means ~9.6 km, which the ground truth rules out, and no
  spec-justified reading of 1968 gives ~2 km (as an index it exceeds the 1282
  ceiling; as N_TA it is 9.6 km). The raw value is published unchanged and the
  dashboard's range check declines to render it. Do NOT reintroduce a scale factor
  to force a plausible number — an earlier /16 guess was disproved by the owner.
  NR distance is trustworthy and does render.
- Shipping a UI change from this branch needs `bun install --frozen-lockfile`,
  `bun run build`, then extracting `out/` INTO `/usrdata/qmanager/www` (never
  replace that directory — `cgi-bin` lives inside it).
- `device/about` and Connection Details use the kernel-derived `bridge0` LAN
  gateway, default-route WAN address, and public-IP probe. The modem identification
  remains truthful (`Quectel RG520N-EB`); product branding belongs in the
  application layer, which this deployment-only branch does not modify.
