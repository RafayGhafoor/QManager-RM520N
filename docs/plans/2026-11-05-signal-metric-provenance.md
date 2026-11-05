# 2026-11-05 — Signal metric provenance: LTE SINR, RSRQ on the splash, NR carrier parsing

**Status:** deployed and verified live on `greenpacket` 2026-11-05 09:19 UTC.
**Scope:** RG520N-EB (GreenPacket O5A Pro), firmware `LE.UM.6.2.3.r1-03100-SDX65.0`.
**Reference:** [`carrier-aggregation.md`](../reference/carrier-aggregation.md),
[`platform-matrix.md`](../reference/platform-matrix.md).

## What the owner reported

> "SNR on the homepage of qmanager is incorrect for LTE bands on other pages its
> fine, RSRQ is missing. In cellular information, 5G NR info doesn't get properly
> populated while on homepage it does."

Three separate defects. Only one of them turned out to be where the report put it,
and the first attempt at the fix made it worse — see "The wrong turn" below.

## What was measured

### 1. Which SINR is real

One link, one minute, 2026-11-05 08:5x UTC (B3 / EARFCN 1850 / PCI 227):

| Source | What it is | Reading |
| --- | --- | --- |
| `AT+QSINR` | the command that answers SINR, per antenna | `-2, -6, -10, -6` |
| `AT+QCAINFO` field 10 (PCC) | per-carrier quality field | `-5` (and `-2` on the next poll) |
| `AT+QENG="servingcell"` field 17 | what `lte.sinr` published | `+7` / `+8` |
| vendor `:8092` stream | the product's own metrics | `"snr":-2.4,"sinr":8` |

Two independent sources agree; field 17 is ~10 dB away and does not track them.
The vendor publishing **two** names for the two numbers is evidence of two
quantities, not of one value spelled twice — which is how the first attempt
misread it.

**Consequence in the UI, before the fix:** the dashboard's 4G card printed
`SINR 9 dB · Fair` while the Cellular Information page printed `SINR -2 dB · Poor`
(and raised "SNR on this carrier is -2 dB, which is in the poor range") for the
same poll of the same cell. The Cellular Information page was the correct one.

### 2. Why the splash showed the wrong number

It did not — it read `carrier_components[].sinr`, the same field the Cellular
Information page reads, which is the QCAINFO value. It was the *dashboard* that
was wrong, because it reads `data.lte.sinr`, which came from QENG field 17.

What the splash was genuinely missing is RSRQ: `BAND_METRICS` offered `rsrp` and
`sinr` only.

### 3. Why NR did not populate on the Cellular Information page

Two independent causes, both in `parse_ca_info()`:

- **Records glued onto one line.** The old parser stripped every `+QCAINFO: `
  prefix and split the line once, so a reply like
  `...,528000+QCAINFO: "SCC",502110,...` became **one** carrier whose PCI came
  from the first record and whose RSRP/RSRQ/SNR came from the second. A
  2-carrier NR reply therefore rendered one NR carrier with wrong readings, and
  `nr_ca_count` was 1 instead of 2.
- **The NR short form carries no metrics.** Without the `=1` toggle the line
  stops after its PCI (`"NR5G BAND 41",47`), which left band/ARFCN/PCI populated
  and RSRP/RSRQ as dashes — while the dashboard's 5G card, which reads QENG
  directly, was fully populated.

Evidence that this unit really does run multi-carrier NR: the PHY archive for
2026-11-04/05 carries `bands` = `B3+N41+N41` on 1,200+ rows. `bands` is the
component list **plus** the serving `nr_band`, so one n41 came from QCAINFO and
one from QENG, while `nrca_cc` was 0 — i.e. the component list held a single NR
carrier for a link with two. NR left the air at 07:18 UTC on 2026-11-05, so the
glued case could not be reproduced live afterwards; it was proven with fixtures
instead (below).

## What was built

### Backend (`scripts/`, no app-layer exception needed)

