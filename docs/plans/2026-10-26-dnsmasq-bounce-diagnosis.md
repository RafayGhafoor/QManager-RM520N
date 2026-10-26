# 2026-10-26 — Is dnsmasq being bounced, and by whom; make the writer canonical

**Lane**: Full. **Device**: GreenPacket O5A Pro, RG520N-EB, boot `up 1:29` at start.
**Trigger**: a report that dnsmasq is being restarted repeatedly, suspected cause a
script that patches its config non-canonically.

## Intended

1. Prove or disprove the churn, and attribute it.
2. Fix the *writer*, not the symptom: any script patching the dnsmasq config must emit
   a canonical file (own block stripped **and** trailing blank lines dropped, block
   re-appended once) so `cmp` is equal on a second run.
3. Validate the candidate with `dnsmasq --test` **and** assert the writer's own
   directives are present, before touching the live daemon.
4. Restart/reload only when the file actually changed.
5. Make a restart survivable: `KillMode=process` on any oneshot that does it, always
   start the daemon back, and verify `dig @<lan-ip> example.com`.

## Measured

### The churn is not there

`dmesg` restart ledger for this boot — **5** `Stopping dnsmasq service` events total:

| t (s) | what was happening |
| --- | --- |
| 8 → 35 | boot: QCMAP brings the LAN bridge up |
| 303, 309 | boot: bridge reconfigure |
| **1548, 1552** | WAN bring-up: `netmgrd` stopped/started at 1543–1544, `ipa-wan` default-egress ioctl at 1547, HTB class setup at 1552 |

Two 2-minute samples, 15 s apart, of `pid` + `/proc/<pid>/stat` field 22 (starttime) +
`md5sum` of both configs + the dmesg restart counter:

| Run | pid | starttime | md5 `/etc/data/dnsmasq.conf` | md5 `/var/run/data/dnsmasq.conf.bridge0` | restarts |
| --- | --- | --- | --- | --- | --- |
| A — all DNS timers **active** | 17398 | 155285 | `a3bc7fe6` (×9) | `d152208f` (×9) | 5 (×9) |
| B — `gp-dns-health.timer`, `qmanager-dns-edge.timer`, `qmanager-dns-stats.timer` **stopped** | 17398 | 155285 | `a3bc7fe6` (×9) | `d152208f` (×9) | 5 (×9) |

Both runs are **flat and identical**. Stopping the guard timers changed nothing,
because they are not the cause. The daemon's PID did not move once during the whole
session, including every apply test below.

### Attribution

- `/var/run/data/dnsmasq.conf.bridge0` — the file dnsmasq is actually started with —
  is written by **`QCMAP_ConnectionManager`**, the vendor binary. `strings` on it
  contains `/var/run/data/dnsmasq.conf.bridge%d`, `/var/run/data/dnsmasq.leases.bridge`
  and **`dnsmasq_service@%d.service`**; nothing else on the device references the
  template. `dnsmasq_service@0.service` has no `WantedBy`/`RequiredBy`/`TriggeredBy`/
  `PartOf`, i.e. no unit and no timer pulls it.
- Grepping every script for a restart: `/etc/init.d/*`, `/data/gp/*`, `/usrdata/qmanager/*`
  — **no non-comment reference to dnsmasq anywhere.** `gp-dns-health.sh` heals
  `gp-smartdns.service` only. `qmanager-dns-stats` sends **SIGUSR1** (a stats dump to
  syslog), not a restart.
- The periodic `Stopped/Started QManager DNS Resolver` lines at t≈363, 2262, 4119 are
  **smartdns**, ~31 min apart — `qmanager-dns-edge.timer` (`OnUnitActiveSec=30min`)
  rewriting the measured edge block. By design, and not dnsmasq.

**Verdict: dnsmasq is not being bounced by QManager or by any timer. The only actor is
the vendor `QCMAP_ConnectionManager`, on bridge/WAN events.**

### Two real defects found in QManager's own writer (`custom_dns.sh`)

| # | Defect | Evidence |
| --- | --- | --- |
| 1 | `strip_sentinel_block` used a one-way `in_block` flag, so a `BEGIN` with no `END` dropped **every line after it** — and `dnsmasq --test` passed, because the truncated file is syntactically valid and merely missing directives | injected a stray `BEGIN` at line 6 of the 331-line live file: **331 → 5 lines**, `dnsmasq: syntax check OK`, exit 0 |
| 2 | Staging dir `/etc/data/qmanager/` does not exist on this install and the CGI has no `mkdir` | `touch /etc/data/qmanager/probe` → *No such file or directory*; every save would report "failed to write staging config file" |

Also fixed: `parse_sentinel_block` read with a bare `while IFS= read -r line`, whose body
never runs for a final line without a newline — so a healthy file ending at the `END`
marker reported `blockCorrupt` (the false positive already recorded in
`docs/reference/custom-dns.md`). `QCMAP` rewrites this file with `sed -i`, which is
exactly the kind of rewriter that leaves no final newline.

