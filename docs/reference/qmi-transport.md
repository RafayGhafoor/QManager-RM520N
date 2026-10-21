# QMI transport (O5A / RG520N-EB)

> **Applies to:** RG520N-EB on the GreenPacket O5A Pro (SDX6X `sdxlemur`) · measured 2026-07-20 by the greenpacket-o5a project, re-read here 2026-10-22
> **Status:** **QManager does not use QMI yet.** This doc records the contract so
> the next reader does not have to rediscover it, and so the same reasoning can be
> ported to another modem instead of re-derived.
>
> **RM520N-GL / RG501Q-EU:** unverified — see [`platform-matrix.md`](./platform-matrix.md).
> **Related:** [`at-command-transport.md`](./at-command-transport.md) (the AT path
> this complements), [`cell-scanner.md`](./cell-scanner.md) (the consumer that
> would benefit most).

> For the assessment that motivated this document — what QMI unlocks, the ranked
> backlog, and the co-residency conflict analysis — see
> [`docs/plans/2026-10-22-o5a-greenpacket-parity.md`](../plans/2026-10-22-o5a-greenpacket-parity.md).

---

## Why this exists: two independent pipes into the same modem

On this device the modem exposes **two unrelated transports**. They do not share a
lock, a buffer, or a failure mode.

| | AT (`/dev/at_mdm0`) | QMI (`qrtr://3`) |
| --- | --- | --- |
| Used by QManager today | **everything** | nothing |
| Used by greenpacket | CFUN, SMS, runbooks | serving cell, neighbours, signal, band info, CA |
| Serialization | `qcmd`'s `flock` on `/tmp/qmanager_at.lock` | none needed; QRTR multiplexes clients |
| Fixed per-call overhead | ~0.27 s port drain + settle (`deploy/atcli_smd11:75,82`) | none — no serial port |
| Measured call cost | 0.3–1.5 s typical; scans 3–6 s | **~40 ms** |
| Contends with vendor `gp-metricsd` (0.4 s poll on smd7) | **yes**, by design it must be avoided | **no** |
| Failure signature | truncated reply to a bare `OK`; stale URC bytes | `n/a` strings; empty sections |

**The design consequence:** anything QMI can answer should not be asked over AT.
On a single-core box where ~30–40 % of wall time is spent holding the AT flock
(see the parity doc §3), moving the read path to QMI is the difference between a
1 Hz live view being trivial and being impossible.

---

## Measured cost

From `greenpacket-o5a/deploy/gp-qmi.sh:5-9`, recorded by the greenpacket project:

> *"validated live on this unit 2026-07-20: neighbors/signal/band-info ~40ms,
> cell-lock get/band get OK over qrtr://3"*

And `greenpacket-o5a/deploy/radio-handler.sh:1333-1335`:

> *"fast QMI neighbors (GET /qneighbors): native NAS cell-location-info, ~40ms end
> to end, safe to poll at 1-1.5s"*

greenpacket then adds a **2 second cache** shared between its two front-ends so
that v1 polling on `:8083` and v2 polling on `:80` do not each spawn a QMI client.
That is the right shape to copy: if two consumers want the same reading, cache it,
do not double the calls.

**Not yet measured by QManager.** `scripts-dev/qmi-probe.sh` measures per-call
latency, jitter, CPU at 1 Hz, failure rate and 3-way concurrency on the device
before anything is built on top of these numbers.

---

## What QMI exposes

Producer: `/data/gp/qmi/bin/qmicli` with private `libqmi-glib` / `libqrtr-glib`
(greenpacket-owned; see §"Provenance" for why this is not QManager's shipping
path).

```sh
qmicli -d qrtr://3 --nas-get-cell-location-info   # neighbour cells
qmicli -d qrtr://3 --nas-get-signal-info          # serving LTE + NR signal
qmicli -d qrtr://3 --nas-get-serving-system       # registration state, MCC/MNC
qmicli -d qrtr://3 --nas-get-rf-band-info         # active band, channel, bandwidth
```

### Field availability

