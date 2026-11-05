# 2026-11-05 — DNS transport (DoH3/DoQ) and upstream racing: measured, both rejected

**Status:** closed — nothing shipped to the live config.
**Device:** O5A Pro, `RG520N-EB`, `LE.UM.6.2.1`-era firmware, measured **2026-11-05 14:33–15:05 UTC**
(carrier live: Jazz, B3/N41, WAN `10.46.74.168/28`).
**Trigger for this work:** two hypotheses raised while explaining why a `dig` on the
device does not exercise smartdns (`docs/reference/smartdns.md` →
"Health checks"):
1. the 9 % `retried or failed` tail on `127.0.0.1#5353` is DoH-over-TCP
   (handshake + head-of-line blocking) and would shrink on **DoH3/DoQ**;
2. a dead edge member costs a full dnsmasq fall-through to the carrier, so
   **racing a healthy second upstream** should fill that gap.

Both were measured against the live config. Both are **negative**. The reason is
worth more than the result: neither mechanism is what the tail is made of.

---

## Method

Six scratch smartdns instances on loopback ports `15354–15359`, each a **replica of
the live config** (`/usrdata/qmanager/etc/smartdns.conf`) with only these edits:

| edit | why |
| --- | --- |
| `bind 127.0.0.1:1535x` | never compete with the live `:5353` |
| `cache-size 256` (from 8192) | 60 unique names per round, so every query in a round is cold anyway |
| `cache-persist no`, own `cache-file` | never touch `/tmp/smartdns.cache` |
| own `log-file` | never touch `/tmp/smartdns.log` |

Sweeps: 60 real second-level domains, **interleaved** (arm order alternates per
domain so neither arm always runs second), one cold query per domain per arm,
`dig +time=5 +tries=1`, latency read from dig's own `Query time`. Failures counted
from `SERVFAIL|connection timed out|REFUSED|NXDOMAIN`.

Conditions honoured (`docs/reference/smartdns.md` fact 4): every sweep was run only
after `tail -1 /tmp/gp-keepalive.log` showed the calibration finished
(`14:34:03 … optimal interval set to 240s`). A later counter window was started
**after** the 30-min `apply-edge` restart (14:43:15) so no sweep and no restart
straddled it.

Arms:

| arm | members | transport |
| --- | --- | --- |
| `https` | the 3 DoH3-capable good members (`dns.google`, `dns.quad9.net`, `dns11.quad9.net`) | `https://` |
| `h3` | same 3 | `h3://` |
| `C` | same 3, flat default group | `https://` |
| `E` | all 9 live members, flat default group | `https://` |
| `F` | **verbatim live config** (base pool + generated EDGE block + groups) | `https://` |
| `G1`/`G2` | live config with the two `-speed-check-mode ping` rules / **without** them | `https://` |

## Measured

### 1. DoH3 vs DoH/2 — no win (60 cold domains, interleaved, same members)

| arm | p50 | p75 | p90 | p95 | max | mean | fails |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `https` | **78** | 102 | 186 | **202** | 350 | 99.8 | 0/60 |
| `h3` | **86** | 104 | 125 | **272** | 431 | 108.8 | 0/60 |

p50 is 8 ms worse and p95 is 70 ms worse. QUIC's `p90` is tighter (125 vs 186) but
the tail that matters is worse, twice over two runs. **Rejected.**

### 2. DoQ — unusable on this carrier

`smartdns resolve --quic @host` from the device:

| endpoint | result |
| --- | --- |
| `dns.quad9.net:853` | `proto error: error writing to quic read: connection lost` |
| `dns.cloudflare.com:853` | `proto error: request timed out` |
| `dns.adguard-dns.com:853` | answered — but AdGuard is a **far**-class member (330 ms) |

