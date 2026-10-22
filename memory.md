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

Those can be false alarms, not modem faults: `AT+QCAINFO`/`AT+QENG` each return in 0-1 s when called alone. The poller's own 10 s cycle budget can be exceeded when a CGI request or health-check run queues behind the AT lock. `qcmd`'s short/long lock waits are now 20/45s. `qm_wait_modem.sh` goes through `qcmd` too.

The transport now drains stale bytes before each capture and strips leading blank lines. Before the drain, trailing bytes from one invocation prefixed the next reply (`AT+QENG` got a stray `ERROR` before its valid payload). The port also intermittently returns zero bytes; the shim detects that quickly and retries only a read-only allowlist (generic/custom commands and setters are never replayed).

## Health check expectations (do not chase these)

`system/health-check` reports 28 pass / 7 fail / 4 warn after the fixes. The remaining failures are **expected deployment deviations**, not defects:

- `perm.smd11` (600 root:root, wants 660 root:dialout) and `perm.www_dialout` — upstream needs these because its CGI runs as `www-data` over `/dev/smd11`. This deployment runs httpd as root and talks to `/dev/at_mdm0`, so both are irrelevant. Not "fixed" on purpose: changing vendor device permissions buys nothing here.
- `sudo.list` — upstream needs sudoers rules for `www-data`; `deploy/sudo` is a passthrough shim and CGI is already root.
- `svc.lighttpd`, `net.lighttpd_listen` — this deployment deliberately does not run lighttpd (busybox httpd on 8080 instead).
- `svc.console` / `bin.ttyd` — see the ttyd row above.
- `svc.firewall`, `svc.setup` — those units were not deployed; the firewall unit writes iptables rules and would collide with the vendor's own firewall set, so it is intentionally absent.
- `svc.tailscaled` inactive — deliberate (product default).
- `svc.poller` may show `inactive` during `RestartSec` or if a health run races its start. Verify `systemctl is-active qmanager-poller`; after this session it was active with a fresh cache.

## Device-specific fixes verified live (2026-10-21)

- **AT response first-line deletion:** `cgi_at.sh` used to delete line 1 unconditionally. The deployment shim already strips leading blanks, so that threw away the first *payload* line. Consequences: APN CID 1 blank and Network Prioritizing empty. It now removes blank/terminal lines instead. Verified profile 1 = `internet`, `ipv4`, active; priority = `NR5G:LTE`.
- **RG520N-EB unsupported compound commands:** `AT+QTEMP` returns ERROR and aborts all later commands in the chain; `AT+QMAP="WWAN"/"LANIP"/"DHCPV4DNS"` also returns ERROR, making `qcmd` discard other successful lines. Temperature now averages live `modem-*` thermal zones; WAN/LAN addresses come from `ip`; APN/DNS from standalone `AT+CGCONTRDP`; unsupported QMAP probes were removed from poller boot. The optional `AT+QGETCAPABILITY` query was split out of the boot identity chain so a capability-query failure cannot erase model/firmware/identity fields; the read-only identity query now retries empty results.
- **AT stale/empty captures:** shim drains leftovers and only retries empty responses for explicitly read-only commands, never generic writes. `qcmd` lock waits are longer to tolerate poll cycles without returning misleading AT failures.
- **Homepage + Connection Details:** poller now reports `temperature=32 C`, carrier `Jazz`, APN `internet`, WAN `10.124.119.137`, carrier DNS, and LAN gateway `192.168.0.1` on this live session.
- **SMS:** listing returned messages; the requested outbound `hello` test returned `{success:true}`. The recipient number is deliberately not retained in repo memory.
- **Traffic Engine:** fixed `_SUDO` empty-as-root handling (the old `$_SUDO -n cmd` tried to execute `-n`); installer completed and installed tpws v72.13. It remains stopped until the user enables it.
- **TLS-dependent fetches:** the device's CA store is dated 2023, so GitHub requests failed certificate verification. Current CA bundle lives at `/usrdata/qmanager/etc/cacert.pem`, exported as `CURL_CA_BUNDLE` by CGI. Verified GitHub manifest HTTP 200 and Traffic Engine release fetch/install. The upstream language manifest currently has `packs: []` (reachable, no community packs published).
- **Latency Monitor / Internet verdict:** qmanager-ping was not deployed. Added its unit, PATH includes jq, and added it to the boot hook. Live ping history now shows 0% loss, ~40-77 ms; `connectivity.internet_available=true`; About Device shows public IPv4.
- **System Logs:** unsupported QMAP probes were removed and CID detection no longer issues `QMAP="WWAN"`. One clean log query returned zero ERROR entries; a later full health-check run introduced four transient AT/lock errors in the 100-entry view. The device recovered, and every unit, CPIN and the modem identity were healthy afterwards; these are historical log records, not an ongoing outage.

