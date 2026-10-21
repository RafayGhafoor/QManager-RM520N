# O5A ↔ greenpacket-o5a parity assessment

> **Created:** 2026-10-22 · **Status:** assessment complete, implementation not started
> **Device:** GreenPacket O5A Pro — Quectel RG520N-EB, SDX6X `sdxlemur`, `LE.UM.6.2.3.r1-03100-SDX65.0`
> **Compared against:** `/Users/emumba/Downloads/projects/greenpacket-o5a` (branch `master`) — the current production product on this same box
> **Scope:** deployment-only branch. Findings that require `app/` edits are labelled **UPSTREAM** and are not authorised by this document. `AGENTS.md` records **one narrow exception** (the speedtest favourite-server control) with its criterion — *"a favourite needs a control in the UI, so it could not live in `deploy/` alone"* and *"prefer extending the backend if a future need can be met without touching app code."* Section 7 splits each proposed surface against that test rather than treating the branch rule as a blanket prohibition.

## Why this document exists

QManager on the O5A is feature-broad but device-shallow. greenpacket-o5a has spent
years accumulating device knowledge on this exact hardware. This document records
what greenpacket does better, what QManager does better, and the ranked backlog —
**because the same knowledge is what makes the next modem port cheap.**

Method: six parallel evidence-based tracks (radio telemetry, neighbour cells,
network health, ops/recovery, UI/UX, AT/QMI resilience), then first-hand
verification of every load-bearing claim against source. Each row below carries a
**Conf** column:

- `V` — I read the code myself; file:line is exact.
- `R` — reported by a track and consistent with surrounding code, but not
  independently re-read. **Re-verify before acting.**

---

## 1. Headline: QManager reads the radio over the wrong pipe

This is the finding everything else hangs off.

greenpacket reads serving cell and neighbour cells over **QMI over QRTR**
(`qmicli -d qrtr://3 --nas-get-cell-location-info`), not AT.

| Fact | Evidence | Conf |
| --- | --- | --- |
| Neighbour read is native QMI NAS, **~40 ms end to end** | `greenpacket-o5a/deploy/radio-handler.sh:1333-1335` — *"native NAS cell-location-info, ~40ms end to end, safe to poll at 1-1.5s"* | V |
| Measured on **this unit**, 2026-07-20 | `greenpacket-o5a/deploy/gp-qmi.sh:5-9` — *"neighbors/signal/band-info ~40ms, cell-lock get/band get OK over qrtr://3"* | V |
| QMI is a **separate transport** from the AT port | Runs over `qrtr://3`, ignores `/dev/smd7` and `/dev/at_mdm0` entirely | V |
| QMI neighbour list = **LTE intra + inter only** | `gp-qmi.sh:157-166` — the `5GNR` and `LTE Info Neighboring` sections are parsed then discarded (`mode == "" { next }`) | V |
| Serving NR RSRP/RSRQ/SNR **does** come from QMI | `gp-qmi.sh:186-214` `parse_signal()` emits an `nr` object from `--nas-get-signal-info` | V |
| **QManager has zero QMI** | `grep -rn 'qrtr\|qmicli\|uqmi\|/data/gp/qmi' AGENTS.md memory.md scripts/ deploy/` → no hits | V |

**Consequences.**

1. Every AT-based read QManager does pays a fixed ~0.27 s port drain+settle
   (`deploy/atcli_smd11:75,82`) plus reply time, and blocks on a shared flock.
   QMI pays neither.
2. A cell scan (2 AT commands + a hard `sleep 1` in
   `scripts/usr/bin/qmanager_neighbour_scanner:126`) costs **3–6 s**. The same
   information over QMI costs ~40 ms.
3. Because QMI does not touch the AT port, it cannot be starved by the vendor's
   0.4 s `gp-metricsd` poll, a cell scan, a speed test, or a band lock. The whole
   class of failure `AGENTS.md` rule 3 exists to avoid does not apply to it.

**This is the single highest-leverage change available.** See §6 for the Live Mode
design it unlocks and `docs/reference/qmi-transport.md` for the contract.

### Caveat that must reach the UI

`gp-qmi.sh:124-135` records, confirmed live 2026-08-01:

> `--nas-get-signal-info` reports RSRP/RSRQ/SNR for whatever cell the radio can
> currently HEAR, independent of whether the modem has actually registered to it
> — with the modem stuck at `not-registered-searching`, it still returned a
> plausible 5G RSRP/RSRQ/SNR.

For antenna aiming this is a trap: a strong RSRP can mean you are pointing at a
tower you are not attached to. Any live signal view must display registration
state (`--nas-get-serving-system`) beside the bars.

---

## 2. Neighbour cells

### 2.1 What greenpacket does

Not a scan screen — a **permanently live card** on Dashboard and Network.

