# SPEC: Cell History — serving-cell, band and 5G-availability history

**Status:** **Proposed 2026-10-23** — needs the owner's authorisation for the app-layer
half (route, components, hook, types, locales, one sidebar entry). The backend half
(poller archive columns + one CGI view) is deployment-layer and in scope for this
branch already.

**Background.** The reference product's History page (greenpacket, `v2/src/pages/History.svelte`)
has been carrying per-minute RF, cell-identity and NR-availability history since
2026-07-28. This branch shipped the *archive* half of that in
[`detailed-metrics-parity.md`](./detailed-metrics-parity.md) — `qm_phy_archive_row`
writes `/usrdata/qmanager/metrics/YYYY-MM-DD.csv` at one row a minute with 30-day
retention — and the page half as `/cellular/detailed-metrics`. That spec closed by
naming the one parity gap it deliberately left open:

> *"cell-change events as History panels … Adding that event panel is the one parity
> gap worth a follow-up spec."* — [`docs/reference/detailed-metrics.md`](../reference/detailed-metrics.md)

**Why now.** The concrete field complaint this page exists to answer:

> *"5G cell gets disappeared at night, sometimes band 1, so we should be able to know."*

None of the current surfaces can answer it. The dashboard shows *now*. Detailed
Metrics shows a range but only PHY numbers — it has no cell identity, no band over
time, and no 5G-availability series at all. Nothing on this device records **which
cell was serving, on which band, and whether 5G was up at 03:00**.

**Goal.** One page at `/cellular/history` that answers, for a selectable range:
*when* 5G was unavailable, *on which serving cell and band* that happened, and what
the radio looked like either side of it — from the archive the poller already writes.

## Conventions this spec is bound by

| Convention | Precedent |
| --- | --- |
| **Extend an existing endpoint; do not add a CGI file** | `docs/specs/system-health-card.md` In Scope 1; one archive reader keeps one column→JSON mapping |
| **The CGI serves more ranges than the pill offers** | `sites.sh:6` vs `sites-card.tsx:48`; `detailed-metrics.md` = 9 served, 4 offered |
| **No separate live band on a history surface** | [`latency-monitor.md`](../reference/latency-monitor.md):74 — shipped, then reverted because it disagreed with the cards below it |
| **The window ends at the newest archived row, not the wall clock** | `latency-monitor.md`:64 |
| **A gap is a gap** — `connectNulls={false}`, never `0` for a missing sample | `latency-monitor.md`:65; `trend-chart.tsx` header |
| **An absent reading is `null`, never `0`** | [`types/detailed-metrics.ts`](../../types/detailed-metrics.ts) header |
| **Only the newest fetch may land**; `dataRange` lags `range` | `latency-monitor.md`:89,`:99`; `hooks/use-detailed-metrics.ts` |
| **No new chart library, no new motion** | `DESIGN.md`; [`dashboard-chart-cards.md`](../reference/dashboard-chart-cards.md) |
| **Signal quality is never hue-only** | `components/dashboard/signal-status-card.tsx:42-66` |

## In Scope

1. **Archive schema v2 (`qm_phy_archive,2`).** Append 19 columns to the existing
   23: serving-cell identity for both RATs, `nr_avail`, `registered`, `rat`,
   `cpu_pct`, `mem_pct`, `dl_bps`, `ul_bps`. Appended, never inserted — the schema
   marker is why a reader resolves columns by name
   (`phy_metrics.sh:QM_PHY_ARCHIVE_COLUMNS`).
1a. **Archive schema v3 (`qm_phy_archive,3`)** — 4 more columns from the CA component
   list the Tier-2 read already builds: `ca_cc`, `nrca_cc`, `bw_mhz`, `bands` (the
   combo actually in use, `"B3+B1+N78"`). Bands alone cannot answer *"which band went
   away"*: losing an aggregated carrier changes the combo without changing the serving
   cell, so the combo is the fact that has to be stored.
