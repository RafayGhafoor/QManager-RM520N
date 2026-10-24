# SPEC: Live Traffic row on the dashboard Device Metrics card

**Status:** Built, 2026-10-24 — deployed to the O5A Pro and verified. This file
started as a proposal whose transport was a CGI; **measurement on the device
rejected that design and the decision is recorded here**, because the reason is
reusable and the next person will otherwise reach for the same CGI.
Lightweight spec — falsifiable requirements, in-scope/out-of-scope explicit,
acceptance criteria as pass/fail.

**Background:** The Device Metrics card (`components/dashboard/device-metrics.tsx`)
shows a **cumulative** Data Used counter read from the poller cache and reset on
demand. That figure answers "how much have I used", never "how fast am I going".
The sibling product (`greenpacket-o5a`, Svelte `v2/src/pages/Dashboard.svelte:369`)
has a *Live throughput* card fed by `traffic.dl`/`traffic.ul` from its 4 s `/all`
poll, with a togglable five-minute mini chart
(`v2/src/lib/components/ThroughputMiniChart.svelte`). Its throughput is computed
in `deploy/gp-metricsd.awk:434-459` as a **bytes-per-second delta of
`/proc/net/dev`** against the default-route interface, with a "largest delta
wins" fallback.

The numbers are the same on this device; the **delivery** is what has to differ:

- QManager's poller cycle is **~3.7–4.0 s** (`scripts/usr/bin/qmanager_poller:33`),
  so routing the rate through `/tmp/qmanager_status.json` would refresh the row
  once every four seconds. A figure that changes once per four seconds is a stat,
  not a live reading.
- The sibling's stream (`gp-metrics-stream.service`, SSE on `:8092`) is **the
  vendor's port on this firmware** — [AGENTS.md](../../AGENTS.md) Hard rule 2
  forbids it — and busybox httpd on `:8080` cannot upgrade a connection at all.

**Goal:** a *Live Traffic* row directly above *Data Used*, showing download and
upload rates that update about once a second, switchable off — costing the device
very little when it is on and nothing at all when it is off.

## The transport decision, and the measurement that forced it

Three transports were measured on the live unit, 2026-10-24, 100 requests with
the client's own cost amortised out (one `curl` process, `-o /dev/null`), device
otherwise idle:

| Transport | CPU per read | forks per read | 1 Hz cost (one core) |
| --- | --- | --- | --- |
| CGI (`public/overview.sh`, jq-heavy) | **69.3 ms** | 7.44 | ~6.9 % |
| CGI, bare `cgi_base.sh` + printf (jq-free floor) | **16–26 ms** | 1.5–2.2 | ~2 % |
| **static file served by busybox httpd** | **9.0 ms** | 1.40 | **~0.9 %** |

The poller itself measures 6.3–7.8 % of the same single core
([`poller-cpu-profile.md`](./poller-cpu-profile.md) and re-measured today). A 1 Hz
CGI read is therefore **as expensive as the entire modem poller**, for two
integers. That killed the CGI design named in the first draft of this file.

A static read is ~13x cheaper than the cheapest possible CGI, but it still means
the *rate* must already exist as a file. So:

1. **One native sampler** (`native/qmanager_traffic`, Rust) writes
   `/tmp/qmanager_traffic.json` once a second.
2. `/usrdata/qmanager/www/live-traffic.json` is a **symlink** to it, so httpd
   serves the document statically and the 1 Hz write stays in tmpfs — writing it
   into the ubifs docroot would put ~130 MB/day of write amplification on flash
   to remember two integers.
3. The browser reads it once a second (static, no auth, no CGI).

Rust rather than a shell loop is the same argument one level down: a shell
`while :; do …; sleep 1; done` forks for `sleep` and (to make the write atomic)
again for `mv` — measured **2.4–5.0 ms per fork** on this unit, so ≈0.5 % of one
core forever. The Rust loop is one wakeup per second and no processes.

## In Scope

1. **`native/qmanager_traffic`** — a dependency-free Rust crate: reads
   `/proc/net/dev` and `/proc/uptime`, computes the delta against its previous
   sample, atomically replaces a one-line JSON document. Seven host tests
   (`cargo test`) cover the parse and the warming/rate/reset/gap state machine.
2. **The counter is the one the Data Used row already counts** — netdev name and
   rx/tx orientation are read at runtime from `data_used.json` (schema v5, see
   [`data-usage-counter.md`](./data-usage-counter.md)), so the rate and the total
   can never describe two different interfaces. Absent that file, the busiest
   `rmnet*` device is used.
3. **`deploy/qmanager-traffic.service`** — `Type=simple`, `Restart=always`, and
   an `ExecStartPre` that re-asserts the docroot symlink on every start. Added to
   `qm_boot_hook.sh`'s `UNITS`, so it starts at boot by the same mechanism as
   every other unit ([boot-timeline.md](./boot-timeline.md)).