| Field | QMI | AT | Source |
| --- | --- | --- | --- |
| Serving LTE RSRP / RSRQ / RSSI / SINR | ✅ `--nas-get-signal-info` | `AT+QENG="servingcell"` | `gp-qmi.sh:186-214` |
| Serving NR (NSA) RSRP / RSRQ / SNR | ✅ same call | `AT+QENG="servingcell"` | same |
| **Neighbour cells, intra-frequency** (EARFCN, PCI, RSRP, RSRQ, RSSI) | ✅ `--nas-get-cell-location-info` | `AT+QENG="neighbourcell"` | `gp-qmi.sh:141-183` |
| **Neighbour cells, inter-frequency** | ✅ same call | same | same |
| Serving-cell identification within the neighbour list | ✅ derived by matching PCI against `Serving Cell ID` | derived | `gp-qmi.sh:155` |
| Active band / channel / bandwidth | ✅ `--nas-get-rf-band-info` | `AT+QCAINFO` | `gp-qmi.sh:216-233` |
| LTE carrier aggregation | ✅ `--nas-get-lte-cphy-ca-info` | `AT+QCAINFO` | `gp-qmi.sh:1009` |
| **NR neighbour cells** | ❌ **not available** | `AT+QNWCFG="ssb_beam_id"` | §"The NR gap" |
| Per-neighbour SINR | ❌ | partially, per CC | — |
| CQI / RI / MCS / TX power / RRC state | ❌ | limited on this firmware | parity doc §3 |

### The NR gap — read this before designing a neighbour view

`gp-qmi.sh:157-166`, `parse_neighbors()`:

```awk
/^LTE Info Neighboring/    { flush(); pci = ""; mode = ""; next }
/^5GNR/                    { flush(); pci = ""; mode = ""; next }
mode == "" { next }
```

The `5GNR` and `LTE Info Neighboring` sections are used only as flush boundaries,
then **discarded**. So `--nas-get-cell-location-info` yields **LTE intra + inter
frequency cells only**.

The only NR-neighbour source that works on this modem is the AT SSB beam table,
per greenpacket's own note at `radio-handler.sh:1481`:

```
# AT+QNWCFG="ssb_beam_id" returns one line per detected SSB beam, and its PCI
```

Parse contract (`radio-handler.sh:1534`), exact and easy to get wrong:

```
+QNWCFG: "ssb_beam_id",<enabled>,<count>,<beamid>,<rsrp>,<rsrq>,<pci>
          f[0]          f[1]      f[2]     f[3]      f[4]  f[5]  f[6]   f[7]
```

- **`f[3]` is the beam *count*, not the serving beam.**
- Reporting may be disabled (`…,"ssb_beam_id",0` with no beam rows); enable it with
  `AT+QNWCFG="ssb_beam_id",1` and let the next poll populate.
- Cost ~0.3 s and it **fails soft** — return the LTE-only list rather than an error
  (`radio-handler.sh:1487-1560`).

So the split is: **serving cell and LTE neighbours are cheap (QMI, 40 ms); NR
neighbours are expensive (AT, ~0.3 s + lock).** Design the refresh rates
accordingly rather than asking for one rate to cover both.

---

## The trap: signal is not attachment

`gp-qmi.sh:124-135`, confirmed live 2026-08-01:

> *"`--nas-get-signal-info` reports RSRP/RSRQ/SNR for whatever cell the radio can
> currently HEAR, independent of whether the modem has actually registered to it —
> confirmed live 2026-08-01: with the modem stuck at `Registration state:
> 'not-registered-searching'` (CS/PS both detached), `--nas-get-signal-info` still
> returned a plausible 5G RSRP/RSRQ/SNR the whole time. `parse_signal`'s own
> numeric-only gate … does NOT catch this case, because the values it receives here
> are real numbers, not `n/a`."*

**Rule: never render QMI signal without `--nas-get-serving-system` beside it.**
For antenna aiming this is the difference between "pointing at the right tower" and
"pointing at a strong tower you are not attached to".

---

## Conservative defaults

