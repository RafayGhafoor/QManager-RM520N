# 2026-10-25 — Tower Lock Schedule could be saved but never armed

**Status:** fixed and live on the O5A Pro (RG520N-EB); boot path proven by a real
reboot. One related defect left open deliberately (UTC schedules, §5).

## The report

Saving the Tower Lock Schedule in the UI
(`http://192.168.0.1:8080/cellular/cell-locking/tower-locking/`) answered:

> Saved, but the schedule isn't armed: the scheduling service isn't installed on
> this device yet — update to the latest firmware to enable it

("update your firmware" is the UI's rendering of `reason: "unit_absent"`, one of
the four arm-helper outcomes documented in
[`docs/reference/scheduled-timers.md`](../reference/scheduled-timers.md).)

## What was actually wrong

Reproduced as root on the live device, before any change:

```
/usrdata/qmanager/bin/qmanager_tower_schedule_arm install 02:00 03:00 0,1,2,3,4,5,6
{"success":true,"armed":false,"reason":"unit_absent"}
/usrdata/qmanager/bin/qmanager_scheduled_reboot_arm install 04:00 0,1,2,3,4,5,6
{"success":true,"armed":false,"reason":"unit_absent"}
```

`/etc/systemd/system` and `/lib/systemd/system` held **no**
`qmanager-tower-schedule-*.service`, no `qmanager-scheduled-reboot.service` and
no `qmanager-scenario-schedule.service`. Each arm helper opens with a presence
test on the oneshot service its generated timer triggers, so arming was refused
and the config was saved anyway. Nothing about the firmware was at fault: this
deployment simply never shipped those units, because it ships only the units
QManager needs *at boot*.

Found while fixing that, and worse:

1. **`qm_pathfix.sh` had patched itself into a no-op.** It lives in
   `/usrdata/qmanager/bin`, the `bin/*` loop rewrote it, and its own `SEDARGS`
   contain the patterns it rewrites — so on the device its rules read
   `/usrdata/qmanager/lib -> /usrdata/qmanager/lib` and
   `/etc/systemd/system -> /etc/systemd/system`. Proof: streaming a fresh
   `qmanager_tower_schedule_arm` (with `/lib/systemd/system`) and re-running the
   deployed pathfix left `UNIT_DIR="/lib/systemd/system"` — unwritable on this
   squashfs root, so arming failed with no visible error. Every deploy after the
   first had been relocating nothing.
2. **The arm helper had no serialization.** With the units present, the UI's
   rapid saves produced
   `Tower schedule timer arm/disarm failed: {"success":false,"error":"arm_failed"…}`
   in `/var/log/syslog`, and each failure path runs `teardown_all` — so a save
   could leave the config `enabled: true` with **both** timers deleted.
   Reproduced deterministically with interleaved `install`/`teardown` pairs.
3. **Nothing re-armed the timers at boot.** This firmware drops `/etc` units from
   PID 1's first transaction (AGENTS.md Hard rule 6), so the arm helpers'
   `timers.target.wants` symlinks are not a boot mechanism.

## What was built

| Change | Where |
| --- | --- |
| Ship the scheduled-feature units with device paths (`/usrdata/qmanager/bin/...`): tower apply + clear, scheduled reboot, scenario schedule, auto-update service + timer, schedule-rearm | `deploy/qmanager-tower-schedule-{apply,clear}.service`, `deploy/qmanager-scheduled-reboot.service`, `deploy/qmanager-scenario-schedule.service`, `deploy/qmanager-auto-update.{service,timer}`, `deploy/qmanager-schedule-rearm.service` |
| Idempotent installer that drops them in `/etc/systemd/system`, installs `bin/qm_schedule_rearm.sh`, `daemon-reload`s and asserts `systemctl cat` can read every unit | `deploy/qm_schedule_units.sh` (deploy/README.md step 5e) |
| Boot re-arm: restart every timer whose `timers.target.wants` symlink exists (the symlink is the *armed* marker, so a feature the user turned off is not resurrected) | `deploy/qm_schedule_rearm.sh` + the rearm service, added to `qm_boot_hook.sh`'s `UNITS` |
| One `flock` (`/tmp/qmanager_schedule_arm.lock`, busybox `-x -n` poll, 30 s cap) around arm/teardown in all three helpers | `scripts/usr/bin/qmanager_{tower_schedule,scheduled_reboot,scenario_schedule}_arm` |
| Never patch `qm_pathfix.sh` itself | `deploy/qm_pathfix.sh` (`patch_file` guard) |

Nothing in `app/`, `components/`, `hooks/`, `lib/` or `types/` was touched, so no
new AGENTS.md exception is needed.

## Verification

