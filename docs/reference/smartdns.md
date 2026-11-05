# SmartDNS on the O5A Pro — the resolver QManager owns

> **Scope:** measured on the **O5A Pro** (`RG520N-EB`, `LE.UM.6.2.3.r1-03100-SDX65.0`),
> 2026-10-23/24. The resolver is portable; the **addresses, the provider latencies and
> the `192.168.x` LAN IP are not** — a port must re-measure all three.

**Specs:** [`../specs/smartdns-o5a.md`](../specs/smartdns-o5a.md) (absorption),
[`../specs/dns-edge-selection.md`](../specs/dns-edge-selection.md) (the algorithm and
the API contract).
**Work record:** [`../plans/2026-10-23-dns-ping-latency-attribution.md`](../plans/2026-10-23-dns-ping-latency-attribution.md).

---

## What it is, and where it sits

smartdns-rs **0.13.1** (GPL-3.0, vendored at `dependencies/smartdns/`, attributed in
`dependencies/NOTICE`) is a **loopback cache-and-race resolver**. It is *not* the
LAN-facing resolver:

```
LAN client ──▶ dnsmasq 192.168.0.1:53 ──strict-order──▶ smartdns 127.0.0.1:5353 ──▶ DoH pool
                      (DHCP, leases,                          (cache 8192,
                       cache 2000)                             serve-expired, groups)
                   │
                   └── falls through to the carrier resolvers (119.160.122.146 / .80.146)
```

That layering is what makes the on/off toggle **safe**: stopping `qmanager-dns.service`
degrades LAN DNS (slower, longer tail) instead of breaking it, because dnsmasq's
`strict-order` already has the carrier as its next tier. The toggle changes nothing in
dnsmasq.

Absorbed from the sibling product (`greenpacket-o5a`) on **2026-10-24**. Its boot
guarantee had been an `ExecStartPost` inside the **vendor's** `gp-radio.service` — which
would have outlived the deprecated repo with nobody reading why it existed. It is now
a `deploy/qm_boot_hook.sh` line (hard rule 7).

## Triggers — open this document when you touch any of these

| Trigger | Where |
| --- | --- |
| `qmanager-dns.service`, `qmanager-dns-edge.{service,timer}`, `qmanager-dns-stats.{service,timer}` | `/etc/systemd/system/` |
| `qmanager-dns-wire.{service,timer}` | `/etc/systemd/system/` — the guard that keeps dnsmasq forwarding here |
| `qmanager_dns_apply`, `qmanager_dns_edge_probe` (`--carrier`), `qmanager_dns_test`, `qmanager_dns_stats_sample`, `qmanager_dns_wire` | `scripts/usr/bin/` → `/usrdata/qmanager/bin/` |
| `# BEGIN QMANAGER-WIRE v1` … `# END QMANAGER-WIRE v1` | the forwarding block `qmanager_dns_wire` owns inside the dnsmasq config |
| `smartdns.sh`, `smartdns_stats.sh`, `dns_test.sh` | `scripts/www/cgi-bin/quecmanager/network/` |
| `/usrdata/qmanager/etc/smartdns.conf` (the live config, `root:root 0600`) | written **only** by `qmanager_dns_apply` |
| `# BEGIN QMANAGER-EDGE v1` … `# END QMANAGER-EDGE v1` | the *generated* block inside the config |
| `{"ok":false,"error":"edge_block_unterminated"}` from `apply-edge` | a `BEGIN QMANAGER-EDGE` with no `END`; the rewrite was **refused** because it would discard the rest of the config (see fact 5) |
| `/tmp/qmanager_dns_edge.json` | last measured decision (tmpfs) |
| `/tmp/qmanager_dns_stats_history.json` | the 5-minute counter ring (tmpfs, 288 rows) |
| `/tmp/smartdns.log` | daemon log, `log-level warn`, capped 128 kB ×2 |
| the `/local-network/smartdns` route | the page |

## The five load-bearing facts

1. **`smartdns test -c` validates NOTHING on 0.13.1.** Measured: it accepts
   `totally-bogus-directive foo`, `speed-check-mode bogusmode` and `bind not-a-port`,
   exiting 0, and unknown directives are silently ignored. **Never gate a config
   deploy on it.** `qmanager_dns_apply` runs the candidate on a throwaway port
   (`15353` by default) and requires it to bind **and** answer before swapping.
2. **dnsmasq does report a cache-hit count**, so a hit rate needs no sampling window:
   `queries forwarded 749, queries answered locally 477` → `38.9 %` from one reading.
   ⚠️ An earlier revision of the specs claimed the opposite — written from memory, not
   from the log line. Corrected 2026-10-24.
3. **ICMP is honest here.** The far/near Google latency classes were confirmed with
   TCP/443 `time_connect` (`142.250.203.14` 67 ms vs `192.178.211.93` 340 ms), so the
   speed-check necromancy is not an ICMP artefact.
