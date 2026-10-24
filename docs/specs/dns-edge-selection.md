# DNS edge selection — the dynamic algorithm, and the contract it exposes

**Status:** building 2026-10-23. Owner steered away from a hard-coded upstream
group ("hardcoding is not a good idea, maybe better algorithm").
**Parent spec:** [`smartdns-o5a.md`](./smartdns-o5a.md).
**Measurements:** [`../plans/2026-10-23-dns-ping-latency-attribution.md`](../plans/2026-10-23-dns-ping-latency-attribution.md).

This document is the **integration contract**. Three pieces are written against it:
the measurement engine (`scripts/usr/bin/qmanager_dns_edge*`), the CGI
(`scripts/www/cgi-bin/quecmanager/network/`), and the UI. Change a JSON shape here
before changing any of them.

---

## Why measurement, not a fixed list

Established first-hand on the O5A Pro, 2026-10-23:

| Fact | Evidence |
| --- | --- |
| Google hands out two latency classes: ~55–80 ms and ~330–350 ms | TCP/443 `time_connect` **and** ICMP agree (`142.250.203.14` 67 ms / `192.178.211.93` 340 ms) — the far class is real at the transport layer, not an ICMP artefact |
| The class depends on **which upstream answered** | `youtube.com` → `dns.google`/`quad9`/`opendns` give `142.250.203.174` (near); `cloudflare-dns.com`/`1.1.1.1` give `192.178.211.x` (far) |
| The talkative part of the pool is a **race**, so the winner varies | `FastestResponse`: first NOERROR wins |
| IP ranges cannot separate the two classes | `142.250.122.101` = 345 ms sits inside the "near" `142.250.0.0/15`; `142.250.203.14` = 62 ms sits in the same /15 |
| Four candidate mechanisms do **not** work | `-speed-check-mode ping` mis-ranks (picked 345 ms over 62 ms, 8/8); `domain-rules … -nameserver <name>` returns **no answer** (8/8); `blacklist-ip 192.178.0.0/16` filters nothing (8/8); group routing works but a hand-written member list rots |

So the only durable axis is **measured per-upstream answer quality**, and the only
mechanism proven to act on it is **upstream group membership**. Keep the mechanism;
compute the membership.

---

## The algorithm

```
refresh (timer, default 30 min, bounded):
  1. Parse the upstream pool from the live config (`server` lines + their groups).
  2. For every PROBE DOMAIN and every upstream:
       answers = `smartdns resolve --https @<upstream> <domain>`   (no cache involved)
       rtt     = min RTT over up to MAX_IPS of those answers, via ICMP (2 packets, 2 s)
  3. quality(u) = median of the per-domain rtts that u answered
  4. good = { u : quality(u) <= THRESHOLD_MS }        default 150
  5. If |good| < MIN_MEMBERS (default 2)  -> KEEP the previous block, log "no change".
       If the pool never produced a good set, nothing is written at all.
  6. Regenerate the `# BEGIN QMANAGER-EDGE v1 … END` block:
       server <url> -group edge -exclude-default-group      (one per good member)
       nameserver /<domain>/edge                            (one per PROBE DOMAIN)
  7. Validate the whole candidate on a THROWAWAY PORT (never `smartdns test -c`,
     which validates nothing on 0.13.1) -> serve + the domain answers from a
     near-class IP.
  8. Atomic swap, restart, confirm 127.0.0.1:5353 is listening, else roll back to
     the previous file and report the rollback.
