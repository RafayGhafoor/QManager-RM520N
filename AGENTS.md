# AGENTS.md — working on the GreenPacket O5A Pro deployment

This branch (`greenpacket`) carries the deployment layer for running QManager on
the **GreenPacket O5A Pro**. Read this before touching anything that talks to the
device. `memory.md` records the current state of the live install.

Scope: this branch is **deployment-only**. The application code (`app/`,
`components/`, `lib/`, `types/`, `hooks/`) tracks upstream QManager and should
not be modified here — the product-specific work lives in `deploy/`.

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
   edits it continuously. QManager joins the boot path by *inserting* three
   `start_service_async` lines (httpd, poller, ping) via `deploy/qm_boot_hook.sh` (idempotent, anchored
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
systemctl restart qmanager-httpd qmanager-poller qmanager-ping
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
systemctl is-active qmanager-httpd qmanager-poller qmanager-ping       # active active active
jq '.device.model, .device.temperature, .network.type, .network.carrier, .network.apn, .network.wan_ipv4' /tmp/qmanager_status.json
# RG520N-EB, temperature C, 5G-NSA, Jazz, internet, assigned WAN IPv4
jq '{reachable,last_rtt_ms}' /tmp/qmanager_ping.json                    # true + measured RTT
# Use qcmd (full path — a plain ssh session does not have bin/ on PATH), NOT
# atcli_smd11: only qcmd takes the shared AT flock.
/usrdata/qmanager/bin/qcmd 'AT+CGMM'                                     # RG520N-EB + OK

# Feature-level checks (these are the ones that broke before):
#   Speed Test -> GET  /cgi-bin/quecmanager/at_cmd/speedtest_servers.sh   (needs Ookla)
#   SMS        -> GET  /cgi-bin/quecmanager/cellular/sms.sh               (needs sms_tool)
#   Priority   -> GET  /cgi-bin/quecmanager/cellular/network_priority.sh
#   Languages  -> GET  /cgi-bin/quecmanager/system/language-packs/list.sh?manifest_url=...
#   Traffic    -> POST /cgi-bin/quecmanager/network/video_optimizer.sh {"action":"install"}
# Both need a session cookie; log in via POST /cgi-bin/quecmanager/auth/login.sh

# The vendor stack must still be healthy after any change:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/              # 200 (vendor UI)

# After a reboot, confirm the units really ran at boot (not just enabled):
systemctl show -p ActiveEnterTimestamp --value qmanager-httpd qmanager-poller qmanager-ping
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
- `device/about` and Connection Details use the kernel-derived `bridge0` LAN
  gateway, default-route WAN address, and public-IP probe. The modem identification
  remains truthful (`Quectel RG520N-EB`); product branding belongs in the
  application layer, which this deployment-only branch does not modify.
