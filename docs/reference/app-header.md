# App header — the status strip

**Scope:** RG520N-EB (O5A Pro) — the measurements in "Cost" are from this unit.
The component itself is device-agnostic.

The top bar (`app-layout.tsx` > `<header>`) holds navigation on the left and the
**status strip** on the right: three live facts that answer "is anything wrong?"
without leaving the page you are on.

| File | Job |
| --- | --- |
| `components/app-layout.tsx` | The bar. Breadcrumbs left, `<AppStatusStrip />` right — the strip owns its own `ml-auto`, so the bar stays a two-child flex row |
| `components/app-status-strip.tsx` | The three lanes, their state maps and the two polls |
| `public/locales/*/common.json` > `statusStrip` | Every string and tooltip |

## The three lanes

| Lane | Glyph | Value | Goes to |
| --- | --- | --- | --- |
| Connection | `cell_tower` / `priority_high` / `radar` / `signal_disconnected` / `airplanemode_active` / `help` | `Jazz · 5G-NSA` | `/dashboard` |
| Signal | `signal_cellular_{0..4}_bar`, `signal_cellular_off` | `-77 dBm` (serving leg RSRP) | `/cellular` |
| Live traffic | `swap_horiz` | `↓ 610 kB/s · ↑ 3.1 MB/s` | `/dashboard` |

Three, not more, and each is one question with one answer that changes without a
reload. They are **links**, not controls: the strip never mutates anything,
because chrome is one keystroke from being pressed by accident on every route.

Lane values hide below the `desktop` breakpoint (`68.75rem`); the glyphs stay.
The glyph — never the colour — is what carries state, which is what keeps the
strip readable in greyscale, under deuteranopia, and on a screen in sunlight.

### Connection states

`service_status` and the two reachability flags map one-to-one onto glyphs:

| State | Source | Glyph |
| --- | --- | --- |
| up | `service_status` ∈ {optimal, connected} + `modem_reachable` | `cell_tower` |
| limited | `service_status = limited` | `priority_high` |
| searching | `searching`, or `unknown` on a reachable modem | `radar` |
| down | `no_service`, `sim_error` | `signal_disconnected` |
| radio off | `network.cfun` ∈ {0, 4} | `airplanemode_active` |
| unknown | `modem_reachable = false` | `help` |

**`modem_reachable = false` is not "offline".** It means the poller could not
observe the modem at all; the lane says "Unknown" and its tooltip says why. Same
rule the dashboard's Radio chip follows.

## Cost — measured 2026-11-05 on this unit

This mounts on **every** route, so both polls are deliberately slower than the
dashboard's, and both stop while the tab is hidden (`document.visibilityState`).

| Poll | Cadence | Endpoint | Why that number |
| --- | --- | --- | --- |
| Status | 10 s | `at_cmd/fetch_data.sh` (cached CGI, ~69 ms CPU / 7.4 forks per read — [live-traffic.md](./live-traffic.md)) | "Which cell am I on" changes on handover, not per poll. ~0.7 % of one core |
| Traffic | 1 s | static `/live-traffic.json` (**9.0 ms CPU / 1.4 forks** per read) | the sampler's own cadence; a static read, not a CGI — ~0.9 % of one core |

The dashboard polls status at 2 s; the strip's 10 s exists so that a page other
than `/dashboard` does not pay the dashboard's rate. `enabled: visible` on the
status hook (and the traffic hook's own hidden-tab gate) mean a backgrounded tab
spends nothing.

## Adding a lane

1. One state map (`LINK_GLYPH` / `LINK_INK`), one `read*()` returning a `Lane`.
   No two states may share a glyph — that is the rule the maps are keyed to.
2. Every string in `common.json` > `statusStrip`, in all five locales
   (`bun run i18n:check` must stay at 0 errors).
3. If the glyph is new, it must already be in `components/ui/material-symbol-names.ts`
   *and* the build-time subset — adding a name to the union alone ships a blank
   box. See [icon-system.md](./icon-system.md).
4. If the lane needs a new poll, price it first: the box has one core.
