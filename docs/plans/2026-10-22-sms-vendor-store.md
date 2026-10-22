# 2026-10-22 — SMS Center reads the device's own store

Spec: [`../specs/sms-vendor-store.md`](../specs/sms-vendor-store.md) ·
Reference: [`../reference/sms.md`](../reference/sms.md#two-sources-one-inbox) ·
Device facts: [`../reference/platform-matrix.md`](../reference/platform-matrix.md)

## What was reported

Owner, looking at both UIs side by side: SMS "not rendering correctly" on
`http://192.168.0.1:8080/cellular/sms/`, correct on `http://192.168.0.1/#sms`.

## What was measured (before any change)

Read-only investigation on the live unit; nothing was modified until the plan
below was agreed.

| Reading | Result |
| --- | --- |
| `AT+CPMS?` | `"ME",24,255` — 24 slots used, newest entry `10/21/26 18:56:10` |
| `sms_tool -s ME recv -j` | 24 entries (index 2 never decodes); `error decoding pdu 12` appeared on one of two identical runs |
| `/data/turin/mifi_config.sqlite` `sms_config` where `sms_pos='0'` | **265** rows, `08-11-2026` → `10-22-2026`, 170 unread |
| same table, `sms_pos='1'` | 301 sent rows |
| `memohigo` `/web/v1/sms/inbox` (via `:8091`) | the same rows — `SmsId` values are literally `sms_config.SmsId` |
| `memohi.db` `smsinbox` | 0 rows — the store is *not* the Beego DB |
| `/usr/sbin/smsd` | running (PID 1545), registered as ubus `sms_ubusd` |

Content comparison of the 20 rows QManager rendered against the store:

| Relationship to the store | Rows |
| --- | --- |
| strict substring of a longer store message (i.e. **one segment of a message the device holds complete**) | 10 |
| identical whole text also present in the store | 2 |
| present only in the modem (dated 11/2025 – 05/2026, older than the store) | 8 |

Diagnosis: `/usr/sbin/smsd` consumes each incoming SMS, assembles it into
`sms_config` and clears the modem copy, leaving roughly one orphaned segment per
multi-part message. QManager was reading those orphans. Everything received
after 10/21/26 18:56 was invisible, and nothing older than 08-11-2026 was ever in
the store to be found.

`/usr/bin/sqlite3` 3.33.0 turned out to be present on the device, so no new
binary was needed — that removed the one design question (Hard rule 9's
committed-vs-fetched decision) this change would otherwise have raised.

## What was built

Backend (deploy layer):

- `scripts/www/cgi-bin/quecmanager/cellular/sms.sh`
  - `store_inbox_json()` — `sqlite3 -readonly -json` over `sms_config`, mapped to
    the existing message shape with `storage: "STORE"`, `indexes: [SmsId]`, the
    vendor date+time normalised to `MM/DD/YY HH:MM:SS`, and the **inverted**
    `readed` flipped into `read`.
  - GET asks the store first; the modem path is unchanged and answers when the
    store cannot.
  - `store_delete_ids()` — validated integer ids, one `DELETE … WHERE
    sms_pos='0' AND SmsId IN (…)`, `.timeout 5000`.
  - `store_backup()` — sqlite's own `.backup` before `delete_all`, newest 3 kept
    in `/usrdata/qmanager/data/sms-store-backups/`.
  - Modem fallback now drops `error` rows (they used to render as blank lines).

App layer, recorded as exception #4 in `AGENTS.md`:

- `types/sms.ts` — `SmsStorageKind`, `read`, `storage.store`, `source`.
- `hooks/use-sms-read-state.ts` — device-reported read counts as read.
- `hooks/use-sms.ts`, `components/cellular/sms/{inbox-card,delete-dialogs,summary-tiles}.tsx`
  — the `STORE` vocabulary, a count-only store tile, and store-aware
  delete-all copy.
- `public/locales/{en,id,it,zh-CN,zh-TW}/cellular.json` — 5 keys each.

## Benchmark

Method: `busybox time -p` around 5 direct CGI invocations (it reports user+sys
**including reaped children** — verified on this box: 20 × `/bin/true` → 50 ms, so
~2.5 ms/fork), with a 30 s idle control window for the global fork counter in
`/proc/stat`. Same harness both runs, same unit, same SIM, phone idle, no other
request in flight. 2026-10-22.

| Metric | Before (modem read) | After (store read) | Delta |
| --- | --- | --- | --- |
| Wall per inbox GET | 4026 ms | 408 / 378 ms (two runs) | **~10× faster** |
| CPU per GET (user+sys, children incl.) | 494 ms (390 user + 104 sys) | 292 / 276 ms (258 user) | **−41 %** |
| Share of one core | 12.3 % | 71.6 / 73.0 % (of a much shorter request) | see note |
| Forks per GET | 179.6 | 15.6 / 22.5 | **−91 %** |
| Response size | 5 727 B | 87 787 B | **+15×** (265 messages vs 20) |
| Poller `poll_cycle exceeded budget` during the window | 0 | 0 | unchanged |

Condition note, per the never-mix-two-runs rule: the "before" wall figure varied
run to run because it waits on the shared AT lock — 4026 ms in the paired run,
7733 ms via `curl`, 11 478 ms in an earlier 5-run window. The CPU figure did not
vary much (476 vs 494 ms). The after figures are stable to ~8 % across two runs.

Two honest caveats:

1. **Same-core share went UP**, because the request got 10× shorter while jq
   still has to parse 87 KB. The number that moved in the right direction is
   absolute CPU and forks.
2. **The response is 15× bigger.** That is the point — it is 265 real messages
   instead of 20 fragments — but it is a real cost on a 1-core box: one page load
   now parses ~88 KB of JSON in the browser instead of ~6 KB.

Forks per request fell 91 % because the store path never takes
`/tmp/qmanager_at.lock`. The old path took it **six times per GET** and held it
long enough to block the poller; that is where the 4–11 s wall time went.

## Edge cases (exercised at close-out, live unless noted)

| Edge case | How it was exercised | Observed |
| --- | --- | --- |
| Store missing | `STORE_DB` pointed at a non-existent path in a scratch copy | `source: "modem"`, modem rows returned |
| `sqlite3` missing | `SQLITE3_BIN` pointed at a non-existent file | `source: "modem"` |
| Store corrupt | 20-byte text file as the DB | `source: "modem"`, one warning logged |
| Store empty | `DELETE FROM sms_config` on a scratch copy | `source: "store"`, `messages: []` — **no** modem re-read |
| Stale `SmsId` delete | POST `{storage:"STORE", indexes:[999999]}` | `success: true`, 0 rows affected |
| Outbox protection | delete `SmsId` 565 (a sent row) against a DB copy | outbox row untouched |
| SQL injection | `indexes: ["1; DROP TABLE sms_config"]` | `delete_failed`, `detail: "rejected non-numeric SmsId list"`, table intact |
| `.backup` + rotation | four backups, rotate | newest 3 kept |
| Malformed `smsdate` | not producible on the live store (received rows are well-formed); handled by passing through verbatim | covered by code path, not exercised with real data |
| Non-ASCII body | existing Urdu `PTA@` row | renders unchanged |
| Blank-PDU row | the `error` row seen during investigation | dropped from the fallback list |

## What is still open

- **Outbox.** 301 sent rows exist in the store and QManager shows none of them.
  A feature, not a data-source bug; needs its own spec.
- **Read state is still browser-local beyond the store's flag.** QManager never
  writes `readed`, so opening a message here does not mark it read in the vendor
  UI. Deliberate — two writers on one flag would fight.
- **`parts_received`/`parts_total` are still emitted and unrendered.** Harmless
  now that the store reassembles, but on a device with no store a fragment still
  looks like a whole message.
- **`sms_tool` still intermittently fails to decode a PDU** (`error decoding pdu
  12`, index 2 of the live modem never decoded in either run). That is the modem
  path only; the row is now dropped instead of rendered blank, but the underlying
  truncated read is not fixed here.