4. **The vendor keepalive sweep poisons DNS measurements.** `gp-keepalive` runs a
   calibration sweep that saturates the uplink; during one (23:40–23:57 on 2026-10-23)
   DoH times out and smartdns answers SERVFAIL. Check
   `tail -1 /tmp/gp-keepalive.log` before trusting any DNS latency figure, and do not
   let a refresh decide provider membership mid-sweep — the timer's
   `RandomizedDelaySec` exists to reduce the collision.
5. **A marker block is rewritten structurally or not at all.** `build_edge_candidate`
   strips `BEGIN…END` and exits **4** if it reaches EOF still inside the block; the
   `apply-edge` dispatch turns that into
   `{"ok":false,"error":"edge_block_unterminated"}`. A one-way `skip` flag would drop
   every line after such a `BEGIN` — the rest of `smartdns.conf` — and the
   throwaway-port validator would accept it, because a truncated config binds and
   answers fine. Measured 2026-10-26: block-free body + an injected `BEGIN` with no
   `END` → refuse, 371 lines preserved; the healthy path still exits 0 and is
   `cmp`-identical on a second run. Same defect class as `custom_dns.sh`'s dnsmasq
   sentinel strip, fixed the same day — see [`custom-dns.md`](./custom-dns.md).

## Edge selection — why the config is generated, not written

Two latency classes exist per Google property, and **which one a client gets depends on
which upstream answered**:

| measured class | providers (2026-10-24) |
| --- | --- |
| near 58–70 ms | `dns.google`, `dns.quad9.net`, `doh.opendns.com` |
| far 336–348 ms | `cloudflare-dns.com`, `1.1.1.1`, `unfiltered.adguard-dns.com`, `sky.rethinkdns.com` |
| mixed | `dns.nextdns.io` (near for one probe domain, far for others) |

A hand-written member list was measured wrong twice: it omitted `adguard`/`rethinkdns`
(both far) and could not express `nextdns` being mixed. So the block is **regenerated
from measurement** every 30 min by `qmanager-dns-edge.timer` →
`qmanager_dns_apply apply-edge`:

```
probe every upstream per probe domain → median RTT → keep ≤ THRESHOLD_MS (150)
→ rewrite the EDGE block → validate on a throwaway port → swap → restart → verify
→ roll back on failure
```

**Measured effect, live on the LAN:** `youtube.com` went from `192.178.211.x`
(341 ms) to `142.250.201.110` (**63 ms**) — 5.4×, and the tester reports
`fastest 58 ms · slowest 343 ms · spread 285 ms`.

Tunables (env): `THRESHOLD_MS`, `MIN_MEMBERS`, `MAX_IPS`, `PING_TIMEOUT`,
`PROBE_DOMAINS`, `DEADLINE_SEC`.

### Rejected mechanisms — do not re-add

| Attempt | Result |
| --- | --- |
| `domain-rules /youtube.com/ -speed-check-mode ping` | ranks only within the winner's candidate set; with a far-winning upstream it returns the best **far** IP (330 ms). On `m.youtube.com` it picked 345 ms over 62 ms, 8/8 |
| `domain-rules … -nameserver <name>` | returns **no answer at all** (8/8 empty) |
| `blacklist-ip 192.178.0.0/16` | filters nothing (8/8 still far); unknown directives are silently ignored on 0.13.1 |
| IP-range tests | impossible: `142.250.122.101` = 345 ms sits inside the "near" `142.250.0.0/15`; `142.250.203.14` = 62 ms is in the same /15 |
| `edns-client-subnet` | measured no effect (sibling `dns.md`), and leaks the subnet |
| `server h3://…` for the pool (**DoH3**) | 2026-11-05, 60 cold domains interleaved, same three members: p50 **78 → 86 ms**, p95 **202 → 272 ms**, 0 failures both arms. No win; q90 alone tightened (125 vs 186). Rejected |
| `server quic://…` (**DoQ**) | unusable on this carrier: `dns.quad9.net:853` → `connection lost`, `dns.cloudflare.com:853` → `request timed out`, only AdGuard answers and it is far-class (330 ms). DoH3 on UDP/443 works, DoQ on UDP/853 does not |
| Widening the flat pool to all 9 members | 2026-11-05: p50 **76 → 65 ms** but p95 **132 → 153 ms**, plus a reproducible 1.6–2.5 s cold outlier (`githubusercontent.com`). The verbatim live config beat it on p50 in both runs (48 / 50 ms). Rejected |

### The 8.5 % `retried or failed` counter is NOT transport