| Behaviour | Evidence | Conf |
| --- | --- | --- |
| 11 columns in one dense row: `# PCI Band (N)ARFCN BW Type RAT RSRP RSRQ RSSI Action` | `v2/src/pages/Dashboard.svelte:409` | R |
| Band/ARFCN/BW/Type user-togglable via `ColumnMenu` | `Dashboard.svelte:134,409` | R |
| Serving-cell highlight matched on NR `NR_pci`+`narfcn`, LTE `pci`+`earfcn`, with a `'-'` placeholder guard | `Dashboard.svelte:201-229` | R |
| Composite sort `rsrp*0.5 + rsrq*1.5 + rssi*0.3`, not raw RSRP | `v2/src/lib/api.ts:599-603` | R |
| Threshold suppression (drop RSRP ≤ −110 dBm unless serving), band filter, top-10 + "show all", **Pause** | `Dashboard.svelte:194-249` | R |
| Server-side dedup keyed `rat\|earfcn\|pci`, 30 s TTL **plus serving-PCI invalidation** — a handover throws the list away rather than showing confidently stale cells | `radio-handler.sh:1129-1215` | R |
| Persistent cross-boot cache so the list is warm | `radio-handler.sh:1130-1230` | R |
| NR neighbours sourced from `AT+QNWCFG="ssb_beam_id"` — per greenpacket's own note, the **only working 5G-neighbour source on this modem** | `radio-handler.sh:1481-1550` | V |
| SSB parse offsets: `f[4]=beam, f[5]=rsrp, f[6]=rsrq, f[7]=pci`; **`f[3]` is the beam count, not the serving beam** | `radio-handler.sh:1534` | V |
| Enables reporting with `AT+QNWCFG="ssb_beam_id",1` when it answers `,0` | `radio-handler.sh:1509-1510` | V |

### 2.2 What QManager does

A careful **one-shot manual scan**: 9 paginated columns, CSV export, per-leg
`modem_busy` vs real-failure distinction, 5-failure abort, `0` sentinel rendered
as an em dash.

Structurally absent:

| Missing | Evidence | Conf |
| --- | --- | --- |
| No serving-cell identification anywhere | `grep -rn serving components/cellular/cell-scanner/` → one unrelated comment in `summaries.ts:206` | V |
| No band name, no bandwidth, no Δ-vs-serving | component column set in `neighbour-scan-result.tsx:94-247` | R |
| No cache, no refresh without a button, no band filter, no top-N, no pause | — | R |
| No NR neighbours from the SSB beam sweep | `grep -rln ssb_beam scripts/` → no hits | V |
| NR leg relies on `AT+QNWCFG="nr5g_meas_info"`, which has **no live evidence** on this firmware anywhere in either repo | `scripts/usr/bin/qmanager_neighbour_scanner:124-128` | V |
| No historical neighbour capture — **neither repo has one**; greenpacket's RF history is serving-only | `greenpacket-o5a/2026-07-22.csv` header is `ts,lte_rsrp,…` | R |

### 2.3 Two things QManager does better — port *from* QManager

Do not replace these with greenpacket's:

1. **`lib/earfcn.ts`** (406 lines) does real EARFCN→MHz, NR-ARFCN→MHz, duplex and
   SCS conversion (`:184-261`, `:308-360`). greenpacket only maps EARFCN→band
   **label** (`api.ts:499-511`) and never converts NR-ARFCN at all. It is
   TypeScript, so it runs in the static bundle — **no shell table is needed.**
2. **`Unreported` / `0`-sentinel discipline** in `neighbour-scan-result.tsx:72-80`
   is better than greenpacket's `'—'` string sniffing.

### 2.4 Port design

**Server (S ≈ 150 lines).** Extend `qmanager_neighbour_scanner`, do not add a
second scan CGI:

1. Add an SSB leg via `qcmd 'AT+QNWCFG="ssb_beam_id"'`, parsing greenpacket's
   offsets above. Enable with `,1` if it answers `,0`.
2. Mark `serving` from **already-parsed state** — read `pci`/`nsa_pci` out of
   `/tmp/qmanager_status.json`. No AT needed.
3. Stamp `age_s` on every row set.

**Extend `at_cmd/neighbour_scan_status.sh`, do not add a CGI.** It already owns
the scan's lifecycle and already serves "last result"; give it a cached-last-
result mode with an `age_s` field, never touching the modem when the cache is
fresh. House principle: *"Same endpoint, same hook, same single fetch — no new
CGI file"* (`docs/specs/system-health-card.md` In Scope 1). That is what gives the
page the "always populated" affordance instead of "press a button".

```json
{"success":true,"generated_at":1774000000,"age_s":3,"cached":true,
 "serving":{"rat":"LTE","pci":342,"earfcn":1650,"band":"B3","rsrp":-84},
 "cells":[
  {"id":"1","rat":"LTE","cell_type":"intra","pci":342,"earfcn":1650,"band":"B3",
   "dl_mhz":1842.0,"rsrp":-84,"rsrq":-9,"rssi":-51,"sinr":12,
   "delta_rsrp":0,"serving":true,"source":"qeng"},
  {"id":"2","rat":"NR","cell_type":"nr5g","pci":625,"narfcn":509070,"band":"n41",
   "dl_mhz":2549.55,"rsrp":-89,"rsrq":-11,"rssi":null,"sinr":null,
   "delta_rsrp":-5,"serving":false,"beams":1,"source":"ssb"}]}
```

`delta_rsrp` must be `null`, never `0`, when the serving RSRP is unknown.

**UI (M).** In `neighbour-scan-result.tsx` add Serving badge + row tone, Band and
DL MHz via `lib/earfcn.ts`, Δ RSRP, and an age line. In `scan-table.tsx` add band
filter / top-N / pause to the toolbar. **UPSTREAM** — `components/` is not
modifiable on this branch.

