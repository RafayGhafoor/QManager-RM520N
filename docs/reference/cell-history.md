# Cell History

> **Applies to:** RG520N-EB on the GreenPacket O5A Pro (SDX6X) · built 2026-10-23, **unmeasured on device**
> **RM520N-GL / RG501Q-EU:** unverified — the archive and the CGI are device-independent, but the
> identity fields depend on `AT+QENG` parsing that already differs per module
> ([`platform-matrix.md`](./platform-matrix.md)). Re-probe before trusting the bands.
> **Spec:** [`docs/specs/cell-history.md`](../specs/cell-history.md) · **Plan:** [`docs/plans/2026-10-23-cell-history.md`](../plans/2026-10-23-cell-history.md)

> The serving-cell, band and 5G-availability record: what answered *"5G disappeared at
> night, sometimes band 1"*. It is the archive half of greenpacket's History page,
> rendered on this app's design language.

---

## What it answers, and what it cannot

| Question | Answered from |
| --- | --- |
| When was 5G down, and for how long? | `cells.availability[]`, `cells.outages[]` |
| Which serving cell and band was in use when it dropped? | `cells.timeline[]`, `cells.events[]` |
| Is it a nightly pattern? | The frontend's day × hour matrix over `cells.availability[]` |
| Which cell is bad to camp on? | `cells.stats[].nr_down / nr_known` |
| What did the signal look like either side of it? | `series.{rsrp,sinr,rsrq,rssi,…}` |

It cannot say *why*. A 5G drop has at least four causes on this device — the network
releasing the NR leg in NSA, a band-preference change, the modem re-selecting onto a
cell with no NR neighbour, or a thermal/keepalive-driven reconnect. The page records
which of those is visible in the identity columns (a band change and a PCI change are
visible; a network-side release is not) and never asserts a cause.

## Three sources, one archive

```
qmanager_poller (Tier 3, every 15 cycles ≈ 75 s)
  ├── ubus modemd status ─┐
  └── AT via qcmd         ┴─► qm_phy_snapshot ──► /tmp/qmanager_status.json `.phy`
                             │
                             └─► qm_phy_archive_row ──► /usrdata/qmanager/metrics/YYYY-MM-DD.csv
                                                          (schema v2, one row a minute, 30-day retention)

GET …/fetch_signal_history.sh?view=cells&range=<r>
  └── ONE awk pass over the day files ──► prefixed TSV ──► jq assembles the response
```

**`/tmp/qmanager_status.json` is not the history.** It is the poller's live cache: tmpfs,
regenerated on poller start, and it holds only the newest sample. The durable record is
the CSV. A page that read the cache for "what happened at 03:00" would answer with
whatever is true now.

## Archive schema v2

`#qm_phy_archive,3,ts,<20 PHY columns>,temp,total_cells,rat,registered,lte_pci,lte_earfcn,lte_band,lte_bw,lte_cellid,lte_tac,nr_pci,nr_arfcn,nr_band,nr_bw,nr_cellid,nr_tac,nr_avail,cpu_pct,mem_pct,dl_bps,ul_bps,ca_cc,nrca_cc,bw_mhz,bands`

- **Line 1 carries the column names**, and every reader resolves columns **by name** from
  that marker. That is what makes a v1 day file still readable, and what stops a column
  added later from silently shifting a reader.
- **Append, never insert.** A new column goes on the end of the marker and the end of the
  row.
- **An absent reading is an EMPTY field**, never `0` and never the string `null`. A `0`
  dBm RSRP, a `0` MCS index and a `0` dBm TX power are all real readings.
- **`nr_avail` is three-valued**: `1` an NR serving cell was reported, `0` the modem was
  read and reported no NR leg, empty nobody looked. The distinction is the whole point —
  "we did not look" and "5G is gone" are opposite claims and only one is a fault. An
  empty value never opens or closes an outage span and is never counted in an
  availability denominator.
- **A row is only written when Tier 3 produced something.** `poll_tier3` returns before
  archiving when both the modemd and AT reads were empty, and skips entirely while
  `/tmp/qmanager_long_running` exists (a scan owns the AT port). So real deltas are
  60–90 s and there are genuine holes. **Never assume a clean 60 s grid.** Measured on
  this unit: 993 rows on 2026-10-22 and 1059 on 2026-10-23, i.e. one row per ~75 s, not
  1440 a day.
