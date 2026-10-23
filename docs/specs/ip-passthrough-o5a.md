# SPEC: O5A IP Passthrough

**Status:** Built and verified on the unit, 2026-10-23. Reference: [`docs/reference/ip-passthrough.md`](../reference/ip-passthrough.md).

**Background.** Upstream QManager drives passthrough with `AT+QMAP`, which answers `ERROR` on the O5A. The
vendor UI and the product's `POST :8091/passthrough/set` only flip an XML flag and never activate it. What the
vendor stack itself calls is Quectel's `ql_qmap LAN IPPT` (`libql_qmap`), shipped on the unit as
`/usr/bin/ql_qmap`. The owner asked for a page that works, with no MAC to type and no reboot to turn it on.

## In Scope

1. Drive `ql_qmap LAN IPPT set 0 1 <mac>` from the CGI, with the target **auto-detected** from the DHCP leases
   and ARP table, and confirm with QCMAP's own state.
2. Persist the owner's intent in `/etc/qmanager/ippt.json` and **re-apply after every boot** (the binding is
   runtime-only).
3. A page with one Off/On control and four honest states (Off / Active / Waiting for a device / Turning off).
4. Turning **on** needs no reboot; turning **off** while active uses the acknowledged reboot hand-off.

## Out of Scope (with reasoning)

- **A MAC, NAT, USB-protocol or DNS control.** The target is the newest LAN client, found by the backend;
  `ql_qmap LAN IPPTNAT` exists but was not needed and is untested as a writer.
- **A live disable.** Measured: `ql_qmap LAN IPPT set 0 0` answers OK and the state stays `ACTIVATED`; a QCMAP
  restart auto-reboots the device. A reboot is the only clearing mechanism, so it is surfaced, not hidden.
- **`AT+QMAP`, the XML flag, the product `:8091/passthrough` API, `QCMAP_CLI` item 14, `ql_qmap ... adaptive`.**
  Each was tried and is recorded under "What did NOT work" in the reference. Do not re-add them.
- **Re-enabling `turin_mpdn.service`.** It is masked because it tears the PDN down; the vendor Port Mode path
  depends on it.
- **Choosing among several clients.** Passthrough binds exactly one; the newest wins and the page says so.
- **Keeping the modem UI reachable at `192.168.0.1`.** It is not reachable while passthrough is active
  (measured); Tailscale is the way in, so it must be working (see `docs/reference/tailscale.md`).

## Requirements

- [x] GET returns `{enabled, state, target_mac, clients}`; `state` comes from QCMAP and `unknown` is never
      reported as `inactive`.
- [x] POST `enabled:true` binds the detected device and returns `state:"active"` without a reboot (verified:
      same boot ID, lease became the carrier IP).
- [x] POST `enabled:false` persists, and reboots only when the state is `active` (verified both: off + reboot
      → inactive, router back on `192.168.0.39`).
- [x] The setting survives a reboot: `qmanager-ippt.service` re-applies it (verified by two real reboots).
- [x] No call can flood RAM or hang: the vendor tools run under `timeout -s KILL`, and `QCMAP_CLI` output is cut
      at the first match.
- [x] Five locales in parity; `bun run i18n:check`, targeted ESLint and `bun run build` pass.
- [ ] Full-repo `bun run lint` — still fails on unrelated existing files (`app/not-found.tsx`,
      `cellular-information.tsx`, `carrier-aggregation.tsx`, `recent-activities.tsx`, `reboot-countdown.tsx`).

## Edge cases (close-out)

| Edge case | How it was exercised | Observed |
| --- | --- | --- |
| Boot with intent on | real reboot ×2 | re-bound ~90 s in |
| Boot with intent off | real reboot | "not requested", inactive |
| `QCMAP_CLI` wedged at boot | first version of the applier | hung → fixed (`-s KILL`, 90 s settle) |
| Invalid boolean | direct POST | `invalid_enabled`, no change |
| No client / several clients | not exercised on the unit | by code: persist + background waiter / newest wins |

## Benchmark

| Run | Per GET | Forks / GET |
| --- | --- | --- |
| Before (XML-flag CGI) | ~211 ms | ~22 |
| After (this CGI) | 174 ms | 42 |

Not cheaper (one extra `QCMAP_CLI` spawn per GET); nothing polls the page. Details in the reference.

## Branch scope

Owner-authorised app-layer exception (AGENTS.md exception 5): `components/local-network/ip-passthrough/**`,
`hooks/use-ip-passthrough.ts`, `types/ip-passthrough.ts`, `public/locales/{en,id,it,zh-CN,zh-TW}/common.json`.
The backend half lives in `scripts/` and `deploy/`.