### Round 2 — SMS, telemetry, Traffic Engine, clock

- **SMS truncation is storage reality, not a parser bug.** The modem keeps each segment of a concatenated SMS as its own row and drops some of them. Measured with `sms_tool.bin -d /dev/smd7 -s ME -j recv`: 24 rows stored, of which many carry only `part 2/3`, `3/3` or `4/4` — the earlier segments are simply gone. The CGI now groups across ME/SIM (the storage field is no longer part of the merge key, so a set split across both memories still joins) and reports `parts_received`/`parts_total` per message. Complete sets do reassemble: the 4-part `ref=240` message joined to 229 characters. `parts_received < parts_total` is expected, not a defect.
- **Deployment trap that broke SMS twice:** hand-editing a deployed script with a partial `sed` breaks paths that `qm_pathfix.sh` would have fixed. Copying `sms.sh` and rewriting only `/usr/lib/qmanager` left `SMS_TOOL="/usr/bin/sms_tool"`, so every SMS call failed and the UI showed 0 messages / 0 storage. **Always run the real `qm_pathfix.sh` after copying any backend file, then grep for leftover `/usr/bin/` references.**
- **Dashboard memory and storage are correct.** Memory = `MemTotal - MemAvailable` from `/proc/meminfo` (131 MB of 178 MB); storage = `statfs`/`stat -f` on `/usrdata` (187 MB total, 102 MB used, 81 MB free). `/usrdata` and `/data` share one ubifs volume, and busybox `df` mislabels the mount point as `/etc/machine-id` — trust `statfs`, not `df`.
- **Traffic Engine would never run: `qmanager-dpi.service` was not deployed.** The engine installed fine (`tpws v72.13`) and enabling it saved config, but nothing started, so the API answered `engine_start_failed` with `binary_installed: true`. Added `qmanager-dpi.service`, `qmanager-dpi-ensure.service` and `qmanager-dpi-ensure.timer` (relocated ExecStart, PATH with the QManager bin dir for `jq`/`iptables`, monotonic timer). Engine now reports `running`, `kernel_module_loaded: true`, packets counting; `nat PREROUTING` REDIRECT for `bridge0 tcp 80,443 -> :989` present; tpws bound to `192.168.0.1:989` with `--filter-l7=tls,http --split-pos=1,midsld,sniext+1 --disorder=tls`.
- **QUIC for video:** handled by the separate *Force TCP* toggle, not the engine (tpws only desyncs TCP). With it on, filter/FORWARD carries `-i bridge0 -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable` ahead of the vendor's `GP_HTTP2` rule, and its counters proved it is live (`6 packets / 7668 bytes` rejected) — so QUIC-first players do fall back to TCP through the bypass.
- **Bypass hostlist was nearly empty:** `/etc/qmanager/video_domains.txt` held only `youtube.com` and `facebook.com`, while `qmanager_setup` seeds the full set only when the file is ABSENT. Restored the 21-domain default (incl. `googlevideo.com`, `ytimg.com`, `nflxvideo.net`); `domains_loaded` went 2 → 21. Without `googlevideo.com` the engine runs but YouTube *video* is unmanaged.
- **Engine verification:** the built-in `verify` action completes through the bypass (55.8 Mbps without → 51.9 Mbps with, `throttled: false`) — the path works, and this carrier showed no throttling to defeat.
- **Device clock was unreachable by design on this firmware:** there is no `/usr/share/zoneinfo` at all and busybox ignores `/etc/TZ`, so `qmanager_timezone_apply` always failed `zone_not_found` and `/etc/localtime` was never created; the UI correctly showed the zone as *drifted* on UTC. Fixed by applying the POSIX string the config already stores: the helper accepts it as a second argument and writes `/etc/TZ` + `/etc/qmanager/tz.posix`, `cgi_base.sh` exports `TZ`, and `sys_get_effective_tz` derives the expected offset from it instead of from missing tzdata. Verified `Asia/Dubai` → `+0400/GST` and back to `Asia/Karachi` → `+0500/PKT`, both `applied: true`.

