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

## Boot wiring — the firmware drops units from the boot transaction

`qmanager-httpd` and `qmanager-poller` are `enabled` into `multi-user.target`, but
**that alone does not start them at boot on this device** — proven, not assumed.

First real reboot: both units came back `enabled` yet `inactive`, with an empty
`ActiveEnterTimestamp` (never even attempted), while the vendor stack booted
normally. `FragmentPath`, the `multi-user.target.wants` symlinks and
`systemctl get-default` were all identical to the sibling project's working
units, so this was not a configuration mistake.

The reason is documented inside `/etc/init.d/turin_web.sh` itself:

> "`/etc` is backed by the same late-mounted persistent overlay. PID 1 builds its
> initial boot transaction before that overlay's masks and drop-ins are visible"
>
> "this firmware drops units from the boot transaction"

So any unit living in the persistent `/etc/systemd/system` overlay is **absent
from PID 1's initial transaction**. This is why the product repo starts gp-v2,
gp-sysctl, gp-led, gp-ttl, gp-pcidb, gp-quic-policy and gp-syslog-persist by hand
from `turin_web.sh` via its `start_service_async` helper — the one script known to
actually run at boot (it ships in the read-only squashfs, so it *is* in the
initial transaction).

**Fix:** `deploy/qm_boot_hook.sh` idempotently inserts two
`start_service_async` lines into `/etc/init.d/turin_web.sh`, right after its
`systemctl daemon-reload` (so systemd has re-read the overlay first). It backs up
the original once to `turin_web.sh.pre-qmanager` and refuses to patch if the
anchor line disappears. It deliberately *inserts* rather than shipping a copy of
the script, because the product repo owns and continuously edits that file.

**Validated across two further real reboots** (`boot_id` changed each time):
both units `active` with `ActiveEnterTimestamp` at boot time, UI and overview API
returning 200, vendor UI on :80 and all `gp-*` services unaffected.

The vendor OEM units use a `/systemrw` + `mount --bind` pattern to make read-only
paths writable (e.g. `/web` ← `/systemrw/web`, launched from `turin_web.sh`).
That pattern only works for directories that already exist in the squashfs —
which is exactly why it cannot conjure `/opt`.

## The `model: "RDY"` bug (fixed)

On the first successful boot-hook reboot, the poller started before the modem had
finished booting and cached `"model": "RDY"` — the boot unsolicited result code —
where the model belongs. The poller collects device identity **once** at startup,
so the bogus value persisted for the whole boot even though a manual `AT+CGMM` a
minute later returned `RG520N-EB`. A live AT device node is therefore not evidence
that the modem will answer.

**Fix:** `deploy/qm_wait_modem.sh` is the poller's `ExecStartPre`; it polls
`AT+CGMM` until a real model token (letter + digit, ignoring `RDY`/`OK`/`ERROR`/URC
lines) appears, with a 150 s wall-clock budget. If the budget expires the unit
exits 1 and lets `Restart=on-failure` retry, so a genuinely dead modem fails
loudly instead of silently caching garbage. Re-validated at boot:
`model=RG520N-EB`, `ca=true`, 80 MHz aggregated.

## Plugins and dependencies (what was missing, what was done)

QManager probes for external binaries. Measured gaps and resolutions:

| Need | Status | Resolution |
| --- | --- | --- |
| `speedtest` (Speed Test page) | **installed, working** | Ookla CLI **1.2.0 armhf** (`speedtest`), a **statically linked** musl binary in `bin/`. NOT the Python `speedtest-cli`: QManager invokes `--accept-license --accept-gdpr -f json -p yes --progress-update-interval=250`, which only Ookla's client accepts — the error text saying "speedtest-cli" is misleading. Verified live: 20.2 Mbps down / 5.4 Mbps up, 38 ms, 0 % loss. |
| `sms_tool` (SMS page) | **installed, working** | Upstream's vendored `dependencies/sms_tool` (static ARM) as `bin/sms_tool.bin`, behind `bin/sms_tool` — see below. |
| `tailscale` (VPN page) | **detected, not started** | `/usrdata/tailscale` is a **symlink to the product's `/data/tailscale`**, so QManager sees the existing v1.98.4 binaries and *shares* their single login state (`-statedir=/data/tailscale/state`) instead of duplicating 64 MB on a volume with ~80 MB free. Left **off**, matching the product's deliberate lazy/opt-in default. |
| `jq` | installed | Static `jq-linux-armhf` 1.7.1 in `bin/`. |
| `ttyd` (Console page) | **blocked, by design** | Cannot work in this deployment: ttyd's unit listens on **127.0.0.1:8080**, which this deployment's busybox httpd occupies (the UI is on 8080 per the requirement), and upstream reached it through lighttpd's `mod_proxy` at `/console`, which busybox httpd does not have. |
| `msmtp` (email alerts) | not installed | Only needed for email alerts, which are unconfigured anyway (health check reports "email alerts not configured"). Would need Entware. |
| `tpws` (Video Optimizer / DPI) | not installed | Optional DPI-bypass engine; needs an entropy of its own installer. Not required for the UI to function. |

