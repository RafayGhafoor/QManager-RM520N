# SPEC: Detailed Metrics parity — PHY depth + range trend

**Status:** **Approved 2026-10-22** — the owner authorised R1–R6 (backend *and* the
page), so the app-layer exception this spec needed is granted and recorded in
`AGENTS.md` → "Two recorded exceptions", item 3. Lightweight spec — falsifiable
requirements, in-scope/out-of-scope explicit, acceptance criteria as pass/fail.

**Background:** QManager's radio surfaces show the *RRC-visible* layer (band, PCI,
RSRP/RSRQ/SINR, CA). The reference product on the same device also shows the
*PHY* layer (CQI, RI/PMI, MIMO layers, MCS, TM mode, RRC state, TX power per
channel, SSB beams) and keeps a range-selectable trend of it. Neither exists here:
`grep -rn 'cqi\|nr5g_csi\|tx_pwr' scripts/ app/` finds no producer, and signal
history is 180 rows (≈30 min) in `/tmp` (`qmanager_poller:122-123`), so there is
nothing to trend over.

This spec is deliberately **parity-shaped, not greenpacket-shaped**. Where the
reference product and QManager's own conventions disagree, QManager wins. The
assessment behind it, with per-finding evidence, is
[`docs/plans/2026-10-22-o5a-greenpacket-parity.md`](../plans/2026-10-22-o5a-greenpacket-parity.md) §1–§3.

**Goal:** one page at `/cellular/detailed-metrics` showing the PHY layer live and
over a selectable range, built entirely from primitives that already exist here.

## Conventions this spec is bound by

| Convention | Precedent |
| --- | --- |
| **One surface, one range pill, `now` first** — not a separate live view | `components/monitoring/latency-monitoring/sites-card.tsx:48` (`SITES_RANGES = ["now","1h","24h","7d"]`); `docs/reference/latency-monitor.md:74` — *"No separate Live chart or status band"* |
| **The CGI serves more ranges than the pill offers**; the pill shows the useful subset | `scripts/www/cgi-bin/quecmanager/monitoring/sites.sh:6` serves `now\|1h\|3h\|6h\|12h\|24h\|7d\|30d\|90d`; `sites-card.tsx:48` offers four |
| **Live = a browser-held lease**, never a permanently-running sampler | `sites.sh:33-34` (`/tmp/qmanager_sites_live`), `live_fresh` / `LIVE_LEASE_SEC`, `hooks/use-sites.ts:20` (`LIVE_POLL_MS = 2000`), visibility-gated |
| **Extend an existing endpoint; do not add a CGI file** | `docs/specs/system-health-card.md` In Scope 1 — *"Same endpoint, same hook, same single fetch — no new CGI file"* |
| **Gaps are gaps** — `connectNulls={false}`, never 0 ms / 0 dBm for a missing sample | `docs/reference/latency-monitor.md:65` |
| **The window ends at the newest archived row, not the wall clock** | same doc, `:64` |
| **A fetch carries a sequence number; only the newest may land** | same doc, `:99`; `dataRange` may lag `range`, key claims on `dataRange` (`:89`) |
| **Signal quality is never hue-only** — tonal ramp, ≥3:1 separation | `components/dashboard/signal-status-card.tsx:42-66` |
| **Numbers are `tabular-nums`; no new motion** | `docs/reference/dashboard-state-motion.md`, `docs/reference/motion-preference.md` |

## In Scope

1. **Poller — a Tier 3 PHY block (~60 s cadence).** Add CQI, RI, PMI, MIMO layers,
   TM mode, RRC state, UL/DL MCS, pathloss and TX power (per channel) for LTE and
   NR to the existing snapshot written by `qmanager_poller`. Read-only commands
   only, through `qcmd`. **No new daemon, no new systemd unit.**
2. **Poller — SSB beam list.** `AT+QNWCFG="ssb_beam_id"` into the same snapshot,
   capped at the strongest N (default 4) to bound the snapshot size. It is the only
   working NR-neighbour source on this modem.
3. **Poller — durable trend archive.** The existing 1-minute sampler writes to
   `/usrdata/qmanager/metrics/YYYY-MM-DD.csv` (30-day retention) *in addition to*
   the 30-minute `/tmp` ring the dashboard already reads. The ring keeps serving
   the dashboard unchanged.
4. **CGI — extend `at_cmd/fetch_signal_history.sh`** with an optional `?range=`
   accepting the `sites.sh` vocabulary plus one `?panels=` filter, returning
   `{range, bucket_sec, series:{<panel>:[{ts,…}]}, missing:[…]}`. Default behaviour
   with no query string is **byte-identical to today** so the dashboard chart does
   not change.