Measured 2026-11-05 in a window with **no** `apply-edge` restart and **no**
`gp-keepalive` calibration (14:44:39 → 15:03:03, 1104 s): 1228 queries to
`127.0.0.1#5353`, **105 retried or failed (8.5 %)**, and exactly 105 then sent to
the carrier. So the counter is real and steady — and it is not explained by DoH
over TCP (the DoH3 arm above had 0 failures in 60 cold queries), not by upstream
connection errors (the log carries only ~14 `ERROR` lines/hour: `doh.opendns.com`
the most frequent, then `1.1.1.1`, quad9, `dns.google`, cloudflare), and not by
SERVFAIL propagation (11 SERVFAIL names through `192.168.0.1` added **+0** to it).
**Unattributed** — attribute it with dnsmasq `log-queries` + `SIGHUP` before
proposing a remedy. Work record:
[`../plans/2026-11-05-dns-transport-quic.md`](../plans/2026-11-05-dns-transport-quic.md).

### A silently-ignored pool line (live defect, unfixed)

`/usrdata/qmanager/etc/smartdns.conf:291` reads `https://dns.nextdns.io/d496c7`
with **no `server` keyword**, so it is an unknown directive and is dropped on
0.13.1 (same class as fact 1). The NextDNS profile has therefore never been in the
pool; only the bare `server https://dns.nextdns.io` on line 306 is. Fixing it
changes membership → needs its own before/after sweep, not a drive-by edit.

## Keeping the wiring — `qmanager_dns_wire`

Added **2026-10-26**, after the same defect was found twice on two firmwares: the
resolver runs, the page is green, and **no LAN client uses it** because dnsmasq's
config has lost `server=127.0.0.1#5353`.

| Device | Where the forwarding line lives | Who can lose it |
| --- | --- | --- |
| O5A Pro | `/etc/data/dnsmasq.conf` (`# BEGIN GP smartdns`, sibling product) | anything that rewrites the file; QCMAP regenerates the *bootstrap* that `conf-file=`-includes it, so normally it survives |
| ZLT X16 | `/tmp/dnsmasq.conf` | the vendor regenerates it per boot, and nothing restarts dnsmasq there either (`killall dnsmasq` left LAN DNS dead until an operator noticed) |

`qmanager_dns_wire` does not hardcode a path: it asks the **running** daemon for its
argv, takes `--conf-file=`/`-C`, follows ONE `conf-file=` include, and then:

- **already has the line → write nothing.** This is the O5A case, and it is why the
  guard is safe to run every minute against the sibling product's file. Any form of
  the line counts, not just our marker.
- **missing → append** `strict-order`, `server=127.0.0.1#5353`, `cache-size=2000`
  (and `log-facility=` only on a firmware with no syslog file), between
  `# BEGIN/END QMANAGER-WIRE v1` markers;
- validate the **candidate** with `dnsmasq --test` *and* assert our own directives
  survived assembly, before the live daemon is touched;
- restart dnsmasq by re-exec'ing the argv it was running with, and verify `:53` is
  listening again; if it was not running, start it.
- `status` prints which file it resolved, whether it is wired, and where the syslog
  shim points; `unwire` restores `<conf>.pre-qmanager` or strips only our block.

### Two bugs already paid for — do not reintroduce

1. **The assembly must be canonical.** Stripping the block and re-appending it with
   a blank-line separator grew the file by one line per run, so `cmp` never matched
   and dnsmasq was killed + restarted **every 60 s** — a DNS blip a minute on the
   LAN (measured on the X16, 2026-10-26). Trailing blank lines are dropped first,
   so the second run is a no-op.
2. **`KillMode=process` is load-bearing on the unit that calls it.** With the
   systemd default (control-group) the oneshot's cgroup is torn down on exit and the
   dnsmasq it just started is SIGTERMed a second later. This is the "for when one
   does" case `docs/reference/custom-dns.md` recorded.

X16 note: `deploy-x16/smartdns/zlt-smartdns.sh wire` in the sibling repo carries the
same algorithm plus the boot/status driver for that device. `qmanager_dns_wire` is
the canonical copy; fold the X16 one into it when that module is next touched.

## The carrier baseline — the comparison the numbers are worth anything against

Added **2026-10-26**. Every latency figure on this page was a comparison the page did
not show: "61 ms" answers nothing without "…and the resolver your ISP gave you says
116 ms". So the domain tester now measures the carrier resolvers as extra rows.

