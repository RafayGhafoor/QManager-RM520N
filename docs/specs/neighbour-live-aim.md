# SPEC: Neighbour cells — live view for antenna aiming

**Status:** Approved to build, 2026-10-22. Lightweight spec — falsifiable
requirements, in-scope/out-of-scope explicit, acceptance criteria as pass/fail.

**Background.** Pointing a directional antenna needs a neighbour-cell view that
updates while the antenna moves. Today the neighbour scanner is one-shot: press a
button, wait 3–6 s for two AT commands plus a hard `sleep 1`, get a paginated
table. There is no serving-cell column, no band, no delta, no refresh, no cache.

The measured fix is not AT at all. `qmicli -d qrtr://3 --nas-get-cell-location-info`
returns the full LTE neighbour set over QMI — a transport independent of the AT
port, so it cannot be starved by the vendor's 0.4 s `modemd` poll, a cell scan, or
a speed test. See
[`docs/reference/qmi-transport.md`](../reference/qmi-transport.md).

**Measured on this device (GreenPacket O5A Pro, RG520N-EB, boot
`3b7af010-0846-4999-a1a9-58ddccf872e3`), 2026-10-22, `scripts-dev/qmi-probe.sh`:**

| Measurement | Value |
| --- | --- |
| `--nas-get-cell-location-info` | 30–260 ms, **avg 82 ms** over 30 ticks |
| `--nas-get-signal-info` | 40 ms |
| `--nas-get-serving-system` | 30 ms |
| 1 Hz soak, 30 ticks | **0 failures** |
| CPU at 1 Hz | **~4 % of one core** |
| 3 concurrent QMI clients | **3/3 succeeded** — QRTR multiplexes |
| Neighbour cells returned | **5**, serving cell identified (`Serving Cell ID 104` = `Cell[0] PCI 104`) |
| Live state during probe | Jazz, `registered`, LTE EARFCN 250 / band 1, NR ARFCN 509070 |

**Goal.** A neighbour view that refreshes about once per second while an operator
is watching it, and stops on its own when they are not.

## Conventions this spec is bound by

| Convention | Precedent |
| --- | --- |
| **Live is a browser-held lease**, not an always-on sampler | `scripts/www/cgi-bin/quecmanager/monitoring/sites.sh:33-34`, `hooks/use-sites.ts:20` (`LIVE_POLL_MS`), `docs/reference/sites-monitor.md` → Live mode |
| **One surface, `now` is a range** — no separate live page | `docs/reference/latency-monitor.md:74` |
| **Extend the endpoint that owns the data** — no new CGI file | `docs/specs/system-health-card.md` In Scope 1 |
| **Never hue-only for quality** — `MetricBar` ramp, ≥3:1 | `components/dashboard/signal-status-card.tsx:42-66` |
| **`Tabular-nums`, existing tokens, existing motion rules** | `DESIGN.md`, `docs/reference/motion-preference.md` |
| **Range picker glyph is `() => null`** | `docs/reference/latency-monitor.md:118` |
| **`0` and `null` are different** — `0` = measured zero, `null` = not reported, rendered `—` | `components/cellular/cell-scanner/neighbour-scan-result.tsx:72-80` |
| **Band / frequency maths lives in TypeScript** | `lib/earfcn.ts` — do not add a shell band table |

## In Scope

1. **QMI reader** — a new shared shell lib that invokes `qmicli` read-only and
   parses its text into QManager's existing neighbour row shape.
2. **Live tick in the poller** — while a lease file is fresh, one neighbours read +
   one signal read per second, written atomically to one `/tmp` file. No new daemon,
   no new systemd unit, no AT lock.
3. **`neighbour_scan_status.sh` extension** — a cached-result mode serving the last
   known cells plus `age_s`, and a `range=now` mode that renews the lease.
4. **Scanner table enrichment** — Serving badge, Band, DL MHz, Δ‑RSRP vs serving,
   and an age line; band filter / top‑N / pause in the toolbar.