**Scheduling — the trap.** Do **not** raise `/tmp/qmanager_long_running` for a
neighbour scan: `qmanager_poller:2457-2468` drops the poller to ping-only for the
whole window. The two QENG/NR reads cost ≤3 s under flock inside the 10 s cycle
budget, and `/tmp/qmanager_scan.lock` already prevents overlap with a full sweep.

> Note: `qmanager_cell_scanner:41` and `qmanager_poller:45` both define and honour
> `LONG_FLAG`, but **nothing sets it for neighbour scans today** — so a neighbour
> scan currently competes with the poller for the AT flock. Confirmed `V`.

---

## 3. Radio telemetry depth

Field inventory. `V` rows were confirmed in source; `R` rows come from the
telemetry track.

| Metric | greenpacket | QManager | Verdict | Conf |
| --- | --- | --- | --- | --- |
| Serving band/EARFCN/PCI/TAC | QMI + ubus | `parse_at.sh:107-425` | tie | R |
| eNB/gNB + sector split (ECI/NCI) | not decomposed | `parse_at.sh:62-78,215-230` | **QM** | V |
| Per-antenna RSRP/RSRQ (4 chains) | on-demand only | every 5 cycles / 10 s (`poller:1404`) | **QM** cadence | V |
| `AT+QCAINFO` per-CC | NR short form only, PCI read from the wrong field (`gp-metricsd.awk:234`) | short **and** long form, per-CC RSRP/RSRQ/SINR, RB→MHz (`parse_at.sh:750-935`) | **QM** | R |
| NR bandwidth enum + SCS | enum only | `_nr_bw_to_mhz`, `map_scs_to_khz` (`parse_at.sh:698-720,87`) | **QM** | R |
| MIMO rank | every 3rd cycle (~1.2 s) | Tier 2, ~60 s | **GP** | R |
| **CQI / RI / PMI** | `lte_csi`, `nr5g_csi` | none (grep: no CSI anywhere) | **GP** | V |
| **UL/DL MCS** | `*_ulMCS`, `nr5g_dlMCS` | none | **GP** | V |
| **TX power** (PUSCH/PUCCH/SRS/PRACH) | yes, with −32768 sentinel filter | **no TX power field at all** | **GP** | V |
| RRC state, TM mode, NR pathloss | yes | none | **GP** | R |
| **SSB beam table** (id/rsrp/rsrq/pci per beam) | yes (`gp-metricsd.awk:196-210`) | none | **GP** | V |
| Rank/mod/CQI decayed histograms | yes | none | **GP** | R |
| Independent 2nd signal source | ubus modemd **+** QMI cross-check | none, 100 % AT | **GP** | V |
| SIM/UICC state, per-ICCID registry | ICCID/IMSI must be operator-typed | `sim_registry.sh`, `known_iccids` | **QM** | R |
| Temperature | modem + CPU zones 32/33 | modem-zone average, sentinel-filtered (`parse_at.sh:447-476`) | **QM** | R |

### Cadence + cost

| | QManager | greenpacket |
| --- | --- | --- |
| Tier 1 interval | `POLL_INTERVAL=2` (measured cycle 3.7–4.0 s) | 0.4 s while watched, **zero while idle** |
| AT commands | ~39 `qcmd` invocations / 60 s | 12 fast + 4–5 slow **in one lock hold** |
| Lock duty | ~30–40 % of wall time, 24/7 | one hold per cycle, client-gated |
| Budget enforcement | `CYCLE_TIME_BUDGET=10` is **warn-only** (`poller:53,2583-2588`) | hard 0.3 s / 0.7 s budgets |

**Verdict: keep QManager's transport, adopt greenpacket's pacing.** QManager's
`at_mdm0` + flock choice is correct on this device; its per-invocation cost and
always-on duty cycle are not.

---

## 4. Degradation and truthfulness

### 4.1 The blank-dashboard bug

| Step | Evidence | Conf |
| --- | --- | --- |
| `poll_serving_cell` treats rc=2 (modem answered `ERROR`) as reachable and reparses | `qmanager_poller:1367-1373` | V |
| `parse_serving_cell` resets every radio field up-front | `parse_at.sh:120-127` | V |
| ⇒ an AT `ERROR` **blanks** the dashboard; a lock timeout instead **freezes** it | — | V |
| Neither path is labelled with age | no `at_age`/`at_ok` anywhere in QManager | V |
| greenpacket publishes both | `gp-metricsd.awk:344,540` | R |

**Fix (S):** on rc≠0 keep last-good values and stamp `at_age`/`at_ok` into
`/tmp/qmanager_status.json`. This is the cheapest user-visible win in the whole
document.

### 4.2 Supporting weaknesses

| Finding | Evidence | Conf |
| --- | --- | --- |
| `qcmd` waits 20 s / 45 s for the flock; a stuck caller stalls the cache that long | `scripts/usr/bin/qcmd:52-53` | V |
| `__QMLIB/qcmd` has no non-blocking mode, so the poller must choose between blocking and skipping entirely | `qcmd:130-145` | V |
| Shim retries up to 3 × 12 s with **no per-attempt cap** — can exceed `LOCK_WAIT_SHORT=20`, the exact compounding greenpacket caps at `radio-handler.sh:2482` | `deploy/atcli_smd11:145-156` | V |
| No AT-queue depth or fail-fast; one slow caller is borne by unrelated requests | `radio-handler.sh:5200-5225` does the opposite | R |
| Service downtimes are invisible to `qlog` (1097 calls from 110 files → `/tmp`, 256 KB × 3) | `qlog.sh:33-35` | R |