5. **Page — `/cellular/detailed-metrics`**, one range pill, cards grouped
   Registration / LTE / NR / Carrier Aggregation / SSB Beams / Distributions.
   Every metric cell carries a `HintIcon` explainer fed by a new
   `lib/metric-glossary.ts`.
6. **Freshness** — each group header carries the stale chip already computable from
   `useModemStatus().isStale`; a group whose values are older than one Tier-3 cycle
   says so instead of silently showing them as current.

## Out of Scope (explicit, with reasoning)

- **A separate Live page or Live tab.** `latency-monitor.md:74` rejected exactly
  this shape after shipping it once: the live band read a different range than the
  cards below it and the two disagreed. Live is the `now` pill. Reason: an existing
  written decision, not a preference.
- **A new always-on sampling daemon for PHY metrics.** The lease protocol exists and
  is device-measured (`sites-monitor.md` → Live mode: ~25 MB/h and ~25 points of the
  single core *only while a visible tab holds the lease*). A second daemon would
  double the cost and add a unit the installer, uninstaller and OTA path must learn.
- **A new CGI endpoint.** `fetch_signal_history.sh` already owns signal history.
  Adding a second endpoint splits the retention story across two files.
- **greenpacket's twelve ranges (`5m…30d`).** Those fit a 1/minute logger and an
  operator watching a single handover. `latency-monitor.md:71` records the same
  rejection: *"No 12 h or Daily range. With a 24 h history window those gave two
  points and one point."* Use the proven set.
- **Server-Sent Events.** greenpacket streams at 1 Hz via SSE. QManager polls. SSE
  needs a long-lived CGI holding a busybox-httpd worker (no `lighttpd`, single core),
  and the repo already rejected a second live mechanism. Poll, gated by visibility.
- **A `MetricInfo` component ported from greenpacket.** `components/ui/hint-icon.tsx`
  already exists; the new part is the glossary *content*, not the control.
- **Recharts replacement or a new chart library.** `components/ui/chart.tsx` is the
  house wrapper. The fix for first-paint cost is `next/dynamic`, tracked separately.
  Reason: swapping the chart stack is a redesign, and it is not needed to ship this.
- **A CSS port of greenpacket's panels.** `DESIGN.md` is the visual authority; every
  element maps to an existing token or component (see the mapping table in the plan,
  §7.2).
- **Histograms as a new visualisation primitive.** Reuse `MetricBar` for the
  decayed CQI/rank distributions rather than building a histogram component for one
  card.
- **LTE TX power and NR pathloss are permanently absent on this device.** Both
  commands answer `ERROR: command_failed` on RG520N-EB (measured 2026-10-22). Shown
  as unavailable rather than retried; a port to another modem re-probes them
  (`platform-matrix.md`). Reason: an always-failing command costs a lock hold every
  cycle for nothing.
- **NR neighbours over QMI.** Not available — `gp-qmi.sh:157-166` discards the
  `5GNR` section. NR neighbours stay an AT read; see `docs/reference/qmi-transport.md`.
- **Per-neighbour SINR, neighbour history, CSV export of the trend.** Not requested,
  and each needs a schema decision that would slow the first ship.
- **`AT+QENG="nr5g_neighbourcell"`.** No live evidence of it working on this
  firmware in either repo. Adding a command because it exists upstream is how the
  poller ends up with a field that is always null.
- **Network-health, DNS or alerting changes.** Separate concerns, separate specs.
- **Any write to `/data/gp/*`.** Hard rule 2. The QMI read path (if adopted later)
  invokes the vendor helper read-only or ships its own bundle; it does not modify it.

## Requirements

### R1 — PHY depth: two sources, measured

**The gate question is answered — measured on this unit 2026-10-22, not assumed.**

The cheap half is **not AT at all**. `ubus call modemd status` already carries `cqi`,
`nr_cqi`, `lte_rank`, `nr_rank`, `lte_dl_tx_mode`, `bandwidth`, `NR_bandwidth`,
`regStat`, `regName`, `rat` and both signal sets — one call, **no AT lock, no qmicli
fork**. The precise half is AT, because modemd's own cache is coarse: greenpacket's
awk records `nr5g_ulMCS` moving 22->21->19 across six reads while modemd sat still.