5. **Aim strip** — a focused, large-number panel for antenna work: serving RSRP,
   serving SINR, registration state, and the top 3 neighbours with peak-hold.

## Out of Scope (explicit, with reasoning)

- **A separate Live route or a second scanner page.** The aiming view is a mode of
  the existing neighbour scanner (`?range=now`). `latency-monitor.md:74` records a
  separate live band that was shipped, disagreed with the cards below it, and was
  removed. Reason: an existing written decision, not a preference.
- **An always-on live sampler.** The lease makes cost zero when nobody watches.
  A permanent 1 Hz QMI sampler would burn ~4 % of the single core permanently for a
  screen nobody is looking at.
- **A new CGI endpoint.** `neighbour_scan_status.sh` already owns this scan's
  lifecycle and already serves "last result".
- **A new systemd unit.** The poller already runs as root, already owns the
  snapshot write, and already has a tier loop. A second daemon needs installer,
  uninstaller and OTA changes for no benefit.
- **Shipping our own `qmicli` bundle.** Correct long-term (hard rule 2 and 9), but
  it needs a deploy-time payload + private libqmi. This ship invokes the vendor's
  binary read-only and records the coupling; see "Known dependency".
- **Calling `/data/gp/gp-qmi.sh`.** It is a vendor *script* the product repo edits
  continuously — the same reason hard rule 7 forbids depending on
  `turin_web.sh`. Parse the binary's output ourselves.
- **NR neighbour cells.** QMI does not provide them; the `5GNR` section carries the
  NR **serving** ARFCN, not neighbours. They stay an AT read (existing scanner
  behaviour) and are not part of the live tick.
- **Cell distance from the QMI timing advance.** `qmicli` reports
  `LTE Timing Advance: '13' us` — a different unit from the AT path's `1968`.
  **Recording this is not a licence to compute distance**, which `AGENTS.md`'s
  gotcha forbids after the `/16` guess was disproved. Raw value only.
- **Sorting by a composite score.** Greenpacket uses
  `rsrp*0.5 + rsrq*1.5 + rssi*0.3`; QManager sorts by raw RSRP with unmeasured
  last (`signalSortingFn`). Keep QManager's, which an operator can reason about.
- **Persisting the neighbour list to durable storage.** It is a live measurement,
  not a trend. `range=now` is intentionally history-free, as `sites.sh` does.
- **Per-neighbour SINR.** Not reported by this QMI call.
- **Changing the AT-based full sweep (`cell_scan_start.sh`).** Separate feature,
  separate lock, untouched.

## Requirements

### R1 — QMI reader lib (general, not neighbour-specific)

- **Target:** `scripts/usr/lib/qmanager/qmi_read.sh`, sourced by the poller and the
  CGI. Subcommand-style functions, each writing JSON to stdout, so later consumers
  do not add a second lib or a second binary dependency.

| Function | qmicli call | Measured |
| --- | --- | --- |
| `qm_qmi_neighbours` | `--nas-get-cell-location-info` | 30–260 ms |
| `qm_qmi_signal` | `--nas-get-signal-info` | 40 ms |
| `qm_qmi_registration` | `--nas-get-serving-system` | 30 ms |
| `qm_qmi_band` | `--nas-get-rf-band-info` | untested |

