---
status: closed
lane: Full
base: 78345af
branch: greenpacket
opened: 2026-10-22
lead: pi-bolt
---

# O5A: live neighbour cells + Detailed Metrics

## Request
Owner: review QManager against the greenpacket-o5a product, find what greenpacket
does better, then build (a) live 1 Hz neighbour cells for antenna aiming and
(b) Detailed Metrics R1-R6, with before/after benchmarks, edge cases at close-out,
and direct pushes to `greenpacket` (no PRs).

## Decisions taken — do not re-ask
- **QMI, not AT, for neighbour reads.** A separate transport; measured 82 ms avg,
  0/30 failures, 3/3 concurrent OK. Owner's own correction, confirmed by probe.
- **QMI as a read-only second source elsewhere; never an AT replacement.** No AT
  reads were migrated in this run.
- **`lte_tx_pwr` and `nr5g_pathloss` are absent on RG520N-EB** (both `ERROR:
  command_failed`). Never sent; the page says "not reported by this modem".
- **Setters are never batched with readers.** AT reads batched into 2 compounds
  because `qcmd` rejects a whole compound on `*ERROR*`.
- **No separate Live route/page** (`latency-monitor.md:74` precedent).
- **`--ppidscan` off by default** — measured at 40 % self-overhead.
- **Push direct to `greenpacket`; no PRs.**
- **App-layer exceptions 2 and 3** authorised by the owner and recorded in AGENTS.md.

## Findings that survive
- Device: `CONFIG_PROC_CHILDREN` is OFF → per-child CPU attribution needs
  instrumentation, not sampling. `CONFIG_SCHEDSTATS` present.
- Device: `qcmd AT+CGMM` fails transiently under lock contention; 5/5 alone.
  A single failure is not proof of a modem fault (AGENTS hard rule 3).
- `out=$(timeout N cmd)` is NOT bounded on this firmware — a grandchild holds the
  pipe. Capture through a file. (Cost 30 s vs 3 s in a test.)
- awk: `x = x (cond ? a : b)` is a FUNCTION CALL. Hit three times in this run.
- `jq` is not on a plain ssh PATH (`/usrdata/qmanager/bin/jq`).
- `deploy/qm_pathfix.sh` must run after EVERY backend redeploy — skipping it gave an
  empty 200 with nothing in the log.
- `?range=now` with no sample must return `registered: null`, not `false`.

## Device state
Reachable (`ssh greenpacket`, 192.168.0.1). Deployed: `qmi_read.sh`,
`phy_metrics.sh`, poller, 2 CGIs, rebuilt `out/`. No new unit, no boot change, no
reboot performed — so **boot state is unproven** for this deploy (rule 6 does not
apply since nothing boot-related changed, but the next reboot is still the only proof).

## Handoff — NEXT ACTION
Nothing is in flight. Open follow-ups, in order of value:
1. **Cell-change event panel** — the one real History parity gap vs greenpacket
   (`total_cells` is a count, not "PCI changed at 03:14"). Needs its own spec.
2. **Tier-1 cycle duration under Tier 3** — measure properly; budget warnings
   pre-date the change but the rate may have risen (n=6, not proven).
3. Browser pass on `/cellular/detailed-metrics` — no console errors and the nav row
   from another route were never visually confirmed.
4. `docs/reference/phone-number.md` is untracked and predates this run — decide
   whether it is wanted.