| Field | Source | Command / key | Measured answer |
| --- | --- | --- | --- |
| CQI, NR-CQI, rank, TM mode, bandwidths, reg state/name | **ubus modemd** | `cqi`, `nr_cqi`, `lte_rank`, `nr_rank`, `lte_dl_tx_mode`, `bandwidth`, `NR_bandwidth`, `regStat`, `regName` | present |
| RI / CQI / PMI (LTE) | AT | `AT+QNWCFG="lte_csi"` | `3,0,9,0` |
| RI / CQI / PMI (NR) | AT | `AT+QNWCFG="nr5g_csi"` | `13,4,10,20` |
| UL MCS (LTE / NR), DL MCS (NR) | AT | `lte_ulMCS`, `nr5g_ulMCS`, `nr5g_dlMCS` | `1,3,1` / `1,26,4` / `1,24,3` |
| MIMO layers (LTE / NR) | AT | `lte_mimo_layers`, `nr5g_mimo_layers` | `1,1` / `1,2` |
| RRC state + RAT | AT | `AT+QNWCFG="rrc_state"` | `1,"LTE",4` |
| SSB beams | AT | `AT+QNWCFG="ssb_beam_id"` | 6 beams, e.g. `6,-67,-11,47` |
| TX power (NR) | AT | `AT+QNWCFG="nr5g_tx_pwr"` | `1,2,-10,18,-10` |
| **TX power (LTE)** | AT | `AT+QNWCFG="lte_tx_pwr"` | **`ERROR: command_failed`** — absent on RG520N-EB |
| **NR pathloss** | AT | `AT+QNWCFG="nr5g_pathloss"` | **`ERROR: command_failed`** — absent on RG520N-EB |

All working commands already answer enabled (they return data, not `,0`), so **no
enable-writes**: `AT+QNWCFG="…",1` is a setter, and this spec issues no setters.

- **Target:** `scripts/usr/lib/qmanager/phy_metrics.sh` (new) + a Tier 3 block in
  `scripts/usr/bin/qmanager_poller`.
- **Acceptance:**
  - [ ] Tier 3 cadence ~60 s, separately tunable, and **never delays Tier 1**
    (measured Tier-1 cycle stays 3.7-4.0 s).
  - [ ] Only the nine working commands are issued. `lte_tx_pwr` and `nr5g_pathloss`
    are **not sent at all** — a command that always errors is a wasted lock hold,
    not a degraded feature. Documented as absent with a glossary note.
  - [ ] AT reads are **batched into at most two compound commands**, because eleven
    separate `qcmd` calls would hold the flock for ~6 s. Two groups so one
    transient `ERROR` costs half the fields, not all of them - `qcmd` rejects an
    entire compound response on `*ERROR*`.
  - [ ] modemd fields come from one `ubus call modemd status` per Tier 3.
  - [ ] **Whitelist only.** `modemd status` also carries `imei`, `imsi` and `iccid`;
    hard rule 10 forbids persisting or publishing them. The reader copies named
    keys and ignores everything else - asserted by grep in review.
  - [ ] Every field independent: one failing command leaves the others populated.
  - [ ] Absent fields publish as `null`, never `0` and never a stale previous value.
  - [ ] With Tier 3 disabled by config the snapshot is byte-identical to today's.

### R2 — SSB beam list

- **Acceptance:**
  - [ ] Parsing uses `f[4]=beam, f[5]=rsrp, f[6]=rsrq, f[7]=pci`; `f[3]` (the beam
    count) is never read as a beam id.
  - [ ] When the response is `…,"ssb_beam_id",0` the poller enables reporting once
    and records `null` for that cycle — it does not fire the enable on every cycle.
  - [ ] The list is capped (default 4, strongest first) and the cap is a named
    constant, not a literal.
  - [ ] A missing or empty beam list yields `[]`, not `null`, so the UI can say
    "none detected" rather than "unavailable".

### R3 — Durable archive

- **Acceptance:**
  - [ ] One row per minute in `/usrdata/qmanager/metrics/YYYY-MM-DD.csv`.
  - [ ] Growth is measured and recorded: expected ≈190 KB/day at 25 columns; the PR
    body carries the measured figure from a 1-hour soak.
  - [ ] Retention deletes whole day-files older than 30 days; it never rewrites a
    file it is appending to.
  - [ ] A full or read-only `/usrdata` disables the writer with one `qlog_warn` and
    leaves the `/tmp` ring working.
  - [ ] The 30-minute `/tmp` ring keeps its current name, shape and cap, so
    `hooks/use-signal-history.ts` is unchanged.

### R4 — `fetch_signal_history.sh?range=&panels=`

- **Acceptance:**
  - [ ] No query string ⇒ same JSON array as today, byte-identical, verified by
    diffing before/after against a live device.
  - [ ] `?range=` accepts exactly `now|1h|3h|6h|12h|24h|7d|30d|90d`; anything else
    returns `cgi_error "invalid_range"` with the accepted list, matching
    `sites.sh:189`.
  - [ ] `range=now` returns current values and empty series, so the pill needs one
    code path.
  - [ ] Unknown panel ids are ignored, not fatal.
  - [ ] Response carries `range`, `bucket_sec`, and `missing[]` naming panels with no
    archive coverage — so the UI can disable a pill instead of drawing an empty chart.
  - [ ] p95 response time under 300 ms on the live device for `30d` with all panels.
  - [ ] Runs as `www-data` and is validated that way, not from a root shell.