2. **One new view on `at_cmd/fetch_signal_history.sh`**: `?view=cells&range=<range>`.
   No new CGI file, no second CSV reader, no new systemd unit, no new daemon.
3. **Page `/cellular/history`** with the panels listed in §Response contract, plus a
   **Bands & carrier aggregation** panel (band/CA runs and a per-combo time-share
   table) and a **page legend** — the availability tiers, the two series colours, the
   band swatches and the "a break is not a zero" note, in one place.
4. **i18n parity** for `history.*` keys in all five bundled locales.
5. **One sidebar entry** under Cellular (`history`, glyph `timeline`).

## Out of Scope, and why

- **A separate live/now band.** Reverted once already
  (`latency-monitor.md`:74): a live strip above a range chart disagrees with it the
  moment the range's last bucket is more than a minute old. The page reads a range;
  the dashboard is the live surface. `snapshot` is served so the *identity card* can
  say "as of the newest sample", never as a second chart.
- **Interval data usage (greenpacket's `traffic-history`).** Its own subsystem with
  its own sparse-interval semantics, and this device's counter is cumulative
  (`data_used.json`, schema v5). Throughput *rate* is in scope because the poller
  already computes the byte delta; a per-interval usage store is not.
- **CSV export.** No surface needs it, and a download endpoint is a new auth surface.
- **Neighbour-cell history.** QMI cannot provide NR neighbours and `AT+QENG` returns
  nothing here ([`cell-scanner.md`](../reference/cell-scanner.md)); the scanner keeps
  its own ledger. This page tracks the **serving** cell only.
- **Backfill of pre-v2 rows.** Rows written before this ships have no identity
  columns. The page states the coverage start rather than drawing "no cell changes"
  over time it could not see (greenpacket's `partialCellData` note, kept).
- **A custom-minutes range input.** Bucket widths are chosen per named range;
  a custom span would need a bucket heuristic no surface asks for, and greenpacket's
  version needed a "same chart, shorter range" apology note because of it.
- **Per-cell scoring or a "good cell / bad cell" verdict.** The rollup reports
  time-on-cell against 5G availability, which is a measurement. A verdict is an
  opinion the device cannot back.
- **New motion.** No draw-in on these charts: they retarget on a 30 s poll, and
  `docs/reference/motion-preference.md` records why a replaying entrance is worse
  than none.

## Requirements (falsifiable)

- [ ] **R1 — Archive v2.** After the first Tier-3 pass following deploy,
  `head -1 /usrdata/qmanager/metrics/<today>.csv` reads
  `#qm_phy_archive,2,<42 names>` and `tail -1` has exactly 42 comma-separated fields.
  A v1 file already on the device is still readable by the trend reader (it resolves
  by name and treats missing names as absent), and the cells view reports
  `coverage.cell_from = null` for it rather than inventing identity data.
- [ ] **R2 — No new fork on the poller tick path.** `qm_phy_archive_row` keeps
  exactly one `jq` invocation; the identity values ride in the `ctx` object
  `poll_tier3` already builds. Verified by counting `jq` execs per archive write
  before/after (expect 1 → 1).
- [ ] **R3 — `view=cells` contract.** `GET …?view=cells&range=24h` returns the shape
  in §Response contract with every documented key present, on an empty archive too
  (`series:{}`, `cells` with empty arrays, `missing` naming requested panels).
- [ ] **R4 — The no-query form is byte-identical** to before this change
  (`serve_ndjson_as_array` on `/tmp/qmanager_signal_history.json`), and
  `?range=1h` without `view` is byte-compatible with the detailed-metrics page's
  contract. Proved by diffing a saved response from `main` against the new build.
- [ ] **R5 — Three-valued `nr_avail`.** `1` = an NR serving cell was reported this
  sample; `0` = the modem was read and reported no NR leg; `null` = no read (AT and
  modemd both silent, or a pre-v2 row). A null never opens and never closes an
  outage span, and is never counted in the availability denominator.
- [ ] **R6 — Window honesty.** `window.end` equals the newest archived row's
  timestamp (clamped to now), never the wall clock; `window.samples` is the number of
  samples inside the window after the identity/PHY filters.
- [ ] **R7 — Every absence is `null`.** No field is `0` because it was missing: a
  `0` RSRP, a `0` MCS and a `0` dBm are all real readings. Verified by a window whose
  rows have empty PHY fields.
- [ ] **R8 — Gap honesty in the UI.** Each RF/PHY chart uses `connectNulls={false}`
  and the CGI emits a bucket with `v:null` (rather than omitting it) only where a
  bucket exists but held no reading.
- [ ] **R9 — i18n.** `bun run i18n:check` passes with `history.*` present in
  `en/id/it/zh-CN/zh-TW`.
- [ ] **R10 — Cold build.** `bunx tsc --noEmit && bun run build` passes; recharts is
  loaded through `next/dynamic` so the chart stack is not in the first paint.
- [ ] **R12 — Bands and CA combos are first-class.** The archive stores the combo in
  use per sample, `?view=cells` returns `cells.bands[]` (combo runs) and
  `cells.combos[]` (time share), and the page renders both. A window that predates the
  combo column reports no combos rather than one "unknown" combo.
- [ ] **R13 — Every colour has a key on the page.** A legend states the availability
  tiers, the series colours, the band swatches and the gap rule; it imports the same
  colour function the panels use, so the legend cannot drift from the marks.
- [ ] **R14 — Measured on the unit.** The before/after pairs come from the same harness
  on the same unit, one core, with the load average recorded beside them; where a delta
  is inside run-to-run variance that is stated instead of claimed as a win.
## Response contract — `GET /cgi-bin/quecmanager/at_cmd/fetch_signal_history.sh?view=cells&range=<range>`

```
                     no query        view absent (today's)      view=cells
shape                NDJSON array    {snapshot,series,missing}  {…, cells:{…}}
```

```jsonc
{
  "success": true,
  "view": "cells",
  "range": "24h",
  "generated_at": 1792616143,
  "bucket_sec": 900,
  "window": { "start": 1792529743, "end": 1792616000, "samples": 287,
              "first_ts": 1792530000, "last_ts": 1792616000 },
  "coverage": { "cell_from": 1792600000 },   // first sample carrying identity; null if none
  "snapshot": { /* identical to the detailed-metrics snapshot, plus: */
    "cell": { "lte_pci": 123, "lte_earfcn": 1650, "lte_band": "3", "lte_bw": 20,
              "lte_cellid": 12345, "lte_tac": 4321,
              "nr_pci": 201, "nr_arfcn": 632448, "nr_band": "78", "nr_bw": 100,
              "nr_cellid": null, "nr_tac": null,
              "network_type": "5G-NSA", "registered": true, "nr_avail": 1 }
  },
  "series": { "rsrp": [{"ts": 1792530000, "v": -67}], "sinr": [], "…": [] },
  "missing": ["rssi"],
  "cells": {
    "availability": [ { "ts": 1792530000, "n": 60, "up": 60 } ],  // buckets of ≤3600 s
    "availability_sec": 900,
    "outages": [ { "start_ts": 1792570000, "end_ts": 1792573600, "samples": 40 } ],
    "events": [ { "ts": 1792600000,
                  "changes": [ {"field": "nr_avail", "from": "1", "to": "0"},
                               {"field": "lte_pci",  "from": "123", "to": "342"} ] } ],
    "stats": [ { "key": "342", "lte_pci": "342", "lte_band": "3", "lte_cellid": "12345",
                 "samples": 120, "nr_down": 110, "nr_known": 120,
                 "first_ts": 1792570000, "last_ts": 1792600000 } ],
    "timeline": [ { "start_ts": 1792570000, "end_ts": 1792600000, "samples": 120,
                    "lte_pci": "342", "lte_band": "B3", "nr_band": "N78",
                    "nr_avail_pct": 8 } ],
    "bands":  [ { "start_ts": 1792570000, "end_ts": 1792600000, "samples": 120,
                  "bands": "B3+B1+N78", "ca_cc": 1, "bw_mhz": 40 } ],
    "combos": [ { "bands": "B3", "samples": 900, "first_ts": 1792530000,
                  "last_ts": 1792590000, "ca_cc": 0, "bw_mhz": 20 } ]
  }
}
```

Rules the shape encodes, all of them load-bearing:

- `availability[].n` is the number of samples in the bucket where NR availability
  was **determined**; `up` is how many of those had the NR leg. A bucket with
  `n == 0` is emitted with `n: 0` (the bucket existed, nothing was determined) so the
  UI can draw "no data" rather than a gap in the strip.
- `outages[]` are contiguous stretches of `nr_avail == 0`, cut at the same
  3-minute gap threshold the charts use for line breaks
  (`GAP_THRESHOLD_SECONDS` in greenpacket's History): a logger outage must never
  paint an NR outage.
- `events[]` compare each sample against the **last known** value of each identity
  field, not the previous row — NR identity columns go null while NR is detached, so
  a pairwise diff misses the "NR dropped and came back on a different PCI" case.
  Newest first.
- `stats[].key` is the PCI (the field an operator recognises); `nr_down / nr_known` is
  the availability ratio *on that cell*.
- `timeline[]` are contiguous runs of one serving cell — the gantt strip. A run ends
  at a PCI/band change or at a gap.
- `timeline[]` are contiguous runs of one serving cell — the gantt strip. A run ends
  at a PCI/band change or at a gap.
- `bands[]` are contiguous runs of one **band/CA combo**, keyed on the combo string
  alone. This is a different segmentation from `timeline[]` on purpose: a serving cell
  can stay put while an aggregated carrier comes or goes, and that is the change the
  owner asked about. A row that named no combo (every pre-v3 row) contributes nothing,
  so a window straddling the schema bump does not invent a "no bands" period.
- `combos[]` is the per-combo time share, most samples first. `ca_cc: 0` is a real
  reading (no carrier aggregation) and is deliberately NOT nulled the way an absent
  count is.
- `lte_band`/`nr_band`/`bands` are display-ready strings **with their RAT prefix already
  on** — `"B3"`, `"N78"`, `"B3+B1+N78"` — exactly as `/tmp/qmanager_status.json` holds
  them, because `parse_serving_cell` does `lband = "B" f(10)` / `nband = "N" f(9)`
  itself. Neither the backend nor the UI may add a prefix; `"B" + band` renders `BB3`.
  An empty band is `null`, never a bare `"B"`. Never parsed to numbers.

## Benchmark table (RULE 1 / 1a)

**Before** captured on the live unit (`ssh greenpacket`) 2026-10-23 00:51–00:56 UTC, one
core, load average 3.2–3.7, poller PID 9985, 2 h 47 m uptime. Method is
[`docs/reference/poller-cpu-profile.md`](../reference/poller-cpu-profile.md): CPU is
`stat` fields 16+17 (cutime+cstime, i.e. **including reaped children**) over a 120 s
window; forks are the `/proc/stat` `processes` counter over the same window.

| Metric | Before (measured) | After (measured) | Delta | Conditions |
| --- | --- | --- | --- | --- |
| Poller CPU, incl. children | 885 jiffies / 120 s = **7.4 % of one core** | 820 jiffies / 120 s = **5.7 %** | -1.7 pp, **not attributable** | before at load 3.71, after at 3.05 |
| Whole-box forks | 6874 / 120 s = **57.3 /s** | 5318 / 120 s = **44.3 /s** | -13 /s, **not attributable** | same caveat; the change adds no fork |
| Poller RSS | **2200 kB** | **2624 kB** | **+424 kB** | the added locals plus the second jq output line |
| Device memory headroom | 50 744 kB | 52 472 kB available | +1 728 kB | `MemAvailable`, differing load |
| Archive bytes per row | 74.5 B (v1, 2093 rows) | **~139 B** (v3: 549 B file - 409 B header) | **+64 B** | schema v1 -> v3 |
| Archive at 30-day retention | ~107 KB/day = ~3.2 MB | ~153 KB/day = **~4.6 MB** | +1.4 MB | ~1100 rows/day; `/usrdata` had 49.7 MB free |
| `?range=1h` (series only) | 0.243 s / 28 605 B | 0.196 s / 1 539 B | unchanged code path | bytes fell because the rotated day files sit outside a 1 h window |
| `?range=24h` (series only) | 0.819 s | 0.73-1.10 s over 3 runs | **within variance** | same unit, load 3.0-3.7 |
| `?range=30d` (series only) | 1.043 s | 1.112 s | +0.07 s | same |
| `?view=cells&range=24h` | - | **1.46-1.62 s** | new | 3 runs, ~0.45 s over the series-only path |
| `?view=cells&range=30d` | - | **2.58 s** | new | the awk pass dominates; still one request |

**Read the CPU and fork rows carefully.** They moved in the *better* direction and the
change cannot plausibly cause that: it adds one jq field expansion and some shell
arithmetic per minute. The two runs were taken at different load averages (3.71 before,
3.05 after) on a single-core box that also serves the vendor UI, so the honest claim is
**no measurable regression**, not an improvement. `AGENTS.md` rule 1a warns about exactly
this mix; the comparison that *isolates* the change is per archive write, and it is 1 jq
exec before, 1 after.

Two corrections to what this spec first estimated from arithmetic alone:

- **Real row size is 74.5 B for v1, not 170 B**, because most PHY columns are empty on
  this modem (`nr_*` is empty whenever the NR leg is inactive). v3 measures ~139 B.
- **A day holds ~1100 rows, not 1440**, because Tier 3 fires every 15 cycles at
  `POLL_PERIOD=5` (75 s) and skips entirely during a scan. Any reader that assumes a
  clean 60 s grid is wrong, which is why the gap threshold is 3 minutes.


## Edge cases

Exercised at close-out per `AGENTS.md` ("Measure it, then prove the edges"); the
data-loss rows are checked before merge.

| Edge case | How it would be exercised | Expected |
| --- | --- | --- |
| Empty archive (fresh install) | point `QM_PHY_ARCHIVE_DIR` at an empty dir | `series:{}`, `cells` arrays empty, `coverage.cell_from:null`, page shows "no history yet for this range" |
| Pre-v2 day file only | a fixture with the v1 marker | trend series intact, `coverage.cell_from:null`, events empty, page states identity coverage starts when it starts |
| Torn final CSV line | append half a row | row dropped by the `nf != ncol` guard; no crash |
| QMI/AT silent for an hour | stop the poller for an hour | 3-min gap threshold breaks the lines and the outage spans; no red band over the gap |
| NR back on a different PCI | fixture where `nr_pci` goes `201 → null → 305` | one event pair, not none (last-known-value diff) |
| Clock at 1970 (no RTC) | boot with WAN down before NTP | sane-epoch gate keeps `range=now` honest; no archive read attempted |
| CGI unauthenticated | request without a session cookie | 401 from `cgi_auth`, page shows the standard auth failure |
| Very long range on a slow device | `range=30d` | < 360 points per series (bucket 7200 s), page stays responsive |

## Why the app layer is in scope

The owner's ask is a *page*. A history panel cannot be delivered by a backend
response alone — the rendering, the range pill, the panel picker and the availability
strip are all components. This is the same criterion recorded for the four existing
exceptions in `AGENTS.md`, and it will be recorded there as exception 7 with this
spec as its authorisation.
