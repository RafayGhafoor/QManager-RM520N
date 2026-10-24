# smartdns (smartdns-rs) — attribution and source offer

**Shipped file:** `smartdns` — 7,029,804 bytes,
`sha256 2caca59f6c9a68a09de10c32414693b3eae3cc4ab6a42166343f8589070cb291`,
`ELF 32-bit LSB executable, ARM, EABI5 version 1 (SYSV), statically linked, stripped`.
Installs to `/usrdata/qmanager/bin/smartdns`.

**Upstream:** smartdns-rs — <https://github.com/mokeyish/smartdns-rs>
**Version:** **0.13.1**. Established first-hand from the running daemon's own startup
line on this device — `/tmp/smartdns.log` → `INFO: SmartDNS 🐋 0.13.1 starting` — and
independently recorded in the sibling product's `dns.md:104`.

**Provenance:** a **published release asset**, not built by this project. This branch
takes the bytes the sibling repo (`greenpacket-o5a`) already ran in production, and
the sha256 above is the check that it is the same binary rather than a rebuild.

## Licence

**GNU General Public License, version 3** — <https://www.gnu.org/licenses/gpl-3.0.html>.
The full text ships beside this file as [`LICENSE.GPL-3.0`](./LICENSE.GPL-3.0)
(674 lines, `sha256 3972dc97…`).

Per the upstream README, the binary is not wholly GPL-3.0:

| Part | Licence |
| --- | --- |
| smartdns-rs itself | GPL-3.0 |
| Code derived from [hickory-dns](https://github.com/hickory-dns/hickory-dns) | dual Apache-2.0 **or** MIT, at the user's option |

## Why this is committed to git (not fetched at deploy)

Decided explicitly under hard rule 9, by the owner on 2026-10-23. This binary is the
**resolver every LAN client on the device depends on**; a fresh install that has to
reach a download host to obtain it fails in the one way that takes DNS away from the
whole LAN. The size precedent is `dependencies/qmi/` (~2.7 MB, committed for the same
"a fresh device has no other source" reason).

Rejected alternatives, so this is not re-litigated:

- **Fetch at deploy** (like `jq` / `speedtest`): makes the resolver network-dependent
  at install time. `jq` and `speedtest` may fail and be retried later; DNS may not.
- **Do not ship it**: falls back to carrier-only resolution, which this branch
  measured stalling 600–1300 ms on 4 of 10 cold names.

## GPL-3.0 compliance

Distribution of a GPL-3.0 binary obliges us to make the **corresponding source**
available. Where it is:

| What | Where |
| --- | --- |
| Upstream source | <https://github.com/mokeyish/smartdns-rs> — release tag **v0.13.1** |
| Exactly-this-build source | the tag matching the version above; this project makes **no local patches** to the resolver. If a patched build is ever shipped, the patch must be published here in `dependencies/smartdns/patches/` and applied to that tag |
| Written offer | contact the project owner (`RafayGhafoor/QManager-RM520N`) for a copy of the source archive for this exact binary |

**No local modifications.** The vendored file is byte-identical to the upstream release
asset (`sha256 2caca59f…`); nothing in this repository links it statically into
QManager code, patches it, or sublicenses it. It runs as a separate process, so
QManager's own licensing is unaffected — the same reasoning `dependencies/NOTICE`
already applies to the LGPL QMI libraries.

**Correction carried over from the sibling repo:** that repository commits this same
binary with **no NOTICE entry and no licence text**. This file and
`LICENSE.GPL-3.0` exist so this branch does not repeat that omission.

## Run-time notes worth having next to the licence

- The daemon is **not** the LAN-facing resolver. `dnsmasq` owns `192.168.0.1:53` and
  `strict-order`-forwards to `127.0.0.1:5353`; stopping smartdns therefore degrades
  rather than breaks LAN DNS.
- `smartdns test -c <file>` **validates nothing** on 0.13.1 (unknown directives are
  silently ignored). Never gate a configuration deploy on it — run the candidate on a
  throwaway port and assert that it serves. Recorded at `dns.md:489` in the sibling
  repo and repeated in this branch's `docs/reference/smartdns.md`.
