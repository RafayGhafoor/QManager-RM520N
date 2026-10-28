# branding — one instance, many faces

QManager is installed onto hardware QManager does not make. The OEM whose name is on
the plastic usually wants its own colour and voice, and forking the UI to give it to
them is how two dashboards drift apart until a bug is fixed in one. So a **brand is a
data file**, and this directory is the only place a brand may change anything.

```
branding/
├── types.ts      what a brand MAY own (a closed, typed set) and what it may not
├── qmanager.ts   the canonical face — overrides nothing, inherits the design system
├── zlt.ts        ZLT / Tozed Kangwei — warm graphite, signal orange, Space Grotesk
└── index.ts      the registry, the resolver, and the token→CSS emitter
```

## Build a badged instance

```sh
NEXT_PUBLIC_ROUTER_BRAND=zlt bun run build   # ZLT-badged console  → out/
bun run build                                # canonical QManager  → out/
```

One build produces one face: this is a static export served by the device itself, so
there is no server to vary it per request and no reason to ship every brand's tokens
to every unit. An unknown id is a **build-time** mistake: it warns once with the list
of known brands and still builds a working image (a field device cannot be reflashed
because a variable was misspelled).

## Add a brand for another router

1. Add the face's `@font-face` — vendored, never fetched at build time (the repo rule:
   *self-hosted assets only*). Drop the woff2 in `app/fonts/`, declare it with
   `localFont({ variable: "--font-<face>", … })` in `app/layout.tsx` (already done for
   the two shipped faces), and record its upstream URL + sha256 beside the
   declaration.
2. Copy `branding/qmanager.ts` to `branding/<slug>.ts` and fill it in: `id`, `vendor`,
   `productName`, `markSrc`, `font.cssVar`, and the tokens the brand owns in both
   themes.
3. Register it in `branding/index.ts` → `BRANDS`.
4. Add its mark to `public/brands/<slug>-mark.svg` — same geometry as
   `public/qmanager-mark.svg`, the brand's own pair of tones (the mark is the source
   of the colour system, so a brand that keeps the blue mark reads as a repaint).
5. Build with `NEXT_PUBLIC_ROUTER_BRAND=<slug>` and look at it (see *Verify* below).

## What a brand may own — and why the line is where it is

| Owned | Why it is safe |
|---|---|
| **neutrals** (background, surface, card, border, sidebar, input, popover) | Temperature is most of the "different product" signal and carries no meaning. |
| **primary** + `ring`, `sidebar-primary`, `sidebar-ring` | The only hue that *acts* (buttons, links, focus, active nav) **and** the NR/5G identity. A brand must supply one, or 5G loses its colour. |
| **info** | Ships identical to primary in the canon, so it must move with it or two blues sit a few pixels apart. |
| **warning**, **destructive** | Retunable, because a warm brand accent lands between the canonical ochre and crimson at a glance; the brand must then *prove* they stayed separable. |
| **font** | The voice. Vendored, one file per face. |

| Never owned | Why |
|---|---|
| `lte`, `uplink`, `downlink`, `spatial`, `success` | Semantic identities, not decoration. Carrier Violet **is** "4G", cyan **is** "uplink", green **is** "healthy". A field tech carrying the same tool between two badged units must not have to relearn what a colour means. |
| `quality-1..5`, `tag-*` | Data-encoding scales, tuned against contrast minima. |
| `--radius`, motion tokens | Shape and motion are the product's. |

Enforced by the type, not by this table: `BrandTokens` in `types.ts` is a closed
record, so a brand that reaches for `--lte` does not compile.

## Rules the emitter holds to

- **In-gamut by construction** (DESIGN.md > The In-Gamut Rule). Every `oklch()` here
  was checked with an OKLab→sRGB brute-force search, chroma floored to 98.5 % of the
  maximum for its lightness and hue. Lightning CSS gamut-maps out-of-range values at
  build time, so an out-of-range token ships a colour nobody authored.
- **Dark is its own ramp**, not a tint of light. The overrides are emitted as
  `:root[data-brand="…"]` + `:root[data-brand="…"].dark`, which outranks the canon's
  `.dark` (0,1,0) regardless of order. Inline style on `<html>` would have beaten
  both and painted dark mode with the light ramp — hence a `<style>` element.
- **The canonical build is byte-identical to before branding existed**: empty token
  maps → no `<style>` element, no `--font-brand-sans`, `data-brand="qmanager"` is the
  only addition.
- The brand's face is applied to **`<body>`**, not just to `--font-sans`. `body` gets
  its family from `localFont(...).className` and only four call sites use the
  `font-sans` utility, so a `--font-sans`-only override would leave most of the app
  in the canonical type.

## Verify

Build the brand, serve the export, and look at it in both themes:

```sh
NEXT_PUBLIC_ROUTER_BRAND=zlt bun run build
(cd out && python3 -m http.server 8080)      # the export is static; any server works
npx playwright screenshot --color-scheme dark --viewport-size "1440,900" \
  http://127.0.0.1:8080/login/ dark.png
```

Committed evidence for the ZLT brand lives in `docs/branding/`
(`login-{qmanager,zlt}-{light,dark}.png`, `splash-*.png`) — captured from the two
builds at 1440×900, Chromium, `prefers-color-scheme` honoured, with the CGI endpoints
stubbed so the pages paint.

```sh
grep -c 'id="brand-tokens"' out/login/index.html   # 1 for a badged build, 0 canonical
grep -o 'data-brand="[a-z]*"' out/login/index.html # the resolved brand
```

## Shipped brands

| id | vendor | ground | acting hue | face |
|---|---|---|---|---|
| `qmanager` | Quectel | cool, hue 258 | the mark's blue | Rethink Sans |
| `zlt` | Tozed Kangwei | warm graphite, hue 65 | signal orange, hue 40 | Space Grotesk |

`zlt` is a **QManager-authored interpretation**, not an official Tozed brand guide:
the vendor's own pages are stock Element-UI, so there is no published palette to
match. It exists so a ZLT-badged build feels like the box it runs on; replace the
tokens in `zlt.ts` if the OEM supplies real ones. Nothing outside that file and
`public/brands/zlt-mark.svg` needs to change.