- **Acceptance:**
  - [ ] `qm_qmi_available` gates every function: `qmicli` present, executable, the
    `qrtr://3` device answers. When false, callers fall back to AT — the lib never
    fails the caller.
  - [ ] Invokes `qmicli -d qrtr://3 <call>` with `LD_LIBRARY_PATH=/data/gp/qmi/lib`,
    both paths overridable by variable.
  - [ ] Every call is wrapped in `timeout`, default 5 s, mirroring the measured
    260 ms worst case with margin.
  - [ ] `qm_qmi_neighbours` parses the captured format exactly: sections
    `Intrafrequency LTE Info` / `Interfrequency LTE Info`, then
    `EUTRA Absolute RF Channel Number`, `Serving Cell ID`, and per-cell
    `Physical Cell ID` / `RSRQ` / `RSRP` / `RSSI`.
  - [ ] Verified against the recorded capture
    (`.orchestra/scratch/qmi-fix/neighbour-sample.txt`), including a cell whose
    `RSRP` is missing → field is `null`, row still emitted.
  - [ ] `serving` is `true` exactly when the cell's PCI equals `Serving Cell ID`.
  - [ ] `qm_qmi_signal` returns **both** the values and the registration state in
    one object, so a consumer cannot read signal without also seeing whether the
    modem is attached. This is not optional — see the trap above.
  - [ ] `qm_qmi_registration` maps `Registration state: 'registered'` to a boolean
    and passes `Description` (`Jazz`) through verbatim.
  - [ ] Missing `qmicli`, non-zero exit, or empty output returns a distinct
    non-zero status; the caller keeps last-good data. It never returns an empty
    array as if "no neighbours were visible".
  - [ ] No AT command, no `qcmd`, no `/tmp/qmanager_at.lock` involvement — asserted
    by grep in the review.
  - [ ] `ash`-clean: no brace expansion, no arrays, no `[[`.

### R2 — Live tick in the poller

- **Target:** `scripts/usr/bin/qmanager_poller` gains a lease-gated live block.
- **Acceptance:**
  - [ ] Lease file `/tmp/qmanager_neighbours_live` holds one epoch, written by the
    CGI as www-data; the poller **only reads it** and trusts nothing but digits
    (≤12 chars, not a symlink) — the `sites.sh` `live_fresh` shape.
  - [ ] The poller runs a live tick only while the lease is 0–10 s old
    (`LIVE_LEASE_SEC`); otherwise it does nothing and naps as it does today.
  - [ ] Live state is written atomically (temp + `mv`) to
    `/tmp/qmanager_neighbours_live.json`, containing `{at, cells[], serving{}}`.
  - [ ] Servicing the live tick never delays Tier 1: measured Tier-1 cycle stays in
    its pre-change band (observed 3.7–4.0 s) with a lease held for 60 s.
  - [ ] With no lease present, the poller's behaviour and its output files are
    byte-identical to today.
  - [ ] A live tick that fails leaves the previous file untouched.
  - [ ] `qlog` records at most one warning per 60 s while live reads are failing —
    not one per tick.

### R3 — `neighbour_scan_status.sh`

- **Acceptance:**
  - [ ] No query string ⇒ current behaviour, byte-identical.
  - [ ] `?range=now` writes the lease and returns the live file's content with
    `age_s`; if the live file is absent or older than 6 s it returns
    `live_at: null` and `cells: []` rather than stale cells presented as fresh.
  - [ ] `?range=last` returns the last completed scan result with `age_s`.
  - [ ] Any other `range` returns `cgi_error "invalid_range"` listing
    `now, last`, matching `sites.sh:189`'s style.
  - [ ] Operations that rewrite the live lease name/path remove it on disable, as
    `sites.sh` must (`sites-monitor.md`: "Disabling has to remove the lease").
  - [ ] Runs and is validated as the CGI user, not from a root shell.

### R4 — Scanner table enrichment

- **Acceptance:**
  - [ ] Columns added: **Serving** (badge + row tone), **Band** (`lib/earfcn.ts`),
    **DL MHz** (`getDLFrequency`), **Δ RSRP** (vs serving; `null` never `0` when
    serving RSRP is unknown), **Age**.
  - [ ] Serving row is visually distinct without relying on hue alone — badge text
    plus a border/weight change.
  - [ ] Toolbar gains band filter, top-N, and an explicit **Pause** control that
    stops renewing the lease.
  - [ ] `0` renders as an em dash and is excluded from sorting, preserving
    `neighbour-scan-result.tsx:72-80`.
  - [ ] Narrow viewport hides the four measurement columns as today; the Serving
    badge stays visible.

