# SPEC: SMS inbox reads the device's own store, not the modem's leftover slots

**Status:** Locked, 2026-10-22 (owner authorised as option "A" in the 2026-10-22
SMS rendering investigation). Measured on the live O5A Pro before and after.

**Background:** The SMS Center renders almost nothing real on this device. The
owner reported it against the vendor UI at `http://192.168.0.1/#sms`, which
renders correctly. Measured cause, not inferred:

| Source | Count | What it holds |
| --- | --- | --- |
| `AT+CPMS?` on `ME` | `"ME",24,255` | 24 slots, newest **10/21/26 18:56:10** |
| `sms_tool -s ME recv -j` | 24 entries (index 2 never decodes) | 15 of 20 merged rows are ONE segment of a multi-part message |
| `/data/turin/mifi_config.sqlite` → `sms_config` (`sms_pos='0'`) | **265 rows**, 08-11-2026 → **10-22-2026** | full reassembled text, per-message read flag |
| `sms_config` (`sms_pos='1'`) | 301 rows | the sent/outbox history QManager never shows |

The vendor's `/usr/sbin/smsd` consumes each incoming SMS, writes the assembled
message to `sms_config` and clears the modem copy, leaving one orphaned segment
behind per multi-part message. QManager reads those orphans. Evidence that the
QManager rows are residue rather than content: of its 20 rows, **10 are a strict
substring of a longer message the device already stores complete**, 2 are whole
texts that also exist there, and 8 exist only in the modem (dated 11/2025 –
05/2026, older than the store, which starts 08-11-2026). Nothing received after
10/21/26 18:56 is visible in QManager at all.

The store is the same table the vendor UI is served from: `memohigo`'s
`/web/v1/sms/inbox` returns `SmsId` values that are literally `sms_config.SmsId`.
`memohi.db`'s own `smsinbox` table is empty, so `mifi_config.sqlite` is the only
copy.

**Goal:** On a device that maintains a vendor SMS store, the SMS Center shows
that store — same messages, same text, same read flags as the vendor UI — while
staying a modem reader on any device that has no such store.

## In Scope

1. **`sms.sh` GET prefers the store.** When `/data/turin/mifi_config.sqlite` and
   `/usr/bin/sqlite3` are both present and the query succeeds, the inbox is read
   from `sms_config WHERE sms_pos='0' ORDER BY SmsId DESC`, one message per row.
2. **Timestamp normalisation.** The store keeps date and time in two columns in
   the vendor's own format (`smsdate="10-22-2026"`, `smstime="16:09:31"`);
   QManager's `SmsMessage.timestamp` and `parseSmsTimestamp()` are
   `"MM/DD/YY HH:MM:SS"`. Convert in the CGI, never in the browser. A row whose
   date or time does not match the vendor pattern is passed through verbatim
   rather than guessed at.
3. **Read flag.** `sms_config.readed` is emitted per message so the page can show
   the device's own read state. **This column is inverted: `readed='1'` means
   UNREAD** (verified two ways — 170 rows have `readed='1'` and the vendor API
   reports `UnreadMsgNum: 170`; the newest row, `readed='1'`, comes back from
   that API as `"Readed": false`). The CGI emits `read: true` only for
   `readed='0'`, so the inversion exists in exactly one place.
4. **A third storage token, `STORE`.** Rows carry `storage: "STORE"` with
   `indexes: [SmsId]`. `ME`/`SM` keep their meaning and their `sms_tool` delete
   path untouched, so a device without a store behaves exactly as today.
5. **Delete targets the store when the row came from it.** `POST
   {action:"delete", storage:"STORE", indexes:[…]}` deletes those `SmsId`s under
   a write transaction with a busy timeout. `action=delete_all` backs the store
   up first, then clears `sms_pos='0'` and, as today, empties the modem memories.
6. **Storage block tells the truth about which source answered.** Store-backed
   responses omit `me`/`sm` (there is no per-memory split to report) and carry
   `store: {used}`, plus `source: "store"`. The count and the copy come from the
   store; no capacity is invented, because the store has none.
7. **Fallback.** If the store is absent, unreadable, or the query fails, the
   existing modem path runs unchanged. An empty store is NOT a fallback trigger —
   that is a legitimately empty inbox, and re-reading the modem there would
   resurrect residue rows the user just deleted.
8. **Undecodable PDU rows are dropped** from the modem fallback path. A row
   carrying `error` has empty sender/content/timestamp and used to render as a
   blank line at the bottom of the table.
9. **App layer (minimal, recorded in `AGENTS.md`):** the storage union gains
   `STORE` in `types/sms.ts`, `hooks/use-sms.ts`, `components/cellular/sms/inbox-card.tsx`
   and `delete-dialogs.tsx`; `hooks/use-sms-read-state.ts` treats a message the
   device reports read as read; `summary-tiles.tsx` words the store tile; five
   locale files gain three keys.

## Out of Scope (explicit, with reasoning)

- **Outbox / sent history.** The store holds 301 sent messages and the vendor UI
  threads them with the inbox. QManager has no outbox surface at all; adding one
  is a feature, not a data-source fix, and it would need its own spec.
- **Writing read state back to the store.** "Mark read" stays browser-local
  (`localStorage`, `qmanager.sms.read.v1`). Writing `readed` from QManager would
  mean QManager mutating vendor state on every message open, and it would fight
  the vendor UI for the same flag. The device flag is used as the *initial*
  state only; a browser-local mark is additive on top of it.
