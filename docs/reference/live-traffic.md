# Live Traffic

> **Scope:** `RG520N` — measured on the GreenPacket O5A Pro (Quectel RG520N-EB,
> SDX6X `sdxlemur`, BusyBox 1.36.1, `uname -m` = `armv7l`) on 2026-10-24.
> **Not** a claim about the RM520N-GL, RG501Q-EU or the Suncomm X75. A port must
> re-measure the two throughput figures and re-check the counter name — see
> *What a port must re-measure*.

The dashboard's **Live Traffic** row: WAN download/upload rate in bits per
second, sampled once a second from the kernel's byte counters, switchable off.
One native sampler produces it, busybox httpd serves it as a **static file**, and
the browser reads it once a second. There is no CGI on this path and no daemon
per reader — both were measured and rejected, see *Why it is not a CGI*.

## Quick reference

| Item | Value |
| --- | --- |
| Producer | `native/qmanager_traffic` (Rust, no dependencies) → `/usrdata/qmanager/bin/qmanager_traffic` |
| Unit | `/etc/systemd/system/qmanager-traffic.service` (source `deploy/`, `Type=simple`, `Restart=always`) |
| Boot | `qm_boot_hook.sh`'s `UNITS` — this firmware needs the hook, not just `enable` |
| Engine document | `/tmp/qmanager_traffic.json` (tmpfs, atomic rename, replaced every tick) |
| Served as | `/usrdata/qmanager/www/live-traffic.json` → **symlink** to the above |
| Endpoint | `GET /live-traffic.json` — static, **no auth**, no CGI |
| Counter | `/proc/net/dev`, netdev + orientation from `/usrdata/qmanager/data_used.json` |
| Clock | `/proc/uptime` (monotonic, fractional) |
| Cadence | 1000 ms (`QMT_INTERVAL_MS`, clamped 200–10 000) |
| Reader | `hooks/use-live-traffic.ts` (1 Hz, visibility-gated) + `components/dashboard/device-metrics.tsx` |
| Cost, sampler | **0 jiffies / 60 s**, RSS **184 kB**, 1 thread |
| Cost, row ON at 1 Hz | **~5.2 ms CPU + ~1.4 forks per read** ≈ 0.5 % of one core |
| Cost, row OFF | 0 requests |
| Env overrides | `QMT_INTERVAL_MS`, `QMT_OUT`, `QMT_DATA_USED`, `QMT_PROC_NET_DEV`, `QMT_PROC_UPTIME`, `QMT_ONCE=1` |

## Why it is not a CGI, and why not a stream

Measured on this unit 2026-10-24, 100 requests, one client process (its own cost
amortised out), device otherwise idle:

| Transport | CPU per read | forks per read | at 1 Hz |
| --- | --- | --- | --- |
| CGI `public/overview.sh` (jq) | 69.3 ms | 7.44 | ~6.9 % of one core |
| CGI, bare `cgi_base.sh` + printf | 16–26 ms | 1.5–2.2 | ~2 % |
| **static file via httpd** | **9.0 ms** | 1.40 | **~0.9 %** |

Storage for comparison: the whole modem poller runs at **6.3–7.8 %** of the same
core. A CGI polled at 1 Hz would therefore cost as much as the poller, for two
integers — and two thirds of that floor is not the endpoint's own work: sourcing
`cgi_base.sh` already costs 1.5–2 forks, and one `qlog_warn` line costs ~3 more
(`date` + `wc -c` + `logger`), which is why the endpoint that was tried first
measured 107 ms and 8 forks.

So the rate is **precomputed** by one process and served statically. Two
consequences worth knowing before changing it:

- **The docroot entry is a symlink into tmpfs.** Writing the document into
  `/usrdata/qmanager/www` directly would be ~130 MB/day of write amplification on
  ubifs to remember two integers. Verified that this httpd serves through the
  symlink (`curl http://127.0.0.1:8080/live-traffic.json` → 200).
- **Never ship a real `www/live-traffic.json`.** A file of that name in `public/`
  is copied into `out/` by `bun run build` and *replaces* the symlink on the next
  deploy, freezing the row at whatever the build contained. This happened twice
  during development — the second time it served fabricated test values to the
  live dashboard. Two guards now exist and neither is optional:
  `deploy/qm_pathfix.sh` unconditionally `rm -f`s and re-creates the link on every
  deploy (it is already the must-run-after-every-deploy step), and the unit's
  `ExecStartPre` re-does it on start.

No WebSocket and no SSE: busybox httpd cannot upgrade a connection, and the port
the sibling product uses for its stream (`:8092`) belongs to the vendor stack
(AGENTS.md Hard rule 2). A second listener would be a second process, a second
port and a second auth story for a two-number payload.

## Where the numbers come from