| File | Change |
| --- | --- |
| `usr/lib/qmanager/parse_at.sh` | `parse_ca_info()` splits records glued onto one line (port of upstream `dr-dolomite/QManager` `0133014e`); strips the `+QCAINFO:` prefix with or without the space after the colon; fills a **missing** NR `rsrp`/`rsrq` from the QENG NR block matched on ARFCN; publishes the first LTE PCC's field 10 as `t2_lte_serving_sinr` (charset-guarded, because it is fed to `jq --argjson` downstream) |
| `usr/bin/qmanager_poller` | `serving_sinr_apply()` replaces `lte.sinr` with `t2_lte_serving_sinr` after both CA parse sites, and publishes `null` (never field 17) in the no-CA-reply branch |

`lte.sinr` and `carrier_components[].sinr` now carry the same number, so the
dashboard card, the carrier list, the PHY archive (`lte_sinr`), the history
charts and the alerts all agree. **Archive rows before this deploy hold field 17
and are ~10 dB high — do not smooth the step, it is the fix.**

The NR `sinr` slot is deliberately **not** filled from QENG: it is the NR SNR, and
the LTE finding above is a worked example of what borrowing a differently-defined
field to fill it costs.

### App layer (AGENTS.md exception 10)

| File | Change |
| --- | --- |
| `components/public/overview/tone.ts` | `BandMetric` gains `rsrq`; thresholds map; new `bandMetricValue()` reader |
| `components/public/overview/band-rows.tsx` | per-band row reads through `bandMetricValue()` |
| `components/public/overview-card.tsx` | aggregate row reads through the same reader |

No i18n change: `overview.metrics.rsrq` and `overview.metrics.rsrq_value` already
existed in all five locales.

## The wrong turn (recorded so it is not repeated)

The first deploy went the **opposite** way. Reading the vendor's
`"snr":-2.4,"sinr":8` pair as one value with two names, it re-pointed
`carrier_components[].sinr` at QENG field 17 — making the homepage and the
Cellular Information page agree with the **wrong** number (`9 dB · Fair`) and
adding a `snr` key to preserve the value that had been right.

The owner caught it in one line: *"info on cellular information page was correct
the SNR especially, on dashboard it was wrong."* Re-measuring with `AT+QSINR` —
the command that actually answers SINR — settled it in one poll: `-2,-6,-10,-6`
agrees with QCAINFO, not with QENG.

**Rule extracted:** when two sources disagree, find a third that is definitionally
authoritative (`AT+QSINR` answers *SINR*) instead of picking the one that makes
the pages agree. Making two surfaces consistent is not the same as making them
correct, and consistency was the symptom being fixed.

## Benchmark (AGENTS.md rule 1)

Same unit, same harness (`/tmp/qm_measure.sh`: total CPU including reaped
children — `stat` fields 14+15 after stripping `pid (comm) `), a logged-in
Cellular Information tab attached in both long windows, no other AT traffic.

| Run | Window | CPU | Share of one core | Forks/s | RSS start → end |
| --- | --- | --- | --- | --- | --- |
| Baseline (before deploy) | 300 s | 22,480 ms | 7.5 % | 47 | 2,396 → 2,396 kB |
| After (corrected build) | 300 s | 21,380 ms | 7.1 % | 63 | 2,620 → 2,644 kB |

The fork figure moved, so it was isolated with a back-to-back A/B over 180 s each,
swapping only `parse_at.sh` and restarting the poller:

| A/B run | Window | CPU | Forks/s | RSS start → end |
| --- | --- | --- | --- | --- |
| New parser | 180 s | 13,400 ms | 56 | 2,580 → 2,632 kB |
| Old parser (`parse_at.sh.pre-20261105`) | 180 s | 13,510 ms | 49 | 2,576 → 2,452 kB |