---

## 5. State truthfulness, atomicity, safety rails

### 5.1 Apply-without-verify

| Setter | QManager behaviour | Evidence | Conf |
| --- | --- | --- | --- |
| **Band lock** | write → grep for `ERROR` → log "applied". **No read-back.** greenpacket pre-reads 3 masks, applies LTE then NR, reads back exactly, and rolls back verified | `bands/lock.sh:76-100` vs `greenpacket gp-qmi.sh:593-745` | V |
| **Tower lock** | write accepted ⇒ config flips to `locked`, even though `tower_read_lte_lock` already exists | `tower/lock.sh:113-147`, `tower_lock_mgr.sh:245` | V |
| **IMEI** | requires exact `OK` (good) but **no NVM read-back**, and the "already set" shortcut compares against the **poller cache** | `imei.sh:104-133` | R |
| **Supported bands** | written **once at boot**, no refresh path; a failed live read renders as `locked=[]` | `qmanager_poller:1300-1312` | V |
| APN | verified against the negotiated view — **good** | `apn_apply.sh:476-527` | R |
| SIM slot | verified — **good** | `slot_verify.sh` | R |
| Profile apply | skip-if-matches against live reads — **good** | `qmanager_profile_apply:735-756` | R |

The verification pattern already exists in-repo; it is simply not applied to the
radio setters.

### 5.2 Atomicity

Multi-step setters take the flock **per command**, so `CFUN=0` → `sleep 3` →
`CFUN=1` releases the port during the radio-off window
(`qmanager_watchcat:329-341`). Any CGI can inject a command there and get a
meaningless `ERROR`. A power cut in that gap leaves the radio **off**;
`settings.sh:473-497` logs a double `CFUN=1` failure and continues, and nothing
re-asserts until the watchdog's own threshold fires.

greenpacket holds `atlock` across the whole transaction and arms an EXIT trap
(`gp-qmi.sh:825-905`, `radio-handler.sh:4257-4262`).

> **Device fact:** bare `AT+CFUN=0` is unreliable here — `turin_modemd` re-asserts
> `+CFUN:1` ~10 s after its polls start erroring
> (`greenpacket radio-handler.sh:3363-3368`). greenpacket's airplane handler stops
> the unit for this reason. A CFUN-based Tier 2 in QManager will mostly race it.

### 5.3 Safety rails

greenpacket has `gp-nv-dump.sh` (read-only `AT+QNVFR`), `gp-pci-guard.sh`,
`gp-nand-backup.sh`, `ODU_RECOVERY_PACKAGE/`, `flash-safety.md`.
QManager has input validation only — no pre-write snapshot, no rollback, no
NV/EFS read helper.

