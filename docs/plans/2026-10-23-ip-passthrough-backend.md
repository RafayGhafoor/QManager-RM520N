# IP Passthrough: use the O5A device backend

**Status:** implementation in progress, 2026-10-23.

## Goal

Make QManager's IP Passthrough page apply the setting through the backend that
actually owns it on the GreenPacket O5A Pro, instead of sending unsupported
`AT+QMAP` commands. Push the source change to the `greenpacket` branch. Do not
enable passthrough or reboot the live router as part of this change.

## Current state and evidence

- QManager's `scripts/www/cgi-bin/quecmanager/network/ip_passthrough.sh` models
  five AT-controlled values (`MPDN_rule`, `IPPT_NAT`, `usbnet`, `DHCPV4DNS`, and
  a target MAC), then calls `cgi_reboot_response`.
- On the live RG520N-EB, the first apply write
  `AT+QMAP="MPDN_rule",0,1,0,1,1,"FF:FF:FF:FF:FF:FF"` returned
  `ERROR: command_failed` (QManager log, 2026-10-23 18:37:14 UTC). Read-only
  probes of the `QMAP` passthrough/NAT/DNS commands also failed; `AT+QCFG="usbnet"`
  answered. The page stopped before persisting config or scheduling a reboot.
- The product's loopback radio-handler at `127.0.0.1:8091` has `GET /passthrough`
  and `POST /passthrough/set`; GET returned
  `{"enabled":false,"rebootRequired":false,"reboot_required":false}`. Its
  setter owns the vendor-supported enable flag. It exposes no target MAC, NAT,
  USB mode or DNS controls.
- The live `/etc/data/mobileap_cfg.xml` currently reports
  `<IPPassthroughEnable>0</IPPassthroughEnable>`. This change will not write it
  directly and will not call the setter during development or deployment.

## Approach

1. Replace the QManager CGI's QMAP path with read-through to the product's
   loopback `/passthrough` endpoint and a strictly validated boolean POST to
   `/passthrough/set`. Verify the backend response matches the requested flag;
   only then keep the existing acknowledged reboot handoff.
2. Re-scope the O5A page to the backend's real contract: one enable/disable
   control and the existing clear LAN-gateway/reboot warning. Remove the
   unimplemented MAC, NAT, USB-protocol and DNS controls rather than displaying
   or silently accepting values the backend cannot apply.
3. Record this owner-authorized app-layer exception in `AGENTS.md`; document the
   backend contract and the measured RG520N limitation in the spec, reference
   router, platform matrix and this plan.
4. Validate shell syntax, translations, type/lint/build, and a read-only GET
   against the loopback backend. Review the diff, verify the GitHub target, then
   commit and push only explicitly listed paths to `origin/greenpacket`.

## Files

- `scripts/www/cgi-bin/quecmanager/network/ip_passthrough.sh`
- `components/local-network/ip-passthrough/{ip-passthrough.tsx,ip-passthrough-card.tsx,status-strip.tsx}`
- `hooks/use-ip-passthrough.ts`, `types/ip-passthrough.ts`
- `public/locales/{en,id,it,zh-CN,zh-TW}/common.json`
- `AGENTS.md`, `docs/specs/ip-passthrough-o5a.md`,
  `docs/reference/ip-passthrough.md`, `docs/reference/README.md`,
  `docs/reference/platform-matrix.md`, and `memory.md` only if the live
  installation itself is changed.

README checked: no install/build/feature entry changes beyond the existing page,
so no README edit is expected.

## Risks and verification

- Enabling IP passthrough can stop the LAN gateway answering and can strand the
  browser. Keep the confirmation dialog and warning; do not invoke the enable
  setter during validation. A successful CGI response must be gated on a valid
  vendor-backend response before the reboot is queued.
- The product backend is an existing loopback service on port 8091; QManager must
  not bind or claim that port, and its absence must fail closed without invoking
  AT or claiming success.
- Never edit `/etc/data/mobileap_cfg.xml`, `/data/gp/radio-handler.sh`, or `/web`.
- Live feature activation and reboot are explicitly out of scope for this run.

## Benchmark

Baseline captured on the live device before deployment (2026-10-23, normal services
running; 10 authenticated-bypass CGI GETs run directly as root; no passthrough
write/reboot, no scan or lock operation). The CPU figure is system-wide and
includes unrelated activity, so it is a noisy upper bound rather than CGI
attribution.

| Run | Elapsed | CPU, one-core share | CGI/system forks | QManager httpd RSS | MemAvailable |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before | 2.11 s | 211 busy ticks = 100% system-wide | +223 | 68 kB (`/proc/1921/status`) | 48,920 → 47,324 kB |
| After | Pending live deployment | — | — | — | — |

The implementation is not a daemon/poller performance change. Repeat the same
10 read requests with identical conditions after deployment; do not claim a
performance improvement from source inspection alone. No setting activation is
needed for this read-only benchmark.
