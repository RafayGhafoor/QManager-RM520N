# Coverage matrix — Go AT collector

> **Companion to** [`go-at-collector.md`](./go-at-collector.md). **Rule: the switch
> from the shell poller to the collector is not allowed until every row below is
> `✅` with evidence.** A row that is `⚠️` ships as a regression.

**How to use this.** Each row is one surface the shell poller produces today. Fill
the *Collector* column with the Go symbol that produces it and the *Evidence* column
with the observation (a diff, a captured file, a `go test` name). An empty Evidence
cell means not done, however complete the code looks.

**Measured inventory (2026-10-22), not estimated:**

| Surface | Size |
| --- | --- |
| `/tmp/qmanager_status.json` | 18 top-level keys · **265 leaf paths** |
| `qmanager_signal_history.json` row | 7 keys |
| `qmanager_ping_history.json` row | 7 keys |
| `qmanager_events.json` row | 4 keys |
| Files written | 8 |

---

## A. `/tmp/qmanager_status.json` — top-level keys

| Key | Collector symbol | Evidence | Status |
| --- | --- | --- | --- |
| `timestamp` | | | ⬜ |
| `last_successful_poll` | | | ⬜ |
| `modem_reachable` | | | ⬜ |
| `system_state` | | | ⬜ |
| `errors` | | | ⬜ |
| `device` | | | ⬜ |
| `network` | | | ⬜ |
| `lte` | | | ⬜ |
| `nr` | | | ⬜ |
| `sim` | | | ⬜ |
| `sim_swap` | | | ⬜ |
| `sim_failover` | | | ⬜ |
| `signal_per_antenna` | | | ⬜ |
| `connectivity` | | | ⬜ |
| `data_used` | | | ⬜ |
| `system_health` | | | ⬜ |
| `watchcat` | | | ⬜ |
| `phy` | | | ⬜ |

**Graph what this is for:** Section A is the diff target for R2. The proof is a
key-path diff — capture `status.json` from the shell poller, run the collector for
5 minutes, diff `[paths(scalars)]` excluding array indices. Zero added keys, zero
removed.

## B. Leaf paths that are NOT array indices

265 leaves include ~90 `connectivity.latency_history.N` indices, which are covered by
the **row shape** rather than individually. The non-index leaves must each be
verified:

| Group | Leaves (count) | Collector | Evidence | Status |
| --- | --- | --- | --- | --- |
| `lte.*` | ~30 | | | ⬜ |
| `nr.*` | ~20 | | | ⬜ |
| `phy.lte.*`, `phy.nr.*`, `phy.beams[]` | ~25 | | | ⬜ |
| `network.*` | ~15 | | | ⬜ |
| `sim.*` | ~10 | | | ⬜ |
| `data_used.*` | ~6 | | | ⬜ |
| `system_health.*` | ~8 | | | ⬜ |
| `connectivity.*` (non-index) | ~9 | | | ⬜ |
| `signal_per_antenna.*` | ~8 | | | ⬜ |
| `device.*` | ~8 | | | ⬜ |

## C. Row schemas

| File | Keys that must match exactly | Evidence | Status |
| --- | --- | --- | --- |
| `qmanager_signal_history.json` | `ts, lte_rsrp, lte_rsrq, lte_sinr, nr_rsrp, nr_rsrq, nr_sinr` | | ⬜ |
| `qmanager_ping_history.json` | `ts, lat, avg, min, max, loss, jit` | | ⬜ |
| `qmanager_events.json` | `timestamp, type, severity, message` | | ⬜ |
| `qmanager_pci_state.json` | (capture live) | | ⬜ |
| `qmanager_neighbours_live.json` | `at, registered, carrier, serving, cells[]` | | ⬜ |
| `qmanager_watchcat.json` | (capture live) | | ⬜ |
| `qmanager_sim_failover` | (capture live) | | ⬜ |

## D. Features fed by the poller — each must still work

| Feature | Fed by | Evidence | Status |
| --- | --- | --- | --- |
| Dashboard live fields | `status.json` | | ⬜ |
| Signal History chart (30 min ring) | `signal_history.json` | | ⬜ |
| Ping / Connection Quality | `ping_history.json`, `connectivity` | | ⬜ |
| Recent Activity / events | `events.json` | | ⬜ |
| Alerts — SMS | `alert_engine.sh` inputs | | ⬜ |
| Alerts — Email | `email_alerts.sh` inputs | | ⬜ |
| Alerts — Discord | `discord_alerts.sh` inputs | | ⬜ |
| Data Used counter | `data_used` | | ⬜ |
| Carrier Aggregation | `network.carrier_components` | | ⬜ |
| Per-antenna signal | `signal_per_antenna` | | ⬜ |
| Neighbour live view (1 Hz) | lease + `neighbours_live.json` | | ⬜ |
| Detailed Metrics page | `phy` block | | ⬜ |
| Cell distance | NR only (LTE intentionally blank) | | ⬜ |
| SIM swap / failover banners | `sim_swap`, `sim_failover` | | ⬜ |
| Connection watchdog | `watchcat` | | ⬜ |
| System Health | `system_health` | | ⬜ |

## E. Deliberate absences — must STAY absent

Removing these would be a silent feature *addition* that lies.

| Must not appear | Why | Evidence | Status |
| --- | --- | --- | --- |
| `phy.lte.tx_power` | `AT+QNWCFG="lte_tx_pwr"` answers `ERROR` on RG520N-EB | | ⬜ |
| `phy.nr.pathloss` | `AT+QNWCFG="nr5g_pathloss"` answers `ERROR` on RG520N-EB | | ⬜ |
| LTE cell distance | Measured inconsistent; `AGENTS.md` gotcha forbids a scale factor | | ⬜ |
| Any `imei` / `imsi` / `iccid` | Hard rule 10 | | ⬜ |

## F. Non-functional parity

| Property | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| Writes are atomic | temp + rename, as today | | ⬜ |
| Cadence | Tier 1 / 1.5 / 2 / 3 unchanged | | ⬜ |
| Lease semantics | 10 s, browser-driven, stops on its own | | ⬜ |
| Flock | same path, 20 s / 45 s ceilings | | ⬜ |
| Fallback | absent/dead collector ⇒ `qcmd`, one warning/60 s | | ⬜ |
| Idle CPU | < 0.5 % of one core with the port open | | ⬜ |
| Per-cycle CPU | 406 ms → < 30 ms | | ⬜ |
| Boot | real reboot, `boot_id` + `ActiveEnterTimestamp` | | ⬜ |
| Go test coverage | parsers and `atdev` ≥ 80 % | | ⬜ |

## Sign-off

| Gate | Owner | Date |
| --- | --- | --- |
| Hard rule 3 amended for `qmanager_atd` | | |
| Native armv7 payload accepted | | |
| A–F all ✅ | | |
| 24-hour soak, no gaps | | |
| Real reboot proven | | |
