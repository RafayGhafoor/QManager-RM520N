// =============================================================================
// branding/types.ts — what a router brand is allowed to own
// =============================================================================
// ONE INSTANCE, MANY FACES. QManager ships onto hardware it does not make, and the
// OEM whose name is on the plastic usually wants its own colour and voice. A brand
// is therefore a DATA file, not a fork: this module declares the small, closed set
// of things a brand may change, and `app/globals.css` stays the single source of
// the design system for everything else.
//
// WHAT A BRAND MAY OWN — and the reasoning for each boundary:
//
//   neutrals    The ground. A brand that reads warm (anodised metal, nameplate)
//               versus cool (instrument glass) is most of the "this is a different
//               product" signal, and it costs nothing semantically.
//   primary     The ONLY hue that acts (buttons, links, focus, active nav) and, by
//               DESIGN.md, also the NR / 5G identity. A brand must supply a hue
//               here or 5G loses its colour and the console goes blind on the one
//               distinction it exists to make.
//   info        Ships as the same blue as primary in the canonical palette, so it
//               moves with it. A brand that left these mismatched would render two
//               blues a few pixels apart.
//   warning /   Retunable because a warm brand accent lands between the canonical
//   destructive ochre and crimson at a glance; the brand must prove it kept them
//               separable (see zlt.ts). Still two distinct hues, never one.
//   ring /      Sidebar and focus chrome derive from primary in the canon too.
//   sidebar*
//
// WHAT A BRAND MAY NOT OWN:
//
//   lte · uplink · downlink · spatial · success
//       Semantic identities, not decoration: Carrier Violet IS "this is the 4G
//       radio", cyan IS "uplink", green IS "healthy". A brand that repainted them
//       would make two devices' dashboards disagree about what a colour means —
//       unacceptable in a tool a field tech carries between units.
//   quality-1..5 · tag-*    Data-encoding scales, tuned against contrast minima.
//   --radius · motion       Shape and motion are the product's, not the OEM's.
//
// This boundary is enforced by the type below, not by a comment: `BrandTokens` is a
// closed record, so a brand file that reaches for `--lte` fails to type-check.
// =============================================================================

/**
 * The CSS custom properties a brand may override, mirroring the names that resolve
 * in `app/globals.css` (`:root` for light, `.dark` for dark).
 *
 * Every value is a CSS colour string in `oklch()` with an in-sRGB-gamut chroma —
 * the In-Gamut Rule in DESIGN.md is a correctness property, not a preference:
 * Lightning CSS gamut-maps an out-of-range `oklch()` at build time, so a token
 * outside sRGB ships a colour nobody authored.
 */
export type BrandTokens = Partial<
  Record<
    | "--background"
    | "--foreground"
    | "--surface"
    | "--surface-container"
    | "--surface-container-high"
    | "--on-surface"
    | "--on-surface-variant"
    | "--card"
    | "--card-foreground"
    | "--popover"
    | "--popover-foreground"
    | "--sidebar"
    | "--border"
    | "--input"
    | "--primary"
    | "--primary-foreground"
    | "--primary-on-surface"
    | "--primary-container"
    | "--on-primary-container"
    | "--info"
    | "--info-foreground"
    | "--info-on-surface"
    | "--info-container"
    | "--on-info-container"
    | "--warning"
    | "--warning-foreground"
    | "--warning-on-surface"
    | "--warning-container"
    | "--on-warning-container"
    | "--destructive"
    | "--destructive-foreground"
    | "--destructive-on-surface"
    | "--destructive-container"
    | "--on-destructive-container"
    | "--ring"
    | "--sidebar-primary"
    | "--sidebar-primary-foreground"
    | "--sidebar-ring",
    string
  >
>;

/** The typeface a brand speaks in. */
export interface BrandFont {
  /**
   * The CSS variable that `next/font/local` binds for this face — e.g.
   * `--font-space-grotesk`. `app/globals.css` maps `--font-sans` to
   * `var(--font-brand-sans, var(--font-rethink-sans))`, and the layout points
   * `--font-brand-sans` at whichever face the active brand chose.
   */
  cssVar: string;
  /** Human name, for the branding README and any diagnostics. */
  family: string;
  /**
   * Fallback stack appended after the local face. Kept brand-specific because a
   * geometric grotesque and a humanist sans want different neighbours when the
   * font file cannot load (a cold first paint on a slow link).
   */
  fallback: string;
}

/** A router brand: identity, voice, and the tokens it owns. */
export interface RouterBrand {
  /** Stable slug — the value of `NEXT_PUBLIC_ROUTER_BRAND`. */
  id: string;
  /** Who the build is branded for. Shown nowhere at runtime; used by docs/tests. */
  vendor: string;
  /** The wordmark line in the sidebar and the document title. */
  productName: string;
  /** The lockup's mark, as a path under `public/`. */
  markSrc: string;
  font: BrandFont;
  tokens: {
    light: BrandTokens;
    dark: BrandTokens;
  };
  /** One line for the branding README: what this brand is going for. */
  notes: string;
}