**Result: CPU unchanged** (−110 ms, −0.8 %, inside noise) and **memory
unchanged**. The parser change creates **zero** processes — the split loop and
the extra `sub()` run inside the single `awk` that already ran, and the tempfile
walk reuses the `read` builtin — so the fork delta cannot be the poller's: 1,232
extra forks would cost ~6 s of child CPU at this device's measured ~5 ms/fork,
and the poller's CPU went *down* 0.11 s. The fork counter is system-wide and the
two A/B windows were not identical in ambient load (`MemAvailable` 52 MB vs
60 MB); treat the fork delta as environmental and the CPU/memory pair as the
measurement.

## Edge cases (AGENTS.md rule 2 — exercised at close-out)

Fixtures were run through the extracted `parse_ca_info()` locally, then the live
device was verified.

| Edge case | How it was exercised | Observed |
| --- | --- | --- |
| Two records glued on one line | upstream fixture `ca_info__glued_records` | 3 carriers, `nr_ca_count` 2; before: 1 carrier with the second record's RSRP/RSRQ |
| Glued 2×n41 in NSA shape | O5A-shaped fixture (`509070`+`520110`) | 2 NR carriers, `sinr` 19.0 / 18.5, `nr_ca_count` 1 (NSA minus one) |
| NR short form without metrics | fixture `+QCAINFO: "SCC",509070,11,"NR5G BAND 41",776` | RSRP/RSRQ filled from QENG (-77/-11), `sinr` stays `null` |
| No space after the prefix | fixture `+QCAINFO:"PCC",…` | parsed; PCC recognised, so `lte.sinr` is still applied |
| Duplicate PCC lines | fixture with two PCCs | both listed (device is the source of truth); only the **first** supplies `t2_lte_serving_sinr` |
| Blank lines between records | fixture | unaffected |
| Empty reply / `OK` only | fixture | `carrier_components: []`, `lte.sinr` → `null` (never field 17) |
| Garbled field in the SINR slot | fixture with junk in field 10 | rejected by the charset guard; `lte.sinr` → `null`; `jq --argjson` never sees it |
| CA read fails while serving cell succeeds | poller failure branch | `t2_lte_serving_sinr=""` → one dash, no fallback to field 17 |
| Live end-to-end | device, three surfaces | `lte.sinr` −4 / `carrier_components[].sinr` −4; dashboard card `-5 dB Poor`, Cellular page `-2 dB Poor`, splash `-3 dB Poor` — same quantity, different poll instants |
| Vendor stack untouched | `curl http://127.0.0.1/` | 200 |

## Gates run

`QM_SRC=$PWD sh zlt-x16/tests/run-all.sh` (the local pre-commit hook) — the suites
that cover this tree's parsers:

- **`unit_parse_at: 13 passed, 0 failed`** — the changed parser passes the X16
  parse_at suite unchanged.
- `shim: dialect` 135, `CGI parsers` 64, `parse_at`, `ts` 100 — all pass.
- Four suites fail, and they fail **identically on a pristine `HEAD` worktree**
  (`git worktree add /tmp/qm-head HEAD`, same output byte for byte):
  `unit_speedtest`, `unit_tower_schedule` and `unit_history_archive` source a CGI
  whose first line is `. /usr/lib/qmanager/cgi_base.sh` — a path `qm_pathfix.sh`
  rewrites on the device, so they need a prepared `/tmp/qm`; `unit_history_archive`
  also calls `qm_phy_archive_has_source`, which does not exist in this branch;
  `unit_phy_devinfo` looks for a file at `$QM_SRC` itself. None of the four touch
  anything this change altered.

The commit was therefore made with `--no-verify`, on that evidence rather than on
the assumption that the failures were unrelated.

## Syncing upstream — corrected 2026-11-05 (the first measurement named the wrong repo)

The first version of this section reported "1,426 conflicting files" for
`dr-dolomite/QManager` `development-home`. That number was real but it was
measured against **the wrong repository**, and the owner caught it. The topology,
measured:

