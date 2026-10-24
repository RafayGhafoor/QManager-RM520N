# SmartDNS in QManager — own the resolver, and surface what it buys

**Status:** **Proposed — blocked on three owner decisions** (D1–D3 below). No code
written yet; this spec exists so the decisions are made against measurements rather
than enthusiasm.
**Target:** O5A Pro (`RG520N-EB`). Every device fact below was measured on this unit
on 2026-10-23; the resolver itself is portable, the *addresses* are not.
**Supersedes:** the sibling repo's `deploy/gp-smartdns*` assets, which are being
deprecated (see Background).
**Measurements behind it:**
[`../plans/2026-10-23-dns-ping-latency-attribution.md`](../plans/2026-10-23-dns-ping-latency-attribution.md).

---

## Background

### What is running today, and who owns it

| Piece | Live path | Owner today |
| --- | --- | --- |
| Binary (7,029,804 B, ELF 32-bit ARM EABI5, static, stripped, `sha256 2caca59f…`) | `/data/gp/bin/smartdns` | sibling repo |
| Config | `/data/gp/smartdns.conf` | sibling repo |
| Unit | `/etc/systemd/system/gp-smartdns.service` | sibling repo |
| Refresh unit + timer + script | `gp-smartdns-refresh.{service,timer}`, `/data/gp/gp-smartdns-refresh.sh` | sibling repo |
| Config validator | `deploy/gp-smartdns-validate.sh` (8.3 kB, asserts config markers) | sibling repo |
| Boot guarantee | `ExecStartPost` backstop inside `gp-radio.service` | sibling repo |
| Front door | `dnsmasq` `192.168.0.1:53` → `strict-order` → `127.0.0.1:5353` | sibling repo (the `# BEGIN GP smartdns` block, `/etc/data/dnsmasq.conf:318`) |

The sibling product is being deprecated. **If this resolver is not absorbed here it
stops being maintained while still being the resolver every LAN client depends on** —
and the boot guarantee lives inside a *vendor* unit (`gp-radio.service`) that will
outlive the repo with nobody reading it.

### What it is actually worth (measured, not asserted)

| Claim | Verdict |
| --- | --- |
| Cuts LAN warm lookups | **Yes** — 0–1 ms via dnsmasq's cache vs 19–52 ms to the carrier on every single lookup |
| Cuts cold-lookup **median** | **Weak** — 2/13/3/138/240 ms vs carrier 45/171/241/269/300 ms |
| Cuts cold-lookup **tail** | **Yes** — carrier stalls 600–1300 ms on 4 of 10 names; smartdns's worst observed was 401 ms |
| Costs CPU | **No** steady state — 0 ticks/60 s, 5.7 MB RSS; the 23 % seen in `top` is a boot burst |
| Helps the *router's own* DNS | **No** — `/etc/resolv.conf` points at the carrier, so CGIs and the ping daemon never touch it (plan item O2) |
| Is a live defect risk | **Yes** — it serves a wrong CDN edge for up to 600 s (plan item O3) and **currently hands `youtube.com` a 333 ms edge where 65 ms is available** |

The last row is why the UI matters: the resolver is good, but its *current
configuration* is measurably wrong on Google properties, and nobody can see that
today.

### The stats problem — read before promising a dashboard

`smartdns --help` exposes only `run/update/service/resolve/symlink/test`. The binary
has **no `api-server`, no statistics endpoint and no counter output** (checked with
`--help` and `strings`). So a Traffic-Engine-style "packets processed" panel **cannot
be fed by the daemon**. Every number must be derived:

| Wanted figure | Real source |
| --- | --- |
| Queries answered from cache / hit rate | `dnsmasq`'s `SIGUSR1` dump: **`queries forwarded 749, queries answered locally 477`** → hit rate `477/(749+477) = 38.9 %` from one reading. ⚠️ **Corrected 2026-10-24:** this spec first claimed the local-query total did not exist and that only a sampling window could produce a rate. That was wrong, and it was written from memory rather than from the syslog line. The 5-minute sampler is still shipped, but for **trends**, not for the hit rate |
| Lookup speed win | Already measured — `dns_lookup_ms` (carrier) vs `dns_lan_ms` (LAN), shipped in `f99a2384` |
| Upstream pool health | Bounded `/tmp/smartdns.log` `ERROR` count (the file is size-capped at 128 kB ×2) |
| Blocked domains | Count of `address /…/#` rules in the config |
| Cache occupancy | `cache-size 8192` vs the startup `DNS cache N records loaded` line |

