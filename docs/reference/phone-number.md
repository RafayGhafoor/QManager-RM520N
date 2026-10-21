# Phone Number (MSISDN) — why the dashboard shows it blank

> **Scope: RG520N** — every measurement below is first-hand on the GreenPacket
> O5A Pro (`RG520N-EB`, `sdxlemur`, `LE.UM.6.2.3.r1-03100-SDX65.0`) with a
> **Jazz PK (MCC/MNC 410-01) prepaid** SIM, 2026-10-21. Nothing here is a claim
> about the RM520N-GL, whose test SIM *does* carry an MSISDN (see
> [sim-detection.md](sim-detection.md)).

**Short version:** the dashboard's "Not provisioned" state is *correct*. This
SIM's `EF_MSISDN` file exists and is readable, and its record is 28 bytes of
`0xFF` — the carrier never wrote the number to the card. Five independent
readers agree, including two below the AT layer. The network *does* know the
number, and Jazz's `*99#` returns it to a phone, but this modem's NAS stack
rejects the reply (`+CME ERROR: unknown network message`). So there is **no
automatic local source for the phone number on this device**, and the only way
to put one on the dashboard is a number the owner supplies.

## Where the value comes from, and where it stops

`AT+CNUM` → poller → `/tmp/qmanager_status.json` `.device.phone_number` →
`components/dashboard/device-status.tsx` and `sim_registry.json`. Nothing is
broken in that chain; the first link returns an empty string.

- Poller boot batch: `scripts/usr/bin/qmanager_poller` (`AT+…;+CNUM`).
- Poller per-cycle refresh: same file, `AT+COPS?;+QUIMSLOT?;+CNUM;+QSIMSTAT?;+CPIN?`.
  A blank reply **resets** `boot_phone_number` to `""` — deliberate, so a SIM
  swap cannot leave a stale number behind.
- Rendered at `components/dashboard/device-status.tsx:168` as
  `data?.phone_number || ABSENT`, so an empty value paints the dash, not a blank row.

## What was measured

| # | Technique | Command | Result | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Standard CNUM | `AT+CNUM` | `+CNUM: ,"",255` | empty, type 255 = unknown |
| 2 | `EF_MSISDN` header | `AT+CRSM=192,28480` | FCI `…83026F40…8002001C8800` → file exists, 28-byte record, activated (`8A0105`) | file is real and reachable |
| 3 | `EF_MSISDN` record | `AT+CRSM=178,28480,1,4,28` | `144,0` SW **9000** + 28 × `FF` | **blank, never provisioned** |
| 4 | Raw APDU, DF_TELECOM | `AT+CSIM` `A4 3F00` → `7F10` → `6F40` → `B2 01 04 1C` | SW `9000`, 28 × `FF` | agrees with #3 |
| 5 | Raw APDU, ADF USIM | `AT+CSIM` `A4 7FFF` → `6F40` → `B2 01 04 1C` | SW `9000`, 28 × `FF` | agrees with #3 |
| 6 | Qualcomm MSISDN | `AT$QCMSISDN?` | bare `OK`, no value | nothing known to the modem |
| 7 | Qualcomm OMADM table | `AT$QCPCOMSISDN?` | 3 entries, all fields `0` | not provisioned |
| 8 | QMI (sibling product) | `qmicli --dms-get-msisdn` | `NotProvisioned` (measured on this unit, `greenpacket-o5a` plan 2026-07-21) | same underlying EF |
| 9 | Vendor daemon | `ubus call modemd status` → `phone_num` | `""` | vendor UI has nothing to show either |

**The control matters more than any single row.** Rows 2–5 use the *same* read
path as the failures, so "the technique does not work here" is excluded:

```
AT+CRSM=176,12258,0,0,10   → 144,0,"982903002014251827F7"   (EF_ICCID, real bytes)
AT+CRSM=176,28423,0,0,9    → 144,0,"084901102014251827"     (EF_IMSI, real bytes)
AT+CRSM=176,28480,0,0,28   → 148,8,""                       (EF_MSISDN: SW 9408 on READ BINARY)
```

