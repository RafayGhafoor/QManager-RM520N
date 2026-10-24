# 2026-10-24 — Dashboard Live Traffic row

**Status:** Built, deployed to the O5A Pro, verified. Docs: spec
[`../specs/live-traffic-row.md`](../specs/live-traffic-row.md), reference
[`../reference/live-traffic.md`](../reference/live-traffic.md).

**Ask (owner):** "on dashboard, in live metrics lets add Live Traffic above Data
Used (togglable) … it needs to be lightweight and real-time", with the sibling
product's live throughput card as the reference and an explicit "if you can do in
rust and if it's better, do that — we have code already in rust".

## Intended

A rate row above the cumulative Data Used counter, updating about once a second,
switchable off, and cheap enough that leaving the dashboard open does not matter.

## Measured (this decided the architecture, twice)

All figures taken on the live install, RG520N-EB, 2026-10-24, 100 requests with
the client's own cost amortised out (single `curl` process, bodies discarded):

| Transport | CPU/read | forks/read | at 1 Hz |
| --- | --- | --- | --- |
| CGI `public/overview.sh` (jq) | 69.3 ms | 7.44 | 6.9 % of one core |
| CGI `data_used.sh` (older run, same day) | 75.8 ms | 7.27 | 7.6 % |
| CGI, `cgi_base.sh` + printf only (jq-free floor) | 16–26 ms | 1.5–2.2 | ~2 % |
| **static file via busybox httpd** | **9.0 ms** | **1.40** | **0.9 %** |

Fork cost on this unit, for reference: `/bin/true` 5.25 ms / 1.12 forks; one
`qlog_warn` line adds ~3 forks (`date` + `wc -c` + `logger`).

**First design, abandoned:** a CGI that computed the delta per request (written,
shipped to `/tmp`, measured at **107 ms / 8.07 forks** per request). At 1 Hz that
is ~10 % of the device's only core — more than the entire modem poller (6.3–7.8 %
measured). The file was deleted rather than kept as a fallback.

**Second design, shipped:** one Rust sampler writes a document once a second;
the docroot entry is a symlink into tmpfs; the browser reads the static file.
Rust over a shell loop for the same reason one level down: a shell `sleep`+`mv`
tick is ~2 forks ≈ 0.5 % of one core, forever.

## Benchmark (before → after)

Same harness both runs, 60 s windows, no browser attached, all daemons as
deployed, downloaded traffic live on the WAN throughout (this box is in service).

| Metric | Before (no feature) | After, row OFF/closed | After, row ON at 1 Hz |
| --- | --- | --- | --- |
| System fork rate | **50.30 /s** | **48.01 /s** | **55.33 /s** (75 reads) |
| System busy, one core | (not comparable¹) | **39.38 %** | **45.91 %** |
| Sampler CPU | — | **0 jiffies / 60 s** (< 0.017 %) | same |
| Sampler RSS / threads | — | **184 kB / 1** | same |
| Poller CPU | 6.34 % | 7.78 % (2 min window) | same |
| MemAvailable | 52.7–53.4 MB | 51.9 MB | same |

¹ The "before" system-busy line was computed with `idle` included in the jiffy
sum and is therefore not a comparable number; the fork rate is, and is unchanged
within the vendor stack's own noise. The **A/B pair** (OFF vs ON, same run, same
conditions) is the honest cost of the row: +7.3 forks/s and +6.5 points of one
core across 75 reads ⇒ **~5.2 ms CPU and ~1.4 forks per read**, i.e. ≈0.5 % of one
core at the shipped 1 Hz cadence, and **0** when the row is switched off.

Per-tick work of the sampler: two `/proc` reads, one `rename`, one wakeup. No
process is created, and nothing is written to flash.

## Built

- `native/qmanager_traffic/` — Rust, **zero dependencies**, armv7-musl static
  (353 716 B). Seven host tests (`cargo test`) over the `/proc/net/dev` parse and
  the warming / rate / too-soon / reset / gap state machine.
- `deploy/qmanager-traffic.service` + `qm_boot_hook.sh` `UNITS` entry; the unit's
  `ExecStartPre` re-asserts the docroot symlink on every start.
- `hooks/use-live-traffic.ts`, `types/modem-status.ts` (`LiveTrafficSnapshot`),
  `components/dashboard/device-metrics.tsx` (row + `CardAction` switch + skeleton
  geometry 4 meters + 4 pills), `metrics.live_traffic_*` in all five locales.
- `deploy/README.md` — build step, unit step, and a "Native binaries" section.

## What broke on the way, and what it taught

1. **The CGI was 107 ms, not 40.** Attribution: `cgi_base.sh` 1.5–2.2 forks,
   one `qlog_warn` ~3 forks, one atomic write ~1 fork, bash startup the rest.
   The lesson is in the reference doc: on this SoC the CGI *floor* is the price,
   so an endpoint polled at 1 Hz cannot be a CGI at all.
2. **`state run in an effect` tripped the react-compiler lint**, and a lazy
   `useState` initializer would have made the prerendered HTML disagree with the
   client. `useSyncExternalStore` with an explicit server snapshot settled both,
   and gave cross-tab agreement for free.
3. **A dev feed file (`public/live-traffic.json`) shipped once** and replaced the
   docroot symlink on a redeploy, freezing the row. Fixed, and the reference doc
   now says never to ship one; the unit's `ln -sfn` heals it on restart.
4. **`pnpm`-style archaeology is not verification.** Verified in a browser at the
   three widths the trio uses, dark and light, in all three states (rates,
   measuring, absent), and clicked the switch rather than assuming it.
5. **The units were wrong for this UI, and only the owner could see it.** The row
   shipped `Mbps`; the product UI it sits beside renders bytes/s
   (`v2/src/pages/Dashboard.svelte:80`), so the same transfer read ~8x different in
   the two places. Reported as "the live traffic is showing wrong results". The
   measurement was verified first — a controlled 20 MB download moved
   `rmnet_ipa0` rx by 22.06 MB, a 10 MB upload moved tx by 10.98 MB, and a 60 s
   window matched the modem's own `AT+QGDCNT` within 1–7 % — so the fix was one
   line in the renderer, not a change to the sampler. Lesson: when a display is
   reported wrong, measure the pipeline *and* the unit before touching the maths.
6. **The docroot symlink is now healed by the deploy step.** A stray
   `public/live-traffic.json` (the dev feed used for the browser checks) was
   copied into `out/` and extracted over the symlink — the second time it served
   fabricated 9.2 Mbps/220 Kbps values to the live dashboard. `qm_pathfix.sh` now
   `rm -f`s and re-creates the link unconditionally; the unit's `ExecStartPre`
   does it again on start.

## Still open

- **Boot proof is outstanding.** `qm_boot_hook.sh` inserted
  `start_service_async qmanager-traffic.service` into
  `/etc/init.d/turin_web.sh` (10 qmanager lines, `sh -n` OK) but AGENTS.md Hard
  rule 6 says only a real reboot proves it. **Next step: reboot the unit, then**
  `systemctl show -p ActiveEnterTimestamp --value qmanager-traffic` must land
  after `/proc/uptime`'s boot time, and `curl /live-traffic.json` must answer
  within a few seconds of the WAN coming up.
- A timeout/peak view of the same counter (the sibling has a five-minute chart)
  is out of scope per the spec; if it is ever wanted it belongs on Signal
  History's surface with a floored scale, not in a pill row.