| Check | Result |
| --- | --- |
| Arm after the units were installed | `{"success":true,"armed":true,"reason":""}` for tower **and** scheduled reboot; `systemctl list-timers` shows both tower timers with a real `NEXT` |
| Teardown | both timers + `timers.target.wants` symlinks removed, helper answers `armed:false` |
| 8 interleaved `install`/`teardown` pairs (race stress) | **0** `arm_failed` (was 2-3 of 4 before the lock; a 10 s lock cap also failed, tail-enders proceeded unlocked together — hence 30 s) |
| Real reboot (`boot_id` `49b21c83…` → `dd10db94…`, uptime 151 s at re-check) | `qmanager-schedule-rearm.service` ran at boot +41 s: `schedule rearm: started qmanager-tower-schedule-apply.timer qmanager-tower-schedule-clear.timer` in `/var/log/syslog`; both timers `active` with `NEXT` after boot |
| UI save (owner in browser, `/var/log/syslog`) | `Tower schedule timer true: apply at 08:00, clear at 03:30, days=0,…,6, armed=true` — the warning is gone |
| Local-time conversion, arm response | `{"success":true,"armed":true,"reason":"","tz_offset_min":300}`; `08:00` local arms as `OnCalendar=Sun,Mon,Tue,Wed,Thu,Fri,Sat 03:00:00` and `03:30` as `… 22:30:00` (both correct for PKT-5) |
| Day-mask rotation | `_qm_utc_oncalendar_line "1" "02:00"` → `OnCalendar=Sun 21:00:00`; `EST5` + `Mon 23:00` → `Tue 04:00:00`; scenario-path filter: `Mon 08:00` → `Mon 03:00`, `Tue 02:00` → `Mon 21:00`, `Sat,Sun 03:30` → `Fri,Sat 22:30` (PKT) and `Mon 13:00`, `Tue 07:00`, `Sat,Sun 08:30` (EST5) |
| Fire guard in local time | at local 04:17 (UTC 23:17, a different weekday): `04:17 → ALLOW`, `23:17 → deny`; `day 1 (Mon) → ALLOW`, `day 0 (Sun) → deny` |
| **End-to-end fire at local time** | schedule saved as `04:24` local, armed as `OnCalendar=… 23:24:00`; at 23:24 UTC (= 04:24 local) the worker logged `Schedule APPLY triggered` → `Schedule APPLY complete` and the unit `Succeeded` |
| Vendor stack | `http://127.0.0.1/` still 200; `qmanager-httpd`/`poller`/`ping`/`dpi`/`dpi-ensure.timer`/`dns*`/`traffic` all `active` with boot-time `ActiveEnterTimestamp` |
| CPU/memory | **Unchanged by design**: no new resident process, no fork on any hot path. The rearm oneshot runs once per boot (3 `systemctl --no-block start` for the timers that exist) and exits. The lock adds one `flock` fd per save, not per poll cycle. No before/after benchmark table because there is no recurring cost to measure — recorded here rather than omitted. |

## Still broken / next

1. ~~**Schedules fire in UTC.**~~ **Fixed after the owner asked ("will it launch at
   8 AM?") — 04:11 local, schedule armed for 13:00.** `schedule_timer.sh` now
   translates the saved local `HH:MM` to UTC (`_qm_utc_offset_minutes`, read live
   from libc so a DST zone gets the offset in force now) and rotates the day mask
   when the boundary crosses midnight (`Mon 02:00` PKT = `Sun 21:00` UTC);
   `_qm_utc_oncalendar_line` / `_qm_utc_oncalendar_rewrite` are the new call sites
   in all three arm helpers, and the fire guard's `now`/`today` moved to
   `_qm_local_date` so it agrees. Arm responses carry `tz_offset_min`.
   Verified on the device: `04:24` local armed as `OnCalendar=… 23:24:00` and the
   worker ran at 04:24 local (`Schedule APPLY triggered` → `APPLY complete`);
   guard discriminator at local 04:17 / UTC 23:17 gave ALLOW/deny and
   ALLOW/deny for the local vs UTC weekday. Residual: a DST transition leaves an
   armed timer an hour off until the next save.
2. **The workers had no `jq` on `PATH`** — found by the end-to-end test above,
   and it would have made the whole fix cosmetic. The schedule read happens
   before any library sets `PATH`, and systemd's default `PATH` has neither
   `/usrdata/qmanager/bin` nor `/usr/sbin` (`env -i sh -c 'command -v jq'` →
   nothing), so every fire was denied with `schedule time unreadable/invalid`
   while the unit still reported `Succeeded`. All six scheduled-feature units now
   set `Environment=PATH=…`; the trap was already documented in
   `deploy/qmanager-poller.service`.
3. **`gp-tls-renew.timer` reads `inactive` after boot** — it is a *masked* unit in
   the product repo (`-> /dev/null`), not a QManager defect. Noted because it was
   briefly mis-read as evidence that `timers.target.wants` symlinks never work
   here, and that wrong reading reached a code comment before being corrected.
4. The UI string for `unit_absent` ("update to the latest firmware") is now
   misleading only in the genuine stale-OTA case. Left alone: it is app-layer
   copy, and fixing it would need a ninth-format exception for a message that no
   longer appears on this deployment.
5. **The Connection Scenario path is not armed on this device** — it has no
   saved profile, so there is nothing to arm. The scenario helper pipes the
   generator's lines through `_qm_utc_oncalendar_rewrite`, and that filter is
   proven at library level (see the table above, including the day-name mapping
   `Tue 02:00` → `Mon 21:00`). It has NOT been proven end to end by firing a
   scenario, because that would apply a scenario to a live radio. Recorded as
   unproven rather than implied.