`9408` on READ BINARY is *not* the answer — `EF_MSISDN` is a **linear-fixed**
record file, so `176` (READ BINARY) is the wrong command and the card rejects it
with "inconsistent instruction with the file structure". The record read is
`178` (READ RECORD), and that returns `9000` with all-`FF`. Reading `9408` as
evidence of anything else — as one outside analysis did — is a misdiagnosis.

## The network route: available to a phone, not to this modem

USSD **works end-to-end on this module**, which is what makes the failure
diagnosable rather than vague:

| Code | Purpose | Result |
| --- | --- | --- |
| `AT+CUSD=1,"*111#",15` | Jazz prepaid balance (control) | `+CUSD: 0,"Rs.81.50 … Rs1.40/day.",15` — live text |
| `AT+CUSD=1,"*789#",15` | Jazz interactive service | `+CUSD: 1,"Enter Mobile Number (11-digits):",15` — session opens |
| `AT+CUSD=1,"*99#",15` | **Jazz own-number** | `OK`, then ~3 s later `+CME ERROR: unknown network message` |
| `AT+CUSD=1,"*99#",0` / `,72` | same, other DCS values | identical failure |
| `ATD*99#;` | same as a supplementary-service / MMI string | `OK`, `ERROR`, then `NO CARRIER` |
| `sms_tool send 667 MNP` | Jazz SMS fallback | `sms sent sucessfully: 235`, **no reply** after 2 min (inbox unchanged at 24) |

The `+CME ERROR: unknown network message` is the important one: the network
**does** answer `*99#`, and the modem's NAS stack cannot parse the message it
gets back. The phone on the same network parses it fine. That is a firmware
limitation inside the modem — not a subscription block, not something QManager
can route around, because the unparsed NAS message never reaches the host.

`*99#` failures are reproducible (4/4) and **not** state pollution from the
`*789#` session: the control `*111#` succeeds in the same minute, and USSD
cancel (`AT+CUSD=2`) returns `ERROR` whether or not a session is open.

## Rejected approaches — do not retry these

1. **`AT+CNUM` is not "unsupported"; it is answering honestly.** The reply
   `,"",255` means "no alpha tag, no number, type unknown". Adding a retry,
   a longer timeout, or a different port will not change it.
2. **USSD `*99#` (Jazz) or `*789#`.** `*99#` fails at the NAS parse (above).
   `*789#` is *not* an own-number service — it asks *you* to type an 11-digit
   number, so it cannot reveal yours.
3. **SMS `MNP` → 667.** Documented by Jazz for handsets; the message was
   accepted by the network (`235`) and no reply arrived. If a port wants this
   route, it must prove a reply first — do not build a UI on it.
4. **IMS `P-Associated-URI`.** Phones on some carriers learn the number here.
   Unreachable on this device: `ubus call modemd status` reports
   `ims_apn_status: "0"`, i.e. no IMS bearer is registered, and Quectel exposes
   no AT command that returns the registered URI. Not a route while IMS is down.
5. **`AT+CRSM=176,28480,…` and "the 9408 means something".** Wrong command for a
   linear-fixed file; see the control above.

## What a port must re-measure

- **Whether the new carrier writes `EF_MSISDN`.** Many postpaid SIMs do; the
  poller then publishes a real number with no code change. Check row 3 first —
  it is one command and decides the whole question.
- **Whether `*99#` (or the local own-number code) parses.** Row `*111#` must
  pass first as a control, otherwise a USSD failure is uninterpretable.
- **`ims_apn_status`** before considering any IMS-based route.
- The `+CME ERROR` text is device-specific; record the literal string, not
  "USSD does not work".

## If the number must appear on the dashboard

The honest options, in order:

1. **Owner-supplied value** bound to the SIM registry entry
   (`sim_registry.json`, keyed by normalized ICCID — see
   [sim-detection.md](sim-detection.md)), rendered only when `AT+CNUM` returns
   nothing, and visibly marked as manually set so it is never mistaken for a
   carrier-provisioned fact. The registry already stores `phone_number` per SIM
   and the SWR banner / device card already read that path.
2. **Do nothing.** `ABSENT` is truthful and already implemented.

What is *not* an option on this hardware: deriving the number from the IMSI,
ICCID, or the WAN address. There is no arithmetic relationship, and the
dashboard must not imply that there is.
