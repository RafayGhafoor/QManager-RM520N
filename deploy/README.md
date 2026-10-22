# GreenPacket O5A Pro — QManager deployment

Deployment layer that runs QManager on the **GreenPacket O5A Pro** (Quectel
**RG520N-EB**, SDX6X / `sdxlemur`, `LE.UM.6.2.3.r1-03100-SDX65.0`).

Upstream QManager targets an **RM520N-GL** reference image. That image differs
from this product's firmware in three ways that each break the stock installer,
so this directory carries the adaptations instead of forking the app.

## Why the stock installer cannot be used

| Upstream assumption | Reality on the O5A Pro |
| --- | --- |
| `/usr/lib/qmanager`, `/usr/bin`, `/lib/systemd/system` are writable | `/` is a **read-only squashfs**. `mount -o remount,rw /` fails and `install_rm520n.sh` hard-dies in preflight |
| Entware (`/opt`) can be bootstrapped for `lighttpd`, `sudo`, `jq` | `/opt` cannot even be created on the ro rootfs, so **none** of those can be installed |
| `atcli_smd11` binary + `/dev/smd11` | The binary **does not exist**, and `/dev/smd11` is owned by `modemd` |
| Releases exist to download a tarball | The fork publishes **no releases**; the frontend must be built locally |

Everything therefore lives on the writable ubifs volume (`/usrdata`, which is
bind-mounted along with `/etc`, `/data`, `/cache`, `/persist`). Nothing outside
`/usrdata/qmanager`, `/etc/qmanager` and `/etc/systemd/system` is touched.

## Contents

| File | Purpose |
| --- | --- |
| `atcli_smd11` | AT transport shim. `qcmd`'s single dependency. Talks to `/dev/at_mdm0` using the vendor's own capture technique (see below). |
| `sudo` | Passthrough shim. Strips sudo flags and execs the command; CGI already runs as root, so no escalation is needed. |
| `sms_tool` | Wrapper around the vendored `sms_tool.bin`. Defaults the device to `/dev/smd7` (SMS storage is not visible on `at_mdm0`) and takes the vendor's radio lock around each call. |
| `qm_serve.sh` | `start\|stop\|restart\|status` manager for busybox httpd on **port 8080**. |
| `qm_pathfix.sh` | Rewrites the paths QManager owns (`/usr/lib/qmanager` → `/usrdata/qmanager/lib`, `/usr/bin/<qm helper>` → `.../bin/<helper>`) across the deployed tree. |
| `qm_boot_hook.sh` | Makes QManager actually start at boot by inserting `start_service_async` lines for the httpd, poller and ping units into `/etc/init.d/turin_web.sh`. Required: this firmware drops units from PID 1's boot transaction. Add new boot units here; the hook is additive and idempotent. |
| `qm_wait_modem.sh` | Poller `ExecStartPre` gate. Waits for a real `AT+CGMM` answer instead of just the device node — without it the poller caches the boot `RDY` URC as the model. |
| `qmanager-httpd.service` | systemd unit: web UI. |
| `qmanager-poller.service` | systemd unit: modem data poller (fills `/tmp/qmanager_status.json`). |
| `qmanager-ping.service` | systemd unit: ping/reachability daemon. Fills `/tmp/qmanager_ping.json`; required for Latency Monitor and the Internet tile. |
| `qmanager-dpi.service` | systemd unit: Traffic Engine (`tpws`). Without it the engine can be installed *and enabled* and still never run — the UI then reports `engine_start_failed` while `binary_installed` is true. |
| `qmanager-dpi-ensure.service` / `.timer` | Re-asserts the engine's `nat REDIRECT` and the QUIC REJECT every 60 s: QCMAP flushes the nat table on each re-dial. **Since 2026-10-22 the service is a resident loop (`qmanager_dpi_run --ensure-loop`, `Restart=always`) and the timer fires it once (`OnBootSec=60`)** — a per-minute oneshot put 3 PID-1 lines a minute into dmesg. Monotonic schedule only (no RTC on this SoC). |

## The AT path (the non-obvious part)