DoH3 rides UDP/443 and works; DoQ rides UDP/**853** and does not, on two of three
providers. **Rejected for this carrier**, irrespective of the latency result.

### 3. Pool width / grouping — the live config is already the best of the three

| run (both arms freshly started, 60 cold domains) | p50 | p90 | p95 | max | fails |
| --- | --- | --- | --- | --- | --- |
| `C` 3 good members, flat | 76 | 106 | 132 | 158 | 0/60 |
| `E` 9 members, flat | **65** | 137 | 153 | 1671 | 0/60 |
| `F` **live config** | **48 / 50** | 127 / 84 | 135 / 184 | 1852 / 1623 | 1/59, 0/60 |

`F` (production) wins p50 in both of its runs. Widening the flat pool (`E`) buys
p50 but loses p95. Neither is worth a config change, and both threw a **1.6–2.5 s
cold outlier** (`githubusercontent.com` 2052/1671/2553 ms) that the live config
showed only once in two runs. Also measured: the 4 good members are **still in the
default group** despite the generated EDGE block re-declaring them
`-exclude-default-group` — non-Google names answered in ~46 ms on `F`, which is
impossible if only the five 316–341 ms members were serving them. **Rejected.**

### 4. `-speed-check-mode ping` — no cost, no benefit (25 Google-family names)

| arm | p50 | p75 | p90 | max | fails |
| --- | --- | --- | --- | --- | --- |
| `G1` two `-speed-check-mode ping` rules (live) | 64 | 74 | 110 | 943 | 0/25 |
| `G2` rules removed | 65 | 71 | 74 | 2722 | 0/25 |

OFF was faster on 15 of 25 domains, but the two arms trade outliers
(`r1---sn-…googlevideo.com`: 943 vs 2722 ms) and the medians are 1 ms apart. Not a
reason to change anything; **not** a reason to re-add it elsewhere either.

### 5. The 9 % tail is real, steady, and **not** transport

dnsmasq counters (`SIGUSR1` → `/var/log/syslog`), window with **no** keepalive
calibration and **no** smartdns restart (14:44:39 → 15:03:03, 1104 s):

| counter | delta | per query |
| --- | --- | --- |
| queries forwarded | +1272 | 1.15 qps |
| `127.0.0.1#5353` queries sent | +1228 | |
| `127.0.0.1#5353` **retried or failed** | **+105** | **8.5 %** |
| carrier `…122.146` queries sent | +105 | exactly the failures |

So the 858/9540 = 9.0 % seen at 14:12 is not an artefact of the 30-min `apply-edge`
restart and not an artefact of the keepalive sweep (17 of that window's 31 minutes
*was* a sweep, which is why that window read 5.2 % despite carrying a restart).

What it is **not**:
- **not** upstream connection failures — the live log holds only **100** `ERROR`
  lines for the whole 07:24→14:28 span, i.e. ~14/h, while the counter moves ~340/h.
  Most frequent: `doh.opendns.com` 23, `1.1.1.1` 16, quad9 17, `dns.google` 9,
  cloudflare 9, rethinkdns 8.
- **not** SERVFAIL propagation — 11 SERVFAIL-answering names pushed through
  `192.168.0.1` (`wpad`, `use-application-dns.net`, `_dns.resolver.arpa`) added
  +5 forwarded and **+0** to `retried or failed`.

What it still might be: dnsmasq's own retransmission timer, or a reply-shape
mismatch (over-EDNS-size answers, TC). **Unattributed** — the counter has no
per-query visibility without `log-queries`, and this work did not turn it on.

## Built

Nothing. No live file was modified: all six instances ran from `/tmp/dnstab*` and
were stopped; `/tmp/dnstab*` removed; `MemAvailable` returned from 42.9 MB to
45.5 MB. `qmanager-dns` stayed `active` on `:5353` throughout, and after the last
scratch instance was killed: `curl :8080` → 200, vendor `:80` → 200,
`dig @192.168.0.1` answers.

## Found while measuring — a real defect to fix

`/usrdata/qmanager/etc/smartdns.conf:291` is

```
https://dns.nextdns.io/d496c7
```

with **no `server` keyword**. It is an unknown directive, silently ignored on
0.13.1 (the same class as `docs/reference/smartdns.md` fact 1), so the NextDNS
**profile** endpoint has never been in the pool — only the bare
`server https://dns.nextdns.io` on line 306. Two consequences: the profile
(`d496c7`) filters nothing, and the probe reports 8 members while the file looks
like 9. Fixing it changes pool membership, so it needs its own before/after sweep;
it is not a drive-by edit.

Also observed (not chased): non-existent names get **NOERROR/NODATA**, not
`NXDOMAIN`, so a client resolving a typo pays A → AAAA → HTTPS round trips instead
of one fast fail. Worth measuring separately.

## Next

1. **Attribute the 8.5 %** before touching anything else: enable dnsmasq
   `log-queries` via a config include + `SIGHUP` (dnsmasq reloads without dropping
   `:53`), capture 5 minutes, and read *which* queries generate the retry. Only
   then does a remedy have a target. Do not re-open transport work on the strength
   of this counter.
2. Fix the `server` keyword on line 291 with a measured before/after sweep.
3. Leave DoH3/DoQ alone on this carrier until either the carrier changes or a
   member appears whose UDP/853 path works (only AdGuard does, and it is far-class).
