# 2026-11-05 — Detailed Metrics parity with the vendor `#metrics` page, and the History gaps

**Status:** phase 1 partially built (aggregation charts, 2026-11-05) · the three
decisions are **taken** (see "Decisions taken") · phases 2–4 not started.
**Owner's ask (verbatim):**

> "in the detailed metrics we should include all metrics shown at
> http://192.168.0.1/#metrics and the graphs as well according to the conventions
> we have for UI/UX.
> In history, we should have graphs for pci, there should be aggregation graph as
> well, like SNR,RSRP etc are being shown only for primary band I think, so we
> should have detailed information, WAN IP address, etc"

Reference: [`../reference/detailed-metrics.md`](../reference/detailed-metrics.md),
[`../reference/cell-history.md`](../reference/cell-history.md),
[`../reference/chart-time.md`](../reference/chart-time.md), and the earlier
[`detailed-metrics-parity.md`](./detailed-metrics-parity.md) (R1–R6, shipped).

## What the vendor page shows, and where each value comes from

Read out of `greenpacket-o5a/v2/src/pages/DetailedMetrics.svelte` (709 lines) and
`deploy/gp-metricsd.awk`.

| Vendor panel / field | Source on the device | Already archived per minute here? |
| --- | --- | --- |
| RSRP, RSRQ, RSSI, SINR/SNR per leg | AT + modemd | **yes** (`lte_*`, `nr_*`) |
| CQI, RI, PMI, MIMO layers, TM mode, DL/UL MCS | `AT+QNWCFG` + modemd | **yes** |
| Band, bandwidth, EARFCN/ARFCN, PCI, Cell ID, TAC | AT | **yes** |
| Carrier aggregation / EN-DC (PCell, role, #CC, total BW) | `AT+QCAINFO` | **yes** (`ca_cc`, `nrca_cc`, `bw_mhz`, `bands`) |
| SSB beams | `AT+QNWCFG="ssb_beam_id"` | **yes** (`phy.beams`, live only — not archived) |
| Registration / RRC state / RRC RAT / roaming | `AT+QNWCFG="rrc_state"`, modemd | partially (`registered`, `rat`); **RRC state is live-only** |
| **Pathloss** | vendor computes it | **no** |
| **TX power by channel** — PUSCH / PUCCH / SRS / PRACH | `AT+QNWCFG` per channel | **no** (only `nr_tx_power` aggregate) |
| **NR DL MCS / UL MCS** | `AT+QNWCFG="nr5g_ulMCS"` / `"nr5g_dlMCS"` | **yes** |
| **LTE DL MCS** | `AT+QNWCFG="lte_dlMCS"` | **no** (only `lte_ul_mcs`) |
| **Best RSRP** (max across carriers) | vendor derives it | **no** — needs per-carrier values |
| **Distributions / Trends** | vendor derives from history | charts exist; distribution panels exist here too |

**So the real gap is six fields, not sixty.** Everything else the vendor page
shows, this branch already reads and archives; the difference is presentation.

## What is missing on the QManager side, precisely

### A. Six unarchived fields (backend, `scripts/` only)

Each needs: a read in the poller's Tier 3 (or Tier 2), a column in
`QM_PHY_ARCHIVE_COLUMNS` (schema **v4**), and a name in the readers' `col[]`
map. The archive's schema marker makes that a mechanical change.

| Field | Read | Cost |
| --- | --- | --- |
| `lte_dl_mcs` | `AT+QNWCFG="lte_dlMCS"` — same compound as the existing `lte_ulMCS` | 0 extra AT calls |
| `nr_tx_pusch`, `nr_tx_pucch`, `nr_tx_srs`, `nr_tx_prach` | already in `QM_PHY_AT_NR`'s reply — the parser currently keeps only the aggregate | 0 extra AT calls, parser only |
| `pathloss` | derived: `nr_tx_power` − `nr_rsrp` is **not** path loss; the honest form needs the eNB/gNB reference power, which the modem does not publish. **Do not invent it** | ⚠️ decision |
| `rrc_state`, `rrc_rat` | already read in `qm_phy_at`; only `phy` (live) carries them | 0 extra AT calls, archive only |
| `nr_bwp` | `AT+QNWCFG="nr5g_bwp"` — **unverified on this firmware** | 1 probe |

⚠️ **Pathloss is the one item to decide.** The vendor displays it; on this
firmware there is no reference-power field, so any number we print would be
`tx_power − rsrp` dressed up as path loss, which is a different quantity (it
folds in the gNB's own transmit power, which varies per cell). Options:
(a) omit it, (b) label it "UL−DL level difference" and never call it pathloss,
(c) print the vendor's own formula and mark it derived. **Recommendation: (a) or
(b) — never (c) unlabelled**, per this repo's rule that a derived figure carries
a marker.

### B. Per-carrier series in History (backend + app layer)

> "SNR, RSRP etc are being shown only for primary band I think, so we should have
> detailed information"

Correct: the archive records **serving-cell** metrics only. An SCC's RSRP/SINR
never reaches a column, so History cannot plot it. To fix, the archive needs one
column per SCC *slot* — e.g. `cc1_band, cc1_rsrp, cc1_sinr, cc2_…` — which is a
schema change with a fixed slot budget (2 SCCs covers every combination observed
on this unit: `B3+N41+N41` was serving B3 + one n41 SCC + the serving n41).

⚠️ **Decision needed:** a fixed slot budget (simple, bounded, misses a 4-CC
surprise) or a JSON sidecar per row (flexible, but the CSV readers would need a
second format). **Recommendation: fixed slots, 2 LTE + 2 NR, and a
`scc_overflow` count** so a bigger aggregation is visible as a count rather than
silently truncated.

### C. History additions that need no backend work at all

These are already in the archive and are pure UI:

| Ask | Data already archived | Work |
| --- | --- | --- |
| PCI graph | `lte_pci`, `nr_pci` per row | new chart panel; the CGI already emits per-cell runs (`cells.stats`, `cells.timeline`) |
| Aggregation graph | `ca_cc`, `nrca_cc`, `bw_mhz`, `bands` | new chart panel (step, not line — a count is not continuous) |
| Band-combo timeline | `bands` | exists as `cells.combos` / `cells.band_runs`; needs a visual |
| WAN IP over time | **not archived** | needs a column (⚠️ it is not a subscriber identifier, but it *is* the owner's public address — see below) |

⚠️ **WAN IP is the one archival item with a privacy shape.** `AGENTS.md` hard rule
10 forbids committing subscriber identifiers, and `lib/radio-info.ts`'s clipboard
payload deliberately excludes the WAN address. Archiving it locally is a different
question (the owner's own router, their own file), but it should be a **decision,
not a default**: recommend archiving a *truncated* form (`10.9.x.x`) plus a change
counter, so "the WAN IP changed at 03:12" is answerable without storing the
address. Full value only if the owner asks for it.

## Decisions taken (owner: "do what you think is best")

1. **Pathloss: omitted.** This firmware publishes no reference-power field, so
   `tx_power − rsrp` is a different quantity (it folds in the gNB's own transmit
   power, which varies per cell). Same class of error as publishing RSSNR as
   SINR. If it is ever added it must be labelled "UL−DL level difference".
2. **SCC slots: fixed budget**, 2 LTE + 2 NR, plus an `scc_overflow` count so a
   larger aggregation is visible as a count rather than silently truncated. A
   JSON sidecar would fork the CSV readers for a case this unit has never shown.
3. **WAN IP: truncated + a change counter** (`10.9.x.x`, plus a `wan_changed`
   flag). It answers "the WAN IP changed at 03:12" without storing the address,
   which is consistent with hard rule 10 and with the diagnostics payload
   deliberately excluding it.

## Phasing

1. **No-backend phase** (C): aggregation panel **shipped 2026-11-05**
   (`components/cellular/history/aggregation-card.tsx`, `derive.ts` >
   `runStepPoints`/`comboCarriers`, panel id `agg`, five locales). Band-combo
   timeline already existed as `bands-card`.
   **PCI is NOT shipped as a chart, deliberately**: `timeline-card.tsx` is already
   the PCI-over-time view (a gantt of one contiguous run per serving cell, with
   the PCI in the tooltip), and a second PCI chart would restate it in a weaker
   form. If the owner wants PCI plotted *as a line alongside the metrics*, that is
   a different ask and needs an `lte_pci`/`nr_pci` **panel series** in the CGI
   (they are identity fields today, not series) — recorded as phase 2 work.
2. **Cheap backend phase** (A, the zero-extra-AT items): `lte_dl_mcs`, the four
   NR TX-power channels, `rrc_state`/`rrc_rat` into the archive → schema v4.
   Then their panels and charts.
3. **Per-carrier phase** (B): SCC slots in the archive, then per-carrier series
   in History. This is the largest item and the one that changes the file format.
4. **Pathloss**: decided, not built, until the owner picks (a)/(b)/(c).

### What the aggregation panel deliberately does NOT plot

The `bw`, `ca` and `total_cells` **panel series** are bucketed and averaged by the
CGI — a 15-minute bucket that straddles a carrier change reports "1.4 carriers" and
"29.1 MHz". An average is a fine statistic for a measurement and a nonsense one
for a count of discrete things. The panel is therefore built from `cells.bands`
**runs** (exact, one per contiguous carrier set) and drawn as steps.

`ca` is also not the carrier count: it maps to `ca_cc`, which counts LTE
**secondary** carriers only and reads 0 on this device's normal NSA link (one LTE
PCC + one NR SCC). The count plotted is the token count of the run's combo
("B3+N41" → 2).

## Acceptance criteria (falsifiable)

- [ ] Every field the vendor's `#metrics` page displays is either shown by
      Detailed Metrics **or** listed in Out of Scope here with a reason.
- [ ] A new archive column appears in `QM_PHY_ARCHIVE_COLUMNS` **and** in every
      reader's `col[]` map, and a day file written before the bump still parses
      (the readers guard on field count — prove it with a real pre-bump file).
- [ ] Every added chart uses `ChartTooltipTime` and names its series (`name=`);
      a hover never shows a dataKey again.
- [ ] Aggregation is plotted as a step, never a line: a carrier count is not a
      continuous quantity, and a sloped line between 1 and 2 CC invents values.
- [ ] No derived figure is printed without its marker (pathloss, distance, SCS).
- [ ] Before/after CPU for the added reads, per `AGENTS.md` rule 1a. The
      zero-extra-AT items must show **no measurable change**; if one does, it is
      not zero-extra-AT.

## Out of scope, with reasoning

- **Re-deriving the vendor's exact layout.** Its page is a single scrolling
  column of cards tuned for a desktop browser; this branch's convention is
  grouped cards with one cadence each (see `docs/reference/detailed-metrics.md`).
  Parity of *information*, not of composition.
- **Pathloss, until decided** — see above. Printing `tx_power − rsrp` as
  "pathloss" would be the same class of error as publishing RSSNR as SINR
  (`docs/plans/2026-11-05-signal-metric-provenance.md`).
- **Storing the full WAN IP by default** — see above.
- **Per-carrier history for more than 4 slots** — bounded on purpose; the
  overflow count keeps it honest.