- **Band values arrive display-ready.** `lte_band` is `"B3"` and `nr_band` is `"N78"`,
  prefix included, because `parse_serving_cell` adds it (`lband = "B" f(10)`). Nothing
  downstream may prefix again — `"B" + band` renders `BB3`. An empty band is an empty
  field, never a bare `"B"`.
- **`bands` is the COMBO, and it is the column that answers "which band went away".**
  `"B3+B1+N78"`, `+`-joined with no comma and no space (it is a CSV field), built from
  the CA component list and falling back to the two serving bands when that list is
  empty. A serving-band column alone cannot show the loss of an aggregated carrier,
  because the PCC does not change when an SCC goes.
- **`ca_cc` of `0` is a reading, not a gap**: no carrier aggregation. The reader keeps
  it (only `bands`-run and combo counting null a missing value), which is why the UI
  can say "no aggregation" instead of "not reported". A day file's header is never
  rewritten, so after a schema bump the current day's file keeps its old header until
  the next UTC day; **at deploy time move the live day file aside**
  (`mv 2026-10-24.csv 2026-10-24.csv.v2`) or the new rows are dropped by the
  field-count guard.
- **Deploy order matters.** Ship the files, then run `deploy/qm_pathfix.sh`, then
  restart. Shipping after the pathfix leaves `/usr/lib/qmanager` paths in the deployed
  copies and the poller dies with `203/EXEC` / exit 1.
- Size, **measured 2026-10-23 on this unit**: 74.5 B per v1 row (156 KB across 2093 rows),
  i.e. ≈107 KB/day and ≈3.2 MB at the 30-day retention. Most PHY columns are empty
  whenever the NR leg is inactive, which is why the row is smaller than the column count
  suggests. `/usrdata` had 49.7 MB free of 182.9 MB. v2 rows carry 19 more columns; the
  after-figure is in the spec's benchmark table once the deploy is measured.
  `QM_PHY_ARCHIVE_KEEP_DAYS` is the retention lever if that headroom ever shrinks.
- Failure policy is unchanged from v1: one `qlog_warn`, then the archive disables itself
  for the run. No retry loop — the failure it guards (a full or read-only `/usrdata`) is
  not fixed by trying again a minute later.

## `?view=cells`

| Query | Behaviour |
| --- | --- |
| no query string | The dashboard's NDJSON array, byte-identical to before |
| `?range=<r>` | The detailed-metrics contract, unchanged (no new keys) |
| `?range=<r>&view=cells` | The cell-history contract — `view`, `window`, `coverage`, `cells` added |
| `?range=now&view=cells` | Snapshot only; `series: {}` and empty `cells` (the page never asks) |
| `?panels=<csv>` | Narrows the series vocabulary; unknown ids are ignored, not fatal |

Ranges: `1h 3h 6h 12h 24h 7d 30d 90d` (+ `now`). The page offers seven of them.
The **window ends at the newest archived row, clamped to now** — never at the wall clock,
so an archive that stopped updating shows its last window instead of an empty chart.

### The derived shapes, and why each is the shape it is

| Field | Rule | Why it is not the obvious alternative |
| --- | --- | --- |
| `availability[].n / up` | `n` counts samples where availability was **determined**, `up` the ones with an NR leg. A bucket with `n: 0` is still emitted | Scoring an unknown as "down" would invent outages on every logger restart |
| `outages[]` | Contiguous `nr_avail == 0` runs, **cut at the 3-minute gap threshold** | Without the cut, a logger outage that happened to start on an `nr_avail=0` sample paints hours of solid red over no data at all |
| `events[]` | Each sample compared against the **last known** value of each field, not the previous row | NR identity columns go null while detached, so a pairwise diff misses the common "NR dropped and came back on a different PCI" case entirely |
| `events[]` grouping | One row per instant with a `changes` array | A handover changes PCI and Cell ID at the same tick; listing them separately doubles the table for no information |
| `stats[]` | Per LTE PCI: samples, `nr_down`, `nr_known` | The raw event list is dominated by noise (PCI and Cell ID always change together, and a night of ping-pong produces dozens of rows). Time-on-cell against availability is what answers "is this cell hurting me" |
| `timeline[]` | Contiguous runs of one serving cell; ends at a PCI/band change or a gap | The gantt strip. One row per cell, not per sample |
| `bands[]` | Contiguous runs of one **band/CA combo**, keyed on the combo string alone | A different segmentation from `timeline[]` on purpose: an aggregated carrier can come and go while the serving cell stays put, and that is the change worth a segment |
| `combos[]` | Per-combo time share, most samples first, `ca_cc: 0` preserved | `ca_cc: 0` is a real reading (no aggregation); nulling it would read as "not reported" |
| `coverage.cell_from` | First timestamp in the window carrying any identity column | A pre-v2 day file has PHY data and no identity. The page must say *when* identity coverage starts rather than render "no cell changes" over time it could not see |

