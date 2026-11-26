# 2026-11-05 — Cell Distance rows, and an app-wide status header

Owner, in one message:

> "lte cell distance, nr cell distance not being shown"
> "also let's add a header to the UI, so it shows important stuff, maybe at top right 3 icons? useful stuff, design however you want"

Two independent asks. The first turned out to be a *reading* problem, not a
broken endpoint; the second is a new surface.

---

## 1. Cell Distance — what was actually wrong

### Intended

Find out why both rows under Device Metrics were blank and make them state what
the modem actually reports.

### Measured (live unit, 2026-11-05)

| Probe | Answer |
| --- | --- |
| `jq '{lte_ta:.lte.ta, nr_ta:.nr.ta, rat:.network.type, lte:.lte.state, nr:.nr.state}' /tmp/qmanager_status.json` | `.lte.ta = 0`, `.nr.ta = -512`, `rat = 5G-NSA`, both legs `connected` |
| `.lte.pci` / `.nr.pci`, `.lte.band` / `.nr.band`, `.lte.rsrp` / `.nr.rsrp` | 420 / 776, B3 / N41, −69 / −77 dBm |
| `AT+QNWCFG="lte_time_advance",1` then query | `+QNWCFG: "lte_time_advance",1,0` |
| `AT+QNWCFG="nr5g_time_advance",1` then query | `+QNWCFG: "nr5g_time_advance",1,-512,0` |
| The same two, reporters held ON for 50 s with a 2 Hz ping running | **unchanged** — so this is the modem's report, not a read-too-early artefact. `qmanager-poller` was stopped for this probe so its `ca_ext_off` could not re-disable the reporters mid-test; it was restarted immediately after |
| Same commands, 2026-10-22 (`docs/reference/carrier-aggregation.md`) | `1968` latched, and `.nr.ta = 24576` (≈1.9 km) |
| Anchor cell then vs now (archive `metrics/2026-10-25.csv` vs today) | B1 / EARFCN 250 / NR PCI 47 → **B3 / EARFCN 1850 / NR PCI 776** |

So: the backend is fine and the values are the modem's own. Both frontend guards
(`ta <= 0` → null, `nta <= 0` → null) discarded them, and the rows printed `—`.

### Built

`types/modem-status.ts` gained the reading model — `readLteDistance()`,
`readNrDistance()`, `formatCellDistance()`, `formatDistanceBound()` and the two
unit constants — with four states: `measured`, `at_reference`, `out_of_range`,
`absent`. Only the first two print a number, and `at_reference` prints a `≤`
bound because the figure is the width of one quantisation step, not a
measurement. A `connected` flag is what separates "index 0 = inside the first
78 m step" from "index 0 = the modem has nothing to report".

Both surfaces go through it: the dashboard's two rows
(`components/dashboard/device-metrics.tsx`) and the Connection details card's
Timing Advance row (`components/cellular/radio/cellular-information-card.tsx`).
Two new tooltip strings per locale explain the `at_reference` and
`out_of_range` states.

Result on this unit today: **LTE `≤ 78 m`**, **NR `≤ 39 m`** — both replaced a
blank that had been there for weeks.

### Still open / caveats

- The **absolute** distance to the tower is still not claimable from a
  reference reading: `≤ 78 m` is an upper bound, and the same 0/−512 pair on a
  cell 2 km away would look identical. The tooltip says so.
- No before/after CPU benchmark is attached **because this change adds no work
  to the hot path**: it is two pure functions in the browser, called on data the
  poller was already publishing. There is no poller, CGI or AT cost to measure.
- Worth re-reading this in a month: if the anchor returns to B1 and
  `nr5g_time_advance` answers large and positive again, the reference reading
  was a property of that cell, not of the firmware.

---

## 2. The status strip in the top bar

### Built

`components/app-status-strip.tsx`, mounted as the second child of the existing
`<header>` in `components/app-layout.tsx`. Three lanes, each a link to the page
that owns its number:

| Lane | Glyph | Value |
| --- | --- | --- |
| Connection | six-state map (`cell_tower`, `priority_high`, `radar`, `signal_disconnected`, `airplanemode_active`, `help`) | `Jazz · 5G-NSA` |
| Signal | wedge ladder (`signal_cellular_{0..4}_bar`) from the serving leg's RSRP | `-77 dBm` |
| Live traffic | `swap_horiz` | `↓ 610 kB/s · ↑ 3.1 MB/s` |

Values hide below `desktop` (68.75rem); glyphs stay. Every string lives in
`common.json` > `statusStrip` in all five locales. `bun run i18n:check` → 0
errors.

### Cost

Both polls stop while the tab is hidden, and both are slower than the
dashboard's:

| Poll | Cadence | Per read (measured, `docs/reference/live-traffic.md`) |
| --- | --- | --- |
| `at_cmd/fetch_data.sh` (cached CGI) | 10 s | ~69 ms CPU, 7.4 forks → ~0.7 % of one core |
| static `/live-traffic.json` | 1 s | 9.0 ms CPU, 1.4 forks → ~0.9 % of one core |

**Unmeasured:** the *end-to-end* effect of the strip on a page that previously
polled nothing (e.g. `/monitoring/alerts`) has not been benchmarked on the
device — the per-read figures above are the ones already recorded for these two
endpoints, and the strip issues no other traffic.

### Verified

- `bunx tsc --noEmit` clean, `bunx eslint` clean on all changed files,
  `bun run build` succeeded, `bun run i18n:check` 0 errors.
