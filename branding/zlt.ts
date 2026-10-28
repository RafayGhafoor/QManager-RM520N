// =============================================================================
// branding/zlt.ts — ZLT / Tozed Kangwei
// =============================================================================
// THE WORLD: "nameplate, not dashboard."
//
// A ZLT CPE arrives as warm anodised metal and matte plastic with one printed plate
// and one LED. Nobody at Tozed hand-picked a Pantone for a web app; what the hardware
// has, and what a field tech recognises, is a *temperature*: warm greys, and a single
// hot accent that means "powered / selected". So this brand does not repaint the
// console in a logo colour — it moves the whole surface from instrument glass to
// warm graphite, and lets one signal-orange carry the acting role.
//
// This palette is a QManager-authored interpretation, NOT an official Tozed brand
// guide. It exists so a ZLT-badged build feels like the box it runs on; swap the
// tokens in this file if the OEM supplies real ones. Nothing outside this file and
// `public/brands/zlt-mark.svg` has to change.
//
// -----------------------------------------------------------------------------
// WHY THE ACTING HUE IS ORANGE AND NOT THE OBVIOUS RED
// -----------------------------------------------------------------------------
// The reflex is a red brand, because the vendor's own Element-UI pages look
// alarming. But `--primary` in this design system is the only hue that ACTS
// (buttons, links, focus, active nav) *and* the NR / 5G identity — see
// branding/types.ts. Painting the acting role red puts it 10° from `--destructive`,
// and on an instrument surface a red button next to a red alarm chip is a usability
// defect, not a brand. So the three warm hues are ORDERED by lightness and separated
// by hue, each keeping its job:
//
//   destructive  oklch(0.47 0.18 18)   deepest, crimson  — "this will break something"
//   primary      oklch(0.56 0.17 40)   mid, signal orange — "this acts / this is NR"
//   warning      oklch(0.62 0.12 92)   lightest, gold     — "read this"
//
// …and separation is not left to the eye alone: measured ΔE between primary and
// destructive is 0.11 in OKLab (5.6× a just-noticeable difference), and between
// primary and warning 0.15. The one place they sit adjacent is a status chip row,
// where each also carries a glyph and a label (the Glyph-Carries-The-State Rule).
//
// Values are in-gamut by construction, chroma floored to 98.5% of the sRGB maximum
// for its lightness and hue (DESIGN.md > The In-Gamut Rule). Verified with an
// OKLab→sRGB brute-force search, not by eye.
// -----------------------------------------------------------------------------
//
// TYPOGRAPHY: Space Grotesk. A technical grotesque — square-cut terminals, a
// single-storey 'a' won't be found here but the 'g' and the numerals are plainly
// industrial — chosen against Rethink Sans' friendlier geometry so the two builds
// are distinguishable at a glance from across a room. Monospace stays JetBrains
// Mono: the machine voice is product DNA, and swapping it would cost the two builds
// comparable numerals, which is the one thing a rebrand must not do.
//
// VENDORED, per the repo's own rule (all faces local; the build touches no network):
//   app/fonts/SpaceGrotesk-Variable.woff2 — Google Fonts, latin subset, variable
//   300..700, OFL-1.1.
//   https://fonts.gstatic.com/s/spacegrotesk/v22/V8mDoQDjQSkFtoMM3T6r8E7mPbF4C_k3HqU.woff2
//   sha256 a0d054c4af557de20afd6ca59f47ab353bcaec49c63ff04b6c9d39d0f8910557
// =============================================================================

import type { RouterBrand } from "./types";

// --- the warm ramp -----------------------------------------------------------
// One hue (65°) for every neutral, chroma kept under 0.013 so it reads as a tint of
// the same metal rather than as a coloured surface. Chroma rises slightly with
// depth, which is how the canonical cool ramp is built too.
const NEUTRAL_HUE = 65;

const ORANGE = 40; // primary / NR / act
const CRIMSON = 18; // destructive
const GOLD = 92; // warning

const primaryLight = `oklch(0.560 0.170 ${ORANGE})`;
const primaryDark = `oklch(0.680 0.150 ${ORANGE})`;
const destructiveLight = `oklch(0.470 0.180 ${CRIMSON})`;
const destructiveDark = `oklch(0.630 0.180 ${CRIMSON})`;
const warningLight = `oklch(0.620 0.120 ${GOLD})`;
const warningDark = `oklch(0.800 0.130 ${GOLD})`;