The 3-minute threshold exists because the writer is not a metronome (see above). It is
wide enough to absorb 60–90 s jitter, narrow enough that a genuine absence is never
bridged. The client carries the same constant (`GAP_THRESHOLD_SECONDS` in
`types/cell-history.ts`) for the shapes it derives itself, and the backend does not
import it — the number is duplicated **on purpose**, because a single source would mean a
CGI sourcing a TypeScript module.

Everything is derived in **one awk pass** over the day files, in the same program that
produces the panel series, and jq only shapes the few thousand aggregated TSV lines. jq
over 43k raw rows is the slow path on one core
([`sites-monitor.md`](./sites-monitor.md) measures 3.3 s for a comparable row count).

## The page

`/cellular/history`, one range pill, seven panels behind a picker (visibility in
`localStorage`), and the availability hero which is **not** toggleable — it is the
page's spine.

| Panel | Reads | Default |
| --- | --- | --- |
| 5G availability (hero) | `cells.availability`, `cells.outages` | always |
| Nightly pattern | `cells.availability`, bucketed into local day × hour | on |
| Serving cell | `cells.timeline` | on |
| Radio signal | `series.{rsrp,sinr,rsrq,rssi}` | on |
| Bands & CA | `cells.bands`, `cells.combos`, `series.{ca,bw}` | on |
| Cell events | `cells.stats`, `cells.events` | on |
| PHY depth | `series.{cqi,rank,mcs,tx_power}` | off |
| Device load | `series.{temp,cpu,mem,dl,ul}` | off |
| 5G outages | `cells.outages` | off |

**No live band.** `latency-monitor.md:74` records that shape being shipped and reverted
because it disagreed with the cards below it. The dashboard is the live surface; this
page reads a range. `snapshot` is served so the identity card can say "as of
&lt;newest sample&gt;", never as a second chart.

A **legend** sits under the controls and is not decoration: it states the four
availability tiers, the two series colours, the band swatches (imported from the same
colour function the bands panel uses, so the two cannot drift) and the rule that a break
in a line is a missing reading rather than a zero.

Charts obey the standing rules: `connectNulls={false}` (a break is a bucket with no
reading, never a zero), `isAnimationActive={false}` (a 30 s retarget must not replay an
entrance), recharts behind `next/dynamic` so the chart stack is not in the first paint.

The per-cell callout has greenpacket's floor: a cell is only named as a problem when it
has **≥ 3 determined samples and ≥ 80 % down**. Below that the device merely brushed
past it, and branding it would be a verdict, not a measurement.

## Verifying a change here

```bash
# frontend
bunx tsc --noEmit && bun run i18n:check && bun run build

# on the device, after shipping lib + poller + cgi and re-running qm_pathfix.sh:
head -1 /usrdata/qmanager/metrics/$(date -u +%F).csv    # #qm_phy_archive,2,...
tail -1 /usrdata/qmanager/metrics/$(date -u +%F).csv    # 42 comma-separated fields
SID=$(sh -c '. /usrdata/qmanager/lib/cgi_auth.sh; qm_create_session')
curl -s -H "Cookie: qm_session=$SID" \
  'http://127.0.0.1:8080/cgi-bin/quecmanager/at_cmd/fetch_signal_history.sh?view=cells&range=24h' \
  | jq '{window, coverage, outages: (.cells.outages|length), events: (.cells.events|length)}'
```

A pre-v2 day file must still render its PHY series with `coverage.cell_from: null` — that
is the backward-compatibility check, and it is the one an eager schema bump breaks.

## Deliberately not included

From the spec's out-of-scope list — do not re-add without a decision:

- Interval data usage (greenpacket's `traffic-history`); throughput *rate* is here, a
  per-interval usage store is its own subsystem.
- Neighbour-cell history (QMI cannot provide NR neighbours; `AT+QENG` returns nothing on
  this firmware — see [`cell-scanner.md`](./cell-scanner.md)). Serving cell only.
- Backfill of pre-v2 rows, CSV export, a custom-minutes range, and any per-cell
  "good/bad" verdict.