The same one-way-flag defect existed in `qmanager_dns_apply`'s `# BEGIN QMANAGER-EDGE v1`
strip, where it would have dropped the rest of `smartdns.conf` — fixed the same way.

## Built

`scripts/www/cgi-bin/quecmanager/network/custom_dns.sh`:

- `canonical_conf_body()` (awk) replaces `strip_sentinel_block()`: removes the block,
  holds back **truly empty** lines and flushes them only before real content (so
  interior blanks survive, trailing ones do not), and **exits 3** on an unterminated
  block.
- The empty-line test is `$0 == ""`, **not** `/^[[:space:]]*$/`. The first version used
  the whitespace class and rewrote two whitespace-only lines (`"  "`, `" "`) inside the
  stock config's own comments — caught because `md5` after save→clear did **not** return
  to baseline (`405a2b3f` vs `a3bc7fe6`). Content QManager does not own is never touched.
- `assert_own_block()`: exactly one `BEGIN`, exactly one `END`, `no-resolv` when
  requested, and one `server=<addr>` line per requested upstream — for
  `enabled=false`, *zero* markers. Runs before the daemon is touched.
- `cmp -s` against the live file → identical save returns `changed:false` and does not
  write or signal anything.
- Backup → `sudo mv` → chown → `killall -HUP dnsmasq` (**HUP, never a restart**: the
  daemon keeps its PID, so there is no window with no resolver).
- `verify_dns_live()`: daemon must be running (starts `dnsmasq_service@0.service` if
  not — nothing supervises it) and must answer `dig @<lan-ip> example.com` with
  `status: NOERROR`. `<lan-ip>` comes from the runtime config's
  `dhcp-option-force=6,192.168.0.1` — the address DHCP literally hands clients —
  with `ip`, `ifconfig` and the `busybox` applets behind it as fallbacks.

  **Correction, and a trap worth remembering.** The first revision of this plan
  claimed `ip` and `ifconfig` were absent, because `command -v ip` and
  `command -v ifconfig` both returned nothing on the device. That was wrong: a
  non-login ssh session has `PATH=/usr/bin:/bin` with **no `/sbin`**. Both exist and
  work — `/sbin/ip` → `/sbin/ip.iproute2` (real iproute2, 465 KB), `/sbin/ifconfig` →
  `/bin/busybox.nosuid` (busybox applet), and `busybox --list` includes `ip` and
  `ifconfig`. The CGI sees both because `cgi_base.sh` puts `/sbin` on PATH. Measure
  tool availability from the environment that will run the code, not from an ssh
  shell. Failure → `rollback_live_conf()`, which reuses the **same**
  `mv` grant (backup → staging → mv), so undoing a change never needs a privilege the
  forward path did not already use.
- Staging dir recreated if missing.

`scripts/usr/bin/qmanager_dns_apply`: `build_edge_candidate()` refuses an unterminated
edge block with exit 4; the `apply-edge` dispatch reports
`{"ok":false,"error":"edge_block_unterminated"}` instead of the misleading
`{"ok":true,"applied":false}`. (Deliberately **not** `if ! build_edge_candidate` — `$?`
inside that branch is the status of the negation, not the function.)

`scripts/etc/sudoers.d/qmanager`: one new grant,
`/bin/systemctl start dnsmasq_service@0.service`. Start-only, one unit — not `restart`,
not bare `systemctl`. Not exercised on this device (there is no `/etc/sudoers.d` here;
`sudo` is the `deploy/sudo` no-op shim and CGI runs as root), so it must be checked with
`visudo -cf` on a real-sudo device before relying on it.

## Verified on the device

Deployed to `/usrdata/qmanager/www/cgi-bin/quecmanager/network/custom_dns.sh`
(pathfixed) with the previous file kept at
`/usrdata/qmanager/backup/custom_dns-<ts>.sh` and the config at
`/usrdata/qmanager/backup/dnsmasq.conf.<ts>`.

| Step | Observed |
| --- | --- |
| `save` enabled, `server=1.1.1.1` | `ok:true, changed:true`; md5 `a3bc7fe6` → `73775843`; `dig` `status: NOERROR` |
| **`save` identical, again** | **`ok:true, changed:false`**; md5 unchanged; **same PID 17398** — no write, no reload |
| `save` 2 servers + `ignore_carrier` | `ok:true, changed:true`; block written with `no-resolv` + both `server=` lines |
| `clear` | `ok:true, changed:true`; markers 0; **md5 back to exactly `a3bc7fe6`** — byte-identical to the pre-test file |
| `clear` again | `ok:true, changed:false` |