QManager routes **all** modem I/O through `qcmd`, which shells out to
`/usr/bin/atcli_smd11`. That binary is absent here, and the two obvious
replacements both misbehave:

* **`/dev/smd11`** — owned by `modemd`; writing here interleaves with its
  multiplexer.
* **`/dev/smd7`** — the vendor's "spare" AT port, but `/data/gp/gp-metricsd.sh`
  polls it every ~0.4 s and **steals response bytes**. Measured: responses
  truncate to a bare `OK`, silently losing the payload.
* **`/dev/at_mdm0`** — the modem's dedicated AT channel (bridged to USB by
  `port_bridge`). It does not use the vendor's `atlock`, but QManager commands
  are serialized by `qcmd`'s own `/tmp/qmanager_at.lock`. The port can return an
  empty response intermittently, so the shim retries only a read-only allowlist;
  never replay arbitrary setters. **This is what the shim uses.**

The port is a **raw character device, not a tty**, so `stty` and `read -t` do
not work on it. `atcli_smd11` therefore reuses the vendor's proven approach from
`/data/gp/gp-qmi.sh` (`at_smd()`): background `cat` into a temp file, sleep
0.2 s, write `"<cmd>\r"`, poll the capture file for `^OK` / `^ERROR` /
`+CME ERROR`, then kill the reader. It always exits 0 because `qcmd` does its
own OK/ERROR text parsing. Override the port with `AT_DEV=...`.

## Third-party payloads (fetched, never committed)

`deploy/.gitignore` keeps binaries out of git. Place these in `stage/bin/`:

| Binary | Source | Why |
| --- | --- | --- |
| `jq` | `jqlang/jq` release `jq-linux-armhf` (1.7.1) | Not on the device; used everywhere. |
| `speedtest` | Ookla: `https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-armhf.tgz` | Powers the Speed Test page. Must be **Ookla's** CLI, not Python `speedtest-cli`: QManager passes `--accept-license --accept-gdpr -f json -p yes --progress-update-interval=250`. Statically linked (musl), so no glibc dependency. |
| `sms_tool.bin` | `dependencies/sms_tool` in this repo | Vendored, static ARM. Kept as `.bin` because `deploy/sms_tool` is the wrapper that supplies `-d` and the radio lock. |
| `qmicli` + `libqmi-glib.so.5` + `libqrtr-glib.so.0` | `dependencies/qmi/` in this repo | **Committed**, not fetched — a fresh device has no `/data/gp/qmi`, and without it the neighbour live view cannot run. Built by the project owner; libqmi/libqrtr are LGPL-2.1 so the two libraries ship as separate replaceable `.so` files (`dependencies/NOTICE`). ~2.7 MB. |

Tailscale is **not** a payload: `/usrdata/tailscale` is a symlink to the product
stack's `/data/tailscale`, so the ~64 MB of binaries and the single login state
are shared rather than duplicated (the volume only has ~80 MB free). Do not let
QManager's VPN page run its "install" action — it would overwrite
`/etc/systemd/system/tailscaled.service` and clobber the product's unit.

## Install

Requires: SSH root on the device, and `bun` + `git` on the build machine.

