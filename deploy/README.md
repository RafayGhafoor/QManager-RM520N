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
| `qm_serve.sh` | `start\|stop\|restart\|status` manager for busybox httpd on **port 8080**. |
| `qm_pathfix.sh` | Rewrites the paths QManager owns (`/usr/lib/qmanager` → `/usrdata/qmanager/lib`, `/usr/bin/<qm helper>` → `.../bin/<helper>`) across the deployed tree. |
| `qmanager-httpd.service` | systemd unit: web UI. |
| `qmanager-poller.service` | systemd unit: modem data poller (fills `/tmp/qmanager_status.json`). |

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
  `port_bridge`). Measured clean and complete on every call, with no
  participation in the vendor's `atlock`. **This is what the shim uses.**

The port is a **raw character device, not a tty**, so `stty` and `read -t` do
not work on it. `atcli_smd11` therefore reuses the vendor's proven approach from
`/data/gp/gp-qmi.sh` (`at_smd()`): background `cat` into a temp file, sleep
0.2 s, write `"<cmd>\r"`, poll the capture file for `^OK` / `^ERROR` /
`+CME ERROR`, then kill the reader. It always exits 0 because `qcmd` does its
own OK/ERROR text parsing. Override the port with `AT_DEV=...`.

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

# 4. Ship it and relocate the paths
tar czf - -C stage . | ssh root@<device> 'mkdir -p /usrdata/qmanager && tar xzf - -C /usrdata/qmanager'
tar czf - -C deploy qm_pathfix.sh | ssh root@<device> 'tar xzf - -C /tmp && sh /tmp/qm_pathfix.sh'

# 5. Web UI + services
tar czf - -C deploy qm_serve.sh | ssh root@<device> \
  'tar xzf - -C /usrdata/qmanager/bin && chmod +x /usrdata/qmanager/bin/qm_serve.sh'
tar czf - -C deploy qmanager-httpd.service qmanager-poller.service | ssh root@<device> \
  'tar xzf - -C /etc/systemd/system && systemctl daemon-reload &&
   systemctl enable --now qmanager-httpd.service qmanager-poller.service'
```

Then browse to `http://<device-lan-ip>:8080/` and complete first-run setup.
Set the password there — no credentials are baked into this deployment.

## Verification

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/            # 200
curl -s http://127.0.0.1:8080/cgi-bin/quecmanager/public/overview.sh      # JSON
systemctl is-active qmanager-httpd qmanager-poller                        # active active
jq '.device.model, .network.type' /tmp/qmanager_status.json               # RG520N-EB, 5G-NSA
```

## Notes and known gaps

* **Port 8080 is deliberate** — port 80 already serves the vendor UI
  (`busybox httpd -f -p 80 -h /web/v2`) and is left untouched.
* Never use `pkill -f "httpd -p 8080"` over SSH: it matches the SSH command line
  itself and kills the session. Use `qm_serve.sh`.
* `device/about` reports empty LAN/WAN IPs — the poller's boot-time collection
  expects upstream interface names, not this firmware's `bridge0` / `rmnet_data1`.
* Unavailable without Entware: HTTPS (443), ttyd console proxy, DPI, Tailscale,
  Discord bot, language packs.
* `/tmp/qmanager_status.json` is tmpfs and regenerated by the poller on start.

## Uninstall

```bash
systemctl disable --now qmanager-httpd.service qmanager-poller.service
rm -f /etc/systemd/system/qmanager-httpd.service /etc/systemd/system/qmanager-poller.service
systemctl daemon-reload
rm -rf /usrdata/qmanager /etc/qmanager
```
