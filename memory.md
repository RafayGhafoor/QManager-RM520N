# MEMORY.md — GreenPacket O5A Pro / QManager deployment state

Durable record of what exists where and why. Update this when the install
changes. Operational rules for agents live in `AGENTS.md`.

## What is deployed

| Item | Value |
| --- | --- |
| Host | `greenpacket` (SSH, root) |
| Device | GreenPacket O5A Pro — Quectel **RG520N-EB**, SDX6X `sdxlemur`, `LE.UM.6.2.3.r1-03100-SDX65.0` |
| App | QManager, upstream `RafayGhafoor/QManager-RM520N`, branch `development` at install time |
| Frontend | Next.js static export (`out/`), **no Node runtime on device** |
| URL | `http://192.168.0.1:8080/` (LAN IP is `bridge0`) |
| Auth state | **`setup_required`** — no password set; first visitor to `/setup` claims it |
| Footprint | `/usrdata/qmanager`: www 12.7 MB, bin 1.9 MB, lib 0.5 MB; ~82 MB free on `/usrdata` |
| Sibling product | `/Users/emumba/Downloads/projects/greenpacket-o5a` — the current production UI + boot wiring; source of truth for device conventions |

### Port map (do not collide)

| Port | Owner |
| --- | --- |
| 80 | vendor UI — `busybox httpd -f -p 80 -h /web/v2` |
| **8080** | **QManager (this deployment)** |
| 8083 | `turin_web` (memohigo) — the product UI |
| 8090 / 8091 / 8092 | `gp-pcidb`, radio-handler, metrics stream (`nc`-backed HTTP) |
| 11080 / 18080 | nanoproxy (SOCKS5 / HTTP, loopback only) |
| 2222 | dropbear SSH |

Filesystem layout on device:

```
/usrdata/qmanager/www/                  frontend static export (docroot)
/usrdata/qmanager/www/cgi-bin/quecmanager/   CGI endpoints (the whole API)
/usrdata/qmanager/lib/                  backend shell libraries
/usrdata/qmanager/bin/                  helpers + atcli_smd11 + sudo + jq + qm_serve.sh
/usrdata/qmanager/{data,locales,sites}/
/etc/qmanager/                          state (auth.json, profiles, qmanager.conf)
/etc/systemd/system/qmanager-{httpd,poller}.service
/tmp/qmanager_status.json               poller cache (tmpfs, regenerated)
```

Services (both `enabled` + `active` under `multi-user.target`):

- `qmanager-httpd.service` — busybox httpd on **:8080**, docroot `/usrdata/qmanager/www`, run as root.
- `qmanager-poller.service` — `qmanager_poller`, waits for `/dev/at_mdm0`, fills the cache file.

## Why the stock installer was not used

1. The fork publishes **no releases**, so `qmanager-installer.sh` (which downloads
   a release tarball) has nothing to fetch.
2. The rootfs is **read-only squashfs**. `install_rm520n.sh` hard-dies in
   preflight on `mount -o remount,rw /`, and its targets `/usr/lib/qmanager`,
   `/usr/bin`, `/lib/systemd/system` are unwritable.
3. `/opt` cannot be created, so Entware (`lighttpd`, `jq`, `sudo`) is unavailable.

So the frontend is built on the workstation and the app is deployed by hand under
`/usrdata`. Paths are relocated by `deploy/qm_pathfix.sh` (146 files rewritten:
`/usr/lib/qmanager` → `/usrdata/qmanager/lib`, plus QManager's own
`/usr/bin/<helper>` → `/usrdata/qmanager/bin/<helper>`).

## Decisions and their evidence

- **AT transport → `/dev/at_mdm0`.** `atcli_smd11` is absent on this firmware and
  `qcmd` is the single entry point for all modem I/O, so a shim was written.
  Measured on-device:
  - `/dev/smd11` — owned by `modemd`.
  - `/dev/smd7` — vendor "spare" port, but `gp-metricsd.sh` polls it every ~0.4 s
    and **steals bytes**; replies truncate to a bare `OK`.
  - `/dev/at_mdm0` — clean and complete on repeated calls, no atlock involvement. ✔
  - `/dev/smd21`, `/dev/smd22` — no modem behind them (open times out).
  The port is a **raw char device, not a tty**: `stty` fails with "Inappropriate
  ioctl", and `read -t` returns nothing. Capture therefore uses the vendor's own
  technique from `/data/gp/gp-qmi.sh` `at_smd()` (background `cat` to temp file,
  write `\r`, poll for `OK`, kill reader).