```bash
# 1. Build the static frontend on the build machine
git clone -b greenpacket https://github.com/RafayGhafoor/QManager-RM520N.git
cd QManager-RM520N
bun install --frozen-lockfile
bun run build            # -> out/  (static export, no server-side runtime)

# 2. Assemble the payload (frontend + CGI + libs + helpers)
mkdir -p stage && cp -a out/. stage/www/
mkdir -p stage/www/cgi-bin stage/lib stage/bin
cp -a scripts/www/cgi-bin/quecmanager stage/www/cgi-bin/
cp -a scripts/usr/lib/qmanager/.       stage/lib/
cp -a scripts/usr/bin/.                stage/bin/
cp -a deploy/atcli_smd11 deploy/sudo   stage/bin/

# 3. jq is not shipped in this repo — fetch a static ARMv7 build
curl -fsSL -o stage/bin/jq \
  https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-armhf
chmod +x stage/bin/jq

# 3b. Current CA bundle — device's built-in 2023 CA store cannot validate
#     GitHub's current issuer. This bundle is a deploy-time payload, not git.
curl -fsSL -o stage/cacert.pem https://curl.se/ca/cacert.pem

# 3c. Ookla speedtest + the vendored sms_tool (see "Third-party payloads")
curl -fsSL -o /tmp/ookla.tgz \
  https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-armhf.tgz
( mkdir -p /tmp/ookla && tar xzf /tmp/ookla.tgz -C /tmp/ookla && \
  cp /tmp/ookla/speedtest stage/bin/speedtest && chmod +x stage/bin/speedtest )
cp dependencies/sms_tool stage/bin/sms_tool.bin && chmod +x stage/bin/sms_tool.bin
cp deploy/sms_tool stage/bin/sms_tool && chmod +x stage/bin/sms_tool

# 3d. QMI reader — qmicli plus its two libraries (see "Third-party payloads").
#     Shipped because a FRESH device has no /data/gp/qmi: without this, the
#     neighbour live view cannot run at all. libglib/libgio come from the base
#     firmware and are deliberately not bundled. Keep the two libs as separate
#     .so files — LGPL-2.1 requires them to stay replaceable (dependencies/NOTICE).
mkdir -p stage/lib/qmi
cp -a dependencies/qmi/bin dependencies/qmi/lib stage/lib/qmi/
cp -a dependencies/NOTICE stage/lib/qmi/NOTICE

# 4. Ship it and relocate the paths
tar czf - -C stage . | ssh root@<device> 'mkdir -p /usrdata/qmanager && tar xzf - -C /usrdata/qmanager'
# The CA bundle lives in the QManager-owned state dir, not /etc/ssl (read-only).
ssh root@<device> 'mkdir -p /usrdata/qmanager/etc && mv /usrdata/qmanager/cacert.pem /usrdata/qmanager/etc/cacert.pem'
tar czf - -C deploy qm_pathfix.sh qm_wait_modem.sh | ssh root@<device> \
  'tar xzf - -C /tmp && sh /tmp/qm_pathfix.sh && \
   cp /tmp/qm_wait_modem.sh /usrdata/qmanager/bin/ && chmod +x /usrdata/qmanager/bin/qm_wait_modem.sh'
# qm_pathfix.sh only rewrites scripts it recognizes. Verify the poller specifically:
ssh root@<device> 'grep -q /usrdata/qmanager/lib /usrdata/qmanager/bin/qmanager_poller || \
  sed -i "s|/usr/lib/qmanager|/usrdata/qmanager/lib|g" /usrdata/qmanager/bin/qmanager_poller'

# 5. Web UI + services
tar czf - -C deploy qm_serve.sh | ssh root@<device> \
  'tar xzf - -C /usrdata/qmanager/bin && chmod +x /usrdata/qmanager/bin/qm_serve.sh'
tar czf - -C deploy qmanager-httpd.service qmanager-poller.service qmanager-ping.service | ssh root@<device> \
  'tar xzf - -C /etc/systemd/system && chmod 644 /etc/systemd/system/qmanager-*.service && \
   systemctl daemon-reload && systemctl enable qmanager-httpd.service qmanager-poller.service qmanager-ping.service'

# 5b. Traffic Engine units (engine + the 60s rule re-assert timer)
tar czf - -C deploy qmanager-dpi.service qmanager-dpi-ensure.service qmanager-dpi-ensure.timer | ssh root@<device> \
  'tar xzf - -C /etc/systemd/system && chmod 644 /etc/systemd/system/qmanager-dpi*.service /etc/systemd/system/qmanager-dpi-ensure.timer && \
   systemctl daemon-reload && systemctl enable qmanager-dpi.service qmanager-dpi-ensure.timer'

# 6. Boot wiring — `enable` alone does NOT survive this firmware's boot
#    transaction (see qm_boot_hook.sh). This is what actually starts them.
tar czf - -C deploy qm_boot_hook.sh | ssh root@<device> \
  'tar xzf - -C /tmp && sh /tmp/qm_boot_hook.sh'

# 7. Start now (and reboot to prove the boot path)
ssh root@<device> 'systemctl start qmanager-httpd.service qmanager-poller.service qmanager-ping.service qmanager-dpi.service qmanager-dpi-ensure.timer'

# 8. Traffic Engine bypass hostlist
#    qmanager_setup seeds /etc/qmanager/video_domains.txt ONLY when it does not
#    exist, so a partially-populated file survives forever and the engine then
#    silently bypasses almost nothing. Verify it lists the video CDNs that
#    actually carry streams — youtube.com alone is not enough:
ssh root@<device> 'grep -cE "^(youtube|googlevideo|ytimg|nflxvideo|fbcdn)" /etc/qmanager/video_domains.txt'   # expect >= 4
```

