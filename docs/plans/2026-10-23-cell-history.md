# Cell History — when 5G dropped, and on which cell

> **Created:** 2026-10-23 · **Status:** built and measured on the unit (before/after below)
> **Device:** GreenPacket O5A Pro — Quectel RG520N-EB, SDX6X `sdxlemur`, reachable as
> `ssh greenpacket`
> **Spec:** [`docs/specs/cell-history.md`](../specs/cell-history.md) · **Reference:** [`docs/reference/cell-history.md`](../reference/cell-history.md)
> **Branch exception:** `AGENTS.md` → recorded exception 7

## What was asked

> *"5G cell gets disappeared at night, sometimes band 1 so we should be able to know.
> You can improve the information, graphs, however you like, it should have nice UX."*

The reference product (`greenpacket-o5a`, `v2/src/pages/History.svelte`) has carried
per-minute cell-identity and NR-availability history since 2026-07-28. This branch
shipped only the PHY half of that archive and closed its spec by naming the gap:

> *"Adding that event panel is the one parity gap worth a follow-up spec."*
> — [`docs/reference/detailed-metrics.md`](../reference/detailed-metrics.md)

## What was measured before building

Captured on the live unit first (this is the one measurement that cannot be reconstructed
once the change is deployed). Method per
[`poller-cpu-profile.md`](../reference/poller-cpu-profile.md): 120 s window, CPU as `stat`
fields 16+17 so reaped children count, forks from `/proc/stat` `processes`.

| Before | Value | Conditions |
| --- | --- | --- |
| Poller CPU incl. children | 885 jiffies / 120 s = **7.4 % of one core** | 1 core, load 3.7, idle LTE watch |
| Whole-box forks | 6874 / 120 s = **57.3 /s** | same window |
| Poller RSS | **2200 kB** | — |
| Memory available | 50 744 kB of 182 532 kB | — |
| Archive row size | **74.5 B** (156 KB / 2093 rows) | schema v1, 3 day files |
| Archive rate | **~1100 rows/day** = one per ~75 s | `TIER3_EVERY=15` × `POLL_PERIOD=5` |
| `/usrdata` free | 49.7 MB of 182.9 MB (73 % used) | — |
| `?range=1h` / `24h` / `30d` | 0.243 s / 0.819 s / 1.043 s | authenticated curl, 127.0.0.1 |

Two of these corrected the spec's arithmetic: the row is **74.5 B not 170 B** (most PHY
columns are empty whenever the NR leg is inactive), and a day holds **~1100 rows not
1440** because Tier 3 is on a 75 s cadence and skips during a scan. The second one is why
the 3-minute gap threshold is not decoration.

Facts that were first-hand, read from the live device and the repo:

| Fact | Source |
| --- | --- |
| Archive is `/usrdata/qmanager/metrics/YYYY-MM-DD.csv`, 23 columns, `#qm_phy_archive,1` marker, 30-day retention, ~170 KB/day | `scripts/usr/lib/qmanager/phy_metrics.sh:540-580` |
| A row is written only when Tier 3 produced something (`poll_tier3` returns before archiving when both reads are empty, and skips entirely during a scan) | `scripts/usr/bin/qmanager_poller:1793-1855` |
| Tier 3 fires every 15 cycles at `POLL_PERIOD=5` | `qmanager_poller:76,84,3113` |
| Real archive deltas are therefore 60–90 s, not a clean 60 s | header of `qm_phy_archive_row` + the above |
| Every identity field the page needs is already parsed by the poller — no new AT command, no QMI call | live `/tmp/qmanager_status.json`: `.lte = {band:"B3", earfcn:1850, pci:227, cell_id:34117379, tac:55383}`, `.nr.state="inactive"` |
| The band string already carries its RAT prefix, so nothing downstream may add one | `parse_at.sh` `lband = "B" f(10)` / `nband = "N" f(9)`; live `.lte.band = "B3"` |
| The device spends time with the NR leg inactive — the exact condition this page exists to explain — and the archive records it as empty NR columns | live: `.nr.state="inactive"`, empty `nr_*` fields in today's day file |
| The poller already reads `/proc/net/dev` byte counters every cycle for the data counter, so throughput is a delta it already computes | `qmanager_poller` `update_data_used` step 2-5 |
| greenpacket's own lessons, inherited rather than rediscovered: gap threshold 3 min, last-known-value event diff, three-valued `nr_avail`, outage spans cut at gaps, per-cell rollup with an ≥80%-down floor, panel visibility in localStorage | `v2/src/pages/History.svelte:120-260`, `plans/2026-07-28-history-nr-and-cell-tracking.md` |

