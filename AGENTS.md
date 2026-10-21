# AGENTS.md — working on the GreenPacket O5A Pro deployment

This branch (`greenpacket`) carries the deployment layer for running QManager on
the **GreenPacket O5A Pro**. Read this before touching anything that talks to the
device. `MEMORY.md` records the current state of the live install.

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
   `acquire_atlock`/`release_atlock` in `/data/gp/radio-handler.sh`, and
   `deploy/atcli_smd11` deliberately avoids that contention entirely by using a
   separate port (see below). If you ever move it to `/dev/smd7`, you MUST
   participate in that lock.
4. **Back up before touching `/web` or `/data/gp`** — timestamped tarball into
   `backup/<ts>/`. This branch does not modify either; if that changes, back up.
5. **Boot changes are only proven by a real reboot** — poll
   `/proc/sys/kernel/random/boot_id` before and after. `systemctl restart` proves
   nothing about boot. The sibling project's history contains several units that
   were `enabled` yet never ran at boot, so always confirm
   `ActiveEnterTimestamp` against the boot time afterwards.
6. Never commit secrets or subscriber identity (IMEI/IMSI/ICCID, `auth.json`).

## Target hardware — assume nothing from upstream

Upstream QManager targets an **RM520N-GL** reference image. The O5A Pro is a
different module on different firmware, and every one of the following has
already caused a failed install:

| Fact | Consequence |
| --- | --- |
| Module is **Quectel RG520N-EB**, SDX6X / `sdxlemur`, `LE.UM.6.2.3.r1-03100-SDX65.0` | Upstream `--force` is needed for its firmware check, and AT parsers written for RM520N occasionally miss |
| `/` is a **read-only squashfs** | `/usr/lib`, `/usr/bin`, `/bin`, `/lib` are **physically unwritable**; `mount -o remount,rw /` fails. Never plan an install there |
| Writable storage is the ubifs volume `ubi2_0`, bind-mounted at `/etc`, `/usrdata`, `/data`, `/cache`, `/persist`, `/systemrw`, `/web` | All install state goes under `/usrdata/qmanager` + `/etc/qmanager` + `/etc/systemd/system` |
| No `lighttpd`, `jq`, `sudo`, node, python, or compiler; `/opt` cannot be created | The stock installer's package stage cannot run. Use the shims in `deploy/` |
| Port 80 is the vendor UI (`busybox httpd -f -p 80 -h /web/v2`) | QManager goes on **8080**. Never bind 80 |
| `/dev/smd11` is owned by `modemd`; `atcli_smd11` does **not exist** | Use `deploy/atcli_smd11`, which talks to `/dev/at_mdm0` |

## Hard rules

1. **Never write outside `/usrdata`, `/etc/qmanager`, `/etc/systemd/system`.**
   The rootfs is immutable; attempts fail or, worse, half-succeed.
2. **Do not disturb the vendor stack.** `/data/gp/*` (radio-handler, metricsd,
   QMI helpers), the `:80` UI, and `modemd` must keep working. Verify
   `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/` still returns 200
   after any change.
3. **AT goes through `/dev/at_mdm0`.** Do not switch to `/dev/smd7`: the vendor's
   `gp-metricsd.sh` polls it every ~0.4 s and steals response bytes, which
   silently truncates replies to a bare `OK`. Do not use `/dev/smd11` (modemd).
4. **Never `pkill -f "httpd -p 8080"` over SSH.** The pattern matches the SSH
   command line itself and kills your own session. Use
   `/usrdata/qmanager/bin/qm_serve.sh {start|stop|restart|status}`.
5. **Keep third-party binaries out of git.** `deploy/.gitignore` excludes the
   static `jq`; it is fetched at deploy time (see `deploy/README.md`).
6. **Do not commit secrets or subscriber identifiers.** No IMEI/IMSI/ICCID, no
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
qm_serve.sh start             # busybox httpd on :8080
systemctl restart qmanager-httpd qmanager-poller
```

`deploy/qm_pathfix.sh` must be re-run after **every** redeploy of the backend,
because the source tree still hardcodes upstream paths. It only rewrites paths
QManager owns; `/usr/bin/timeout`, `flock`, `env` etc. must stay untouched.

## Verification (do this after every change)

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/         # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/setup/   # 200
curl -s http://127.0.0.1:8080/cgi-bin/quecmanager/public/overview.sh    # JSON
systemctl is-active qmanager-httpd qmanager-poller                      # active active
jq '.device.model, .network.type' /tmp/qmanager_status.json             # RG520N-EB, 5G-NSA
/usrdata/qmanager/bin/atcli_smd11 'AT+CGMM'                             # RG520N-EB + OK

# The vendor stack must still be healthy after any change:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/              # 200 (vendor UI)

# After a reboot, confirm the units really ran at boot (not just enabled):
systemctl show -p ActiveEnterTimestamp --value qmanager-httpd qmanager-poller
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
- `device/about` shows empty LAN/WAN IPs because the poller expects upstream
  interface names, not this firmware's `bridge0` / `rmnet_data1`. Cosmetic;
  not yet fixed.