Then browse to `http://<device-lan-ip>:8080/` and complete first-run setup.
Set the password there — no credentials are baked into this deployment.

## Verification

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/            # 200
curl -s http://127.0.0.1:8080/cgi-bin/quecmanager/public/overview.sh      # JSON
systemctl is-active qmanager-httpd qmanager-poller qmanager-ping          # active active active
jq '.device.model, .device.temperature, .network.type, .network.carrier, .network.apn, .network.wan_ipv4, .connectivity.internet_available' /tmp/qmanager_status.json
# RG520N-EB, temperature °C, 5G-NSA, Jazz, internet, assigned WAN IPv4, true
jq '{reachable,last_rtt_ms}' /tmp/qmanager_ping.json                    # true + measured RTT
# Read-only modem diagnostics MUST use qcmd so the shared AT flock is held:
/usrdata/qmanager/bin/qcmd 'AT+CGMM'                                     # RG520N-EB + OK
# Feature checks: cellular/apn.sh, cellular/network_priority.sh, cellular/sms.sh,
# network/video_optimizer.sh, system/language-packs/list.sh, device/about.sh

# Boot wiring is only proven by a real reboot — compare against uptime:
systemctl show -p ActiveEnterTimestamp --value qmanager-httpd qmanager-poller
```

## Notes and known gaps

* **Port 8080 is deliberate** — port 80 already serves the vendor UI
  (`busybox httpd -f -p 80 -h /web/v2`) and is left untouched.
* **`systemctl enable` is not sufficient here.** This firmware drops units from
  PID 1's boot transaction, so an enabled unit simply never runs. `qm_boot_hook.sh`
  is what makes boot work; the hook lives in the product repo's
  `/etc/init.d/turin_web.sh`, which is also why that file must not be replaced.
* `qm_wait_modem.sh` exists because the poller caches device identity once at
  startup; starting it before the modem answers bakes `"model": "RDY"` into the
  cache until the next restart.
* Never use `pkill -f "httpd -p 8080"` over SSH: it matches the SSH command line
  itself and kills the session. Use `qm_serve.sh`.
* The RG520N-EB does not support `AT+QTEMP`, `AT+QMAP="WWAN"`, `AT+QMAP="LANIP"`
  or `AT+QMAP="DHCPV4DNS"`; probing these in a compound AT chain used to discard
  other valid responses and create false log errors. Temperature comes from the
  modem thermal zones; LAN/WAN addressing comes from `ip`; APN/DNS from
  `AT+CGCONTRDP`.
* The device's `/etc/ssl` trust store is dated 2023. The current CA bundle is
  therefore deployed at `/usrdata/qmanager/etc/cacert.pem` and exported as
  `CURL_CA_BUNDLE` by `cgi_base.sh`; without it GitHub TLS fails even though DNS,
  TCP and general internet reachability work. The language-pack manifest is
  currently reachable but upstream publishes `packs: []`.
* `qmanager-ping.service` must be deployed and started. Without it, every ping
  history sample is null, the Latency Monitor reports 100% loss, and the
  `Internet` tile can claim unreachable despite a working WAN.
* **`qmanager-dpi.service` must be deployed too.** Upstream ships it; if it is
  missing the Traffic Engine installs and enables but never runs, and the UI
  reports `engine_start_failed` with `binary_installed: true`. The engine needs
  `Environment=PATH` including `/usrdata/qmanager/bin` (its helper shells out to
  `jq` and `iptables`, and neither `/usrdata/qmanager/bin` nor `/usr/sbin` is on
  systemd's default PATH here).
* **QUIC is handled separately from the engine.** `tpws` only desyncs TCP, so
  outbound UDP/443 (QUIC) is untouched by it; the *Force TCP* toggle installs a
  `REJECT --reject-with icmp-port-unreachable` for `-i bridge0 -p udp --dport 443`
  in filter/FORWARD so QUIC-first apps fall back to TCP where the bypass applies.
  Verified live with live counters on that rule (`6 packets / 7668 bytes`
  rejected) and the vendor's `GP_HTTP2` rule sitting behind it.
* **`/etc/qmanager/video_domains.txt` is only seeded once.** The engine bypasses
  exactly the hosts it lists. A file that was created early with one or two
  entries never gains the rest, so YouTube *video* (`googlevideo.com`) stays
  unmanaged even though the engine is running. Keep the full default set
  (`youtube.com`, `googlevideo.com`, `ytimg.com`, `ggpht.com`, `youtu.be`,
  `fbcdn.net`, `nflxvideo.net`, ...) — the deployment had only 2 lines.
* **Timezone: this firmware has no tzdata and its busybox ignores `/etc/TZ`.**
  `/usr/share/zoneinfo` does not exist, so `/etc/localtime` can never be
  installed and the old apply path failed with `zone_not_found`, leaving the
  clock on UTC with the UI correctly reporting it as *drifted*. The only working
  mechanism is the `TZ` environment variable holding a POSIX string
  (`TZ=PKT-5 date` → `... PKT`). `qmanager_timezone_apply` now takes the POSIX
  string as a second argument, writes `/etc/TZ` + `/etc/qmanager/tz.posix`, and
  `cgi_base.sh` exports `TZ` from that file; `sys_get_effective_tz` computes the
  expected offset from the same string when no tzdata exists. Verified:
  set `Asia/Dubai` → `+0400/GST`, set `Asia/Karachi` → `+0500/PKT`, both `applied`.
* **SMS multipart messages are assembled by the CGI, but only from what is still
  stored.** The modem keeps each segment of a concatenated SMS as its own row and
  drops some of them; `/etc/qmanager/...` is not involved. Messages therefore
  carry `parts_received` / `parts_total`, and `parts_received < parts_total` is
  normal (measured: several messages retain only part 2/3 or 3/3). A message that
  looks truncated in the UI is usually a fragment whose siblings the modem no
  longer holds — not a parser bug. Fully retained sets do reassemble (measured:
  a 4-part message joined to 229 characters).
* **Dashboard memory/storage are correct.** Memory is `MemTotal − MemAvailable`
  (`/proc/meminfo`), i.e. 131 MB of 178 MB on this unit; storage is `statfs` of
  `/usrdata` (187 MB total / 102 MB used / 81 MB free). Note `/usrdata` and
  `/data` share the same ubifs volume, and busybox `df` mislabels that mount
  point, so trust `statfs`/the cache rather than `df`.
* QManager's health check has expected deployment deviations (root-run CGI,
  no lighttpd/tty/console, no firewall/setup units); see `memory.md`. Do not
  "fix" the `smd11`/dialout/sudoers checks: this deployment uses `at_mdm0` and
  root-run CGI.
* `/tmp/qmanager_status.json` is tmpfs and regenerated by the poller on start.

## Uninstall

```bash
systemctl disable --now qmanager-httpd.service qmanager-poller.service
rm -f /etc/systemd/system/qmanager-httpd.service /etc/systemd/system/qmanager-poller.service
systemctl daemon-reload
# remove the boot hook (restores the product repo's script verbatim)
if [ -f /etc/init.d/turin_web.sh.pre-qmanager ]; then
    mv /etc/init.d/turin_web.sh.pre-qmanager /etc/init.d/turin_web.sh
    chmod 755 /etc/init.d/turin_web.sh
fi
rm -rf /usrdata/qmanager /etc/qmanager
```