### Why `sms_tool` needs a wrapper

Upstream's vendored `sms_tool` has **/dev/smd11 compiled in as its default device** — the port `modemd` owns. Injecting SMS commands there risks the vendor's modem manager and therefore the WAN. Measured on this unit:

```
-d /dev/at_mdm0  -> {"msg":[]}          SMS storage NOT visible
-d /dev/smd7     -> full list ("Storage type: ME, used: 24, total: 255")
-d /dev/smd11    -> works, but modemd's port (avoid)
```

So `deploy/sms_tool` is a wrapper that defaults `-d /dev/smd7` (an explicit `-d` still wins) and participates in the vendor's radio lock (`/tmp/gp-radio.lock`, the mkdir + `init` + `owner|pid|token|uptime|procstart` protocol defined by `/data/gp/radio-handler.sh`) around each call, because `gp-metricsd.sh` polls smd7 every ~0.4 s and otherwise steals response bytes. The real binary stays beside it as `sms_tool.bin`.

### AT access rule (learned the hard way)

**Every AT call must go through `qcmd`**, which holds the shared flock on `/tmp/qmanager_at.lock`. Calling `bin/atcli_smd11` directly looks fine in isolation but steals response bytes from concurrent polls. Measured consequence of doing it during debugging:

```
qm_poller: qcmd_exec failed: cmd=AT+QENG="servingcell" exit=1
qm_poller: poll_cycle exceeded budget: 14s > 10s
qm_poller: EVENT [signal_lost] Modem unreachable
```

Those are **false alarms**, not modem faults: `AT+QCAINFO`/`AT+QENG` each return in 0-1 s and do include `OK` when called alone. The poller's own 10 s cycle budget is exceeded whenever a CGI request or health-check run holds the lock, and `qcmd`'s 5 s/10 s lock wait then reports `exit=1`. QManager's health check running AT tests while the poller polls is itself enough to produce this. `qm_wait_modem.sh` therefore goes through `qcmd` too.

Second bug fixed here: the AT capture begins with an empty line, but upstream's binary does not. `atcli_smd11` now strips **leading blank lines**, because parsers that slice line 1 (the health check's `AT+CGMI` test among them) were reading `""` instead of `Quectel`.

## Health check expectations (do not chase these)

`system/health-check` reports 27 pass / 8 fail / 4 warn after this work, up from 25/10. The remaining items are **expected deviations**, not defects:

- `perm.smd11` (600 root:root, wants 660 root:dialout) and `perm.www_dialout` — upstream needs these because its CGI runs as `www-data` over `/dev/smd11`. This deployment runs httpd as root and talks to `/dev/at_mdm0`, so both are irrelevant. Not "fixed" on purpose: changing vendor device permissions buys nothing here.
- `sudo.list` — upstream needs sudoers rules for `www-data`; `deploy/sudo` is a passthrough shim and CGI is already root.
- `svc.lighttpd`, `net.lighttpd_listen` — this deployment deliberately does not run lighttpd (busybox httpd on 8080 instead).
- `svc.console` / `bin.ttyd` — see the ttyd row above.
- `svc.firewall`, `svc.setup` — those units were not deployed; the firewall unit writes iptables rules and would collide with the vendor's own firewall set, so it is intentionally absent.
- `svc.tailscaled` inactive — deliberate (product default).
- `svc.poller` may show `inactive`/`failed` if the check lands while the unit is inside `RestartSec` or parked by a previous `start-limit-hit`. Confirm with `systemctl show qmanager-poller | grep -E '^(Result|NRestarts)='` before believing it.

## Known gaps

- `device/about` returns empty `device_ip`, `lan_gateway`, `wan_ipv4/6`: the
  poller's boot-time collection expects upstream interface names, not
  `bridge0` / `rmnet_data1`. Cosmetic.
- Unavailable without Entware: HTTPS (443), ttyd console proxy, DPI (tpws), email alerts (msmtp), language packs that need `opkg`.
- `/lib/systemd/system` is read-only, so `qm_pathfix.sh` rewrites it to `/etc/systemd/system` (12 more files). This is what makes unit-writing features work at all — and why QManager's Tailscale page must **not** be used with its "install" action: it would write `/etc/systemd/system/tailscaled.service` and clobber the product stack's unit (which pins `-statedir=/data/tailscale/state -socket=/run/tailscale/tailscaled.sock -tun=userspace-networking`). Start/stop via the existing unit is fine.

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
# drop the boot hook — this restores the product repo's script verbatim
[ -f /etc/init.d/turin_web.sh.pre-qmanager ] && \
  mv /etc/init.d/turin_web.sh.pre-qmanager /etc/init.d/turin_web.sh && \
  chmod 755 /etc/init.d/turin_web.sh
rm -rf /usrdata/qmanager /etc/qmanager
```

Touch-points outside `/usrdata/qmanager` are exactly three: the two unit files in
`/etc/systemd/system`, `/etc/qmanager`, and the 8 inserted lines (plus the
one-time `.pre-qmanager` backup) in `/etc/init.d/turin_web.sh`. Removing them
leaves the firmware's own UI and boot path as they were.