4. **`hooks/use-live-traffic.ts`** — a 1 Hz reader shaped exactly like
   `hooks/use-detailed-metrics.ts`: a hidden tab reads nothing, only the newest
   response may land, nothing is written after unmount. 1 Hz is already the
   house cadence for a live surface (`use-detailed-metrics.ts:42`).
5. **The row** — a `PillRow` (Data Used's own row anatomy) above the Data Used
   pill, `arrow_circle_down` / `arrow_circle_up` in `--downlink-on-surface` /
   `--uplink-on-surface`, values through `formatBitsPerSec()` (which existed for
   exactly this and had no caller).
6. **The toggle** — a `Switch` in `CardHeader`'s `CardAction` slot (the slot
   `card.tsx` always reserved), persisted per browser in `localStorage` and read
   through `useSyncExternalStore` so the prerendered HTML and the client cannot
   disagree. Off means **zero requests**.
7. **i18n** — `metrics.live_traffic_*` in all five locales.
8. **Docs** — this spec, [`../reference/live-traffic.md`](../reference/live-traffic.md)
   plus its router row, and a dated plan carrying the benchmark table.

## Out of Scope (explicit, with reasoning)

- **A throughput chart or sparkline in the row.** The sibling's mini chart is
  126 px tall and needs a five-minute sample ring; this row is 40 px on a card
  whose skeleton geometry is mirrored 1:1, and DESIGN.md's Area-Fill Rule would
  additionally require a floored scale. A chart belongs on Signal History's
  surface, not inside a pill row.
- **WebSocket or SSE delivery.** busybox httpd cannot upgrade; a separate
  listener means a second process, a second port and a second auth story for a
  two-number payload, and the cheap port for it (`:8092`) belongs to the vendor.
- **Bytes *total*, peak rate, or rolling averages.** The cumulative total is the
  row directly beneath; a second total would be the same number twice.
- **Per-interface, per-client, or per-APN breakdown.** One aggregate counter,
  the one the counter already uses. `data-usage-counter.md` records why a fixed
  `rmnet_dataN` is wrong (the index migrates), and a breakdown multiplies that.
- **History persistence.** Nothing is stored beyond the previous sample in
  tmpfs. A reboot costs one `warming` tick — the same thing a fresh dashboard
  load shows.
- **Alerting on rate** (e.g. "download stopped"). `connection-watchdog.md` owns
  link health from an independent probe; a second opinion from a byte counter
  would disagree with it during hardware offload.
- **Auth on the document.** `/live-traffic.json` is served to anyone who can
  reach `:8080`. It carries two integers and an interface name — no addresses,
  no client data, no counters — and the whole static app is served the same way.
  Putting a session check in front of it means a CGI, which is the cost this
  design exists to avoid.
- **Leasing the sampler on client presence.** With a static document there is no
  server-side signal that anyone is watching, so the sampler always runs. At
  **0 jiffies per 60 s** measured, buying that signal would cost more than the
  sampling does.
- **Replacing the Data Used counter's source or cadence.** Schema v5 state on
  flash with its own migration history. Untouched.

## Requirements

### R1 — Document contract

`GET /live-traffic.json` → `application/json`, written once per tick:

```json
{"ok":true,"iface":"rmnet_ipa0","rx_bps":42130000,"tx_bps":3100000,"window_ms":1000,"warming":false,"counter_reset":false,"ts":1792803200}
```

- [x] `rx_bps` / `tx_bps` are JSON **numbers** in bits per second.
- [x] `iface` names the `/proc/net/dev` counter actually read.
- [x] `window_ms` is the real interval averaged over, not the requested one.
- [x] `warming` distinguishes "no rate yet" from "no traffic".
- [x] `counter_reset` distinguishes "the counter went backwards" from idleness.
- [x] `ts` lets a reader tell a stale document from a quiet link.
- [x] An unreadable counter emits `{"ok":false,"error":…,"detail":…}` — never a
      zero that reads as an idle link.

### R2 — Rate math and its guards

- [x] rate = `(counter_now − counter_prev) / dt`, both fields oriented by the
      poller's own `orientation`.
- [x] `dt < 150 ms` hands back the previous window's figure and does **not** move
      the anchor (so nothing is measured twice and no sub-window spike is drawn).
- [x] `dt > 10 s` is `warming` + a fresh anchor, never an average sold as live.
- [x] a counter that went backwards yields `counter_reset: true` and 0 rates.
- [x] no previous sample → `warming: true`, rates 0.
- [x] `dt` comes from `/proc/uptime` (monotonic), so the missing RTC cannot
      produce a spike or a zero divisor.