export const zlt: RouterBrand = {
  id: "zlt",
  vendor: "Tozed Kangwei",
  productName: "ZLT",
  markSrc: "/brands/zlt-mark.svg",
  font: {
    cssVar: "--font-space-grotesk",
    family: "Space Grotesk",
    fallback: "ui-sans-serif, system-ui, sans-serif",
  },

  tokens: {
    light: {
      // --- ground: warm graphite, not cool glass ---
      "--background": `oklch(0.985 0.004 ${NEUTRAL_HUE})`,
      "--foreground": `oklch(0.205 0.011 ${NEUTRAL_HUE})`,
      "--surface": `oklch(1.000 0.000 ${NEUTRAL_HUE})`,
      "--surface-container": `oklch(0.967 0.005 ${NEUTRAL_HUE})`,
      "--surface-container-high": `oklch(0.938 0.007 ${NEUTRAL_HUE})`,
      "--on-surface": `oklch(0.205 0.011 ${NEUTRAL_HUE})`,
      "--on-surface-variant": `oklch(0.505 0.012 ${NEUTRAL_HUE})`,
      "--card": `oklch(1.000 0.000 ${NEUTRAL_HUE})`,
      "--card-foreground": `oklch(0.205 0.011 ${NEUTRAL_HUE})`,
      "--popover": `oklch(1.000 0.000 ${NEUTRAL_HUE})`,
      "--popover-foreground": `oklch(0.205 0.011 ${NEUTRAL_HUE})`,
      "--sidebar": `oklch(0.967 0.005 ${NEUTRAL_HUE})`,
      // The sidebar sits on the container step, so its border is the ground's own
      // hairline; the canon does the same on the cool ramp.
      "--border": `oklch(0.905 0.006 ${NEUTRAL_HUE})`,
      "--input": `oklch(0.868 0.008 ${NEUTRAL_HUE})`,

      // --- the hue that acts (and is the NR identity) ---
      "--primary": primaryLight,
      "--primary-foreground": "oklch(0.985 0.008 60)",
      "--primary-on-surface": `oklch(0.530 0.160 ${ORANGE})`,
      "--primary-container": "oklch(0.890 0.055 55)",
      "--on-primary-container": `oklch(0.360 0.110 ${ORANGE})`,
      "--ring": primaryLight,
      "--sidebar-primary": primaryLight,
      "--sidebar-primary-foreground": "oklch(0.985 0.008 60)",
      "--sidebar-ring": primaryLight,

      // --- info rides with primary (the canon ships them identical) ---
      "--info": primaryLight,
      "--info-foreground": "oklch(0.985 0.008 60)",
      "--info-on-surface": `oklch(0.530 0.160 ${ORANGE})`,
      "--info-container": "oklch(0.890 0.055 55)",
      "--on-info-container": `oklch(0.360 0.110 ${ORANGE})`,

      // --- status hues, retuned so the warm trio stays separable ---
      "--warning": warningLight,
      "--warning-foreground": "oklch(0.985 0.008 92)",
      "--warning-on-surface": `oklch(0.560 0.110 ${GOLD})`,
      "--warning-container": "oklch(0.900 0.060 92)",
      "--on-warning-container": "oklch(0.360 0.070 92)",

      "--destructive": destructiveLight,
      "--destructive-foreground": "oklch(0.985 0.007 18)",
      "--destructive-on-surface": `oklch(0.460 0.170 ${CRIMSON})`,
      "--destructive-container": "oklch(0.880 0.060 18)",
      "--on-destructive-container": `oklch(0.350 0.130 ${CRIMSON})`,
    },

    dark: {
      "--background": `oklch(0.120 0.008 ${NEUTRAL_HUE})`,
      "--foreground": `oklch(0.965 0.004 ${NEUTRAL_HUE})`,
      "--surface": `oklch(0.170 0.009 ${NEUTRAL_HUE})`,
      "--surface-container": `oklch(0.200 0.010 ${NEUTRAL_HUE})`,
      "--surface-container-high": `oklch(0.235 0.012 ${NEUTRAL_HUE})`,
      "--on-surface": `oklch(0.965 0.004 ${NEUTRAL_HUE})`,
      "--on-surface-variant": `oklch(0.762 0.011 ${NEUTRAL_HUE})`,
      "--card": `oklch(0.170 0.009 ${NEUTRAL_HUE})`,
      "--card-foreground": `oklch(0.965 0.004 ${NEUTRAL_HUE})`,
      "--popover": `oklch(0.170 0.009 ${NEUTRAL_HUE})`,
      "--popover-foreground": `oklch(0.965 0.004 ${NEUTRAL_HUE})`,
      "--sidebar": `oklch(0.170 0.009 ${NEUTRAL_HUE})`,
      "--border": `oklch(0.288 0.012 ${NEUTRAL_HUE})`,
      "--input": `oklch(0.330 0.013 ${NEUTRAL_HUE})`,

      "--primary": primaryDark,
      "--primary-foreground": `oklch(0.195 0.055 ${ORANGE})`,
      "--primary-on-surface": `oklch(0.720 0.135 ${ORANGE})`,
      "--primary-container": "oklch(0.375 0.110 42)",
      "--on-primary-container": "oklch(0.900 0.045 55)",
      "--ring": primaryDark,
      "--sidebar-primary": primaryDark,
      "--sidebar-primary-foreground": `oklch(0.195 0.055 ${ORANGE})`,
      "--sidebar-ring": primaryDark,

      "--info": primaryDark,
      "--info-foreground": `oklch(0.195 0.055 ${ORANGE})`,
      "--info-on-surface": `oklch(0.720 0.135 ${ORANGE})`,
      "--info-container": "oklch(0.375 0.110 42)",
      "--on-info-container": "oklch(0.900 0.045 55)",

      // Dark warning is a bright gold on purpose: at dark-surface lightness an ochre
      // loses its "read this" energy and reads as a second orange instead.
      "--warning": warningDark,
      "--warning-foreground": "oklch(0.195 0.040 95)",
      "--warning-on-surface": `oklch(0.800 0.120 ${GOLD})`,
      "--warning-container": "oklch(0.400 0.080 95)",
      "--on-warning-container": "oklch(0.900 0.060 95)",

      "--destructive": destructiveDark,
      "--destructive-foreground": `oklch(0.195 0.055 ${CRIMSON})`,
      "--destructive-on-surface": `oklch(0.680 0.160 ${CRIMSON})`,
      "--destructive-container": "oklch(0.400 0.120 20)",
      "--on-destructive-container": "oklch(0.900 0.050 20)",
    },
  },

  notes:
    "Warm graphite ground, signal-orange as the acting/5G hue, gold warning and crimson destructive ordered by lightness, Space Grotesk for the UI voice.",
};
