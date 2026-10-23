# DNS and ping latency on the O5A Pro — where the improvement came from, measured

**Date:** 2026-10-23  **Lane:** ad-hoc diagnosis (owner: *"check how dns and ping
is so better now… is it due to smartdns or what"*)
**Risk class:** read-only. **No device change was made** — every number below is a
probe, no config was written, no unit restarted, no vendor daemon signalled.
**Device:** GreenPacket O5A Pro, `LE.UM.6.2.3.r1-03100-SDX65.0`,
`boot_id 6ef00f6d-0e9d-4ed6-98cf-011fe31b10f5`, **uptime 5 min** at first probe
(the box had just rebooted — see [What this cannot tell you](#what-this-cannot-tell-you)).
**Status:** diagnosis complete · four optimisation candidates measured, **none
built** · two need an owner decision, two belong to the sibling repo.

---

## What was asked

Two questions, and they have different answers:

1. Why are pings < 100 ms when they were bad before — is it smartdns?
2. Is smartdns beneficial for this router, and are there better results available?

**Short answer:** smartdns is doing real and measurable work, but it is **not** what
your ping number is measuring. Ping RTT on the dashboard is ICMP over the radio to
a nearby anycast; smartdns is not in that path at all. What is actually carrying the
improvement is a **fresh boot** resetting vendor memory growth and CPU contention —
and that is inference, because the "before" numbers were destroyed by the reboot.
The DNS half *is* smartdns, and it is nearly free. The largest untapped win found is
not in smartdns: the **router itself bypasses the LAN cache entirely**.

---

## Measured — the topology: there are two DNS paths, not one

| Path | Chain | Who uses it |
| --- | --- | --- |
| **LAN** | client → `dnsmasq` `192.168.0.1:53` (cache 2000) → `smartdns` `127.0.0.1:5353` (DoH pool, cache 8192) → carrier, `strict-order` fallback | every LAN client (browser, phone) |
| **Router itself** | `/etc/resolv.conf` → carrier `119.160.122.146` **direct** | `qmanager_ping`, all CGIs, busybox |

Evidence, all on-device tonight:

```sh
ps w | grep -E 'dnsmasq|smartdns'
#  1855/1856 radio /usr/bin/dnsmasq --conf-file=/var/run/data/dnsmasq.conf.bridge0
#  2711     nobody /data/gp/bin/smartdns run -c /data/gp/smartdns.conf
netstat -lnp | grep -E '5353|53 '     # dnsmasq 192.168.0.1:53 tcp+udp, smartdns 127.0.0.1:5353 udp
ls -la /etc/resolv.conf               # -> /var/run/resolv.conf, radio:radio, mtime = boot
head -3 /etc/resolv.conf              # nameserver 119.160.122.146 / 119.160.80.146
```

The config chain is two hops — the running file is a 312-byte per-boot stub that
pulls in the real one, so grepping only one of them will mislead you:

```
/var/run/data/dnsmasq.conf.bridge0   (312 B, radio:radio, rewritten at boot)
  conf-file=/etc/data/dnsmasq.conf   <- everything below lives here
  interface=bridge0
  dhcp-option-force=6,192.168.0.1    <- DHCP hands LAN clients dnsmasq as their resolver
```

In `/etc/data/dnsmasq.conf`: the GP block opens at `:318`, `cache-size=2000` is `:328`,
and `except-interface=lo` is `:307`. `dhcp-option-force=6` is what makes the split
unambiguous: LAN clients are *given* dnsmasq, and the router is not.

The two paths disagree, which is how you can see them separately:

```sh
dig +short @192.168.0.1 google.com      # 192.178.177.138      <- LAN path (smartdns)
ping -c3 google.com                     # PING google.com (142.250.202.46)   <- ROUTER path (carrier)
```

`/etc/data/dnsmasq.conf:328` (`# BEGIN GP smartdns` block) is what joins the two —`strict-order`, `server=127.0.0.1#5353`, `cache-size=2000`. That block is the **sibling
product's** (`greenpacket-o5a`), not this branch's: QManager's own Custom DNS sentinel
(`# QMANAGER-CUSTOM-DNS-BEGIN v1`) is **absent**, so this branch's DNS feature is
configured off and is not implicated in anything measured here.

> ⚠️ `dnsmasq` is loopback-blind twice over — `interface=bridge0` in the stub and
> **`except-interface=lo`** (`/etc/data/dnsmasq.conf:307`) — so it does *not* answer on
> `127.0.0.1:53`: verified, `dig @127.0.0.1` returns *"connection timed out; no servers
> could be reached"*. Any future "point the router at the local cache" work must target
> `192.168.0.1`, not loopback. This is a trap worth knowing before designing.

---

## Measured — DNS

### Warm (the path that decides whether browsing feels fast)

| Resolver | Latency | Note |
| --- | --- | --- |
| `dnsmasq :53` (LAN) | **0–1 ms** | 10 reps: github `1 0 0 0 0 0 0 0 0 0`, cloudflare `0 1 0 1 0 0 0 0 2 1` |
| `smartdns :5353` | 3–6 ms | its own cache hit; the extra ms is the loopback hop |
| carrier direct | 19–52 ms | **no local cache exists for the router at all** |

dnsmasq's front cache is doing its job, and the 2026-10-01 eviction problem is gone:

```
Oct 23 23:13:20 dnsmasq[1855]: cache size 2000, 0/311 cache insertions re-used unexpired cache entries.
```

`0/311` against the recorded `149/554` from 2026-10-01 — the `cache-size=2000` raise
fixed it, and 2000 is not saturated 10 minutes after a boot.

### Cold (a name nobody has looked up)

Two runs, interleaved against `119.160.122.146` in the same window:

| Name | smartdns path | carrier |
| --- | --- | --- |
| postgresql.org | 3 | **654** |
| rust-lang.org | 2 | 25 |
| kernel.org | 2 | 17 |
| debian.org | 2 | 23 |
| archlinux.org | 173 | 31 |
| golang.org | 2 | **631** |
| python.org | 2 | 23 |
| php.net | 2 | 18 |
| perl.org | 401 | **1306** |
| sqlite.org | 2 | **742** |

Several of the `2–3` figures are cache hits rather than cold lookups (an earlier run
of `*.example.com` took 47–80 ms, and the exact names `kernel.org` / `postgresql.org`
/ `rust-lang.org` appear in `smartdns.conf`'s own benchmark comment, so a vendor probe
may have warmed them). **Not first-hand-verified which** — treated as unverified rather
than claimed. A second set of names chosen to avoid that list is the cleaner signal:

| Name | smartdns path | carrier |
| --- | --- | --- |
| gnu.org | 240 | 269 |
| neovim.io | 2 | 241 |
| eclipse.org | 13 | 45 |
| vim.org | 3 | 300 |
| tmux.github.io | 138 | 171 |

**Read this honestly:** on a *median* cold lookup there is no dramatic win — smartdns
2/3/13/138/240 against carrier 45/171/241/269/300. The win is **the tail**: the carrier
stalls at 600–1300 ms on 4 of 10 names (all three of `postgresql.org` 654,
`golang.org` 631, `sqlite.org` 742, `perl.org` 1306), and smartdns's worst observed
cold was 401 ms. A resolver that answers everything in ≤ 400 ms beats one that is
sometimes faster and sometimes hangs for over a second — that is the user-visible
difference, and it is *not* a lower median.

### Pool health

One `ERROR` in 10 minutes from one of eight upstreams — the config's own expected
failure mode, not a finding:

```
23:18:18 ERROR ... Failed to connect to any nameserver: https://doh.opendns.com/dns-query request timed out
```

### Cost of smartdns on this box

| Metric | Measured | Method |
| --- | --- | --- |
| CPU, steady state | **0 ticks / 60 s** (< 10 ms per minute) | `sed 's/^[0-9]* (.*) //' /proc/2711/stat \| awk '{print $14+$15}'` delta |
| CPU, boot-time | 23 % of one core | `top` at uptime 5 min — cache rebuild + DoH pool re-race; transient |
| RSS | 5.7 MB | `/proc/2711/status` |
| Forks | none | it is a single Rust process; box-wide fork rate was 39/s, all vendor loops |

`dnsmasq` measured 0 ticks over the same 60 s window, RSS 496 + 220 kB.
**Verdict: smartdns is not a resource problem. The 23 % is a boot burst, and quoting
it as its cost would be wrong.**

---

## Measured — ping

Live from `/tmp/qmanager_status.json`:

| Field | Value |
| --- | --- |
| `latency_ms` | 31.8 |
| `avg_latency_ms` / `min` / **`max`** | 41.1 / 22.2 / **466.5** |
| `jitter_ms` | 21.7 |
| `packet_loss_pct` | 0 |
| `ping_target` | cloudflare.com |

12 raw samples to that target in one minute: `39.2 28.6 43.9 24.6 31.4 27.0 39.4 28.8 40.9 33.1 30.8 31.9`.

Why < 100 ms is *legitimate and expected*: `cloudflare.com` resolves to
`104.16.132.229`, Cloudflare anycast, and the floor on this radio is `1.1.1.1` at
**min 23.7 ms**. The two literal legs are much noisier — `1.1.1.1`
`23.7/64.6/242.1 mdev 79.6`, `8.8.8.8` `54.7/96.5/276.5 mdev 80.7` — so any grading
that leans on them will flap (see O5).

### The DNS → ping coupling is real, and it was wrong tonight

`qmanager_ping:26` already documents it: *"target_host_1 (default cloudflare.com)
hostname — the RESOLVER picks the address family, not a config slot"*. The resolver
also picks **which edge**, and therefore the RTT:

| What | IP | ICMP RTT |
| --- | --- | --- |
| `google.com` via **dnsmasq** (what the LAN gets) | `192.178.177.138` — Google's **far** range | **354 ms** (345/353/376) |
| `google.com` via **smartdns**, queried fresh | `142.251.37.142` — near range | **68 ms** (62/67/79) |
| `www.` / `mail.` / `dl.` / `maps.google.com` | all `142.25x` near | ~68 ms |

So the per-domain `domain-rules /google.com/ -speed-check-mode ping` rule **works** —
it returns the near edge when asked. What was being served was a stale far-edge answer
sitting in front caches. TTL counted down `462 → 197` over ~4 minutes, i.e. it expires,
but **a wrong edge can be served for up to 600 s** (`rr-ttl-min 600` written into the
record, then cached by dnsmasq for that full TTL). This is the one genuinely *wrong*
behaviour found in the current DNS setup, and it is LAN-side only.

### What the dashboard's DNS number is actually measuring

```sh
cat /tmp/qmanager_dns.json
# {"ms":90,"ok":true,"resolver":"119.160.122.146","name":"one.one.one.one",...}
```

`qmanager_ping`'s `dns_job` takes **the first `nameserver` in `/etc/resolv.conf`**
(`scripts/usr/bin/qmanager_ping:515`) and times an `nslookup` against it
(`:529`). On this device that is always the **carrier**, so the UI reports carrier
latency — 90 ms — while the same name on the path clients actually use costs 3–11 ms:

| Name `one.one.one.one` | 5 reps (ms) |
| --- | --- |
| carrier `119.160.122.146` | 32 22 19 19 22 |
| LAN cache `192.168.0.1` | 10 3 8 3 11 |

Not a defect — it is measuring the network's resolver, which is a defensible thing to
measure. But it is **not** the latency a user experiences, and nothing on screen says
which path it is. See O1.

---

## What this cannot tell you — read before quoting any of it

Every "before" number is gone. The box had been up **5 minutes** when the first probe
ran, so:

- `qmanager-ping`'s history is tmpfs (`/tmp/qmanager_ping_history.json`) and was wiped.
- The previous boot's latency series cannot be reconstructed from the device.
- `netmgrd` was measured on 2026-10-23 at **37.2 MB RSS+swap, +2.1 MB/h**, and reads
  **2.3 MB** now — reset by the reboot, not fixed
  ([`2026-10-23-netmgrd-memory-growth.md`](./2026-10-23-netmgrd-memory-growth.md)).
- Box state at probe time: load `2.9 / 2.57 / 1.32`, `MemAvailable` 61 MB, 30.7 % idle.

So the attribution "a reboot improved the pings" is **inference from the reset state,
not a measured before/after**. AGENTS.md rule 1 says the baseline must be captured
before the change; here the change was a reboot that was not instrumented, and the
baseline is unrecoverable. A future claim about ping improvement needs the numbers
taken either side of a planned reboot, with `boot_id` recorded.

---

## Optimisation candidates — measured baseline, nothing built

No code or config was changed. Per AGENTS.md, each of these needs a
`docs/specs/<feature>.md` (status, In Scope, Out of Scope + reasoning, falsifiable
`- [ ]` acceptance criteria) before implementation, and a before/after benchmark in
the same commit.

### O1 — point QManager's own DNS probe at the path clients use

| | |
| --- | --- |
| Baseline | `dns_lookup_ms` = **90 ms**, resolver `119.160.122.146` (carrier) |
| Baseline, LAN path, same name | **3–11 ms** warm |
| Change | `scripts/usr/bin/qmanager_ping:490,515` — probe `192.168.0.1` instead of (or in addition to) `/etc/resolv.conf`'s first nameserver |
| Expected gain | UI number moves from ~90 ms to ~10 ms and becomes representative |
| Blocker | `:529` computes `_ms = (_t1 - _t0) * 10` from `/proc/uptime`, i.e. **10 ms resolution, floored at 10**. A 0–3 ms LAN hit can only ever read "10". The gain is visible but understated unless the clock source changes (`date +%N` availability on this busybox is **unverified**) |
| Risk | None functional; a reporting change. But `dns_lookup_ms` feeds connection-quality grading, so the threshold semantics shift with it |
| Owner decision needed | Which number *should* the dashboard show — network resolver health (carrier) or user experience (LAN cache)? Defensible answer: both, labelled |
| Repo | **this branch** (`scripts/`) |

### O2 — stop the router's own lookups bypassing the LAN cache

| | |
| --- | --- |
| Baseline | router warm lookups **19–52 ms every time** (no local cache); cold **17–1306 ms** with 4/10 over 600 ms |
| Change | make `/etc/resolv.conf` name `192.168.0.1` first (the LAN cache), carrier second |
| Gain | every CGI and QManager probe gets 0–1 ms warm; cold tails removed |
| Blocker 1 | `dnsmasq` has **`except-interface=lo`** — `127.0.0.1:53` is refused (measured). Must be `192.168.0.1` |
| Blocker 2 | `/etc/resolv.conf` is a **symlink to `/var/run/resolv.conf`**, owned `radio:radio`, rewritten by the modem stack on every connect (mtime tracks boot). A hardcoded edit is clobbered on reconnect — this needs a hook, and it **fights the vendor stack** (AGENTS.md hard rule 2) |
| Risk | the router's own name resolution gains a new dependency. `strict-order` already gives carrier fallback, so the residual risk is dnsmasq dying, not smartdns |
| Recommendation | **defer** — needs the vendor-stack owner's sign-off, and it is vendor DNS wiring: **sibling repo**, not this branch |
| Repo | `greenpacket-o5a` |

### O3 — close the wrong-edge window (the only measured *wrongness*)

| | |
| --- | --- |
| Baseline | `google.com` served as `192.178.177.138` at **354 ms** for ~7 min while a fresh lookup gives `142.251.37.142` at **68 ms** |
| Root cause | `rr-ttl-min 600` writes a 600 s TTL into the record; **dnsmasq then caches it for that full 600 s independently**. dnsmasq's cache, not smartdns's, is what persists the bad answer |
| Why the existing refresh does *not* fix it | `gp-smartdns-refresh.sh` restarts **smartdns only**, and dnsmasq keeps serving its own copy. Worse, that script's header claims *"The persistent cache is saved to /tmp before restart and reloaded afterward"* — its **body never touches the cache** (verified: only `BIN`/`CONFIG` set, config test, bootstrap probe, `systemctl restart`, bind poll). `/tmp/smartdns.cache` is **absent** on this device despite `cache-persist yes`, so a restart clears smartdns's memory anyway and the header's claim is stale |
| Options | (a) drop `rr-ttl-min` — the config author chose 600 *deliberately* to cut upstream traffic on cellular, and the file warns a high floor pins you to a possibly-dead CDN edge; (b) **flush dnsmasq** (`killall -HUP dnsmasq`) after a smartdns refresh or at boot — cheap, targets the actual cache; (c) pin `google.com` via `address` like `aidcgroup.net` already is |
| Unexercised | a dnsmasq `SIGHUP` here would flush 2000 entries on the vendor's daemon. Not done — read-only lane. This is the validation step for whichever option is chosen |
| Repo | `greenpacket-o5a` (vendor DNS config) |

### O4 — do **not** add an upstream health-trimmer

`doh.opendns.com` timed out once in 10 minutes. The precedent is explicit in
`smartdns.conf` (`DO NOT RE-ADD Mullvad`) and the config says outright: *"Do NOT trim
on /tmp/smartdns.log error counts — those are dominated by transient cellular WAN
blips."* A member dropping one query under `FastestResponse` costs nothing.
**Negative result — do not retry.**

### O5 — do not grade a connection on the literal legs

`1.1.1.1` mdev **79.6**, `8.8.8.8` mdev **80.7**, maxima 242 / 276 ms, against
`cloudflare.com` mdev 5.7 / max ~43. The anycast literals are rate-limited and
ICMP-deprioritised. Thresholds that lean on them will flap. No change proposed here —
recorded so the next person does not read a 240 ms `1.1.1.1` sample as a fault.

### Rejected — replacing dnsmasq with smartdns as the LAN resolver

dnsmasq owns DHCP, `:53`, lease hostnames and `dnsmasq_script.sh` on this device.
smartdns is a cache-and-race layer, not a DHCP server. Serving in front is the right
shape; do not collapse them.

---

## Is smartdns beneficial here? — the verdict, with its caveat

**Yes, and it is close to free** (5.7 MB RSS, 0 % idle CPU, no forks). But be precise
about *where* the benefit lands:

| Claim | Verdict |
| --- | --- |
| "smartdns made my pings faster" | **No.** It is not in the router's ping path; `qmanager_ping` resolves via the carrier |
| "smartdns made browsing snappier" | **Yes.** 0–1 ms warm for the whole LAN, and the carrier's 600–1300 ms cold stalls are gone |
| "smartdns lowered cold-lookup median" | **Weak.** Mixed on medians (2/13/3/138/240 vs 45/171/241/269/300); the win is the tail |
| "smartdns costs CPU" | **No** in steady state; 23 % is a boot burst only |
| "smartdns helps this router's own DNS" | **No — it is bypassed entirely.** That is the biggest available win (O2) |

Are there better results available? **Yes, but only one of them is in smartdns.**
O2 (router bypassing the LAN cache) is the largest measured gap and it is a wiring
problem, not a resolver problem. O1 makes the dashboard tell the truth. O3 removes the
one wrong answer. Nothing here justifies touching the upstream pool.

---

## Edge cases

Written with the analysis; exercised where a read-only probe could reach them.

| Edge case | How exercised | Observed |
| --- | --- | --- |
| Stale/expired record served as fresh | `dig @192.168.0.1 google.com` repeatedly | far-edge answer held with TTL counting `462 → 197`; self-expires at 600 s, does **not** report its age to the client (O3) |
| Cold lookup when an upstream is down | live pool with `doh.opendns.com` timing out | one `ERROR` in 10 min, no client-visible impact — `FastestResponse` demoted it |
| Carrier resolver hangs | 10-name interleaved cold run | 4/10 stalled 600–1300 ms; `strict-order` means dnsmasq waits rather than racing a second upstream |
| Loopback assumed to work | `dig @127.0.0.1` | **fails** — `interface=bridge0` + `except-interface=lo`. Any design must use `192.168.0.1` |
| Reading the wrong dnsmasq conf | grepped `/etc/data/dnsmasq.conf` while the process ran `/var/run/data/dnsmasq.conf.bridge0` | stub is 312 B and `conf-file=`s the real one, so the settings do apply — but a reader who checks only the stub sees a config with no cache and no upstream, and would wrongly conclude smartdns is unreachable |
| Resolver cache wiped (tmpfs) | reboot at 23:07 | `cache-size 2000, 0/311` after 6 min of traffic — refills fast, no eviction pressure |
| Clock/resolution floor | `qmanager_ping:529` arithmetic | DNS figure quantised to 10 ms, floored at 10 — a 1 ms LAN hit cannot be displayed |
| **Not exercised** — dnsmasq flush | needs `killall -HUP dnsmasq` on the vendor daemon | left for the O3 change's validation, not a read-only lane |

---

## Still broken / next

1. **Nothing is broken by this analysis** — no change was made.
2. The `gp-smartdns-refresh.sh` header comment is **wrong**: it describes cache
   save/restore that the body does not implement, and `/tmp/smartdns.cache` is absent
   on this device. Correct that comment, or drop `cache-persist` from the config so
   nobody designs around a cache file that does not exist.
3. Decide O1 (which DNS number the dashboard shows) — that decides whether a spec is
   written.
4. O2 and O3 belong to the sibling repo. O3's cheap first step is a dnsmasq flush
   after the refresh, and it needs a before/after in the same commit.
5. Any future ping-improvement claim needs a **planned** reboot with `/proc/uptime`,
   `boot_id` and a latency sample either side. Tonight's improvement cannot be
   attributed, only inferred.

---

## Provenance

All measurements 2026-10-23 23:12–23:30 UTC, on the live unit, over SSH. Config facts
read from `/etc/data/dnsmasq.conf`, `/var/run/data/dnsmasq.conf.bridge0`,
`/data/gp/smartdns.conf`, `/data/gp/gp-smartdns-refresh.sh`, `/etc/systemd/system/gp-smartdns.service`,
and the `/tmp/qmanager_{dns,ping}.json` + `/tmp/qmanager_status.json` sidecars.
QManager code facts from `scripts/usr/bin/qmanager_ping:26,486-530`. Nothing was
written to the device; the only daemon state touched was a `killall -USR1 dnsmasq`
attempt whose output landed in `/var/log/syslog` (the cache-stats line quoted above).