| Rule | Why |
| --- | --- |
| **Auto-picked, never hardcoded** | The operator's nameservers change per SIM and per network. They are read from the device's own resolv files — `/tmp/resolv.conf` (dnsmasq's `resolv-file` on the X16) → `/run/resolv.conf` → `/etc/resolv.conf`, first hit wins, duplicates dropped. A hardcoded pair measured a resolver the router does not use. |
| **Loopback skipped** | A unit whose resolv.conf points at its own cache would otherwise compare the resolver with itself and call it a baseline. |
| **Never a candidate** | Rows carry `is_carrier: true` and are excluded from `recommendation.good`/`dropped` unconditionally. The edge timer calls the probe **without** `--carrier`, so pool membership can never grow a plain UDP/53 entry. |
| **Measured the same way** | `dig @<carrier> <domain>` → ping the A records → same median/class code path as a DoH provider, so the two columns are comparable. A carrier that blocks or hijacks a name shows up as a different IP, not as a different measurement. |

Live example (X16, 2026-10-26, `youtube.com`): `dns.quad9.net 93 ms` · `carrier
182.176.100.89 93 ms` · `carrier 39.39.39.39 142 ms` · `dns.google 112 ms` ·
`cloudflare-dns.com 398 ms`. That is the whole point of the page in one line: the
carrier is *not* the problem on this network, and two pool members are worse than it.

`carrier.measured: false` (no resolver found, or `dig` missing) carries a `reason` and
renders as **no carrier rows** — never as a 0 ms baseliner.

## Corpora / state

| Path | Owner | Survives reboot |
| --- | --- | --- |
| `/usrdata/qmanager/etc/smartdns.conf` | `qmanager_dns_apply` only | **yes** (ubifs) |
| `…/etc/smartdns.conf.pre-qmanager` | last-good backup kept by the helper | yes |
| `/tmp/smartdns.log`, `/tmp/smartdns.cache` | the daemon | no (tmpfs) |
| `/tmp/qmanager_dns_edge.json` | the helper, per refresh | no |
| `/tmp/qmanager_dns_stats_history.json` | the sampler, 288 × 5 min | no |

## Health checks

```sh
systemctl is-active qmanager-dns.service                       # active
netstat -lnu | grep 127.0.0.1:5353                             # exactly one listener
dig +short @192.168.0.1 debian.org                             # LAN path answers
dig +short @127.0.0.1 -p 5353 youtube.com                      # expect 142.25x, not 192.178.x
sed -n '/BEGIN QMANAGER-EDGE/,/END QMANAGER-EDGE/p' /usrdata/qmanager/etc/smartdns.conf
/usrdata/qmanager/bin/qmanager_dns_test youtube.com --json     # the tester, by hand
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/      # vendor UI still 200
```

## Cutover state and rollback

The vendor unit is **not masked** (its file belongs to the sibling repo). A drop-in
makes it refuse to start while QManager ships a resolver:

`/etc/systemd/system/gp-smartdns.service.d/qmanager-owns-resolver.conf`
→ `ConditionPathExists=!/usrdata/qmanager/bin/smartdns`

This also neutralises the `ExecStartPost` inside `gp-radio.service` that would
otherwise race for `:5353` at boot. **Rollback:**

```sh
rm /etc/systemd/system/gp-smartdns.service.d/qmanager-owns-resolver.conf
systemctl daemon-reload
systemctl disable --now qmanager-dns.service qmanager-dns-edge.timer qmanager-dns-stats.timer
systemctl enable --now gp-smartdns.service
```

`systemctl is-active gp-smartdns` must read `inactive` while the cutover holds —
`active` means both resolvers are fighting for the port.

## Benchmark

| Metric | Value | Conditions |
| --- | --- | --- |
| Full provider sweep | **32 s** (3 domains × 8 providers) | 2026-10-24, live WAN |
| `apply-edge` end to end | **45 s** (probe + throwaway validation + restart) | same run |
| smartdns idle CPU | **0 ticks / 60 s** | measured pre-cutover, sibling-owned process |
| smartdns RSS | 5.7–6.1 MB | |
| Stats sampler | 1 run / 5 min; a handful of forks (killall + syslog scan + jq) | not yet profiled over hours — treat as unmeasured |
| LAN DNS hit rate | **38.9 %** (477 local / 1226 total) | dnsmasq counters, 2026-10-24 00:59 |

## Gotchas

- Two resolvers on `:5353` is the failure mode to check first. `qmanager-dns` binds it;
  anything else that does means the drop-in is missing or was removed.
- The **first** `refresh_edges` after boot is slower (~45 s) because the pool is cold.
  The timer waits `OnBootSec=5min` so the WAN is up before membership is decided.
- The generated EDGE block is rewritten wholesale. Hand edits inside it are lost by
  design; put custom rules **outside** the markers.
- A hand `save` does **not** update the ledger — the operator's text is not a
  measurement, and pretending otherwise would make "last measured" lie.
- dnsmasq caches the answer it already gave for up to `rr-ttl-min` (600 s), so a
  corrected edge reaches clients within ~10 minutes, not instantly. Do not "fix" that
  by flushing the vendor daemon without the before/after that plan item O3 requires.
- `qmanager_dns_test` rejects anything that is not `[A-Za-z0-9.-]` **before** reaching a
  resolver (verified against `../../etc/passwd`).