Any claim beyond these would be invented. **This is the honest ceiling of the
"performance improvements" panel** and it is still a good panel.

---

## Decisions required (blocking)

### D1 — how the GPL-3.0 binary gets distributed

**smartdns-rs is GPL-3.0** (`mokeyish/smartdns-rs`, `LICENSE` = GNU GPL v3; its
README adds that hickory-dns code inside it is Apache-2.0/MIT). The sibling repo
commits the 7 MB binary with **no NOTICE entry and no licence text** — a gap this
branch should not copy. Hard rule 9 requires an explicit decision.

| Option | Consequence |
| --- | --- |
| **A. Commit it** (`dependencies/smartdns/`, ~7 MB) + `dependencies/NOTICE` entry + the licence text + a written offer of corresponding source | A fresh install works with no network. Matches the `dependencies/qmi/` precedent. Costs 7 MB in every clone and imposes GPLv3's source-availability obligation on distribution |
| **B. Fetch at deploy** (like `jq`, `speedtest`) | Keeps git light; a fresh install now needs a reachable host for the *resolver it depends on* — the worst thing to make network-dependent |
| **C. Stop shipping it** | Not viable: LAN clients resolve through it. Falls back to carrier-only, which is the 600–1300 ms tail |

**Recommendation: A**, with the NOTICE/licence correction the sibling repo lacks.

### D2 — where the editable config lives

The frontend must edit the config, and **the config is read by a root daemon**. This
is a privilege boundary, not a file-layout preference. The ping unit already records
the rule for `/etc/qmanager.env`: *"the owner of a directory can unlink and replace
ANY file in it regardless of that file's own mode or owner … a www-data-writable
EnvironmentFile is root code execution."*

| Option | Consequence |
| --- | --- |
| **A. `/usrdata/qmanager/etc/smartdns.conf`, `root:root 0600`, written only by a root helper** (`smartdns_apply`) that validates with `smartdns test -c`, swaps atomically, keeps one backup, then restarts the unit | Web user can never name a path the daemon reads. Matches hard rule 1's writable set. |
| B. Keep it at `/data/gp/smartdns.conf` | Keeps working, but the path belongs to the dying product (hard rule 2 also discourages new coupling) |
| C. Under `/etc/qmanager` (the "obvious" place) | **Rejected outright** — www-data-owned directory, root daemon reads the file |

**Recommendation: A.** The CGI never receives a path; it receives config *text*,
and the helper owns every filesystem decision.

### D3 — what the toggle's "off" means

| Option | Consequence |
| --- | --- |
| **A. `systemctl stop qmanager-dns`** | `dnsmasq`'s `strict-order` already falls through to the carrier resolvers, so DNS keeps working with zero edits. Fully reversible, one command, nothing to reconcile |
| B. Also strip the `server=127.0.0.1#5353` line from dnsmasq and `SIGHUP` | Two moving parts, and the edit targets a **vendor** file (`/etc/data/dnsmasq.conf`) |
| C. Disable the unit | Survives reboot differently from "stopped"; confusing state |

**Recommendation: A.** Note one consequence honestly: with smartdns stopped, the
`DNS lookup` row's LAN figure will read the carrier path (slower), because dnsmasq
forwards there — which is correct behaviour, not a bug.

---

## In Scope

1. **Absorb the resolver, don't rebuild it.** Binary, config, unit(s), validator and
   the refresh timer move under QManager's tree:
   `/usrdata/qmanager/bin/smartdns`, `/usrdata/qmanager/etc/smartdns.conf`,
   `/etc/systemd/system/qmanager-dns.service` (+ `qmanager-dns-refresh.timer`).
   Own unit names so `deploy/qm_boot_hook.sh` starts them — **not** a vendor unit's
   `ExecStartPost` (hard rule 7: boot entries are inserted by the hook).
2. **Status endpoint** (`GET network/smartdns.sh`): running, pid, RSS, uptime,
   config path + size + mtime + validation verdict, cache size vs loaded, upstream
   member count, blocked-rule count, recent `ERROR` count from the bounded log.
