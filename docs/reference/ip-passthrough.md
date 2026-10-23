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

## Related

- [`at-command-transport.md`](at-command-transport.md) — qcmd response and
  failure semantics for the RM520N path.
- [`../specs/ip-passthrough-o5a.md`](../specs/ip-passthrough-o5a.md) — acceptance
  criteria and the owner-authorized O5A UI exception.
- [`../plans/2026-10-23-ip-passthrough-backend.md`](../plans/2026-10-23-ip-passthrough-backend.md) — implementation and validation record.