**Recommended:** snapshot the radio state before every mutation into
`/usrdata/qmanager/state/radio/` (writable, survives reboot, outside
`/etc/qmanager`'s www-data surface):

```json
{"captured_at":1774000000,"source":"AT+QNWPREFCFG",
 "lte_band":"…","nsa_nr5g_band":"…","nr5g_band":"…",
 "qnwlock_4g":"…","qnwlock_5g":"…","cgdcont":["…"]}
```

Three-generation ring, read back into the UI as "previous state" so rollback is
one click.

---

## 6. Live Mode — 1 Hz neighbour view for antenna aiming

The user's stated need: while physically pointing a directional antenna, the
neighbour view must refresh about once per second.

### 6.1 Why it is easy now

Because QMI is a separate transport at ~40 ms (§1), Live Mode does **not** need
to pause the poller, hold the AT flock, or compete with anything.

| Element | Rate | Transport |
| --- | --- | --- |
| Serving LTE RSRP/RSRQ/RSSI/SINR | 1 Hz (2 Hz fits) | QMI `--nas-get-signal-info` |
| Serving NR RSRP/RSRQ/SNR | 1 Hz | QMI (same call) |
| LTE intra+inter neighbours, serving marked | 1 Hz | QMI `--nas-get-cell-location-info` |
| Registration state — **required alongside the bars** | 1 Hz | QMI `--nas-get-serving-system` |
| NR beams / 5G neighbours | ~0.3–0.5 Hz | AT `ssb_beam_id`, in the gaps |

QMI gives **no** NR neighbour list (§1), so NR neighbours remain an AT read. That
is acceptable: the numbers you watch while aiming are serving LTE and serving NR,
both of which are in the 40 ms path.

### 6.2 Display decoupling — reuse the sites lease, do not build a live daemon

QManager has already solved "live, but only while someone is watching" for the
sites monitor, and it is device-measured (~25 MB/h and ~25 points of one core,
*only* while a visible tab holds the lease). Antenna aiming must use the same
protocol rather than a second mechanism:

| Step | Owner | Behaviour |
| --- | --- | --- |
| 1 | www-data (CGI) | each `?range=now` GET writes the current epoch to a lease file |
| 2 | root (poller) | renews the live tick only while the lease is 0–10 s old (`LIVE_LEASE_SEC`) |
| 3 | browser | polls at `LIVE_POLL_MS` only while `visibilityState === 'visible'` |
| 4 | everything | lease ages out ⇒ live ticks stop on their own |

Precedents: `sites.sh:33-34`, `hooks/use-sites.ts:20`, and
`docs/reference/sites-monitor.md` → Live mode. The reader writes each tick to a
single root-owned file; the browser polls a CGI that `cat`s it (~10 ms, no modem),
so modem jitter never stutters the UI — the screen shows the reading plus its real
age.

### 6.3 Three things that make it usable for aiming

1. **Peak-hold.** A faint marker at the best RSRP seen since Live Mode started,
   per cell. Without it you cannot read a moving number after turning the antenna.
2. **Big-number focused strip.** Serving RSRP, SINR, top 3 neighbours, legible
   from ~2 m while holding a wrench. (UPSTREAM if it becomes a new route.)
3. **Auto-stop after 5 minutes** with a visible countdown — Live Mode starves
   alerts and history pauses while it runs.

### 6.4 Open measurement

`scripts-dev/qmi-probe.sh` answers, on the device: real per-call latency, jitter,
CPU cost at 1 Hz, failure rate, three-way concurrency safety, and dumps the raw
`--nas-get-cell-location-info` bytes the parser must be written against.
**Run it before writing any Live Mode code.**

---

## 7. Detailed Metrics tab (specified, not yet built)

The requested feature — a tab showing everything greenpacket's dashboard shows,
in QManager's design language — now has a proper spec rather than prose in this
document:

> **[`docs/specs/detailed-metrics-parity.md`](../specs/detailed-metrics-parity.md)**

Written in the repo's own spec format (`docs/specs/system-health-card.md`): status,
background, numbered In Scope, **Out of Scope with reasoning**, falsifiable
requirements as `- [ ]` acceptance criteria, and the `qm-orchestrate` lane and
flags it must run under.

### A first draft of this section was wrong — record why

The first version invented things this repo had already solved or explicitly
rejected. The corrections, because they are the reusable part:

| Invented | What QManager already has | Source |
| --- | --- | --- |
| A "Live tab" separate from History | **One surface, one range pill, `now` first.** A separate live band was shipped once and reverted: it read a different range than the cards below it and the two disagreed | `docs/reference/latency-monitor.md:74` |
| A new "Live Mode" sampler | A **browser-held lease** (`/tmp/qmanager_sites_live`, 10 s age, visibility-gated). Stops on its own when nobody watches; device-measured at ~25 MB/h and ~25 points of one core *only while leased* | `sites.sh:33-34`, `hooks/use-sites.ts:20`, `sites-monitor.md` → Live mode |
| New CGIs (`phy_metrics.sh`, `history.sh`, `nearby_cells.sh`) | **Extend the endpoint that already owns the data.** The house principle is "same endpoint, same hook, same single fetch — no new CGI file" | `docs/specs/system-health-card.md` In Scope 1 |
| greenpacket's twelve ranges (`5m…30d`) | `now\|1h\|3h\|6h\|12h\|24h\|7d\|30d\|90d` exactly as `sites.sh:189` validates them; the pill offers a subset, the CGI serves the full set | `sites.sh:6,189`; `sites-card.tsx:48` |
| SSE for 1 Hz updates | HTTP polling, hidden-tab-suppressed. No long-lived CGI holding a busybox-httpd worker on a single core | `latency-monitor.md:95-99` |
| A ported `MetricInfo` component | `components/ui/hint-icon.tsx` exists; only the glossary *content* is new | `components/ui/hint-icon.tsx` |
| A histogram component for CQI/rank | `MetricBar` — already lifted to `components/ui/` by that spec's locked decision | `docs/specs/system-health-card.md` In Scope 6 |

### What the spec locks

- **Poller:** a Tier 3 PHY block (~60 s) + the SSB beam list, into the **existing**
  snapshot. No new daemon, no new unit.
- **Archive:** 1/minute CSV under `/usrdata/qmanager/metrics/`, 30-day retention,
  while the 30-minute `/tmp` ring stays exactly as it is so the dashboard is
  untouched.
- **CGI:** `fetch_signal_history.sh?range=&panels=` — no query string must return
  today's bytes unchanged.
- **Page:** `/cellular/detailed-metrics`, one range pill, groups Registration /
  LTE / NR / CA / SSB Beams / Distributions, glossary on every cell, stale chip per
  group.
- **Lane: Full** (cross-layer, new backend fields). Flags: `modem-investigator`
  recon, on-device run for the shell, `ui-builder` + the three static gates, and
  `qm-redesign-review` for the visual pass **before** the approval gate.

**The spec's gate question:** which R1 fields this firmware actually returns.
`AT+QENG="servingcell"` on RG520N-EB is already known to omit fields RM520N has, so
recon measures the set and anything absent ships as `null` with a glossary note —
it does not become a card that always reads `—`.

## 8. Network health, DNS, alerting

| Capability | greenpacket | QManager | Verdict | Conf |
| --- | --- | --- | --- | --- |
| WAN up/down | 2 HTTP `generate_204` by **hostname**, 3 fails | 2 hostnames **+ 2 IP literals**, monotonic staleness, fail-closed rule | **QM** | R |
| DNS health per resolver | LAN + smartdns pool + per-DoH, unique-name probe, guarded heal 1/h (`gp-dns-health.sh:364-394,616`) | **none** — `custom_dns.sh` only writes config | **GP** | V |
| Stuck-registration detection | implicit (linecheck CSV); `gp-ipv4watch` auto-restarts `QCMAP_ConnectionManagerd` | 4-tier ladder COPS→CFUN→QUIMSLOT→reboot + token bucket, **in code but not deployed** | mixed | V |
| Notification pacing | SMS 300 s, 20/UTC-day, bounded 20-msg queue (`gp-notify-lib.sh:63-79`) | routing + capability matrix better; **no pacing, no cap**; latches poller-lifetime only (`alert_engine.sh:98-99`) | **GP** discipline | V |
| Per-app shaping (QUIC/TTL/DPI) | QUIC reject only | `dpi_state.sh` + `ttl_state.sh` | **QM** | R |
| Smart-DNS policy routing | 366-line config, domain pins, ICMP speed-check | none | **GP** | R |
| Event retention | per-day CSV, 7/14/30/40-day, monthly ISP report | NDJSON ring **300 in `/tmp`**, ~50 served | **GP** | R |

**DNS matters more than it looks here:** dnsmasq `serve-expired-ttl 86400` makes a
dead resolver look alive for a day, and `force-AAAA-SOA` is only valid while the
link is IPv4-only.

**Do not ship smartdns.** greenpacket already runs it on `127.0.0.1:5353` on this
box. Consume it; shipping it would also be a third-party binary (rule 9).

---

## 9. Operations

| Area | Finding | Conf |
| --- | --- | --- |
| Upgrade path | QManager's updater is genuinely better designed — SHA-256 with a `--strict` unattended mode, `VERSION.pending` crash marker, `previous_version`, reboot ack (`scripts/usr/bin/qmanager_update:198-360`). **But `update.sh:31` targets `dr-dolomite/QManager-RM520N`, which publishes no releases** (`deploy/README.md:19-21`) ⇒ never runs here. The real path is 8 manual steps, **no version stamp on device**, and "rollback" = `rm -rf /usrdata/qmanager /etc/qmanager` | R |
| Backup | **only `auth.json`** is backed up (`install_rm520n.sh:1493-1516`). Unbacked in `/etc/qmanager`: `qmanager.conf`, `ping_profile.json`, `tower_lock.json`, `sites.json`, `scenarios/`, `profiles/`, `alert_routing.json`, `sms_forwarding.json`, `discord_bot.json`, `msmtprc`, `sim_registry.json`, `known_iccids`, `quality_thresholds.json`, `ttl_state`, `tz.posix`, `ethernet_speed`, `video_domains.txt`, `auth.json`, `crash.log`, `modem_crashes.json`, `reboot_history.json`, `VERSION` | R |
| Resource hygiene | greenpacket runs tmpfs-cleanup, memwatch, syslog-persist, fake-hwclock, sysctl. **QManager has none of the four** — while 1097 `qlog_*` calls write to `/tmp` and there is no RTC, so a WAN-down boot logs at 1970 | R |
| Post-reboot forensics | QManager **does** persist `/etc/qmanager/crash.log`, `modem_crashes.json`, `reboot_history.json`, `last_boot_id`. What is missing is the *why*: `qlog` and `qmanager_update` write to `/tmp`, and the updater then reboots — destroying its own audit trail | R |
| Health check | user-triggered only (`health-check/run.sh`), no timer, so nothing proves health at boot | R |

**Persistent-history cost check:** greenpacket's 1/min CSV schema is 25 cols × ~130 B
⇒ **~190 KB/day, 1.3 MB/week**. Against ~82 MB free on `/usrdata`, that is cheap.

---

## 10. Co-residency conflicts — the referee rules

Both stacks are on the same box. These are not hypothetical.

| # | Conflict | Evidence | Conf |
| --- | --- | --- | --- |
| 1 | **Cap-cut → reboot loop.** greenpacket removes the default route to enforce a data cap; QManager's watchdog reads that as an outage and escalates to Tier 4 reboot, forever, cap re-applied each boot | `gp-wanmon.sh:45-58`, documented in its own header `:8-14` | R |
| 2 | **`AT+CFUN=0` does not stick** — `turin_modemd` re-asserts `+CFUN:1` in ~10 s, so a CFUN-based Tier 2 races it | `radio-handler.sh:3363-3368` | V |
| 3 | **Two writers on `/etc/data/dnsmasq.conf`**, both inserting `no-resolv` + `server=` under their own markers. Both edits survive ⇒ LAN clients bypass smartdns and greenpacket's policy silently stops applying | `install.sh:592-632` vs `custom_dns.sh:419-425` | R |
| 4 | **Duplicate resource daemons.** greenpacket already runs sysctl/memwatch/syslog-persist/tmpfs-cleanup; adding QManager copies doubles flash writes for no benefit | — | R |
| 5 | QManager's watchdog is **not deployed** — `scripts/usr/bin/qmanager_watchcat` and `scripts/etc/systemd/system/qmanager-watchcat.service` exist, but there is **no unit in `deploy/`** and no line in `qm_boot_hook.sh:58` `UNITS`. Its ladder is latent | V |
| 6 | A neighbour scan does not set `LONG_FLAG`, so it currently competes with the poller for the AT flock | `qmanager_cell_scanner:41` sets it, `qmanager_neighbour_scanner` does not | V |

**Ownership rule.**

- **Link verdict** — QManager's ping daemon is the only uptime oracle (its probe
  design is better than greenpacket's hostname-only pair).
- **DNS policy** — greenpacket's smartdns owns it. QManager writes upstreams only
  when greenpacket's block is absent.
- **Recovery** — exactly one actor. On this device the proven fix is
  QCMAP-restart + COPS; CFUN/SIM/reboot must sit behind a lock greenpacket can
  also see.

---

## 11. UI/UX

### Where greenpacket's authoring is better

| Finding | Evidence | Conf |
| --- | --- | --- |
| **Freshness is computed and thrown away.** `isStale`/`receivedAtMs` exist but the chip was removed; the in-repo note calls the result "a quieter version of the same bug". Only `active-bands-card.tsx:551-556` still renders it | `hooks/use-modem-status.ts:53-106`, `radio/page-header.tsx:20-22`, `cellular-information.tsx:41-45` | V |
| **Duplicated pollers.** `useModemStatus` is per-component; `/monitoring/connection-quality` mounts it twice ⇒ `fetch_data.sh` hit **2× per 2 s** | `probe-targets-card.tsx:196`, `quality-thresholds-card.tsx:181` | V |
| **recharts ships in first paint** (lodash + victory-vendor + 7 `d3-*`) and there is **no `next/dynamic` anywhere** | `components/dashboard/signal-history.tsx:6`; `grep -rn "next/dynamic" app/ components/` → none | V |
| No `Cache-Control`, no gzip from busybox httpd | `deploy/qm_serve.sh:80` | R |
| No service worker at all, vs greenpacket's cache-first `/static/*` SW | `greenpacket deploy/gp-sw.js` | R |
| No per-metric glossary; greenpacket has ~220 lines of `{range, better, explanation}` with a tap-first ⓘ | `MetricInfo.svelte` | R |
| Apply-progress/countdown exists only for the cell scanner and reboot | `scanner.tsx:119-139` | R |
| `DESIGN.md` has 4 stale rows (cites `dashboard/live-latency.tsx` and `latency-monitoring/round-trip-card.tsx`, neither exists; describes a deleted `/monitoring/sms-alerts`), plus a comment claiming the app is "served by lighttpd" | `DESIGN.md:250,256,297,299`; `connection-scenarios/page.tsx:18` | R |

### Where QManager is better — do not regress

- Signal quality as a **5-glyph ladder + tonal ramp**, with a measured
  justification (success/warning containers are 1.03:1 apart, so hue alone cannot
  carry it): `signal-status-card.tsx:42-66`.
- Real mobile drawer vs an icon rail.
- One normative token file (`app/globals.css`).
- Deep-linkable routes with breadcrumbs vs 13 hash routes.

Only the `DESIGN.md` corrections are deploy-safe on this branch; the rest are
**UPSTREAM**.

---

## 12. Ranked backlog

### Tier 1 — small, high value, no rule risk

| # | Change | Where | Effort |
| --- | --- | --- | --- |
| 1 | Non-blocking AT tier: `qcmd -n`, poller skips instead of sleeping 20 s, stamps `at_age`/`at_ok` | `scripts/usr/bin/qcmd`, `qmanager_poller` | S |
| 2 | rc≠0 must not blank last-good radio fields | `qmanager_poller:1367` | S |
| 3 | Verify-after-write for band / tower / frequency (readers already exist) | `bands/lock.sh`, `tower/lock.sh`, `tower_lock_mgr.sh` | S |
| 4 | Persist events + alert latches off `/tmp` | `events.sh:35`, `alert_engine.sh:98` | S |
| 5 | Alert pacing/cap 300 s / 20-day / bounded queue | `alert_engine.sh:_ae_dispatch` | S |
| 6 | `qmanager-log-persist` unit (tail 300 KB × 3, 600 s, `.prev`) | new unit + `qm_boot_hook.sh` | S |
| 7 | Config backup before redeploy + `/etc/qmanager` tarball, keep 3 | `deploy/` | S |
| 8 | Cap the shim's retry budget after attempt 1 | `deploy/atcli_smd11:145-156` | S |
| 9 | Refresh supported-bands cache on demand; treat stale-vs-live disagreement as an error | `qmanager_poller:1300` | S |
| 10 | `docs/latest.md`, ≤2 KB, one entry per deployment | new | XS |

### Tier 2 — substantive

| # | Change | Effort |
| --- | --- | --- |
| 11 | **QMI read path** — deploy-time `qmicli` + private libs bundle, one shared reader | M |
| 12 | **Live Mode** (§6) on top of it | M |
| 13 | Neighbour-cell port (§2.4) | S+M |
| 14 | Durable 1/min metrics CSV to `/usrdata/qmanager/metrics/`, 7-day prune | M |
| 15 | `ubus call modemd status` as a lock-free fallback tier (gate NR fields — modemd never clears `NR_*` on detach) | S |
| 16 | Pre-write radio snapshot + rollback ring | M |
| 17 | Flock **lease** for multi-step setters + stale-lease reaper | M |
| 18 | `deploy/qm_deploy.sh` + on-device `VERSION`: SHA-256, stage-then-rename, `previous_version` | M |
| 19 | Clock persistence to `/usrdata/qmanager/state/clock-epoch` | S |
| 20 | DNS observability by **reading** greenpacket's `dns-<day>.csv`, not a second prober | M |
| 21 | **PHY depth collection** — Tier 3 poll (~60 s) for CQI / RI / PMI / MCS / TM / RRC / TX power / SSB beams, into the **existing** snapshot. No new CGI. Prerequisite for §7 | L |
| 22 | Durable archive + `fetch_signal_history.sh?range=&panels=` (extend the existing endpoint; no query string must return today's bytes). Prerequisite for §7 | M |

### Tier 3 — UPSTREAM app changes, needs authorisation

**§7 Detailed Metrics tab** — fully specified in
[`docs/specs/detailed-metrics-parity.md`](../specs/detailed-metrics-parity.md):
route, range pill, metric groups, glossary, acceptance criteria, lane and flags.
Depends on backlog #21, #22, #14 and #4 landing first, because the fields and the
retention do not exist yet.

Smaller items: `next/dynamic` on the three recharts surfaces · one shared
`ModemStatusProvider` · stale chip in card headers · `components/ui/sparkline.tsx`
· `lib/metric-glossary.ts` · global apply-progress toast.

The freshness chip, the shared poller and the recharts dynamic import are worth
arguing for; `lib/metric-glossary.ts` is also a hard dependency of §7.2.

---

## 13. Open decisions

1. **Replacement or co-resident?** If co-resident, items 4/6/19 are largely
   already provided by greenpacket's running units and drop to "verify, don't
   duplicate". This reshuffles Tier 1.
2. **Is a new `app/` route authorised** for PHY-depth metrics and the big-number
   aiming strip, or is a CGI-only surface the ceiling on this branch? This now
   covers the whole of [`docs/specs/detailed-metrics-parity.md`](../specs/detailed-metrics-parity.md).
   The question is narrower than it looks: the spec's R1–R4 are **backend-only and
   in scope**, so they ship either way; only R5–R6 (the page, the glossary) need the
   owner to extend the recorded app-layer exception from one control to one page.
3. **Recovery ownership** — does QManager replace `gp-ipv4watch`/`gp-wanmon` as the
   recovery actor, or coexist behind a shared lock? This decides whether
   `qmanager-watchcat` is ever deployed.
4. **QMI binary provenance** — borrow `/data/gp/qmi/bin/qmicli` to prove the idea
   (fast, couples to greenpacket) vs ship QManager's own deploy-time bundle
   (correct, more work). Rule 2 now names "QMI helpers" as vendor stack, so the
   borrowed path must stay a probe, never the shipping path.

---

## 14. Portability notes for the next modem

What generalises, and what must be re-measured per device:

| Fact | Portability |
| --- | --- |
| QMI is a separate transport from AT | **Universal** — any Qualcomm modem with QRTR |
| `--nas-get-cell-location-info` returns LTE intra+inter only, never NR neighbours | Likely universal; the section-discard behaviour should be checked per firmware |
| `--nas-get-signal-info` can report signal while unregistered | **Universal trap** — always pair with `--nas-get-serving-system` |
| ~40 ms per QMI read | Device-specific; re-measure |
| `AT+QNWCFG="ssb_beam_id"` as the NR-neighbour source, offsets `f[3]=count, f[4]=beam, f[5]=rsrp, f[6]=rsrq, f[7]=pci` | Quectel-specific; verify per firmware |
| `turin_modemd` re-asserting `+CFUN:1` | **O5A/vendor-specific** — an AT+CFUN-based recovery tier is unsafe here and fine elsewhere |
| The `rd` port choice (`at_mdm0` vs `smd7` vs `smd11`) | Depends entirely on which daemons the vendor runs; always check `ps` and `/proc/*/fd` first |
| `ssb_beam_id` costs ~0.3 s and fails soft | Re-measure |

A port should follow the shape of `docs/reference/rg501q-bringup.md`: probe, record
the raw bytes, then write the parser against the capture — not against an
assumption.

---

## 15. Reference index

| Topic | Where |
| --- | --- |
| **Detailed Metrics parity — the requested feature's spec** | [`docs/specs/detailed-metrics-parity.md`](../specs/detailed-metrics-parity.md) |
| QManager's change workflow (lanes, flags, gates) | `.claude/skills/qm-orchestrate/SKILL.md` + `references/lanes.md` |
| Existing spec format to copy | [`docs/specs/system-health-card.md`](../specs/system-health-card.md) |
| Live-range + lease precedent | `docs/reference/latency-monitor.md:64-99`, `docs/reference/sites-monitor.md` → Live mode, `scripts/www/cgi-bin/quecmanager/monitoring/sites.sh` |
| QMI transport contract, field inventory, porting checklist | [`docs/reference/qmi-transport.md`](../reference/qmi-transport.md) |
| Probe tool (read-only, run on device) | `scripts-dev/qmi-probe.sh` |
| AT transport and `qcmd` flock | [`docs/reference/at-command-transport.md`](../reference/at-command-transport.md) |
| Per-device facts | [`docs/reference/platform-matrix.md`](../reference/platform-matrix.md) |
| Cell scanner internals | [`docs/reference/cell-scanner.md`](../reference/cell-scanner.md) |
| Watchdog ladder | [`docs/reference/connection-watchdog.md`](../reference/connection-watchdog.md) |
| greenpacket QMI implementation | `greenpacket-o5a/deploy/gp-qmi.sh` |
| greenpacket neighbour/QMI handler | `greenpacket-o5a/deploy/radio-handler.sh:1117-1440` |
| greenpacket metrics + history | `greenpacket-o5a/deploy/gp-metricsd.{sh,awk}`, `metrics-logger.sh` |
| greenpacket device knowledge | `greenpacket-o5a/CLAUDE.md`, `memory.md`, `detailed-metrics.md`, `jazz-stuck-registration.md`, `qmi.md` |