### R5 — Aim strip

- **Acceptance:**
  - [ ] Visible only in the `now` range.
  - [ ] Shows serving RSRP, serving SINR, registration state, and top 3 neighbours.
  - [ ] Peak-hold: a faint marker at the best RSRP seen since the range was
    entered, per cell, reset on leaving `now`.
  - [ ] Registration state is displayed beside the signal values — QMI reports
    signal for a cell the modem is not attached to (`docs/reference/qmi-transport.md`).
  - [ ] One line states the measured cost while live ("~4 % CPU, measured
    2026-10-22") so it is not a hidden tradeoff.
  - [ ] Leaving the range, hiding the tab, or 5 minutes elapsing stops all polling
    and renews nothing.

### R6 — UI/UX conformance

- **Acceptance:**
  - [ ] Range picker is `SegmentedField` with `glyph={() => null}`.
  - [ ] Every new string goes through the i18n path; `bun run i18n:check` passes.
  - [ ] No new animation; any transition respects `motion-preference`.
  - [ ] Numbers use `tabular-nums`; colours come from existing OKLCH tokens only.
  - [ ] Empty / loading use `Empty` / `Skeleton`; no bespoke spinner.
  - [ ] `bunx tsc --noEmit` and `bun run build` pass; the route loads with no
    console errors.

## QMI beyond neighbours — staged adoption

The owner asked whether QMI should be used elsewhere where it improves performance
without hurting accuracy. Measured answer: **yes for a specific enumerated set, as a
read-only second source with explicit precedence — never as an AT replacement.**

| Fact | QMI | Decision |
| --- | --- | --- |
| LTE neighbour cells | ✅ 82 ms | The feature this spec ships |
| Registration state + carrier (`MCC`/`MNC`/`Jazz`) | ✅ 30 ms | **Stage 1 (this spec, additive).** QManager infers this today; QMI states it |
| Serving NR RSRP/RSRQ/SNR (NSA) | ✅ | **Stage 1 (additive)** — the AT NSA parse is the fragile one on this firmware |
| Serving LTE RSRP/RSRQ/RSSI | ✅ | Cross-check only; AT also yields SINR, so QMI must not become the sole source |
| Active band / bandwidth | ✅ | Complement only — `AT+QCAINFO` is richer per-CC |
| LTE carrier aggregation per CC | ✅ | **Do not migrate** — QManager's `parse_at.sh` handles short *and* long form; greenpacket's QMI parser mis-reads NR PCI (`gp-metricsd.awk:234`) |
| CQI, RI, PMI, MCS, TX power, SSB beams, per-antenna RSRP, temperature, data counters | ❌ | AT or `/proc` stays |
| Cell distance | ⚠️ | **Never mix transports.** AT says `1968`, QMI says `13 µs` for the same field |

**Rules that make this safe** — each has a precedent in this repo's own history:

1. **Capability-detect, then fall back.** `qm_qmi_available` false ⇒ AT path, as
   today. The RG501Q-EU is unverified for QMI
   ([`platform-matrix.md`](../reference/platform-matrix.md)), so a hard dependency
   would break the port goal.
2. **Signal is never returned without registration state.** `gp-qmi.sh:124-135`
   records a live case of plausible 5G RSRP while `not-registered-searching`.
3. **One transport per derived value.** The disproved `/16` cell-distance guess
   (`AGENTS.md` gotcha) is exactly what mixing scales produces.
4. **QMI is read-only.** It is never a setter path; every write stays on `qcmd`.

**Deliberately staged:** this spec wires the neighbour live view plus the two
additive fields (registration, NSA signal). It does **not** rip out the poller's
serving-cell AT read. Replacing a working dashboard data path in the same deploy as
a new feature risks the dashboard for a CPU win nobody will see. Migration is a
follow-up with its own spec, once the lib has run in production for a while.

## Known dependency (recorded, deliberately)

This ship reads `/data/gp/qmi/bin/qmicli` and its private libs. `AGENTS.md` hard
rule 2 names `/data/gp/*` — including QMI helpers — as vendor stack, so:

- **It is read-only.** No write, no install, no symlink, no config touch.
- **It is a real coupling.** If the vendor removes or relocates the binary, live
  mode degrades to "live unavailable" and the AT scanner keeps working. That
  degradation must be visible, not silent.
- **Follow-up:** ship QManager's own `qmicli` + `libqmi-glib`/`libqrtr-glib` as a
  deploy-time payload (the `jq` / `speedtest` / `sms_tool.bin` pattern, hard rule 9),
  then drop this dependency. Tracked as backlog, not silently forgotten.

## Benchmark — before / after

Captured per `AGENTS.md` → *Measure it, then prove the edges*. The baseline had to
be taken **before** the deploy, while the old code was still live.

**Conditions (both runs):** device idle apart from the vendor stack, no scan
running, no live lease held for the baseline; 60 s window; CPU is
`cutime`+`cstime` (parent + reaped children), not htop's parent-only view.

| Metric | Before (`60ae0925`) | After, run 1 | After, run 2 (post timeout fix) |
| --- | --- | --- | --- |
| Poller CPU, idle 60 s | **909 ticks = 15.2 %** | 772 = 12.9 % | **917 = 15.3 %** |
| Poller CPU, live 60 s | n/a | 1171 = 19.5 % (**+6.7**) | **1134 = 18.9 % (+3.6)** |
| Poller RSS, idle | **2164 kB** | 2468 kB | 2456 kB (+292 kB) |
| Poller RSS, live | — | 2472 kB | — |
| Forks for radio reads | AT ~39 `qcmd`/60 s | 2 `qmicli`/s leased, 0 idle | same |
| Neighbour refresh | 3–6 s, manual | ~1 s while leased | same |

**Read this as: idle unchanged, live costs 3.6–6.7 points.** Two back-to-back runs of the
*same code* differed by 2.4 points idle and 3.1 points live, because the box's load
average moved between 3.2 and 4.5 across them (the vendor stack is not idle). Neither
run is "the" number, and quoting the better one would be dishonest — this is the
`poller-cpu-profile.md` 595-vs-815 ms/cycle warning happening live.

What the pair does establish, and what matters:

- **Idle did not regress.** 15.3 % against a 15.2 % baseline, with +292 kB RSS.
- **Idle costs nothing structural**: no lease ⇒ one `[ -f ]` test, no fork, no QMI call.
- **Live is bounded and small** relative to the poller's existing 15 % — and it only
exists while a visible tab holds the lease.

**The ~4 % in the probe and in the UI copy was wrong** and was corrected to 7 % across
five locales. The probe measured `qmicli` children only; the tick also pays the `jq`
merge (`jq` = 4.3× a normal applet, `poller-cpu-profile.md`) and, after the timeout fix
below, a `cat` and `rm` per read.

**A per-bucket breakdown is deliberately NOT claimed here.** These are whole-tree
totals; nobody can yet say whether the delta is `qmicli`, `jq`, or fork overhead.
`scripts-dev/qm-profiler.sh` (dispatched 2026-10-22) attributes CPU by child program
name so the next optimisation is aimed at a measured target rather than a guess.

### Edge case EC2 found a real bug at close-out

`out=$(timeout 5 cmd)` **is not bounded on this firmware.** busybox `timeout` kills the
direct child, but a grandchild it spawned still holds the stdout *pipe*, so the command
substitution blocks until that grandchild exits. Measured: a stub running `sleep 30`
returned in 5 s to a plain redirect and **30 s** through `$( )`.

Fixed by capturing through a file and reading it back, with a fallback chain
`qm_timeout` → `timeout` → refuse (never an unbounded call). Inside the poller this
mattered: a wedged `qmicli` would have stalled a whole cycle.

This is the argument for exercising edge cases at all — it was invisible in review, in
the fixture tests, and in the happy path on the device.

## Edge cases — validated at close-out

Checked **after** the feature works end to end, per `AGENTS.md`. This is a checklist,
not a harness; hard rail 8 still bans `scripts/test/` and assertion scripts. Evidence
is the observed output, pasted into the commit body.

| Edge case | How to exercise | Must observe |
| --- | --- | --- |
| `qmicli` absent or moved | point the path override at a non-existent file | `qmicli_available` false; `?range=now` reports live unavailable **visibly**; AT scanner still works |
| QMI call hangs | stub that sleeps past `timeout` | call bounded at 5 s; previous live file untouched; one warning per 60 s max |
| Zero cells returned | force a response with no `Cell [n]` entries | distinct non-zero status, never `cells: []` presented as "none visible" |
| Cell missing RSRP | fixture row without `RSRP:` | `"rsrp": null`, row still emitted, renders `—`, excluded from sorting |
| Serving PCI not in the list | fixture whose `Serving Cell ID` matches no cell | `serving: null`; Δ RSRP `null`, never `0` |
| No lease | hit `?range=now` once, then wait > 10 s | `live_at: null`, `cells: []`; poller stops ticking on its own |
| Stale live file | hold the file mtime back past 6 s | treated as absent, not served as fresh |
| Lease is a symlink or non-digits | write `abc` / a symlink as root | ignored — the poller trusts nothing but digits |
| Two tabs holding `now` | open two browser tabs | both renew, one live file, no double-rate ticking |
| Hidden tab | switch tab away | polling stops immediately; lease ages out within 10 s |
| 5-minute cap | leave `now` open | polling stops, no lease renewal, UI says why |
| No RTC, clock at 1970 | boot with WAN down | `age_s` neither negative nor absurd; TTL logic does not treat everything as fresh |
| Concurrent cell scan | start `cell_scan_start.sh`, then open `now` | live reads unaffected (different transport); no AT lock held by QMI |
| `/tmp` full | fill tmpfs, then tick | atomic write fails cleanly; last-good retained; one warning |
| Modem deregistered | observed live 2026-08-01 precedent | signal shown **with** `registered: false` beside it — never bare bars |
| LTE present, no NR | — | `cells` populated, NR fields `null`, no crash |

**Safety-critical subset, checked at the gate instead:** none. This feature performs
no radio write, no boot change, and writes only to `/tmp` — so nothing here can
brick or deregister the device. It runs entirely at close-out.

## Routing (`qm-orchestrate`)

**Lane: Full** — cross-layer (lib → poller → CGI → component), new backend fields.

| Flag | Agent | When |
| --- | --- | --- |
| Reads modem state | `modem-investigator` | **Already satisfied** by the on-device probe; the format is captured, not hypothesised |
| Shell script | Conductor runs it on the device first | Before merge; then `busybox-portability-checker` for residue |
| Frontend | `ui-builder` + `bun run i18n:check`, `bunx tsc --noEmit`, `bun run build`, route load | Build wave |
| Design language | `qm-redesign-review` | **Not fired** — this adds columns and one panel to an existing surface; it is not a redesign (`lanes.md`: one added card is Lite-class UI work) |

`installer-safety-auditor` does **not** fire: no unit, installer, sudoers,
`/usrdata/` layout or OTA change. The live file is `/tmp`; nothing new persists.

## Authorisation to touch the app layer

`AGENTS.md` says this branch is deployment-only and records one exception for the
speedtest favourite control, with the criterion *"it could not live in `deploy/`
alone"*. R4–R6 are a UI surface and cannot be met from the backend: an aiming view
is a component. The owner's instruction on 2026-10-22 to build this feature —
including "follow UX and UI conventions" — is that authorisation, recorded here so
the next reader does not have to re-litigate it.

Write set for this authorisation: `components/cellular/cell-scanner/**`,
`hooks/use-neighbour-scanner.ts`, `lib/`, `types/cell-scanner.ts`,
`public/locales/en/*.json`. Nothing else in `app/` or `components/`.