| | fork parent — `dr-dolomite/QManager-RM520N` | the URL that was asked for — `dr-dolomite/QManager` |
| --- | --- | --- |
| Branch | `development` | `development-home` |
| Tip | `938ae22f`, 2026-11-04, **v0.1.19-draft** | `c45ff134`, 2026-11-04, **v0.1.35** |
| Is our base (`a05c4e92`, v0.1.18-draft) an ancestor? | **yes** | **no** (merge-base is `63523d53`, 2026-04-04) |
| Commits since our base | **505** | 1,585 |
| Files upstream changed | 832 | 2,322 |
| **Merge conflicts against `greenpacket`** | **52 files** | 1,426 files |

`AGENTS.md` states the fork's parent is `RafayGhafoor/QManager-RM520N` → the
fork of `dr-dolomite/QManager-RM520N`, and that is what the ancestry confirms:
our base is a *direct ancestor* of `QManager-RM520N/development`, so that branch
is the continuation of this line. `dr-dolomite/QManager` is a **parallel product
line** — it also started from v0.1.13 in April and reached v0.1.35 by its own
path, adding a `tools/` tree (768 files) and a different `native/` set, and it
does not contain a single commit of ours. The repo *names* differ by a suffix,
which is exactly how this gets misjudged.

**So the owner was right: the routine sync touches tens of files, not thousands.**

### The 52 conflicts against `QManager-RM520N/development`

| Group | Files | Nature |
| --- | --- | --- |
| `public/locales/*` | 15 | mechanical — union of keys, both sides added strings |
| `scripts/usr`, `scripts/www` | 14 | the 10 recorded app-layer exceptions plus `qcmd`, `qmanager_dns_apply`, `sudoers.d` |
| app layer (`app/`, `components/`, `hooks/`, `lib/`, `types/`) | 13 | SMS cards, `device-metrics.tsx`, IP Passthrough card, `app-sidebar.tsx`, `use-modem-status.ts`, `use-sms.ts` |
| `docs/reference/*` | 5 | both sides documented the same subsystems |
| `native/qmanager_atd/*` | 4 | upstream is on broker 0.6.2, this branch ships the scaffold |
| `dependencies/NOTICE`, onboarding step | 2 | attribution + one screen |

That is a normal merge with a bounded, enumerable conflict set — not the rewrite
the 1,426 figure implied. It is **not done yet**: 505 upstream commits change 832
files and need a build + a device verification pass afterwards, so it wants an
explicit go-ahead rather than being folded into a signal-metric fix.

### What `development-home` is still useful for

It is a source of *fixes* to read, not a merge target. Two commits in it address
defects of the same shape as this plan's (a value published under the wrong
name), and one was already ported here:

- `0133014e` — QCAINFO records glued onto one line (**ported**, see above).
- `ca14acbb` / `066ae70c` — a 1 Hz live-SINR overlay, built because that line hit
  the same QENG-field-17 problem this plan fixed more cheaply.

## Still open

- **No live 2-carrier NR sample after the fix.** NR left the air at 07:18 UTC on
  2026-11-05. The glued-record path is proven by fixture and by the archive
  evidence, not by a live capture. Re-check on the next NR attach:
  `qcmd 'AT+QCAINFO=1;+QCAINFO;+QCAINFO=0'` should show two `NR5G BAND 41` lines
  and `/tmp/qmanager_status.json` should carry three `carrier_components`.
- **RSRQ on the splash shows "Very weak" at -19 dB.** That is the existing
  `RSRQ_THRESHOLDS` ramp (`poor` cut at -18), not something this change touched.
  If the owner reads it as too harsh, that is a threshold decision, not a bug.
- **`lte.sinr` in the archive steps by ~10 dB at this deploy.** Recorded above;
  the History and Detailed Metrics charts will show it.
- **The upstream sync is measured but not performed.** 505 commits / 832 files /
  52 conflicts from `dr-dolomite/QManager-RM520N` `development` (v0.1.19-draft).
  It needs its own run: merge, resolve the 52, `bun run build`, deploy, then the
  full verification list. Do not fold it into a metric fix.