```

### Tunables (all overridable, defaults shown)

| Knob | Default | Why this value |
| --- | --- | --- |
| `THRESHOLD_MS` | `150` | near measures 55–80 ms, far 330–350 ms; the gap is >4×, so the exact cut is not delicate |
| `MIN_MEMBERS` | `2` | a one-member group is a single point of failure; below this, keep what works |
| `MAX_IPS` | `2` | enough to see a class difference without a ping storm |
| `PROBE_DOMAINS` | `youtube.com googlevideo redirector.googlevideo.com` + `google.com` | the measured offenders; **this list is data, and is the one hardcoded input** — smartdns logs at `warn`, so there is no query log to mine real traffic from |
| `REFRESH_INTERVAL` | `30min` | matches the existing refresh timer's spirit; cost measured before enabling |
| `PING_TIMEOUT` | `2s`, 2 packets | bounds a dead upstream to ~4 s |

A provider that starts handing out far edges is dropped **by measurement** and
returns automatically when it recovers. That is the whole point: the list of "good
providers today" is never written by hand.

### Honest limits

- Fixes the class where **a specific upstream** is bad. If every upstream hands out a
  bad IP for a name, nothing here can help.
- `PROBE_DOMAINS` is a fixed small set (see above).
- The generated block only affects domains in `PROBE_DOMAINS`.

---

## Measured on the live unit (2026-10-24, O5A Pro)

First full run of `qmanager_dns_edge_probe`, **3 domains × 8 providers, 32 s wall**
(timer allows 180 s, the CGI's `refresh_edges` allows 90 s):

| Provider | quality | verdict | per-domain class |
| --- | --- | --- | --- |
| `dns.google` | **66 ms** | good | near,near,near |
| `dns.quad9.net` | **70 ms** | good | near,near,near |
| `doh.opendns.com` | **64 ms** | good | near,near,near |
| `dns.nextdns.io` | 163 ms | slow | far,**near**,far |
| `cloudflare-dns.com` | 344 ms | slow | far,far,far |
| `1.1.1.1` | 346 ms | slow | far,far,far |
| `unfiltered.adguard-dns.com` | 348 ms | slow | far,far,far |
| `sky.rethinkdns.com` | 342 ms | slow | far,far,far |

`recommendation.action = rewrite`, `good = [dns.google, quad9, opendns]`.

**This is the argument for measurement over a hand-written list.** Two of these
rows were not in the list I originally hand-picked: `adguard` and `rethinkdns`
return the far class and would have been wrongly included, and `nextdns` is mixed
(near for one domain, far for the others) so neither "include" nor "exclude" is
right for it — a per-domain median is what makes that visible.

The tester (`qmanager_dns_test youtube.com`) on the same unit:

```
fastest 142.250.203.174 @ 58 ms   slowest 343 ms   spread 285 ms   8/8 answered
  58 nextdns(near) · 62 quad9(near) · 65 dns.google(near) · 68 opendns(near)
 336 1.1.1.1(far) · 340 rethinkdns(far) · 341 adguard(far) · 343 cloudflare(far)