### Round 3 — speedtest favourite, cell distance

- **Cell Distance: the NR figure is good, the LTE figure is not.** Two separate
  findings. (a) A real bug, fixed: Tier-2 group 3 had `else lte_ta=""`, so any
  single empty AT reply (lock timeout, dropped command) erased a good reading
  until the next Tier 2 pass, 15 cycles later. Removed for both the LTE and NR
  groups — an empty reply means "no answer", not "no timing advance", and the UI
  already gates these on `modem_reachable`. (b) The LTE *value* is unusable on
  this firmware. Measured stable across samples: `lte_time_advance=1968`,
  `nr5g_time_advance=25600-26112`. Under 3GPP that is ~9.6 km (LTE) vs ~2.0 km
  (NR), and the owner confirmed the tower is at most 2.5 km away — so the NR
  reading is right and the LTE one cannot be. No spec-justified reading of 1968
  yields ~2 km: as a TA index it exceeds the 1282 ceiling, as N_TA it is 9.6 km.
  An intermediate revision divided values above 1282 by 16 (1968 -> 123) to force
  a plausible ~9.6 km, which the ground truth disproved; that guess has been
  reverted. The poller now publishes the raw value and the dashboard's own range
  check declines to render it, so LTE distance shows blank while NR renders ~2 km.
  Revisit only with a Quectel manual for `lte_time_advance`; do not add a fudge
  factor. (Aside: 1968 happens to be almost exactly the NR distance in metres,
  which is a coincidence worth remembering if a manual ever suggests the field is
  a distance rather than a timing offset.)
- **Speedtest favourite server.** `speedtest_servers.sh` now accepts POST
  `{action:"set_favourite"|"clear_favourite"}` and returns `favourite` alongside
  the list; it is persisted as `speedtest.favourite_id` / `favourite_name` in
  `/etc/qmanager/qmanager.conf` (NOT config.json — `qm_config_get/set` use
  `QM_CONFIG=/etc/qmanager/qmanager.conf`). `speedtest_start.sh` falls back to the
  favourite whenever the request carries no `server_id`, so the pinned server is
  used on every later run — including from another browser — while an explicit
  pick still wins. The dialog gained a star per row (Material `favorite`, since
  `star` is not in the shipped icon subset) and auto-selects the pinned server
  when the list loads. Gotcha: this endpoint was GET-only and never called
  `cgi_read_post`, so `$POST_DATA` was empty and every action answered
  `unknown_action` until that call was added.
- **Shipping a UI change from this branch.** App files are normally off-limits
  here, but a favourite needs a control. The procedure that works: `bun install
  --frozen-lockfile`, `bun run build` (static export -> `out/`), then
  `tar czf - -C out . | ssh ... 'tar xzf - -C /usrdata/qmanager/www'`. Extract
  INTO `www` rather than replacing it — `www/cgi-bin` lives inside that tree and
  a replace would delete every endpoint. `bunx tsc --noEmit` is NOT a usable
  check here without `node_modules` (it reports "cannot find module react" for
  the whole tree); the build is the real gate.

### Live verification snapshot (round 3)