- **Web server → busybox httpd.** lighttpd is not installed and Entware is not
  reachable (see below). The firmware already ships busybox httpd and it supports
  CGI natively (verified before committing to it).
- **`sudo` → passthrough shim.** Upstream expects CGI as `www-data` escalating via
  sudo from Entware. Here CGI runs as root, so the shim strips sudo's flags and
  execs. `www-data` (uid 33) does exist, so upstream `chown` calls still work.
- **`jq` → static `jq-linux-armhf` 1.7.1** in `bin/` (not committed; fetched at
  deploy time). That dir is prepended to the PATH exports in `cgi_base.sh`,
  `downloader.sh` and the two speedtest scripts.
- **Port 8080** because port 80 is the vendor UI, which was left untouched
  (verified still 200).

## Verified working (at install time)

- `http://192.168.0.1:8080/` → 200, `/setup/` → 200, `public/overview.sh` → 200.
- Poller cache reported: `RG520N-EB`, 5G-NSA, CA active
  (B1 10 MHz + B3 20 MHz + N41 50 MHz).
- Full auth chain exercised end-to-end with a temporary password (setup → login →
  session cookie → protected endpoint), then the password was **removed** to
  restore `setup_required` so the owner chooses their own.
- AT: `AT+CGMM` → `RG520N-EB`, `AT+CSR`/`AT+CSQ` → signal, `AT+CPIN?` → `READY`.
- Vendor UI on :80 unaffected.

## Boot wiring — validated by real reboot?

`qmanager-httpd` and `qmanager-poller` are `enabled` into `multi-user.target`.
That target *does* work at boot on this device — the sibling project's
`gp-keepalive.service` and `gp-metrics-logger.service` also use
`multi-user.target` and were observed started at 10:05:37 on a 10:05 boot.

**Status: proven by real reboot.** See "Boot validation" at the end of this file.
The sibling project's `AGENTS.md` is explicit that only a reboot validates boot
changes (`systemctl restart` proves nothing), so always confirm
`ActiveEnterTimestamp` against boot time after any unit change.

Note the vendor OEM units use a `/systemrw` + `mount --bind` pattern for making
read-only paths writable (e.g. `/web` ← `/systemrw/web`, launched from
`/etc/init.d/turin_web.sh`). That pattern only works for directories that already
exist in the squashfs — which is exactly why it cannot conjure `/opt`.

## Known gaps

- `device/about` returns empty `device_ip`, `lan_gateway`, `wan_ipv4/6`: the
  poller's boot-time collection expects upstream interface names, not
  `bridge0` / `rmnet_data1`. Cosmetic.
- Unavailable without Entware: HTTPS (443), ttyd console proxy, DPI, Tailscale,
  Discord bot, language packs.

## Entware: verified feasible, not yet applied

An earlier conclusion that Entware was impossible was **wrong**. On-device test
proved `overlayfs` is available and works with the squashfs root as the lower
layer:

```
mount -t overlay overlay -o lowerdir=/,upperdir=<ubifs>,workdir=<ubifs> <merged>   # OK
mkdir <merged>/opt                                                                 # OK
```

So `/opt` **can** exist — inside an overlay of `/`, since a mount point cannot be
created directly on the immutable root. Doing it for real is a boot-level change,
not a one-off mount:

1. Create ubifs-backed `upper`/`work` dirs (e.g. under `/usrdata` or the
   currently unused `/systemrw`), then mount an overlay of `/`.
2. Make `/` actually *be* that overlay at boot (mount-then-`--move`/`pivot_root`)
   via an early systemd unit, because `/opt` must exist in the live namespace for
   Entware's `#!/opt/bin/...` shebangs and rpaths to resolve.
3. Then bootstrap Entware (`bin.entware.net`, armv7sf-k3.2 for the 5.4 kernel) and
   the upstream package set, and switch the web tier to lighttpd on 8080.

Trade-off: this is the one change here that can affect boot. Current install
works without it; only the feature set above is missing. Decide before applying.

Note that the sibling project's `mount --bind` trick does **not** substitute for
this: it can only bind onto directories that already exist in the squashfs
(`/web`, `/etc/data`), and `/opt` does not exist. An overlay of `/` is the only
route to a real `/opt`.

## Rollback

```bash
systemctl disable --now qmanager-httpd.service qmanager-poller.service
rm -f /etc/systemd/system/qmanager-httpd.service /etc/systemd/system/qmanager-poller.service
systemctl daemon-reload
rm -rf /usrdata/qmanager /etc/qmanager
```

Nothing outside those paths, `/etc/systemd/system` and `/etc/qmanager` was
modified, so rollback leaves the firmware as it was.