## What was built

### Backend (deploy layer)

1. **Archive schema v2** — 19 appended columns: serving-cell identity for both RATs,
   `nr_avail` (three-valued), `rat`, `registered`, `cpu_pct`, `mem_pct`, `dl_bps`,
   `ul_bps`. Appended, never inserted: the schema marker is what lets an old day file
   stay readable.
2. **Poller** — the identity rides in the `ctx` object `poll_tier3` already builds (one
   `jq -cn`), and the archive function still execs exactly one `jq`. Throughput deltas
   accumulate in `update_data_used` and are converted to bits/sec at archive time.
3. **`?view=cells`** on `at_cmd/fetch_signal_history.sh` — availability buckets, outage
   spans, cell events, per-cell stats, serving-cell runs, band/CA combo runs and a
   per-combo time share, aggregated in the **same single awk pass** that already
   produces the panel series. No second CGI, no second archive reader, no new daemon.
4. **Schema v3, after the first deploy.** The owner asked for bands and CA combos as
   well; four columns (`ca_cc`, `nrca_cc`, `bw_mhz`, `bands`) came from the CA component
   list Tier 2 already builds, so it cost one extra jq field expansion on a call that
   already ran — not a new read. `bands` stores the combo (`"B3+B1+N78"`) rather than
   the serving band, because losing an aggregated carrier changes the combo without
   changing the PCC.

### Frontend

One route `/cellular/history` and eight togglable panels, with the availability hero as
the spine of the page: the 5G availability strip, the **day × hour nightly pattern**
matrix (the shape that answers "it happens at night"), the serving-cell timeline, the RF
and PHY charts, the outage table, the cell-event rollup, and the current-cell identity.

## What went wrong, and what it cost

Recorded because each one will recur on the next port.

1. **`nr_avail` was computed before the AT read it tests.** `poll_tier3` built the
   context object, and derived `nr_avail` from `at`, at the top of the function — where
   `at` is still the `"{}"` initialiser. The effect was silent and total: an LTE-only
   sample became "unknown" instead of "down", so no outage could ever be recorded and
   the page would have shown "not known" for exactly the condition it exists to explain.
   Caught by reading the diff before deploy, fixed by moving the context build below the
   `qm_phy_available` block, then proved on the live box (`.nr.state="inactive"` was
   available as a real fixture — the device was in the failed state while being built).
2. **A schema bump does not reach the day file already open.** The writer never rewrites
   a header it appends to, so the first deploy wrote 42-field rows under a 23-column
   header and the readers dropped them until UTC midnight. Handled by rotating the live
   day file at deploy time (`mv <date>.csv <date>.csv.v1`); the old file keeps its data
   and stops matching `*.csv`, so it leaves the window cleanly instead of leaking into
   retention.
3. **`qm_pathfix.sh` has to be the LAST step of a backend ship.** Shipping the files
   again after a pathfix put `/usr/lib/qmanager` back into the deployed copies and the
   poller exited `203/EXEC`. `AGENTS.md` says exactly this; it is worth a line here
   because the failure looks like a broken script rather than a stale path.

## What is still open

- **The device measurements.** Everything in the spec's benchmark table. Until they are
  taken, this feature is *built and reasoned*, not *proven*.
- **Retention vs size.** 42 columns ≈ 360 KB/day ≈ 11 MB at the 30-day retention. If
  `/usrdata` is tight on a customer unit, `QM_PHY_ARCHIVE_KEEP_DAYS` is the lever that
  already exists.
- **One archive, two readers.** `fetch_signal_history.sh` now serves both shapes. If a
  third consumer appears, the awk program is the thing to split — not the column map.

## Next

1. On the next device session: take the before/after pairs (poller forks per archive
   write, CPU share, `?view=cells&range=24h` and `range=30d` wall times) and replace the
   "unmeasured" rows in the spec's table.
2. Confirm `head -1` of a new day file reads `#qm_phy_archive,2,…` and that a pre-upgrade
   day file still renders its PHY series with `coverage.cell_from: null`.
3. Watch one overnight window for the field complaint itself — a 5G drop on band 1 — and
   check the pattern card and the outage table agree with it.