- Deployed UI-only (`out/` extracted INTO `/usrdata/qmanager/www`, never
  replacing it) and ownership normalised (`chown -R root:root`): `/`,
  `/dashboard/`, `/cellular/`, `/setup/`, `/login/`,
  `/cellular/detailed-metrics/` all 200; vendor UI on `:80` still 200;
  `qmanager-httpd`, `-poller`, `-ping`, `-dpi`, `-traffic` all `active`.
- Not visually reviewed on the device: the install is in `setup_required` and
  claiming it to take a screenshot is not something to do on the owner's box.
  Layout reviewed against `DESIGN.md` (36px lanes in a 64px bar, glyph carries
  state, ramp ink not used on a numeral without a bar).

---

## Next

1. Look at it on a real screen — especially the 1100-1300 px band where three
   values plus breadcrumbs are tightest.
2. If the strip proves useful, the same three facts are what the pre-auth
   overview splash already shows; do not copy the strip there.

---

## 3. The live aim screen stopped blanking (2026-11-05, later)

Owner: *"during live like neighbours scan and others, the screen disappears, I
think we should serve those few seconds through cache"*.

**Cause.** `?range=now` answers `live_at: null` **with `cells: []`** both when the
poller has not published and when its sample aged past the CGI's 6 s window, and
the browser cannot tell those apart. `fetchLive` replaced the sample with that
empty one, so the aim card, both serving figures and every neighbour row vanished
for a beat — the publish and the read are unsynchronised, so it happened several
times a minute.

**Built.** `hooks/use-neighbour-scanner.ts` holds the previous sample and ages it
one tick per dropped read (`NeighbourLiveView.stale = true`); `aim-strip.tsx`
labels it with a warning chip ("Not updating · last sample N s old"), and the
trend/beeps/voice are suppressed while held, so a frozen reading cannot be heard
as "steady".

**Not built:** no server-side cache. The sample already exists in `/tmp` on the
device (the poller writes it); the blank was a client-side replacement, and
holding it there is the smaller, more honest fix. A CGI-side cache would also
paper over a genuinely stopped sampler.

## 4. The aim surface, re-scaled, with an audible aid (2026-11-05, later)

Owner: *"redesign the neighbour screen for live and read both … the font should be
larger and easier to read. The idea is when using directional or parabolic
antenna"*, and *"add a voice mode so it gives beeps when moving to tell you if the
signal is improving … and also speaking mode"*.

**Built (type).** `AIM` in `cell-scanner/shapes.ts` is one step up across the
board: serving figure 34px → 52px, neighbour value 16px, PCI 15px, band and
eyebrow 13px, taller neighbour rows. Figures stay `Numeric` (slot-sized), so this
does not bend the ramp — it is a surface-scoped step, recorded in
[`docs/reference/cell-scanner.md`](../reference/cell-scanner.md) with the reason.

**Built (direction).** A trend chip beside the serving RSRP: `arrow_upward` +
"Up N dB", `arrow_downward` + "Down N dB", `graphic_eq` + "Steady". Three glyphs,
because a fill difference is not a difference in sunlight.

**Built (audio).** `lib/aim-audio.ts` (pure: `aimTrend`, `toneHz`, `shouldBeep`,
`toneMs`, the gap constants) and `hooks/use-aim-audio.ts` (Web Audio note with a
real envelope, `speechSynthesis` line, both opt-in and persisted). One decision
feeds the chip, the beep and the spoken line, so they cannot disagree. A 2 dB
hysteresis means jitter does not beep; only a move does.

**Still open / caveats**

- **Not heard on a phone.** The note/timing were chosen from measurements of the
  sample rate (1 Hz) and the trend hysteresis, not from a listening test on the
  device; the volumes (peak gain 0.18) and the 392/1046.5 Hz pair are a first
  guess that should be tried outdoors before being treated as tuned.
- **No before/after benchmark** for this change: nothing here adds work to the
  device. The audio runs in the browser, and the hold removes requests rather than
  adding them.
- The sweep page (`/cellular/cell-scanner`) was **not** redesigned — it is a read,
  not an aim, and it does not blank. Only its shared shapes module changed.

## 5. The aim page, rebuilt around one question (2026-11-05, later)

Owner: *"This should have been redesigned from scratch … should have better UX."*

**What was wrong.** The live range rendered two cards that listed the SAME cells:
the aim strip ranked three neighbours, and directly beneath it a sortable table
listed them all with its own band filter and row limit. Nothing told the reader
which to look at, so while turning a dish they read neither. The actions that
matter in the field (pause, silence the beeps) were at the bottom of the strip
and inside the table's toolbar.

**Built.** `aim-strip.tsx` is now a console in priority order — hero RSRP
(48/64px) + trend chip + a 60-sample trace, then SINR/RSRQ/RSSI as one row, then
the top four neighbours with peak ticks — with **one toolbar at the top** holding
the range picker, pause, export and both audio toggles. The table is behind a
count-labelled disclosure (`All N cells heard` / `Hide the list`) and stays open by
default in `last`.

**Corrected in the same pass:** the first cut of the console's load state, its
sr-only quality words, and the trend-chip glyph mapping (three states need three
glyphs — `arrow_upward`, `arrow_downward`, `graphic_eq`).

**Not verified:** the layout has not been looked at on a screen by anyone but the
code's author; the 64px hero and the 3-up secondary row are sized from the
card-width breakpoints, not from a screenshot. That is the first thing to check on
the device.
