# SPEC: O5A IP Passthrough backend parity

**Status:** Source pushed in `03e916cd` and deployed. The owner-authorized no-reboot test and rollback completed 2026-10-23; the configured flag changed but live forwarding was not demonstrated. The owner accepts the existing Apply-and-reboot behavior; the flag is currently disabled.

**Background.** Upstream QManager's page sends five Quectel `AT+QMAP`/`AT+QCFG`
settings. On this GreenPacket O5A Pro (RG520N-EB, firmware
`LE.UM.6.2.3.r1-03100-SDX65.0`), the passthrough/NAT/DNS `AT+QMAP` commands
return errors. The O5A product backend already exposes the native
`GET /passthrough` and `POST /passthrough/set` API on loopback port 8091, but it
only controls the enable flag. Keeping the upstream MAC/NAT/USB/DNS controls
would falsely imply the O5A backend can apply them.

## In Scope

1. Use the product's loopback passthrough API for reads and writes; do not issue
   the unsupported AT command family from this CGI.
2. Match the O5A page to the native contract with one enabled/disabled control,
   an accurate configured-state display, and a confirmation warning about losing
   LAN gateway access.
3. Verify a successful backend response before returning success and queuing the
   existing acknowledged reboot handoff.
4. Record the measured command availability and integration contract for RG520N.

## Out of Scope

- **Per-MAC targeting.** The product endpoint has no target-device parameter; do
  not keep a control that would be ignored.
- **NAT mode, USB protocol, and DHCP DNS offloading.** The O5A endpoint does not
  expose these; adding AT writes would reintroduce the observed failure, and
  editing the vendor XML directly is outside this deployment's allowed paths.
- **Changing `/data/gp/radio-handler.sh`, `/etc/data/mobileap_cfg.xml`, `/web`,
  or any vendor service.** The integration consumes its existing loopback API.
- **Rebooting the live device during validation.** The owner authorized one
  temporary API-mediated enable test without reboot. Enabling can remove the LAN
  management path, so a backup and timed API rollback are required before the
  write; do not use QManager's current rebooting Apply path for this test.
- **Claiming that QMAP commands are unsupported on every RG520N variant.** The
  observation applies only to this O5A firmware until another device is measured.

## Requirements

- [x] GET returns the `enabled` boolean read from `http://127.0.0.1:8091/passthrough`;
      live CGI GET returned `success:true, enabled:false`. The failure branches
      for missing service, non-2xx and malformed JSON are fail-closed by inspection
      but were not fault-injected on the live unit.
- [ ] POST accepts only `enabled: true|false`, calls the product setter with a
      JSON boolean, and requires the returned state to match the request before
      reporting success. The invalid string value was exercised and rejected
      before the setter; the QManager CGI setter path still schedules reboot and
      is not used for the no-reboot live test.
- [x] The CGI never issues `AT+QMAP` or `AT+QCFG="usbnet"` for passthrough (source
      review; live CGI returned state without AT activity).
- [x] The existing `cgi_reboot_response` handoff remains gated on a verified
      setter response; the no-reboot test invoked the product API directly, not
      the QManager CGI, and did not reboot.
- [x] The page exposes only controls supported by the endpoint and clearly warns
      that enabling passthrough may make the LAN gateway unreachable.
- [x] All five shipped locales remain structurally in parity and describe the
      narrowed controls truthfully.
- [x] Shell syntax, `bun run i18n:check`, targeted ESLint and `bun run build` pass.
      Full `bun run lint` remains blocked by pre-existing errors in unrelated files.
- [x] The source was reviewed and pushed only to the owner's `greenpacket` branch.

## Edge cases (close-out)

| Edge case | How it was exercised | Observed |
| --- | --- | --- |
| Product API missing | Not fault-injected; fail-closed branch reviewed | Not exercised |
| Empty/non-JSON response | Not fault-injected; jq/type guard reviewed | Not exercised |
| Backend reports a different enabled value | Not fault-injected; exact equality guard reviewed | Not exercised |
| Invalid request boolean | Direct CGI POST with `enabled:"true"` | `invalid_enabled`; no setter call; product flag remained false |
| Temporary passthrough enable / no-reboot behavior | Owner-authorized product API setter; backup plus 120-second disabled rollback; no reboot | API/XML flag changed to enabled then returned to disabled; boot ID unchanged and services stayed up. The user's traceroute still showed `192.168.0.1` as a hop, so live forwarding was not demonstrated. Product API reports `rebootRequired:true`; owner accepts Apply-and-reboot for actual enable. |

## Benchmark

| Run | Conditions | CPU share of one core | RSS | Fork rate |
| --- | --- | --- | --- | --- |
| Before | Live device, 10 GETs, no AT write/scan; 2.11 s window | 100% system-wide (211 busy ticks; noisy, not CGI attribution) | QManager httpd 68 kB | +223 system forks |
| After | Live device, 10 GETs, no setter/scan; 1.45 s window | 100% system-wide (145 busy ticks; noisy, not CGI attribution) | QManager httpd 116 kB after restart | +282 system forks |

Memory headroom during the before run was 48,920 → 47,324 kB and after was
55,012 → 48,784 kB; these are system snapshots, not per-CGI RSS peaks. The
system fork counter advanced by 59 more in the after batch, but background
activity makes that an upper-bound observation, not isolated CGI attribution.
This functional compatibility change makes no performance claim.

## Branch scope

The owner explicitly authorized the minimal app-layer exception required to
remove controls the O5A backend cannot provide:
`components/local-network/ip-passthrough/**`, `hooks/use-ip-passthrough.ts`,
`types/ip-passthrough.ts`, and
`public/locales/{en,id,it,zh-CN,zh-TW}/common.json`. The backend-only alternative
would falsely retain and accept unsupported fields, so it is not a valid fix.
