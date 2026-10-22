# Boot timeline — how long the O5A takes to come up, and where QManager sits in it

> **Scope:** `RG520N` — GreenPacket O5A Pro (Quectel RG520N-EB, SDX6X `sdxlemur`,
> systemd 244.5). Every figure is from **one real cold boot**, boot_id
> `3bff0e74-…`, 2026-10-22 08:41:15 UTC, idle LAN, SIM attached (Jazz, 5G-NSA).
> A port must re-measure all of it: modem firmware load time, the vendor's boot
> script, and AT responsiveness after attach are all device-specific.
> **Not measurable from userspace:** the bootloader stage before the kernel. Every
> time below is **kernel uptime** (`/proc/uptime`), i.e. it starts when Linux starts,
> not at power-on.

## How it was measured (no `systemd-analyze` on this firmware)

`systemd-analyze` is not installed and journald is masked, so:

1. **Units:** `systemctl show <unit> -p InactiveExitTimestampMonotonic -p
   ActiveEnterTimestampMonotonic` for every service/timer/target — monotonic µs since
   kernel start, exactly what `systemd-analyze blame` would have printed.
2. **Kernel / modem / data path:** `dmesg` timestamps.
3. **QManager internals:** `/tmp/qmanager.log` wall-clock lines converted with
   `boot_wall = date +%s − uptime`. Since 2026-10-22 the poller also logs its own
   phases in kernel-uptime terms (see *Boot-phase stopwatch* below), so no
   conversion is needed on future boots.

Hard rule 6 applies: a `systemctl restart` is **not** a boot measurement. The warm
figures below are labelled as such and exist only to show what changes at boot.

## Timeline (seconds of kernel uptime)

| t (s) | Event | Owner | Source |
| ---: | --- | --- | --- |
| 0.90 | kernel init done (`Freeing unused kernel memory`) | kernel | dmesg |
| 1.45 | systemd (PID 1) starts | systemd | dmesg |
| 8.93 → 19.18 | `init_sys_mss` — **modem firmware load (10.3 s)**; `modem: Brought out of reset` at 20.85 | vendor/Qualcomm | unit + dmesg |
| 12.75 | `eth0` link up | kernel | dmesg |
| 24.69 | `turin_web.service` starts (`/etc/init.d/turin_web.sh` — runs the QManager hook) | vendor | unit |
| 26.1 | `QTI: Modem is up`; NAS "in service" from 26.5 | vendor | dmesg |
| 29.25 | `rmnet_data0` registered with IPA | kernel | dmesg |
| 31.17 → ~36.0 | **`systemctl daemon-reload` inside `turin_web.sh` (~5 s)** — the anchor the QManager start lines sit behind | vendor script | dmesg `Reloading.` |
| **32.21** | **`QCMAP: WAN connected v4` — internet up** | vendor | dmesg |
| 36.18 | `turin_modemd` active (start 24.93, 11.3 s) | vendor | unit |
| 36.92 | qmanager-httpd, qmanager-poller start (hook fires) | QManager | unit |
| 37.97 | poller main process starts — `qm_wait_modem.sh` gate took **1.0 s** | QManager | unit `ExecStartPre` |
| 38.18 | qmanager-ping active | QManager | unit |
| **38.84** | **QManager UI answers on :8080** | QManager | unit |
| 41.02 | qmanager-dpi (tpws) active | QManager | unit |
| 41 → 61 | **poller `collect_boot_data` — 20 s** | QManager | qmanager.log |
| 42.43 | vendor UI `gp-v2` started | vendor | unit |
| 56.40 | `multi-user.target` | systemd | unit |
| **~61** | **first `/tmp/qmanager_status.json` — dashboard shows data** | QManager | qmanager.log |
| 62.03 | `gp-radio-defaults` done (19.7 s) | vendor | unit |
| 86.84 | `gp-ttl` done (30.4 s) — last boot-time unit | vendor | unit |

**Summary:** internet at **32 s**, QManager page at **39 s**, QManager data at
**~61 s**, everything settled at **~87 s** (plus the unmeasured bootloader).

## Where QManager's time goes

| Gap | Size | Why | Ours to change? |
| --- | ---: | --- | --- |
| Kernel start → QManager units start | 36.9 s | modem firmware load (10 s), then `turin_web.sh` runs `gp-admin-account.sh ensure` and a **5 s `daemon-reload`** before the hook lines | **No.** Hard rule 7: the product repo owns `turin_web.sh`; the hook is deliberately anchored after `daemon-reload` because the late-mounted `/etc` overlay's units are not visible before it |
| Unit start → poller main | 1.0 s | `qm_wait_modem.sh` (hard rule 8) | Already minimal — the modem answered on the first try |
| `collect_boot_data` | **20 s at boot vs 4.8 s warm** | see below | **Yes** — the one QManager-owned delay worth chasing |

### `collect_boot_data`: 20 s at boot, 4.8 s on a warm restart

Warm restart, same code, phase stopwatch (2026-10-22, uptime 615 s):

```
total=4.79 identity=0.55 capability=0.36 sim_and_serving=0.84 ca_mimo=2.62 usbnet_addr=0.38 bands_profile=0.04
```

At the real boot (log timestamps, 1 s resolution): start → serving cell parsed took
**8 s**, serving cell → done took **12 s**. No retry warnings were logged, and no
profile exists in `/etc/qmanager/profiles/` (so `auto_apply_profile` is a no-op),
so the extra ~15 s is AT calls being slow in the first minute after attach — the
modem is busy with QCMAP data bring-up (WAN up at 32 s, this runs 41–61 s) — plus
the one-time `AT+QNWPREFCFG="policy_band"` read (0.35 s warm; cached in tmpfs after).
**This is inferred, not measured per phase**: the stopwatch below was added after
this boot, so the next real reboot will give the split.

## Boot-phase stopwatch (added 2026-10-22)

`collect_boot_data` now ends with one line, all builtin `/proc/uptime` reads:

```
Boot data timing (s): total=… identity=… capability=… sim_and_serving=… ca_mimo=… usbnet_addr=… bands_profile=… | kernel uptime at end …
Boot data collected, entering poll loop (first status published at kernel uptime …s)
```

`grep -E "Boot data timing|first status" /tmp/qmanager.log` after a reboot is the
whole measurement.

## Open

1. Reboot once with the stopwatch in place and fill in the per-phase split above.
2. If `ca_mimo` / AT slowness dominates at boot: publish a first status right after
   the serving cell (≈ 8 s earlier) and defer the CA/MIMO enables to the first
   cycles — a UX change, needs the owner.
3. Vendor-side (not ours, record only): the `daemon-reload` in `turin_web.sh` costs
   ~5 s of every boot before anything after it can start.
