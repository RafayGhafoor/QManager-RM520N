# IP Passthrough

> **Scope:** RM520N-GL for the upstream QMAP contract; RG520N-EB / GreenPacket O5A Pro for the deployment backend below. RG501Q-EU is unverified.

## O5A Pro deployment contract

On the GreenPacket O5A Pro, IP Passthrough is configured by the product's own
network backend, not by the Quectel QMAP commands used by upstream QManager. The
O5A page and CGI therefore expose the one capability this backend supports:
enable or disable IP Passthrough. It does not offer a MAC selector, NAT mode, USB
protocol or DHCP DNS toggle because the product API has no controls for them.

| Item | O5A implementation |
| --- | --- |
| Page | `/local-network/ip-passthrough` — one enabled/disabled control |
| QManager CGI | `scripts/www/cgi-bin/quecmanager/network/ip_passthrough.sh` |
| Product GET | `http://127.0.0.1:8091/passthrough` |
| Product POST | `http://127.0.0.1:8091/passthrough/set` with `{"enabled":true|false}` |
| Device source of truth | Product backend reads/writes `<IPPassthroughEnable>` in `/etc/data/mobileap_cfg.xml` |
| Apply | Product setter must return the requested boolean plus `rebootRequired:true`; QManager then uses `cgi_reboot_response` and the existing `/reboot/` acknowledgement handoff |

The CGI consumes the product's loopback API. It does **not** write the vendor XML,
modify `/data/gp/radio-handler.sh`, or bind port 8091. A failed, empty, malformed,
or non-matching backend response is an error; the CGI never schedules the reboot
unless the product endpoint confirms both the requested state and reboot
requirement.

### Measured compatibility boundary (RG520N-EB)

On the live O5A Pro, 2026-10-23, read-only QManager `qcmd` probes returned
`ERROR: command_failed` for `AT+QMAP="MPDN_rule"`,
`AT+QMAP="IPPT_NAT"`, and `AT+QMAP="DHCPV4DNS"`. The user's apply attempt was
rejected on its first write:

```text
AT+QMAP="MPDN_rule",0,1,0,1,1,"FF:FF:FF:FF:FF:FF"
```

The QManager log recorded `MPDN_rule ETH failed (rc=1)` at 2026-10-23 18:37:14
UTC; execution stopped before persisting settings or scheduling a reboot.
`AT+QCFG="usbnet"` did answer, but that does not make it a supported passthrough
control in the product API. The product GET returned
`{"enabled":false,"rebootRequired":false,"reboot_required":false}` and the
observed config flag was disabled. These observations apply to this O5A firmware
only; re-measure other RG520N product builds before porting the conclusion.

### Safety and truthful state

Enabling passthrough may make the LAN gateway unreachable. The page keeps the
confirmation dialog and warns to retain Tailscale or another way back in before
applying. This feature's validation does not enable passthrough or reboot the
router.

GET reports the product backend's **configured flag**, not a live packet-path
probe. The status wording says "Device setting" and describes what the backend
reports; it must not be relabelled as a measurement of active forwarding.

## Upstream RM520N-GL contract

The original RM520N-oriented QManager implementation uses the modem's QMAP MPDN
rule and related settings:

- `AT+QMAP="MPDN_RULE"` reads passthrough mode and target information.
- `AT+QMAP="IPPT_NAT"`, `AT+QCFG="usbnet"`, and
  `AT+QMAP="DHCPV4DNS"` read NAT mode, USB protocol and DHCP DNS behavior.
- Apply writes the MPDN rule, NAT, USB mode and DNS setting before its reboot
  handoff, with writes serialized through `qcmd` and confirmed by a line-exact
  modem `OK`.

That richer contract is **not** the O5A backend contract. Do not restore those
controls to the O5A page unless a device-owned backend is measured and can apply
each one. The platform-specific observation is also recorded in
[`platform-matrix.md`](./platform-matrix.md).

## Deployment verification and benchmark (2026-10-23)