```

Edge cases exercised at close-out:

| Case | How | Observed |
| --- | --- | --- |
| Invalid domain | `qmanager_dns_test not_a_domain` | `{"error":"invalid_domain"}`, exit 2 |
| Path traversal attempt | `qmanager_dns_test ../../etc/passwd` | `{"error":"invalid_domain"}`, exit 2 — rejected before reaching a resolver |
| A name nobody answers | `… zzz-nonexistent-12345.invalid` | exit **0**, `fastest:null`, `answered:0`, `tested:8` — an answer, not an error |
| Probe not installed | default path before deploy | `{"error":"probe_missing"}` (distinct from "no answer") |
| Missing `jq` on PATH | timer without `Environment=PATH` | **found during build**: every JSON build failed and the unit still exited 0, which reads as "nothing to do". Both new service units now set `Environment=PATH=/usrdata/qmanager/bin:…` |

## Contract 1 — the engine CLI (`qmanager_dns_edge_probe`)

Read-only. Safe to run by hand, by the timer, and by the domain tester.

```sh
qmanager_dns_edge_probe [--domain <d>]... [--upstream <url>]... [--json] [--timeout <s>]
```

Exit `0` whenever a report could be produced, **even if some upstreams failed** (a
failed upstream is a *result*, not an error). Exit non-zero only if the config or the
binary cannot be read.

```json
{
  "generated_at": 1792800000,
  "binary": "/usrdata/qmanager/bin/smartdns",
  "config": "/usrdata/qmanager/etc/smartdns.conf",
  "threshold_ms": 150,
  "live_group": ["https://dns.google/dns-query"],
  "probe_domains": ["youtube.com", "google.com"],
  "providers": [
    {
      "upstream": "https://dns.google/dns-query",
      "short": "dns.google",
      "ok": true,
      "quality_ms": 61,
      "verdict": "good",
      "in_live_group": true,
      "domains": [
        {"domain": "youtube.com", "ok": true, "ips": ["142.250.203.174"], "rtt_ms": 61, "class": "near"},
        {"domain": "google.com",  "ok": true, "ips": ["142.250.202.206"], "rtt_ms": 58, "class": "near"}
      ]
    },
    {
      "upstream": "https://1.1.1.1/dns-query",
      "short": "1.1.1.1",
      "ok": true,
      "quality_ms": 338,
      "verdict": "slow",
      "in_live_group": false,
      "domains": [
        {"domain": "youtube.com", "ok": true, "ips": ["192.178.211.136"], "rtt_ms": 338, "class": "far"}
      ]
    }
  ],
  "recommendation": {
    "good": ["https://dns.google/dns-query"],
    "dropped": [{"upstream": "https://1.1.1.1/dns-query", "reason": "median 338 ms > 150 ms"}],
    "action": "rewrite",
    "reason": "2 of 6 providers within threshold"
  }
}
```

`action` is one of `rewrite` (a new block should be written), `keep` (the live block
is already correct), or `insufficient` (fewer than `MIN_MEMBERS` good — write nothing).

`class` is `near` (≤ `threshold_ms`), `far` (> `threshold_ms`) or `unknown` (no
answer). Every provider row is emitted even when it failed, with `ok:false` and
`quality_ms:null`.

## Contract 2 — the tester CLI (`qmanager_dns_test`)

Same engine, one domain, human-facing shape. This is what the UI's domain tester
calls.

```sh
qmanager_dns_test <domain> [--json]
```

```json
{
  "domain": "youtube.com",
  "threshold_ms": 150,
  "tested_at": 1792800000,
  "fastest": "142.250.203.174",
  "fastest_ms": 61,
  "slowest_ms": 338,
  "spread_ms": 277,
  "results": [
    {"upstream": "https://dns.google/dns-query", "short": "dns.google",
     "ok": true, "ips": ["142.250.203.174"], "rtt_ms": 61, "class": "near"},
    {"upstream": "https://1.1.1.1/dns-query", "short": "1.1.1.1",
     "ok": true, "ips": ["192.178.211.136"], "rtt_ms": 338, "class": "far"}
  ]
}
```

Invalid domain → exit `2` with `{"error":"invalid_domain"}`. A domain nobody answers →
exit `0` with every `ok:false` and `fastest:null` (never an error that the UI could
not distinguish from a transport failure).

## Contract 3 — HTTP endpoints

All under `/cgi-bin/quecmanager/network/`, session-cookie authenticated like every
other CGI (`cgi_base.sh` + the auth guard).

| Endpoint | Method | Body / query | Response (200) |
| --- | --- | --- | --- |
| `smartdns.sh` | `GET` | — | `{enabled, running, pid, uptime_sec, rss_kb, config_path, config_size, config_mtime, config_valid, cache_size, cache_loaded, provider_count, blocked_count, error_count, edge:{mode,members[],last_refresh}, logs_tail[]}` |
| `smartdns.sh` | `POST` | `{"action":"enable"}` / `{"action":"disable"}` | `{enabled, running, dns_ok, fallback:"carrier"}` |
| `smartdns.sh` | `POST` | `{"action":"save","config":"<text>"}` | `{saved:true, restarted:true, listening:true}` or `{saved:false, error:"validation_failed", detail:"…"}` |
| `smartdns.sh` | `POST` | `{"action":"refresh_edges"}` | the Contract-1 `recommendation` object + `{applied:bool}` |
| `smartdns_stats.sh` | `GET` | `?range=1h\|6h\|24h` | `{cache:{size,insertions_reused,insertions_total,answered_locally,hit_rate_pct}, forwarding:{queries_forwarded,servers[]}, latency:{carrier_ms,lan_ms,speedup_x,saved_ms}, pool:{members,errors}, blocked:{rules}, history:{samples,sufficient,forwarded_per_min,insertions_per_min,series[]}, sampled_at}` |
| `dns_test.sh` | `GET` | `?domain=<d>` | Contract 2 verbatim |

`config_valid` is **always** `null` — `smartdns test -c` validates nothing on 0.13.1,
so the endpoint must not pretend to validate. The real gate is the throwaway-port run
inside `save`.

## Contract 4 — UI

Route `/local-network/smartdns` (sidebar: Local Network). Four cards:

1. **Status + toggle** — on/off switch, running state, pid/rss/uptime, config path and
   mtime, and a plain-language line saying what "off" means (dnsmasq falls back to the
   carrier resolvers, so DNS keeps working).
2. **DNS providers / edge selection** — the Contract-1 table: provider, measured
   quality, verdict chip (`good`/`slow`/`failed`), in-group indicator, and per-domain
   answers. A `Refresh now` button posts `refresh_edges`. This is the panel that makes
   the algorithm visible.
3. **Performance** — the Contract-3 stats: cache hit rate, LAN-vs-carrier lookup
   speed-up, pool size, blocked-rule count. **Every figure shows its source** (e.g.
   "dnsmasq cache stats"), because none of these are smartdns counters.
4. **Domain tester** — input + button → Contract 2 as a table sorted fastest-first,
   with the near/far class per row and a summary line `fastest X ms · slowest Y ms ·
   spread Z ms`.
5. **Config editor** — the config text in a monospace editor, Save disabled while the
   current save is in flight, server error rendered verbatim (that is where the
   throwaway-port validator's message appears), and a confirmation toast on success.