| Edge case | How it was exercised | Observed |
| --- | --- | --- |
| Unterminated block | injected a lone `BEGIN` at line 101 of the live config, then `save` through the real endpoint | refused with the explanatory error; file **byte-identical** (330 lines, nothing truncated); no reload; `dig` still `NOERROR`. Old code produced a 100-line file that `dnsmasq --test` called valid |
| Trailing blank lines | file with 3 appended `\n`, build twice | `cmp` equal — no drift |
| Whitespace-only interior lines | save → clear on the stock config | md5 returns to baseline; the two `"  "` / `" "` comment lines are preserved |
| Daemon not running | `pidof`/`systemctl`/`sudo` stubbed to fail the liveness check | tried `systemctl start dnsmasq_service@0.service`, then returned 1 so the caller rolls back |
| `qmanager_dns_apply` unterminated edge block | block-free body + injected `BEGIN`, no `END` | exit **4** (refuse); healthy path still exit 0, 371 lines, `cmp` equal |
| Real timer run after deploying `qmanager_dns_apply` | `systemctl start qmanager-dns-edge.service` | `Result=success`, `ExecMainStatus=0`; smartdns `active`; dnsmasq PID unchanged; markers intact |
| **Rollback path, executed for real** | backup of a good file, live file overwritten with garbage, `rollback_live_conf` | `exit=0`, live file restored **byte-for-byte** (`cmp` equal); uses the same `mv` grant as the forward path |
| Rollback with no backup | `BACKUP_FILE` removed, live file good | `exit=1`, live file **not** clobbered |
| `edge_block_unterminated` through the real dispatcher | synthetic Contract-1 probe JSON (`action=rewrite`) on stdin + a scratch config (`SMARTDNS_CONF=`) with a lone `BEGIN` and 5 marker lines after it | `{"ok":false,"error":"edge_block_unterminated",...}`; scratch file unchanged (29 lines, all 5 tail markers intact) |
| No false positive on the edge path | same JSON against a healthy scratch config | reached `validation_failed` (the stub config has no upstream), **not** `edge_block_unterminated` |
| `lan_dns_addr` in four environments | CGI PATH (has `/sbin`), ssh PATH (`/usr/bin:/bin`, no `/sbin`), no runtime config, no address at all | `192.168.0.1` in the first three; the fourth returns empty and `verify_dns_live` exits **0** (daemon alive, nothing to probe) rather than failing a good save |
| GET contract after the change | authenticated GET, parsed with `jq` | all 9 documented keys present; `{"enabled":false,"available":true,"dnsMode":"ABSENT","currentSource":"carrier","blockCorrupt":false,...}` |
| Unauthenticated GET | no cookie | `Status: 401` + `"error":"unauthorized"` JSON, not an empty body |

Device health after all of it: `dmesg` restart count still **5** (zero restarts across
the entire session), dnsmasq PID still **17398**, vendor `:80` → 200, QManager `:8080`
→ 200, `qmanager-{httpd,poller,ping,dpi,dns,traffic}` all `active`, LAN DNS answering.

## Not done / still open

- **`KillMode=process` is not applied to anything, because no QManager unit restarts
  dnsmasq.** The rule binds the moment one is added: a `Type=oneshot` unit that spawns
  dnsmasq directly puts the daemon in the oneshot's cgroup, and the default
  `KillMode=control-group` SIGTERMs it when the oneshot completes. Today the only
  restart path is the vendor's, and our writer only ever HUPs. Recorded in
  `docs/reference/custom-dns.md`.
- The sudoers `start` grant is **unverified on a real-sudo device** (see above).
- The **verify-failure trigger** inside `verify_dns_live` (as opposed to its two
  branches) has not been fired end-to-end: forcing it would mean deliberately breaking
  LAN resolution on a live device. Its two branches — "daemon gone" (stubbed `pidof` →
  start attempted → `exit 1`) and "no address to probe" (`exit 0`) — are exercised, and
  the rollback it would call is exercised for real. The composition of the two is not.
- The sibling repo's `deploy/install.sh` (`apply_dnsmasq_candidate`) also restarts
  `dnsmasq_service@0.service` and has the same one-way-flag strip
  (`strip_gp_smartdns_config`). It is not this repo; not touched. It *does* already do
  `dnsmasq --test` + `cmp`-before-restart + rollback.
- No new benchmark row: this is not a performance change. The only added cost is one
  `dig` per user-initiated save (and one `awk` per save), neither on the poller path.

## Next

1. If a QManager unit ever needs to restart dnsmasq, give it `KillMode=process`,
   `Type=oneshot`, and the same verify-then-rollback shape as `custom_dns.sh`.
2. Consider lifting the ban on a marker-repair verb in the Custom DNS UI: the writer is
   now safe by construction (refuses rather than truncates), which is the condition the
   existing note in `docs/reference/custom-dns.md` set for that feature.
3. Re-measure the boot-time dnsmasq bounces if the vendor firmware changes — 1548/1552
   is a *sample of one* WAN event, not a rate.
