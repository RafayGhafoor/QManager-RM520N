# IP Passthrough: use the O5A device backend

**Status:** source deployed and pushed (`03e916cd`); owner then authorized a one-time live enable test without reboot. Runtime verification/rollback is in progress.

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
- The live `/etc/data/mobileap_cfg.xml` reported
  `<IPPassthroughEnable>0</IPPassthroughEnable>` at deployment. QCMAP's native
  API source returns an immediate setter response, while the product's wrapper
  edits this XML and sets a `rebootRequired` marker without itself rebooting.
  The owner has authorized one test through that API, with backup and timed
  rollback, to determine whether the runtime path changes without reboot.

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
5. Deploy the built static export and CGI under `/usrdata/qmanager/www` only;
   retain a pre-deploy backup and verify both UIs plus service state.
6. With the owner's one-time authorization, back up the product XML and
   passthrough marker state, set enabled via the existing product API, do not
   reboot, observe runtime reachability, and restore disabled via the API on a
   short timer. Do not use QManager's current rebooting Apply path for the test.

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
  browser. Keep the confirmation dialog and warning. The one-time live test used
  a timed product-API rollback; no reboot was invoked. A successful CGI response
  must be gated on an exact vendor-backend readback.
- The product backend is an existing loopback service on port 8091; QManager must
  not bind or claim that port, and its absence must fail closed without invoking
  AT or claiming success.
- Never edit `/etc/data/mobileap_cfg.xml` directly or modify
  `/data/gp/radio-handler.sh`; the owner authorized one temporary API-mediated
  setting change, not a source edit.
- Live enable testing is now in scope; rebooting remains explicitly out of scope.
- Tailscale is active as a service but has no assigned IPv4/interface, so there
  is no out-of-band management path. A timed API rollback was armed before the
  live flag test.
- **No-reboot result:** the XML-only setter did not demonstrate live data-path
  activation, while its response marks `rebootRequired:true`. The owner accepted
  using the page's existing Apply-and-reboot flow; no QCMAP service restart was
  performed. A future no-reboot implementation would need a measured QCMAP
  runtime setter and an active-state readback.

## Outcome, validation and review

- Deployed the new frontend + CGI to `/usrdata/qmanager/www` after backing up the
  prior www tree to `/usrdata/qmanager/backup/ip-passthrough-20261023/www-before.tgz`
  (5.2 MB). The live test temporarily changed the product XML and created its
  reboot marker through the authorized API; the timed rollback restored both to
  their pre-test state. The persistent QManager writes were the www tree and
  backups under `/usrdata/qmanager`; `/web` and vendor source files were untouched.
- The safe live CGI GET returned `success:true, enabled:false`; an invalid
  string boolean was rejected before the setter. Under the owner's explicit
  one-time approval, the product setter was then called directly with
  `enabled:true` (not through QManager's rebooting POST): it returned
  `rebootRequired:true`, the XML flag became `1`, and no reboot occurred. The
  QManager and vendor web services remained reachable, but the user's traceroute
  still included `192.168.0.1`; this does not establish live passthrough.
- A 120-second rollback invoked the product setter with `enabled:false`, removed
  the marker that had been absent before the test, restored the XML flag to `0`,
  and returned the product GET to `{enabled:false,rebootRequired:false}`. Boot ID
  remained unchanged. The `GET /passthrough` API reads the configured XML flag,
  not an active-path readback.
- HTTP smoke: `:8080/`, `/setup/`, `/local-network/ip-passthrough/`, and the
  public overview returned 200; vendor UI `:80` returned 200. The protected CGI
  still returns 401 without a session. `qmanager-httpd`, poller, ping, DPI and
  DPI ensure timer were active at close-out; boot ID was unchanged.
- The first post-copy `qm_serve.sh restart` left a manual httpd child while
  systemd considered `qmanager-httpd` inactive. Recovered immediately by
  `qm_serve.sh stop` followed by `systemctl start qmanager-httpd.service`; the
  final service/PID check is active and the UI smoke passed. No reboot occurred.
- `bun install --frozen-lockfile`, `bun run build`, `bun run i18n:check`, targeted
  ESLint, `sh -n`, and `git diff --check` passed. `bun run icons:check` passed
  with its existing dead-glyph warning. Full `bun run lint` remains blocked by
  unrelated pre-existing lint errors in `app/not-found.tsx`,
  `components/cellular/cellular-information.tsx`,
  `components/dashboard/{carrier-aggregation,recent-activities}.tsx`, and
  `components/reboot/reboot-countdown.tsx`; changed files had no lint errors.
- Diff review confirmed the QManager CGI no longer sources `cgi_at.sh` or issues
  QMAP/usbnet commands, and retains the acknowledged reboot handoff after the
  product API confirms the configured flag. The UI remains narrowed to the
  supported configured boolean. The device flag is disabled after rollback; the
  owner plans to enable it through the page and reboot.
- Pushed commit `03e916cd` to `origin/greenpacket` after verifying the owner fork
  and active `RafayGhafoor` authentication. Unrelated dirty `memory.md` / Jazz
  work was not staged; the live-install note is present in the working tree only.

## Benchmark

Before and after were ten direct authenticated-bypass CGI GETs as root with the
normal QManager services running; no scan, lock operation, setter, or reboot. The
system CPU counter is global (contains unrelated activity), and the httpd process
was restarted between runs, so neither CPU nor RSS is attributable to the CGI.
Forks are the system `/proc/stat` counter over each request batch.

| Run | Uptime window | Elapsed | CPU ticks / one core | Forks | QManager httpd RSS | MemAvailable |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Before | 55697.90–55700.01 s | 2.11 s | 211 / 100% system-wide | +223 | 68 kB (PID 1921) | 48,920 → 47,324 kB |
| After | 55980.92–55982.37 s | 1.45 s | 145 / 100% system-wide | +282 | 116 kB (PID 18519) | 55,012 → 48,784 kB |

These separate short windows are noisy and do not support a speedup claim. The
observed system fork counter advanced by 59 more over the post-change batch; this
is not isolated CGI attribution. The page is not polled continuously, and no new
resident process was added.
