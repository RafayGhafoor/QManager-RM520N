# IP Passthrough

> **Scope: RG520N-EB / GreenPacket O5A Pro** (`LE.UM.6.2.3.r1-03100-SDX65.0`). The upstream
> RM520N-GL page used `AT+QMAP`; that path is **not** used here. Everything below was measured
> on this unit on 2026-10-23. A port must re-measure it.

> The `/local-network/ip-passthrough` page: hand the carrier's IP address to the router connected
> to the modem's LAN port, instead of the modem sharing it through NAT.

## Quick reference

| Item | Value |
| --- | --- |
| Page | `/local-network/ip-passthrough` — one Off/On control, no MAC field |
| CGI | `scripts/www/cgi-bin/quecmanager/network/ip_passthrough.sh` |
| Helpers | `scripts/usr/lib/qmanager/ippt.sh` (state, target MAC, apply) |
| Boot re-apply | `scripts/usr/bin/qmanager_ippt_apply --boot` via `qmanager-ippt.service` (`deploy/`), started from `turin_web.sh` by `qm_boot_hook.sh` |
| Owner's intent | `/etc/qmanager/ippt.json` → `{"enabled": true\|false}` |
| Real state | read from QCMAP: `QCMAP_CLI` → 6 Backhaul → 2 WWAN → 16 *Get IP Passthrough State* |
| Mechanism | `/usr/bin/ql_qmap LAN IPPT set 0 1 <mac>` (Quectel's `libql_qmap`, the call the vendor `mpdn` makes) |
| Target device | **auto-detected**: newest live LAN client from `/var/run/data/dnsmasq.leases`, filtered by `/proc/net/arp` |

## Behaviour (measured)

| Action | Result |
| --- | --- |
| **On** | `ql_qmap LAN IPPT set 0 1 <mac>` → QCMAP `ACTIVATED` in ~4 s, the router's DHCP lease becomes the carrier IP (e.g. `10.49.111.179`), **no reboot** |
| **Off** while active | `ql_qmap LAN IPPT set 0 0` answers `CMD OK` but the state **stays ACTIVATED**. Only a reboot clears it, so the CGI uses the acknowledged reboot hand-off |
| Off while not active | just persists; nothing to clear |
| **Persistence** | none: `ql_qmap` is **runtime-only** (the XML is never updated). `qmanager_ippt_apply --boot` re-applies it ~90 s into every boot; proven by real reboots (boot ID changed, applier logged `passthrough active for <mac>`, state `active`) |
| Restarting QCMAP while active | QCMAP **auto-reboots the device** ("IPA HW offload"), so never restart it as a way to disable |
| **Modem UI while active** | `192.168.0.1` **stops answering** from behind the passthrough router (`curl` → `000`). Reach the modem over Tailscale: `100.106.128.119` (`ssh greenpacket-ts`, `:8080` for QManager) |
| Traceroute | not a valid check: it showed the `192.168.0.1` hop both before and after. The valid check is the router's lease (carrier IP) and `ACTIVATED` |

## Traps found while building it

1. **`QCMAP_CLI` never exits on EOF: it reprints its menu forever** (93 MB in 8 s). `/tmp` is RAM on this
   182 MB unit, and capturing it with `$(...)` got the CGI OOM-killed. `ippt_state` always cuts the stream
   with `grep -m1`. **Never redirect this CLI to a file or a variable.**
2. **`timeout` must be `timeout -s KILL`.** At boot `QCMAP_CLI` blocks and *ignores* the `SIGTERM` that
   BusyBox 1.31 `timeout` sends (no `-k`), so the boot applier hung 5+ minutes in its first read.
3. **Do not touch QCMAP in the first ~90 s of boot.** The applier waits for 90 s of uptime (`IPPT_SETTLE`).
4. **`ql_qmap` exits 0 even on failure** and prints `CMD Error#0x…` (seen once: `0x401a`, after a wedged
   `QCMAP_CLI` was killed at boot; a clean reboot cleared it). Success is only ever judged by QCMAP's state.
5. The apply re-binds the LAN, so **the browser's own request can be cut**. The hook polls `GET` after a
   network error instead of reporting failure.
6. `systemctl` is `/bin/systemctl` on this unit, not `/usr/bin/systemctl` (a revert script that hardcoded
   the latter would have failed silently, including its reboot fallback).
7. SSH over the LAN dies while passthrough is active. Use Tailscale. On macOS, if the Mac's own Tailscale
   will not connect, see the Mac note in [`tailscale.md`](./tailscale.md); a tailnet host (e.g. `hayden`)
   works as a jump: `ssh -J hayden -p 2222 root@100.106.128.119`.

## Page

`status-strip.tsx` shows four honest states from *asked-for* × *QCMAP-reported*: **Off**, **Active** (with the
bound MAC), **Waiting for a device** (on, nothing to bind yet; a background waiter binds one when it appears),
**Turning off** (disabled but still active until the reboot). The card has one Off/On control; the confirm
dialog differs per direction and only the "turn off while active" case promises a reboot, using the
three-line hand-off (`qm_rebooting`, clear `qm_logged_in`, `/reboot/`). With more than one client connected
the page says passthrough binds only the newest.

## What did NOT work (do not repeat)

| Attempt | Result |
| --- | --- |
| `AT+QMAP="MPDN_rule"` / `IPPT_NAT` / `DHCPV4DNS` (upstream path) | `ERROR` on this firmware (read and write) |
| Vendor `:80` UI / product `POST :8091/passthrough/set` | only flips `<IPPassthroughEnable>` in `mobileap_cfg.xml`; QCMAP stays `Device Type Not Set` / `NOT ACTIVATED`, even after a reboot. It never activated passthrough |
| `QCMAP_CLI` item 14 (*Set IP Passthrough Config*) | `Error: 0x9` for enable, first-device and disable |
| Writing `IPPassthroughDeviceType`/`HostName`/`MacAddr` (the tags QCMAP's *reader* names; its writer emits `IPPassthroughDevice` + `NULL`) with type `0`–`4` and a real QCMAP restart | no effect: still `Device Type Not Set` |
| `ql_qmap LAN IPPT adaptive 0 2` (ETH first device) | `CMD OK` but state stayed `NOT ACTIVATED` in the window observed; the fixed `set 0 1 <mac>` is what works |
| Vendor Port Mode (`turin.turin.mode=bridge` → `mpdn` → `ql_qmap_lan_ippt_set_v1`) | `turin_mpdn.service` is **masked** on this unit (it tears the PDN down when IPv6 fails), so changing the mode does nothing here |

## How the vendor does it (SDK on `petros1`: `/root/o5a-src/o5a`)

`turin/app/cped/web_interface.cpp:5269-5427` maps Port Mode `Routing`→`nat`, `IP Passthrough`→`bridge` into
`uci turin.<project>.mode`; `/usr/bin/mpdn` reads it and calls `ql_qmap_lan_ippt_set_v1` /
`ql_qmap_lan_ipptnat_set_v1`. QCMAP's header (`QCMAP_Client.h:5185-5300`) documents that the private bridge IP is
kept and the WWAN gateway IP added, and that the XML flag does not mean active. **That last claim did not
hold here:** with passthrough active the modem's `192.168.0.1` did not answer from behind the router.
Device-type enum (`qualcomm_mobile_access_point_msgr_v01.h:535-554`): `3` USB, `4` ETHERNET. `ql_qmap LAN IPPT`
modes: `1` ETH (host MAC), `2` WLAN, `3` USB (host name), `4` ETH-NIC2.

## Benchmark (same method both runs: 10 direct CGI GETs on the live unit, normal services)

| Run | Per GET | Forks per GET | MemAvailable |
| --- | --- | --- | --- |
| Before (XML-flag CGI, `jq` + `curl`) | ~211 ms | ~22 | 48,920 → 47,324 kB |
| After (this CGI; adds one `QCMAP_CLI` spawn) | **174 ms** | **42** | 61,948 → 61,932 kB |

Not cheaper: the extra forks are the `QCMAP_CLI` call. System CPU figures are whole-box and noisy, so no CPU
claim is made. Nothing polls this page; the boot applier runs once (~90 s after boot) and exits.

## Edge cases checked

| Edge case | How | Observed |
| --- | --- | --- |
| Boot with passthrough on | real reboot ×2 | re-bound ~90 s in, `state=active`, router got the carrier IP |
| Boot with passthrough off | real reboot | applier logged "not requested", router back on `192.168.0.39` |
| `QCMAP_CLI` wedged at boot | first applier version | hung 5+ min → fixed with `timeout -s KILL` + 90 s settle |
| Invalid request (`enabled:"true"`) | direct POST | `invalid_enabled`, nothing changed |
| No client connected | by code only | persists, spawns the background waiter; **not exercised on the unit** |
| More than one client | by code only | newest wins; **not exercised on the unit** |

## What the passthrough router is actually told (captured 2026-10-23, forced renew)

Method: `ethtool -r eth0` on the modem bounces the Ethernet link, so the router re-runs DHCP within ~10 s
(there is no reliable DHCP force-renew; this and re-running the apply are the two ways). `tcpdump -vv` on
`any` for `port 67 or 68` showed the Offer (the Tenda is `cc:2d:21:1d:21:79`, OUI Tenda):

| DHCP option | Value | Verdict |
| --- | --- | --- |
| IP / mask | `10.49.111.179` / `255.255.255.248` | ok |
| Server-ID, router | `10.49.111.180` (a secondary `/32` the apply adds to `bridge0`) | ok; **changes every carrier session** (seen: `.180`, `10.49.156.116`, `10.122.0.x`), never hard-code it |
| Lease | 3600 s | ok |
| **DNS (option 6)** | **`192.168.0.1`** | **broken for the router**: that address does not answer from behind passthrough, so a router with DNS on *automatic* inherits a dead resolver |

Other measurements from the same session:

- The router's internet itself works: `nf_conntrack` showed 130 live flows from `10.49.111.179` with replies
  (established TLS, replied ICMP, 28 DNS flows answered by the carrier resolver `119.160.122.146`). The only
  `[UNREPLIED]` flows were UPnP/SSDP/NAT-PMP/Tailscale discovery noise.
- dnsmasq **is** listening on `10.49.111.180:53` (bind-interfaces) and forwards to smartdns on
  `127.0.0.1:5353`, and `INPUT` has no rule blocking the router. So the modem's smartdns is reachable to the
  router in principle; **why `192.168.0.1` is not remains unexplained** (suspect the IPA hardware path, which
  also hides these packets from `tcpdump` and the `/proc/net/dev` counters). Not tested from a client behind
  the router.
- The router did **not** renew at half-lease (T1 = 30 min): no `DHCPREQUEST` was logged between 21:31:48 and the
  forced renew at 22:12. Renewal is unicast to the Server-ID, so expect a refresh at most about hourly and bounce
  the link if it stalls.
- The Traffic Engine's `nat PREROUTING -i bridge0 -p tcp -m multiport --dports 80,443 ! --dst-type LOCAL
  -j REDIRECT --to-ports 989` also captures the passthrough router's forwarded web traffic. Passthrough is
  meant to be transparent; this is untested as a cause of breakage but worth ruling out. A stale
  `POSTROUTING -o rmnet_data0 -j SNAT --to-source 10.49.111.179` is left over from an older interface name.
- The overriding line is QCMAP's `dhcp-option-force=6,192.168.0.1` in `/var/run/data/dnsmasq.conf.bridge0`
  (regenerated by QCMAP; later lines win over our `conf-file` block), so fixing the offered DNS needs a
  boot-time step that recomputes the gateway address, not a static option.

**Open:** a device behind the router should run `nslookup google.com 10.49.111.180` and
`nslookup google.com 192.168.0.1` while a capture runs on the modem; that separates "DNS path broken" from
"something else". Interim advice: set the router's WAN DNS manually (`1.1.1.1` / `8.8.8.8`).

## Related

- [`tailscale.md`](./tailscale.md) — the out-of-band path while passthrough hides the modem
- [`at-command-transport.md`](./at-command-transport.md) — why `qcmd` and AT are not involved here
- [`../specs/ip-passthrough-o5a.md`](../specs/ip-passthrough-o5a.md) — scope and acceptance
- [`../plans/2026-10-23-ip-passthrough-backend.md`](../plans/2026-10-23-ip-passthrough-backend.md) — work record
