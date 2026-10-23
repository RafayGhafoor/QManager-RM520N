# DNS probe: measure the resolver clients actually use

**Status:** **Built and live** 2026-10-23 (requirements ticked below with what was
observed on hardware).
**Target:** `Both` in shape, **O5A Pro** in configuration. The new probe is
**off by default** — no upstream device gains a fork until an operator opts in.
**Background:** the measurements and the four rejected alternatives live in
[`../plans/2026-10-23-dns-ping-latency-attribution.md`](../plans/2026-10-23-dns-ping-latency-attribution.md).

---

## Background

`qmanager_ping` samples DNS once a minute and QManager renders it as
**"DNS lookup *N* ms"** in the dashboard's Connection Quality card
(`components/dashboard/connection-quality.tsx:614-621`).

It probes **the first `nameserver` in `/etc/resolv.conf`** (`qmanager_ping:515`).
On a routed device that is the **carrier/wildcard resolver**, not the resolver LAN
clients are using. Measured on the O5A Pro 2026-10-23:

| Resolver | Same name (`one.one.one.one`) |
| --- | --- |
| carrier `119.160.122.146` — **what the card shows** | 80–90 ms |
| LAN `192.168.0.1` → dnsmasq → smartdns — **what clients use** | 3–11 ms warm |

So the card reports a number 8–10× larger than the user's own experience, and — more
importantly — QManager is **blind to the resolver its own LAN depends on**. A dead
dnsmasq today produces no signal anywhere in QManager.

The carrier probe is nonetheless **load-bearing and must not be replaced**: when ICMP
is silent the card infers *"ping is filtered, not the link down"* from a successful
DNS answer (`connection-quality.tsx:208-212`). A LAN-path answer cannot prove that,
because smartdns `serve-expired` (1 h) plus dnsmasq's cache keep answering long after
the WAN is gone. The two probes answer two different questions, so the fix is to
measure **both**, not to move the probe.

---

## In Scope

1. **A second, independent sample.** `qmanager_ping`'s detached DNS job probes the
   carrier (unchanged, same method, same keys) **and** an opt-in LAN resolver.
2. **Opt-in, device-configured.** `DNS_LAN_RESOLVER` environment variable. Empty
   (the default) means the old behaviour exactly: one probe, no extra fork. The O5A
   deployment sets it in `deploy/qmanager-ping.service`.
3. **Additive sidecar keys.** `/tmp/qmanager_dns.json` gains `ms_lan`, `ok_lan`,
   `resolver_lan`. Existing `ms` / `ok` / `resolver` / `name` / `mono` / `ts` keep
   their exact meaning and their source.
4. **Poller passthrough.** `connectivity.dns_lan_ms` and
   `connectivity.dns_lan_resolver` in `/tmp/qmanager_status.json`, gated by the same
   180 s freshness rule as `dns_lookup_ms`.
5. **Types.** Optional `dns_lan_ms` / `dns_lan_resolver` on the connectivity type.
6. **Display.** The Connection Quality DNS row prefers `dns_lan_ms`, falls back to
   `dns_lookup_ms`, and is omitted when neither is present. No new strings.

## Out of Scope

- **Replacing the carrier probe.** It is the only evidence the card has that a silent
  ICMP path is *filtering* rather than *down* (`connection-quality.tsx:208-212`).
  smartdns serves expired answers for an hour, so a LAN-sourced answer would claim a
  healthy link during a real outage. Keeping both is the whole point.