- **Calling `memohigo` (`:8083`) instead of the file.** It is the same data one
  HTTP hop away, but every endpoint needs a JWT, and the only way to obtain one
  is to log in — the vendor admin rows are `md5("admin")`, a fleet-wide default.
  Hardcoding vendor credentials into QManager is worse than reading a local file.
- **Bundling a SQLite reader.** Not needed: the device already ships
  `/usr/bin/sqlite3` 3.33.0 with `-readonly` and `-json`, which is what this
  design uses. Nothing new enters `dependencies/`, so Hard rule 9's
  committed-vs-fetched decision does not come up.
- **Merging modem residue into the store view.** Those 8 modem-only rows are
  fragments of campaigns from before the store existed; the vendor UI does not
  show them and merging would re-introduce duplicates and fragments.
- **Labelling partial messages (`parts_received`/`parts_total`).** The CGI already
  emits these and nothing renders them. Once the store answers, fragments are
  gone, so a badge would be decoration. It stays an open item for a device with
  no store (see the fallback caveat in `docs/reference/sms.md`).
- **Fixing the interleaved order of same-timestamp rows.** Both the store and the
  modem can hold messages with identical stamps; order within a second is
  `SmsId` descending, which is arrival order. No client-side re-sort is added.
- **Porting the store path to the RM520N-GL.** Vanilla QManager has no vendor
  store; `/data/turin/mifi_config.sqlite` is O5A-specific. Recorded in
  `platform-matrix.md`; the modem path stays the default for every other device.

## Requirements

### R1 — Store read (backend)

- **Acceptance:**
  - [ ] With the store present, `GET sms.sh` returns the `sms_config` inbox rows,
        newest first, one entry per row, `storage: "STORE"`, `indexes: [SmsId]`.
  - [ ] `messages.length` equals the store's `sms_pos='0'` count at read time.
  - [ ] `timestamp` is `"MM/DD/YY HH:MM:SS"` — `parseSmsTimestamp()` returns
        non-zero for every row (it returns 0 on a shape it does not recognise).
  - [ ] `content` matches the store byte-for-byte (no re-wrapping, no trimming of
        the trailing newline some bank messages carry).
  - [ ] Opening the DB read-only: the CGI never writes on the GET path. Verified
        by file mtime and by `PRAGMA query_only`-equivalent (`-readonly`).
  - [ ] A row whose `smsdate`/`smstime` does not match the vendor pattern is
        emitted verbatim, not dropped and not coerced.

### R2 — Response shape

- **Acceptance:**
  - [ ] Store-backed: `storage` = `{used, total: 0, store: {used}, source: "store"}`;
        `me`/`sm` absent.
  - [ ] Modem-backed: unchanged from today — `used`, `total`, `me`, `sm`.
  - [ ] Every message carries `read` on the store path (`true` for
        `readed='0'`, `false` for `readed='1'`); the modem path may omit it.
  - [ ] `used` equals the number of returned messages on the store path, so the
        "Unread n of m" and the table footer agree.

### R3 — Fallback and failure

- **Acceptance:**
  - [ ] Store file missing → modem path, response shape unchanged from today.
  - [ ] `sqlite3` missing → modem path.
  - [ ] DB present but the query fails (corrupt, locked past the timeout,
        `sms_config` absent) → modem path, and one warning in the CGI log.
  - [ ] Store present and query succeeds with zero rows → `messages: []`,
        `source: "store"`, no modem read.
  - [ ] Modem fallback drops rows carrying `error` (no blank rows).

### R4 — Delete

- **Acceptance:**
  - [ ] `action=delete, storage="STORE"` removes exactly those `SmsId`s and
        nothing else; a non-numeric id is rejected, not interpolated.
  - [ ] The statement is scoped `sms_pos='0'` so a stale or forged id cannot
        delete a sent message.
  - [ ] A locked/busy DB reports `delete_failed` with the sqlite error, never a
        silent success.
  - [ ] `action=delete_all` writes a timestamped backup of the DB before the
        wipe, then clears `sms_pos='0'` and the modem memories.
  - [ ] `ME`/`SM` delete and `delete_all` on a device with no store behave
        exactly as today.

### R5 — Read state

- **Acceptance:**
  - [ ] A message the device reports read renders as read on first load in a
        browser with empty local storage; `unreadCount` matches the store's
        `readed='1'` count.
  - [ ] Browser-local marks still work and still take precedence in the read
        direction (a locally-marked message cannot become unread).

### R6 — Cost (measured, same harness both runs)

- **Acceptance:**
  - [ ] Wall time per inbox GET drops by at least an order of magnitude.
  - [ ] CPU per GET (user+sys, children included) drops.
  - [ ] Fork count per GET drops — the store path takes no AT lock, so it also
        stops blocking the poller for seconds per page load.

## Edge-case validation (closed out at the end, not up front)

| Edge case | How it will be exercised | Expected |
| --- | --- | --- |
| Store missing | point the path variable at a non-existent file | modem path; page still renders |
| Query fails | `chmod 000` the DB copy / drop the table in a scratch copy | modem path + one warning |
| Store empty | delete all rows in a scratch copy | `messages: []`, `source: "store"` |
| Malformed `smsdate` | scratch row `214748364-00-0` | emitted verbatim, sorts last, no crash |
| Non-ASCII body | existing Urdu (`کوآرڈینیشن`) and `–`/`—` rows | renders unchanged |
| `sqlite3` missing | PATH point at a copy without it | modem path |
| DB locked | hold a write transaction, then GET | completes or falls back, no hang past the timeout |
| Delete a stale id | POST an `SmsId` that is outbox | 0 rows affected, reported honestly |
| Clock at 1970 | n/a — timestamps come from the message, not the device clock | unchanged |