### R3 — Cost (measured, `docs/plans/2026-10-24-live-traffic-row.md`)

- [x] sampler: **0 jiffies over 60 s**, RSS **184 kB**, 1 thread, 0 processes
      spawned per tick.
- [x] file is written to tmpfs; the docroot holds a symlink (no flash writes).
- [x] row ON, 1 Hz: **~5.2 ms CPU and ~1.4 forks per read** (A/B: 39.38 % →
      45.91 % of one core at 75 reads/60 s), i.e. ≈0.5 % of one core at 1 Hz.
- [x] row OFF: **0 requests**, so 0 added cost.

### R4 — UI

- [x] the row renders **immediately above** the Data Used pill, and nowhere else.
- [x] direction inks already on the card + an arrow glyph each — colour is never
      the only channel (The Glyph-Carries-The-State Rule).
- [x] **bytes per second**, rendered as `formatBytes(bits / 8)` + `/s`, so the
      rate agrees with the byte-based Data Used total beneath it and with the
      sibling product (`v2/src/pages/Dashboard.svelte:80` renders
      `formatBytes(bytes) + '/s'`). The document keeps bits/s; the conversion is
      the renderer's single job. `0` renders `0 B/s`, never an empty cell.
      *This was wrong on the first deploy — the row showed Mbps while everything
      the owner compares against shows MB/s, i.e. 8x, and was reported as "wrong
      results".*
- [x] the switch lives in `CardHeader`'s `CardAction`: a control that only exists
      inside the row it hides cannot bring it back.
- [x] switch state survives a reload (per browser), and two tabs agree.
- [x] `MetricsSkeleton` mirrors four meters + four pills, so the card does not
      change height when data lands.
- [x] five locales, no hardcoded English.
- [x] verified in a browser at the three widths the trio actually uses, in dark
      and light, in all three states (rates / measuring / absent).

### R5 — Degradation

- [x] `warming` renders "Measuring…", never `0 bps`.
- [x] a 200 whose `ts` stops advancing for two reads is **stale** → the row shows
      `—` (a dead sampler must not look like a frozen link).
- [x] hidden tab: no requests; on return one read re-seeds the row.
- [x] sampler missing at boot → httpd 404 → row shows `—`, no crash, no retry storm.

## Acceptance criteria (pass/fail)

- [x] `curl http://127.0.0.1:8080/live-traffic.json` → `ok:true`, numeric rates,
      `window_ms` within ±20 % of 1000.
- [x] `iface` is the same netdev the Data Used counter selected (`rmnet_ipa0`,
      confirmed against `/usrdata/qmanager/data_used.json`), and the direction is
      confirmed independently: over a 10 s window WAN rx +19.2 MB matched
      bridge0 tx +19.4 MB.
- [x] toggle off → zero `/live-traffic.json` requests in the httpd log; on → ~1/s.
- [x] dashboard 200, `/setup` 200, vendor `http://127.0.0.1/` 200, all five
      qmanager units `active`.
- [x] benchmark table in the plan carries before/after fork rate, CPU share of
      one core, and RSS, with the conditions named.

## Edge cases (exercised at close-out)

| Edge case | How it was exercised | Observed |
| --- | --- | --- |
| First ever tick (no previous sample) | fresh start, `QMT_ONCE=1` | `warming:true`, both rates 0, `ok:true` |
| `dt` under 150 ms | host test, 50 ms step | previous window's figure returned, `window_ms` unchanged, anchor kept |
| Window gap > 10 s | host test, 17 s step | `warming:true`, anchor rebased, next tick measures normally |
| Counter reset (modem reboot) | host test, counter stepped backwards | `counter_reset:true`, rates 0, baseline rebased |
| `data_used.json` missing | host test | falls back to the busiest `rmnet*`, `iface` names it |
| No counter at all in `/proc/net/dev` | host test, rmnet lines removed | `ok:false` + detail, no crash |
| Reversed orientation | host test | the two columns swap |
| Sampler stopped while the row is open | `systemctl stop qmanager-traffic` in the dev harness | two identical `ts` → row drops to `—`, resumes on restart |
| Row switched off | clicked the switch in a browser | row unmounts, no requests, choice survives reload |
| `/tmp` cleared by reboot | reboot (see plan) | symlink dangles until the unit starts, then `warming` for one tick |
| A real file shipped in `public/` | a dev feed file was copied into `out/` and extracted over the symlink **twice**, once serving fabricated test values | `qm_pathfix.sh` now unconditionally `rm -f` + `ln -sfn`s the docroot entry, so every deploy ends in the right state; the unit's `ExecStartPre` heals it too |
| Unit mismatch (bits vs bytes) | compared the row with the product UI during the same transfer | 8x apart; row now renders bytes/s like the product |