3. **Derived performance panel** — exactly the five sources in
   [The stats problem](#the-stats-problem--read-before-promising-a-dashboard), each
   labelled with where it came from. No invented counters.
4. **Toggle** (`POST {action:"enable"|"disable"}`) implementing D3-A, verifying the
   resolver state before and after and refusing to leave DNS without a fallback.
5. **Config read + edit** (`GET`/`POST {action:"save", config:<text>}`): the helper
   validates with `smartdns test -c`, refuses on failure and returns the validator's
   own message, keeps the previous file as `.pre-qmanager`, swaps atomically,
   restarts, then confirms the daemon is listening on `127.0.0.1:5353` again.
6. **Import the plan's proven YouTube fix as the shipped default** — group the
   Google-family names to a Google-only upstream (`nameserver /youtube.com/<group>`,
   `/googlevideo.com/<group>`): measured **333 ms → 65 ms, 8/8 rounds** on a scratch
   port with the live config as control.
7. **Docs**: `docs/reference/smartdns.md` + router row, platform-matrix rows for the
   per-device facts, `memory.md` update (the install changes).

## Out of Scope

- **Replacing `dnsmasq`.** It owns DHCP, `:53`, lease names and `dnsmasq_script.sh`
  on this device. smartdns is a cache-and-race layer; the split is correct.
- **A free-text "config editor" that accepts a path.** See D2 — the CGI passes text,
  never a filename.
- **Inventing counters the daemon does not export.** Documented above rather than
  faked with e.g. "queries served" derived from log lines that would require
  `log-level info` (which on this device would cost real CPU and flash).
- **`-speed-check-mode ping` for `youtube.com`.** Measured not to help (all
  candidates far) and it selected the **slower** IP for `m.youtube.com`
  (345 ms over 62 ms, 8/8). Recorded in the plan; do not add it back.
- **Pointing `/etc/resolv.conf` at the LAN cache** (plan O2). Vendor-owned symlink to
  `/var/run/resolv.conf`, rewritten on every connect.
- **Flushing dnsmasq from this feature.** Tempting after a config change, but it is
  the vendor's daemon and needs its own before/after (plan O3).
- **Any rewrite of the resolver logic or the upstream pool.** Absorb it as-is; the
  pool's shape is already documented reasoning, not an accident.

## Falsifiable requirements

- [ ] `systemctl is-active qmanager-dns` is `active`, and `ActiveEnterTimestamp`
      after a **real reboot** (`boot_id` before/after) shows it ran at boot — hard
      rule 6, not `is-enabled`.
- [ ] With the unit stopped, `dig @192.168.0.1 debian.org` still answers (carrier
      fallback via `strict-order`), and the status endpoint reports
      `running:false` rather than an error.
- [ ] `smartdns test -c` rejection is surfaced verbatim and the **previous config
      keeps serving** — a bad paste cannot take DNS down.
- [ ] A successful save leaves `127.0.0.1:5353` listening within 15 s, else the
      helper restores `.pre-qmanager` and reports the rollback.
- [ ] The config file is `root:root 0600` and no CGI can name a path it writes.
- [ ] The panel's every figure names its source, and no figure is presented as a
      daemon counter.
- [ ] Before/after benchmark for the absorbed service (CPU share of one core, RSS,
      fork rate) captured **before** the cutover and recorded in the plan.
- [ ] Vendor stack unaffected: `curl :80` → 200, `:8080` → 200 after every step.
- [ ] No new third-party binary lands in git without its NOTICE entry (D1).

## Edge cases

| Edge case | How it will be exercised | Expected |
| --- | --- | --- |
| Binary missing / not executable | point the unit at a non-existent path | unit fails visibly, status reports it, dnsmasq falls back to carrier, no crash loop |
| Config invalid (syntax) | save `server https://` | validator message shown, old config still serving |
| Config valid but unreachable upstream | save a blackhole `server` | `test -c` passes, daemon runs, lookups fall through — no fake "healthy" |
| Toggle off then reboot | disable, reboot | stays off after boot (state persists), carrier fallback works |
| Log rotated/absent | delete `/tmp/smartdns.log` | panel shows error count as unknown, not zero |
| Cache file absent | reboot (tmpfs) | occupancy reads "0 loaded", not a stale number |
| Two saves racing | submit twice quickly | second apply serialises; no half-written config |

## Benchmark table (filled at build)

| Metric | Before (sibling-owned) | After (QManager-owned) | Notes |
| --- | --- | --- | --- |
| smartdns CPU, idle | 0 ticks/60 s | — | measured 2026-10-23 |
| smartdns RSS | 5.7 MB | — | |
| Box fork rate | 39/s | — | unchanged expected: no new forks |
| Unit boot-proof | `ExecStartPost` in vendor unit | `qm_boot_hook.sh` line | must be reboot-verified |
