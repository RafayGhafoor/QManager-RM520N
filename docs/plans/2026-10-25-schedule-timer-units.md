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
| Vendor stack | `http://127.0.0.1/` still 200; `qmanager-httpd`/`poller`/`ping`/`dpi`/`dpi-ensure.timer`/`dns*`/`traffic` all `active` with boot-time `ActiveEnterTimestamp` |
| CPU/memory | **Unchanged by design**: no new resident process, no fork on any hot path. The rearm oneshot runs once per boot (3 `systemctl --no-block start` for the timers that exist) and exits. The lock adds one `flock` fd per save, not per poll cycle. No before/after benchmark table because there is no recurring cost to measure — recorded here rather than omitted. |

## Still broken / next

1. **Schedules fire in UTC.** systemd does not read this deployment's timezone
   channel (`/etc/TZ` + `/etc/qmanager/tz.posix`, `cgi_base.sh`-exported `TZ`), and
   there is no tzdata to install `/etc/localtime` from, so `OnCalendar=` is
   evaluated in UTC while the UI is on `PKT-5`. Measured: the UI saved `08:00`,
   `systemctl list-timers` scheduled `08:00 UTC` = **13:00 local**. Affects Tower
   Lock, Scheduled Reboot and scenario schedules equally. Needs a spec: translate
   `HH:MM` by the configured offset before rendering `OnCalendar=`, and keep the
   fire guard's own comparison in the same clock or it will deny the fire.
2. **`gp-tls-renew.timer` reads `inactive` after boot** — it is a *masked* unit in
   the product repo (`-> /dev/null`), not a QManager defect. Noted because it was
   briefly mis-read as evidence that `timers.target.wants` symlinks never work
   here.
3. The UI string for `unit_absent` ("update to the latest firmware") is now
   misleading only in the genuine stale-OTA case. Left alone: it is app-layer
   copy, and fixing it would need a ninth-format exception for a message that no
   longer appears on this deployment.