The code was deployed under `/usrdata/qmanager/www` with the prior tree backed up
at `/usrdata/qmanager/backup/ip-passthrough-20261023/www-before.tgz` (5.2 MB).
The QManager CGI's read-only GET returned `success:true, enabled:false`; an invalid
string boolean was rejected before the product setter. The vendor XML flag stayed
`0`, the boot ID did not change, and no valid setter or reboot was invoked. Both
the QManager page and vendor `:80` UI returned HTTP 200; QManager's HTTP service,
poller, ping, DPI, and DPI ensure timer were active at close-out.

Ten direct CGI GETs before vs after were measured with normal services running,
without scans, lock operations, or setting writes:

| Run | Uptime window | Elapsed | System CPU (one core) | System forks | QManager httpd RSS | MemAvailable |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Before | 55697.90–55700.01 s | 2.11 s | 211 busy ticks / 100% | +223 | 68 kB | 48,920 → 47,324 kB |
| After | 55980.92–55982.37 s | 1.45 s | 145 busy ticks / 100% | +282 | 116 kB | 55,012 → 48,784 kB |

The CPU and process counters are system-wide, not attributable to this transient
CGI; the httpd RSS sample is after a service restart. These short windows are
noisy and do not establish a performance win. The system fork count advanced by
59 more in the post-change batch, with background activity not isolated. No new
resident process was added and the page is not continuously polled.

**Live no-reboot test (2026-10-23):** with the owner's approval, the product
setter changed the XML flag from `0` to `1` without rebooting; its response still
said `rebootRequired:true`. During that window the user's traceroute still showed
`192.168.0.1` on the path, so the API's configured flag did not demonstrate live
forwarding. A 120-second setter rollback restored the flag to `0`, removed the
marker that had been absent before the test, and left the original boot ID intact.
Do not drop the reboot handoff or label the feature active until a QCMAP runtime
setter/readback (or an owner-approved QCMAP service reload) is verified.

**After the reboot (2026-10-23, boot `48301c6f`):** the page's Apply set
`<IPPassthroughEnable>` to `1` and it survived the reboot, but passthrough was still
not in force. QCMAP's own readers (`QCMAP_CLI` -> 6 Backhaul -> 2 Backhaul WWAN ->
15 / 16) reported `IP Passthrough Flag is SET`, `Device Type Not Set` and
`IP Passthrough is NOT ACTIVATED`; the XML held `IPPassthroughDevice=-1`,
`IPPassthroughHostName=NULL`, `IPPassthroughMacAddr=NULL`. The flag alone is therefore
not enough: QCMAP also needs a target device. The user's traceroute (hop
`192.168.0.1` still present) agreed. The vendor `:80` UI's `/passthrough/set` writes
only the flag, so it has the same gap; whether it ever activates was not verified.

**What did NOT work:** QCMAP's native setter (`QCMAP_CLI` item 14: flag, "new config",
choice 1 = specific device, device type `1` = ETH, MAC `cc:2d:21:1d:21:79`, the only
DHCP client) returned `Set IP Passthrough status Error: 0x9` and changed nothing. The
"First Connected Device" choice and a plain disable (`0`) returned the same `0x9`.
`0x9` is most likely QMI `INVALID_HANDLE`: that CLI session has no MobileAP handle.
Getting one means the CLI's "Enable/Disable mobileap", which was not tried because it
can tear the WAN down on a unit with no out-of-band access. Prompt order (ETH path):
`1` enable, `1` new config, `1` specific device, `1` ETH, then MAC; hostname is only
asked for USB. Untried next step: set `IPPassthroughDevice`/`IPPassthroughMacAddr` in
`mobileap_cfg.xml` and reboot so QCMAP reads them at start (direct vendor-file edit,
needs owner approval, backup `/usrdata/qmanager/backup/ippt-live-test-20261023/`).

## Related

- [`at-command-transport.md`](at-command-transport.md) — qcmd response and
  failure semantics for the RM520N path.
- [`../specs/ip-passthrough-o5a.md`](../specs/ip-passthrough-o5a.md) — acceptance
  criteria and the owner-authorized O5A UI exception.
- [`../plans/2026-10-23-ip-passthrough-backend.md`](../plans/2026-10-23-ip-passthrough-backend.md) — implementation and validation record.