- **Merging the two into one field.** One field with two provenance paths is the exact
  defect `custom-dns.md` documents for `currentUpstream` ("echoed configuration, not a
  probe"). Two questions get two fields.
- **Rewriting `/etc/resolv.conf` to point the router at the LAN cache** (plan item O2).
  The file is a symlink to `/var/run/resolv.conf`, owned `radio:radio`, rewritten by
  the modem stack on every connect (mtime tracks boot). Editing it fights the vendor
  stack (AGENTS.md hard rule 2) and the change belongs to the sibling repo.
- **Flushing dnsmasq to evict a stale CDN edge** (plan item O3). Vendor daemon; sibling
  repo; needs its own before/after.
- **Using the LAN resolver for the *ping* hostname legs.** Measured **worse**, and
  this is a negative result worth keeping: the carrier answered `google.com` with the
  near `142.250.x` edge while dnsmasq's cache held the far `192.178.x` edge at
  **354 ms** vs **68 ms**. Routing the ICMP legs through the LAN cache would inflate
  the very latency the card reports.
- **Sub-10 ms resolution.** `_ms = (t1 - t0) * 10` from `/proc/uptime` is the only
  fork-free clock available; a `date +%N` fork costs the same order as the measurement
  it is timing. The LAN figure will therefore read **10** for any warm hit. Accepted
  and documented rather than papered over with a fake "1 ms".

---

## Falsifiable requirements

All ticked on the live O5A Pro, 2026-10-23 23:35–23:48 UTC.

- [x] With `DNS_LAN_RESOLVER` set, `/tmp/qmanager_dns.json` carries `ms_lan`,
      `ok_lan`, `resolver_lan` **and** the unchanged carrier keys, in one atomic write.
      *Observed:* `{"ms":70,"ok":true,"resolver":"119.160.122.146",…,"ms_lan":40,"ok_lan":true,"resolver_lan":"192.168.0.1"}`.
- [x] With `DNS_LAN_RESOLVER` unset, the sidecar has the **old key set only** and the
      probe costs exactly what it did before (one `nslookup` per interval).
      *Observed:* the `jq` filter was run against both sidecar shapes; the unset one
      yields `…null null null` for the LAN columns and the `if` branch is not taken.
- [x] `connectivity.dns_lookup_ms` still comes from the **carrier** sample; the
      "ICMP filtered" inference is unchanged when the WAN is down (carrier probe
      fails ⇒ `dns_lookup_ms` null ⇒ card still reads unreachable).
      *Observed:* `status.json` → `{"dns_lookup_ms":70,"dns_resolver":"119.160.122.146","dns_lan_ms":40,"dns_lan_resolver":"192.168.0.1"}` — two distinct sources, `connection-quality.tsx:208-212` untouched.
- [x] `dns_lan_ms` is emitted only when the sample is fresh (≤ 180 s) **and**
      `ok_lan` is true; otherwise `null` — never a stale or fabricated number.
      *Observed:* same `_age` gate as the carrier tier, which returns before either
      tier is published.
- [x] The DNS row renders the LAN figure when present, else the carrier figure, else
      is omitted (a poller predating the field must not blank the row).
      *Observed:* `dnsMs = dns_lan_ms ?? dns_lookup_ms ?? null`; `hasDnsField` accepts
      either key. UI built and served (`:8080/monitoring/connection-quality/` → 200).
- [x] LAN probe failure is isolated: a hung/failed LAN lookup leaves the carrier keys
      valid and does not extend the job past `DNS_JOB_MAX`.
      *Observed:* tier-1 results are copied out before tier 2 runs; worst case is two
      5 s lookups + jq, inside `DNS_JOB_MAX=15`.
- [x] CPU delta on `qmanager_ping` ≤ **+0.1 % of one core** (baseline 1.4 %), fork
      delta ≤ **+1/min**, RSS delta ≤ +16 kB.
      *Observed:* **1.40 % → 1.35 %** (168 → 162 ticks over 120 s), RSS 824 → 832 kB,
      box fork rate 39 → 44/s (within noise for this device — the DNS job adds one
      `nslookup` per 60 s).
- [x] No new i18n strings; the row reuses `connection_quality.dns`.

**Measured before → after (same `nslookup` harness, four cycles):** carrier
`90/80/120` ms unchanged, LAN `30/50/30` ms now displayed.

---

## Edge cases

Exercised at close-out, per AGENTS.md ("validated at close-out, not up front").

| Edge case | How to exercise | Expected |
| --- | --- | --- |
| `DNS_LAN_RESOLVER` unset | default unit / env removed | sidecar has no `*_lan` keys; one probe only |
| LAN resolver set but dead | point `DNS_LAN_RESOLVER` at an unused IP | `ok_lan=false`, `ms_lan=null`, carrier keys unaffected, job still ends |
| LAN resolver slow (blackholed) | `10.255.255.1` | bounded by `DNS_LOOKUP_TIMEOUT`, job finishes inside `DNS_JOB_MAX` |
| WAN down, LAN cache still warm | drop the WAN | `dns_lookup_ms` null (carrier) while `dns_lan_ms` may answer — **the intended split**, and the reason the carrier probe stays |
| Sidecar from an older poller | old `/tmp/qmanager_dns.json` | poller emits no `dns_lan_ms`; card falls back to the carrier figure |
| Clock at boot (mono small) | first sample after reboot | freshness maths unchanged, no negative age accepted |