The **same kernel counter** the persistent Data Used row counts — netdev name and
the rx/tx field orientation are read at runtime from `data_used.json` (schema v5;
see [data-usage-counter.md](./data-usage-counter.md)). The sampler deliberately
does not re-derive either: `rmnet_dataN` migrates across attach cycles
([ttl-mtu.md](./ttl-mtu.md), `mtu.sh`) and the orientation map is keyed off the
SoC. If the two rows ever described different interfaces, a user watching both
would see the total climb while the rate reads zero.

On this unit the resolved counter is `rmnet_ipa0`, orientation `normal` (rx =
field 2, tx = field 10 of the line). Direction was confirmed independently rather
than assumed — over a 10 s window `rmnet_ipa0` rx grew 19 224 950 B while
`bridge0` tx grew 19 380 543 B, i.e. bytes arriving on the WAN are the bytes the
LAN received:

```
rmnet_ipa0  rx 1834928253 → 1854153203   tx 909615650 → 911849756
bridge0     rx  902658179 →  904744155   tx 1855228170 → 1874603713
```

If the selected netdev is absent from `/proc/net/dev`, the busiest `rmnet*` device
is used and `iface` in the document says which — the sibling's "largest delta
wins" heuristic, applied to the total.

## The document

One line, replaced atomically (`O_CREAT|O_EXCL` temp name + `rename`, so a reader
never sees half a document and a planted symlink in `/tmp` cannot redirect it):

```json
{"ok":true,"iface":"rmnet_ipa0","rx_bps":187080,"tx_bps":86088,"window_ms":1000,"warming":false,"counter_reset":false,"ts":1792804680}
```

| Field | Meaning |
| --- | --- |
| `rx_bps` / `tx_bps` | bits per second, download / upload |
| `window_ms` | the interval actually averaged (`/proc/uptime` delta) |
| `warming` | no rate yet — first tick, or a gap > 10 s. **Never render as 0 bps** |
| `counter_reset` | the counter went backwards (modem reboot / netdev re-created) |
| `ts` | wall clock at the sample; how a reader tells stale from quiet |
| `ok:false` | `error` + `detail` — the counter could not be read at all |

Guards, all covered by host tests: `dt` < 150 ms hands back the previous window's
figure *without* moving the anchor; `dt` > 10 s is `warming` with a fresh anchor;
a backwards counter is `counter_reset` with 0 rates.

## Reading it

`hooks/use-live-traffic.ts` polls `/live-traffic.json` at 1 Hz with
`cache: "no-store"`, and pauses while the tab is hidden — the same three rules as
`use-detailed-metrics.ts`. It adds one rule of its own that this transport needs:
**a 200 can be stale**. A dead sampler leaves the last document on disk, so the
hook compares `ts` between reads and, after two identical timestamps, reports
staleness and the row draws `—`.

The row itself is a `PillRow` above Data Used, with the card's existing direction
inks and glyphs. It is deliberately **not** wrapped in `TickingValue`: that
component dips the figure on every change, and a 1 Hz rate would dip once a
second.

## Units: bytes per second, not bits

The document carries **bits** per second (the canonical rate unit, and what the
sampler's own contract states). The row renders **bytes** per second —
`formatBytes(bps / 8) + "/s"` — because:

- Data Used directly below is a byte total, so `1.1 MB/s` above `37.4 GB` is one
  measurement in one unit family;
- the sibling product renders the same counter the same way
  (`greenpacket-o5a`, `v2/src/pages/Dashboard.svelte:80`:
  `formatBytes(n) + '/s'` over gp-metricsd's bytes/s), and that is the number the
  owner compares against.

The first deploy shipped `Mbps`, which read ~8x larger than the product UI during
the same transfer — reported, correctly, as wrong results. `formatBitsPerSec()`
still exists in `types/modem-status.ts` for anything that wants the bit figure;
changing the row to it again means changing the tooltip copy in all five locales
with it.

## The switch

`CardHeader`'s `CardAction` holds a `Switch` (44 px target via `SWITCH_TARGET`),
persisted per browser as `qm_live_traffic` and read through
`useSyncExternalStore` — the server snapshot is `true` (what the prerendered HTML
shows), the client snapshot is the stored value, so the two cannot disagree during
hydration. Off unmounts the hook, and the browser then issues **no request at
all**; the sampler keeps running because it costs 0 jiffies.

There is no server-side lease, on purpose: a static document gives the server no
signal that anyone is watching, and inventing one costs more than the sampling.

## What a port must re-measure

1. **The counter name and orientation** — read `selected_counter` /
   `orientation` from the device's `data_used.json`; both are per-SoC facts
   recorded in [data-counter-platform-matrix.md](./data-counter-platform-matrix.md).
2. **The static-vs-CGI cost** — the 9.0 / 69.3 ms pair is this SoC and this
   httpd. A slower box widens the gap (better for this design); a faster one may
   make a CGI viable again, but measure before assuming it.
3. **That the docroot symlink is served** — a server that refuses symlinks (or a
   docroot with `-n`) would serve 403/404 instead.
4. **The `rmnet*` fallback** — it exists because the aggregate netdev name is a
   firmware fact, not a contract.