Cell distance populated (`lte.ta=113`, `nr.ta=29696`); speedtest favourite
round-trips set -> GET -> persisted in `qmanager.conf`; new bundle live (its
chunk carries the star's aria string); UI `/` 200 and vendor `:80` 200.

### Live verification snapshot (round 2)

All five units active (`qmanager-httpd`, `-poller`, `-ping`, `-dpi`, `-dpi-ensure.timer`); boot hook carries 5 start lines and is idempotent; APN profile 1 = `internet/ipv4/up` with DNS; Network Priority = `NR5G:LTE`; SMS = 24 rows → 19 logical messages with multipart metadata; DPI `running` with 21 domains and tpws on `:989`; clock `PKT +0500 applied`; QManager `:8080` and vendor `:80` both HTTP 200.

## Known gaps
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
systemctl disable --now qmanager-httpd.service qmanager-poller.service qmanager-ping.service
rm -f /etc/systemd/system/qmanager-httpd.service /etc/systemd/system/qmanager-poller.service /etc/systemd/system/qmanager-ping.service
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

## Added 2026-10-22 — QMI read path, live neighbours, Detailed Metrics

| Item | Where on the device | Notes |
| --- | --- | --- |
| QMI reader | `/usrdata/qmanager/lib/qmi_read.sh` | Read-only `qmicli` against `/data/gp/qmi` (vendor binary, invoked not modified). Never touches the AT flock. |
| PHY reader | `/usrdata/qmanager/lib/phy_metrics.sh` | `ubus call modemd status` whitelist + 2 AT compounds. Resolves `jq` itself — it is not on a plain ssh PATH. |
| Trend archive | `/usrdata/qmanager/metrics/YYYY-MM-DD.csv` | 1 row/min, schema marker on line 1, 30-day retention. **New durable data**; ~190 KB/day. |
| Live neighbour files | `/tmp/qmanager_neighbours_live` (lease, www-data) and `.json` (poller) | tmpfs; lease ages out in 10 s |
| New CGIs | `at_cmd/neighbour_scan_status.sh?range=now\|last`, `at_cmd/fetch_signal_history.sh?range=&panels=` | no query string = pre-existing behaviour |
| New route | `/cellular/detailed-metrics` | sidebar row `items.detailed_metrics` |
| Boot units | **unchanged** — no new unit, no `qm_boot_hook.sh` line | so no reboot was required for this deploy |

Measured on this unit: Tier 3 costs **+3.2 points of one core** (15.2 % → 18.4 % idle),
RSS +404 kB. Live neighbours at 1 Hz cost **+3.6 to +6.7 points** while a visible tab
holds the lease, and nothing when it does not.

`poll_cycle exceeded budget` warnings pre-date these changes (11 in the 39 min before
Tier 3 deployed, 6 in the 9 min after). The budget is warn-only; the overruns are AT
lock contention, not a new fault. Not proven either way with n=6 — re-measure before
treating the rate as a regression.

## Added 2026-10-22 (later) — the QMI reader is now SHIPPED, not borrowed

| Item | Where on the device |
| --- | --- |
| `qmicli` + `libqmi-glib.so.5` + `libqrtr-glib.so.0` | `/usrdata/qmanager/lib/qmi/{bin,lib}` — from `dependencies/qmi/` in the repo |
| Resolver order | explicit `QM_QMI_BIN` → shipped copy → `/data/gp/qmi` (greenpacket's) |

Before this, the neighbour live view read greenpacket's `/data/gp/qmi/bin/qmicli`.
A fresh device has no such path, so `qm_qmi_available` returned false and the live
view degraded to "unavailable". Detailed Metrics was never affected — it uses
`ubus modemd` + AT, not QMI.

Only three files ship. `libc`, `libglib-2.0`, `libgio-2.0` and `libgobject-2.0` are
already in the base firmware at `/usr/lib`. The vendor dir is 2.8 MB only because it
also carries `qmi-band-helper`, `qmi-cell-lock-probe` and `qmi-nr-ncell-probe`, none
of which QManager uses. Payload: **2.7 MB**.

`libqmi-glib` and `libqrtr-glib` are LGPL-2.1-or-later and ship as **separate,
dynamically linked `.so` files** so they stay user-replaceable — that is what keeps
redistribution compliant. Do not statically fold them into one binary. Attribution
is in `dependencies/NOTICE`; `qmicli` itself is the owner's own build, not a vendor
artifact.

Verified after the switch: live view returns 11 cells with serving PCI 104 /
`registered: true` / carrier Jazz using only the shipped copy, `.phy` populates after
its first Tier-3 cycle (~2 min after a poller restart — it is 15 cycles, not 15 s),
and the vendor `/data/gp/qmi/bin` is untouched.

## Added 2026-10-22 (later) — the Rust AT broker: built, NOT deployed

`native/qmanager_atd/` is the Rust AT broker ported from the owner's
`suncomm-x75-live-neighbours` branch, plus `deploy/qmanager-atd.service`.
**Nothing is installed or running on the device** — this records the state so the
next session does not assume otherwise.

| Item | State |
| --- | --- |
| Source | vendored, 16 modules, ~7,300 lines, `libc` only |
| Built artifact | `armv7-unknown-linux-musleabihf`, **513,000 B**, static, stripped, no `INTERP`, `qmanager_atd 0.2.0 proto=2` |
| O5A deltas | `AT_DEV` → `/dev/at_mdm0`; lock → `/tmp/qmanager_at.lock`; pid → `/tmp/qmanager_at.pid`; lock mode 0666; lock waits **20/45 s**; `BUILTIN_LONG` trimmed to QSCAN/QSCANFREQ/QFOTADL; restart via `systemctl restart qmanager-atd.service` |
| On the device | **nothing.** No binary, no unit, no symlink, no socket |
| `qcmd` | still the shell gatekeeper — unchanged, and CGIs must stay on it (the Rust client's `ERROR` returns rc 0, not 1) |
| `qsms` | **must not be installed here** — SMS stays on `/dev/smd7` via `bin/sms_tool` under the vendor radio lock |
| Boot hook | deliberately **not** added, because the unit is opt-in; it becomes mandatory with a proven reboot once adopted |

Why it is not deployed: the unit left the network (the workstation moved to
192.168.6.x / 192.168.88.x) before the binary could be shipped, so the smoke test,
the socket gate and the after-benchmark never ran. Enablement procedure and the
gate that must pass first: `docs/reference/at-broker.md` §"Enabling it on the O5A".

Baseline captured **before** any deploy, so the "before" is not lost (60 s window,
idle, no scan, `/proc`-only harness incl. reaped children): box **66.16 %** of one
core, `qmanager_poller` **16.90 %**, `qmanager_ping` **2.27 %**, **113 forks/s**,
QManager RSS **3.4 MB**, device memory used **133 MB** of 182 MB.
Toolchain note: this crate needs `rustup` + `armv7-unknown-linux-musleabihf`;
Homebrew `cargo` alone has no cross target. Host `cargo test` cannot run on macOS
(Linux-only `libc::SO_PEERCRED`) — the gate is a cross-build plus an on-device run.

## 2026-10-22 (later) — AT broker tested then reverted; modem wedged

**The broker is not enabled and must stay that way until someone re-decides.**
It was deployed for a latency test, measured, and reverted:

| | shell `qcmd` | Rust `qcmd` |
| --- | --- | --- |
| per-AT-call wall | **770 ms** | **11 ms** (~70×) |
| poller cycles / 30 s | 6 | **10** |
| `qmanager_poller` % of one core | 20.07 % | 21.82 % — **no win** |

Verdict: a **latency** win, not a **CPU** win (the shell path's 770 ms is
waiting — drain/settle plus flock — not computation). Reverted; the poller is back
on the shell `qcmd` with its original `PATH`.

Left on the device, all **inert** (nothing starts them, verified after reboot):

- `/usrdata/qmanager/bin/qmanager_atd` — the 513 KB armv7 binary
- `/usrdata/qmanager/atd/qcmd` — a symlink nothing resolves
- `/etc/systemd/system/qmanager-poller.service.pre-atd` — one-time backup

`deploy/qmanager-atd.service` ships in the repo but is **not enabled** and is **not**
in `qm_boot_hook.sh`.

### The unit is currently in a no-signal state (unresolved)

As of the last check the modem answers no AT on `/dev/at_mdm0` (`AT+CGMM` 0/6), so
`/tmp/qmanager_status.json` carries no radio data and there is no data interface.
Diagnosis and the evidence table are in
`docs/reference/platform-matrix.md` §"recovering a wedged modem":

- **Not a QManager fault** — broker absent, poller only logging the failures.
- **Not a SIM fault** — `pinStat READY`, IMEI/IMSI/ICCID readable.
- `modem` subsystem `state=ONLINE`, `crash_count=0`; `ipa_fws state=OFFLINING`.
- `AT+CFUN=1,1` sent via `ubus call modemd atcmd` returned `send_flag: OK` and did
  **nothing** — in this state `send_flag` does not mean the modem replied
  (`at_resp` is always `"-"`).
- No SSR trigger node exists (`subsys0/` has `restart_level quec_state power
  system_debug`, no `restart`).
- `turin_mpdn.service` is **masked since the image date** (2026-08-16) — by design,
  not the fault. `qmi_shutdown_modemd` ("Modem Shutdown Service") ran at boot+32 s.

**A warm reboot does not power-cycle the modem**, which is why rebooting did not
help. The remaining fix is a **cold power cycle** (unplug power ~30 s).

## 2026-10-22 (later) — CA hotfix + glink ioctl fix deployed; timer noise classified

The live poller has the v0.1.34 carrier-aggregation fix and its CA-detail output
is intact. The atcli shell shim now writes AT bytes through `dd` to avoid one
kernel `TCGETS (0x5401)` log per command. The unit file no longer depends on the
missing journald socket for either periodic oneshot or poller stdout.

| Item | Live state / evidence |
| --- | --- |
| `atcli_smd11` writer | **Deployed atomically** at `/usrdata/qmanager/bin/atcli_smd11`. Previous version backed up as `atcli_smd11.pre-dd-writer`; earlier intermediate version also exists as `atcli_smd11.pre-dd-reader`. Uses `printf ... | dd of=/dev/at_mdm0 bs=1` while the background raw reader captures the reply |
| glink ioctl flood | Before: +1 `0x5401` per AT call; isolated poller off. After: single `AT+CGMM` added 0, and the latest ioctl line remained `[2970.242579]` across a 20 s window with the poller active. No new ioctl logged after the fix |
| Tier-1 QCAINFO | Poller wraps each `AT+QCAINFO` in `QCAINFO=1; read; QCAINFO=0` (`ca_info_read`) per upstream v0.1.34 hotfix |
| Tier-3 MIMO/TA | LTE group only in LTE/NSA, NR group only in SA; each enabled only for read and disabled after. One compound with the NR NSA-invalid command returned ERROR and poisoned all data, so groups stay separate |
| CA result after fix | `PCC/LTE/B1`, `SCC/LTE/B3`, `SCC/NR/N41` — full detail still present after disable |
| SIM/network | `CPIN READY`, `QSIMSTAT 1,1`, `QUIMSLOT 1`, `CFUN 1`; QManager cache says SIM ready, `RG520N-EB / 5G-NSA / Jazz / 10.36.138.189` |
| Poller unit | Active, `NRestarts=0`. One dmesg stop/start (uptime 2924→2938) was my own ioctl-bisection test; it was not an automatic restart loop |
| DPI ensure | Starts every 60 s by design (QCMAP flushes iptables on re-dial). `StandardOutput=null` / `StandardError=null` deployed; two later runs reported Succeeded with no child journal warning |
| `gp-prx-proxy-tunnel` | Vendor tunnel. The ~14-restart loop after a reboot came from a **blind preflight** (`ss -p`/`ps` return nothing on the remote host), so it never cleared a stale forward. Fixed in sibling repo `greenpacket-o5a` (deploy `906e41b`, tag `v1.07`); tunnel verified working end to end |
| systemd stdout warning | journald is masked on firmware. Poller unit now has stdout/stderr `null` too (deployed + daemon-reloaded). Other vendor units can still show the warning |

The source `deploy/qmanager-httpd.service` and `deploy/qm_serve.sh` now both use
`/run/qmanager-httpd.pid` instead of `/var/run/...` (systemd warned that it
silently canonicalizes the latter). The live httpd is healthy; this unit/source
cleanup does not require a modem or radio action.

Follow-up, same day: the httpd unit and `qm_serve.sh` were deployed with
`/run/qmanager-httpd.pid`. `/var/run` is a symlink to `/run` on this firmware, so
this was a config-only change: the running httpd (pid 2063) was not restarted,
`qm_serve.sh status` still finds it, :8080 and vendor :80 both return 200, and a
`daemon-reload` no longer warns about `qmanager-httpd`. Backups:
`qmanager-httpd.service.pre-run-pidfile`, `qm_serve.sh.pre-run-pidfile`.

Remaining warnings on a `daemon-reload` belong to the vendor image and are left
alone (hard rule 2): `dbus.conf` world-writable and `systemrw.conf` executable
(both on read-only `/lib`), `earlyinit-logd` PIDFile, and
`gp-prx-proxy-tunnel.service:13` putting `StartLimitIntervalSec` in `[Service]`
instead of `[Unit]` (owned by the sibling product repo — fix it there, not here).