### R5 — Page and range pill

- **Acceptance:**
  - [ ] Route `/cellular/detailed-metrics` exists and is reachable from the sidebar
    without a dead link on any other page.
  - [ ] One `SegmentedField` range pill, `now` first, `glyph={() => null}` per
    `latency-monitor.md:118`.
  - [ ] Selecting `now` sets the lease and polls at `LIVE_POLL_MS`; a hidden tab
    polls nothing; becoming visible reads once then resumes.
  - [ ] Leaving `now`, hiding the tab, or unmounting lets the lease age out; no
    request renews it.
  - [ ] A range switch mid-flight cannot land stale data (sequence-number guard).
  - [ ] Every panel renders `null` as an em dash and a gap in the chart — never `0`.
  - [ ] The page renders with `bun run build` and loads in the browser with no
    console errors; `bunx tsc --noEmit` and `bun run i18n:check` both pass.

### R6 — Glossary and freshness

- **Acceptance:**
  - [ ] `lib/metric-glossary.ts` holds one entry per displayed metric with `range`,
    `better` (`high`/`low`/`neither`) and a one-sentence explanation.
  - [ ] Every metric cell renders a `HintIcon`; a metric with no glossary entry fails
    a build-time check rather than rendering a bare icon.
  - [ ] Each group header shows the stale chip when its data is older than one
    Tier-3 cycle, driven by `useModemStatus().isStale` — not a new timer.
  - [ ] New user-visible strings go through the existing i18n path.

## Branch scope — the one thing that decides whether this can be built here

This branch is **deployment-only**: `app/`, `components/`, `lib/`, `types/` and
`hooks/` track upstream, and the product-specific work lives in `deploy/`. This
spec is therefore **mostly out of scope for the branch that records it**, and that
is stated here rather than discovered halfway through a build wave.

`AGENTS.md` records the exception and the criterion behind it: the
speedtest favourite-server control touches `components/`, `hooks/`, `types/` and a
locale file, *because "a favourite needs a control in the UI, so it could not live
in `deploy/` alone"*, and the rule is *"prefer extending the backend if a future
need can be met without touching app code."*

Applied to this spec, that test splits cleanly:

| Part | Backend-only? | Status on this branch |
| --- | --- | --- |
| R1 poller Tier 3, R2 SSB beams, R3 archive, R4 `fetch_signal_history.sh?range=` | **Yes** | In scope. Build these regardless — they are what makes a later port cheap, and R4 is useful from the AT terminal and `curl` before any UI exists |
| R5 the page, R6 glossary and stale chip | **No** — a metric group cannot be rendered without a component | **AUTHORISED** 2026-10-22 by the owner (R1–R6). Recorded as exception 3 in `AGENTS.md` |

The decision this spec needed — *does the owner extend the recorded exception from
one control to this page?* — was answered **yes** on 2026-10-22, for the whole of
R1–R6. The staging below still matters for build order: R1–R4 are the backend and
must land before R5 can render anything.

### What the backend-only half already buys

`fetch_signal_history.sh?range=30d` returning PHY series with `missing[]` is
immediately useful with no frontend: it answers "what was my CQI at 03:00" from
`curl`, it lets the AT terminal confirm a field really exists on this firmware, and
it is the piece a future port must reproduce anyway (per
`docs/reference/qmi-transport.md` → Porting checklist).

## Routing (`qm-orchestrate`)

**Lane: Full.** Cross-layer (poller → CGI → hook → component) and it introduces new
backend fields; per `references/lanes.md` "frontend-only qualification" that alone
re-lanes it.

Flags fired by the table in `.claude/skills/qm-orchestrate/SKILL.md`:

| Flag | Agent | When |
| --- | --- | --- |
| Reads modem state / poller field | `modem-investigator` | Recon, before the gate — the RG520N command availability for CQI/MCS/TX power is **not** established |
| Shell script | Conductor runs it on the device **first** | Before any dispatch; then `busybox-portability-checker` for residue |
| Frontend | `ui-builder`; gates `bun run i18n:check`, `bunx tsc --noEmit`, `bun run build`, page load | Build wave |
| "Apply the design language" | `qm-redesign-review` skill | **Before** the gate — this spec fixes behaviour and inventory; the visual pass is that skill's Artifact, approved by the user |

`installer-safety-auditor` does **not** fire: no unit, installer, sudoers,
`/usrdata/` layout or OTA change. R3 writes data under an existing directory.

**The gate must answer one thing recon cannot:** which of the R1 fields this
firmware actually returns. `AT+QENG="servingcell"` on RG520N-EB is already known to
omit some RM520N fields. A field that answers `ERROR` ships as `null` with a
glossary note, not as a broken card.