| Default | Value | Why |
| --- | --- | --- |
| Client concurrency | 1 outstanding read | Untested beyond 3-way; `scripts-dev/qmi-probe.sh` §5 measures it |
| Minimum interval between reads | 1 s | greenpacket's proven rate; 2 s cache above that |
| Per-call timeout | `timeout 2` for `--nas-get-*` | Compresses `QMI_CALL_TIMEOUT`; matches `gp-qmi.sh:107-114` |
| Refresh of active band / CA | ≥5 s | Slower-moving data, no user benefit from 1 Hz |
| NR beam leg | 0.3–0.5 Hz | ~0.3 s + AT lock; it is the expensive half |

**Known cost:** each read forks `qmicli`. On a single-core ARMv7 that is ~15 ms of
process startup plus the call. At 1 Hz that is a few percent of one core; at 5 Hz
it starts to matter. Measure, do not assume.

---

## Provenance — do not make the vendor binary a dependency

The only known-good `qmicli` on this box is greenpacket's:

```
/data/gp/qmi/bin/qmicli
/data/gp/qmi/lib/{libqmi-glib,libqrtr-glib,…}.so
```

`AGENTS.md` hard rule 2 names `/data/gp/*` — **including the QMI helpers** — as
vendor stack that must keep working. Invoking it **read-only** does not disturb it,
so it is acceptable for a probe or an experiment. It is **not** acceptable as
QManager's shipping path:

- it makes a core read path depend on greenpacket staying installed;
- if QManager is ever the replacement product, the dependency is a dead end;
- an unannounced greenpacket upgrade could change its private library layout.

**The production shape is QManager's own deploy-time bundle**, exactly like the
existing third-party payloads — `jq` (static ARMv7 fetched at deploy time), Ookla
`speedtest`, and `sms_tool.bin` are all deploy-time payloads, never repo content
(`deploy/README.md:70-72`, hard rule 9). Ship `qmicli` plus its `.so` files into
`/usrdata/qmanager/lib/` and resolve them the same way greenpacket does.

Dynamic-library resolution note: `gp-qmi.sh:107-114` invokes the binary by absolute
path with **no** `LD_LIBRARY_PATH`, so that build must carry an rpath to its
sibling `../lib`. A bundle that does not must set `LD_LIBRARY_PATH` explicitly —
`scripts-dev/qmi-probe.sh` detects the sibling `lib/` directory and exports it.

---

## Porting checklist for a new modem

Do these in order; each one is cheap and each one can invalidate the next.

1. **Does the vendor daemon expose QMI at all?** `ls /dev/qrtr*`; check for a
   `qmi-proxy`. No QRTR ⇒ this whole document does not apply and AT is the only
   path.
2. **Find the QRTR node.** `qrtr://3` is this device's NAS node; others differ.
   greenpacket's `gp-qmi.sh` takes `QMI_DEVICE` from the environment for exactly
   this reason.
3. **Measure one call.** If `--nas-get-cell-location-info` is not in the tens of
   milliseconds, do not build a live view on it.
4. **Capture the raw bytes** and read the section names. Do not assume `5GNR`
   exists, or that it is discarded on another firmware — check whether that
   firmware populates it usefully.
5. **Check the RDY-equivalent.** Which calls succeed while the modem is still
   booting? A reader must not cache identity or band info from an unanswered or
   half-answered call (the O5A analogue of the `"model": "RDY"` bug in
   `AGENTS.md` hard rule 8).
6. **Test concurrency** against the vendor's own QMI readers before running a 1 Hz
   loop on a production unit.
7. **Record the result in `platform-matrix.md`** — including the negative results.
   A "QMI unavailable on device X" line saves the next person a day.

---

## See also

- [`at-command-transport.md`](./at-command-transport.md) — the AT path, `qcmd`, the flock, and why `/dev/smd7` must not be used for general AT
- [`cell-scanner.md`](./cell-scanner.md) — the neighbour scanner that currently pays the AT cost
- [`platform-matrix.md`](./platform-matrix.md) — per-device facts
- [`rg501q-bringup.md`](./rg501q-bringup.md) — the shape a new-modem bring-up record should take
- `scripts-dev/qmi-probe.sh` — the read-only measurement tool
