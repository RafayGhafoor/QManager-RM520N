# Detailed Metrics page

> **Applies to:** RG520N-EB on the GreenPacket O5A Pro (SDX6X) · measured 2026-10-22
> **RM520N-GL / RG501Q-EU:** unverified — the two AT commands that fail here may work
> there; see [`platform-matrix.md`](./platform-matrix.md) and re-probe.
> **Spec:** [`docs/specs/detailed-metrics-parity.md`](../specs/detailed-metrics-parity.md)

> PHY-layer radio depth and a range trend on one page, at
> `/cellular/detailed-metrics`. Triggers below.

---

## Two sources, and why

The page reads PHY fields from **two different places**, and the split is measured,
not stylistic:

| Source | Fields | Cost |
| --- | --- | --- |
| `ubus call modemd status` | `cqi`, `nr_cqi`, `lte_rank`, `nr_rank`, `lte_dl_tx_mode`, bandwidths, `regStat`/`regName`/`rat` | **no AT lock, no qmicli fork** |
| AT via `qcmd`, Tier 3 | CSI (RI/CQI/PMI), UL/DL MCS, mimo layers, `rrc_state`, NR tx power, SSB beams | two compound commands, ~1 s, one lock hold per group |

The cheap half is not AT because it does not need to be. AT is only for the precise
fields, because **modemd's own cache is coarse** — greenpacket measured
`nr5g_ulMCS` moving 22→21→19 across six reads while modemd sat still.

**`AT+QNWCFG="lte_tx_pwr"` and `AT+QNWCFG="nr5g_pathloss"` are never sent.** Both
answer `ERROR: command_failed` on this firmware. The page renders them as
"not reported by this modem" with a glossary entry, never as a silent dash and never
as `0`. Porting to another modem means re-probing those two.

## ⚠️ `modemd status` carries subscriber identity

The same payload contains `imei`, `imsi`, `iccid`. Hard rule 10 forbids persisting or
publishing any of them, so the reader is a **jq whitelist that names 10 keys** — a
field it does not name cannot be emitted. **Any change to that jq program is a
security-relevant change**: keep it a whitelist, never `{...}` splat, never `.`
passthrough.

## Batching, and why exactly two compounds

`qcmd` costs a lock hold per invocation; eleven separate calls would hold
`/tmp/qmanager_at.lock` for ~6 s and starve CGIs. The reads are therefore batched
into **two** compounds (LTE group, NR group) — not one, because `qcmd` rejects an
*entire* compound response on `*ERROR*`, so two groups bound the blast radius to
half the fields instead of all of them.

## The archive

`qm_phy_archive_row` appends one row a minute to
`/usrdata/qmanager/metrics/YYYY-MM-DD.csv`, with a `#qm_phy_archive,1,…` schema
marker on line 1 and 30-day whole-file retention.

- It **never rewrites a file it is appending to**.
- A full or read-only `/usrdata` disables it with **one** `qlog_warn` and leaves the
  30-minute `/tmp` ring working, so the dashboard is unaffected. There is no retry
  loop: the failure it guards is not fixed by trying again 60 s later.
- Retention computes its cutoff from the UTC date in the filename. **If `date -d` is
  unavailable it deletes nothing** rather than guessing a cutoff.
- The existing `/tmp/qmanager_signal_history.json` ring (`SIGNAL_HISTORY_MAX=180`) is
  untouched, which is why `hooks/use-signal-history.ts` is unchanged.

**The trend starts empty.** `?range=1h` returned 3 points on the day it shipped; 24h
and 7d fill in only as the archive accumulates. There is no backfill.

## `fetch_signal_history.sh`

| Query | Behaviour |
| --- | --- |
| **none** | **Byte-identical to before this feature** — the dashboard's array shape |
| `?range=now` | snapshot only, `series: {}`; renews the live lease |
| `?range=1h\|3h\|6h\|12h\|24h\|7d\|30d\|90d` | `{snapshot, series:{panel:[{ts,v}]}, missing[]}` at 60 s buckets |
| anything else | `{"success":false,"error":"invalid_range",…}` |

Panels: `rsrp sinr rsrq rssi temp cqi rank mcs tx_power total_cells`.
`missing[]` names panels with no archive coverage, so the UI disables a panel rather
than drawing an empty chart.

## The page

- **One page, one range pill, `now` first** (offers `now/1h/24h/7d` of the nine the CGI
  serves — the CGI serves more than the pill shows, per `sites-card.tsx:48`).
- A separate live band was **not** built: `latency-monitor.md:74` records that shape
  being shipped and reverted because it disagreed with the cards below it.
- Six groups: Registration, LTE, NR, Carrier Aggregation, SSB Beams, Distributions.
- **The glossary is compiler-enforced.** `lib/metric-glossary.ts` is
  `as const satisfies Record<MetricId, MetricGlossaryEntry>`, so a **missing** entry
  and an **orphan** entry are both `tsc` errors. Both directions were proved by
  deleting an entry and adding a bogus one.
- `registered` is **three-valued** on the wire (`true`/`false`/`null`) because
  `modemd` reporting nothing is "not known", which is not the claim "not registered".

## Deliberately not included

Taken from the spec's out-of-scope list — do not re-add without a decision:

- **Throughput speed, interval data usage, CPU/memory, and cell-change events** as
  History panels. greenpacket's History has them; they belong to other subsystems that
  already own surfaces (Speed Test, Data Used, Connection Quality), and `total_cells`
  is a count, not the "your PCI changed at 03:14" event stream. Adding that event
  panel is the one parity gap worth a follow-up spec.
- NR neighbour cells (QMI cannot provide them), per-neighbour SINR, CSV export.
- A new chart library, a new live daemon, or a separate Live route.

## Verifying a change here

```bash
bunx tsc --noEmit && bun run i18n:check && bun run build
# on the device, after shipping lib + poller + cgi and re-running qm_pathfix.sh:
jq -c '.phy' /tmp/qmanager_status.json          # Tier 3 fires every 15 cycles (~60 s)
tail -2 /usrdata/qmanager/metrics/$(date -u +%F).csv
# every CGI needs a session:
SID=$(sh -c '. /usrdata/qmanager/lib/cgi_auth.sh; qm_create_session')
curl -s -H "Cookie: qm_session=$SID" '…/fetch_signal_history.sh?range=1h'
```

**`jq` is not on a plain ssh PATH.** The lib resolves it itself
(`/usrdata/qmanager/bin/jq` first) for exactly that reason — a bare `jq` there made
`qm_phy_available` report the whole source unavailable.
