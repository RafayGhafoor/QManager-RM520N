// =============================================================================
// branding/index.ts — pick the brand, emit its tokens
// =============================================================================
// A brand is chosen ONCE, at build time, from `NEXT_PUBLIC_ROUTER_BRAND` — this is a
// static export served by the device, so there is no server to vary it per request
// and no reason to ship every brand's tokens to every device. One build = one face.
//
//   NEXT_PUBLIC_ROUTER_BRAND=zlt bun run build      # a ZLT-badged console
//   bun run build                                   # the canonical QManager face
//
// An unknown id falls back to the canonical brand and says so ONCE, at build time,
// where the person who mistyped it is looking. Silently shipping the default in
// production because of a typo is the failure mode to avoid — see `resolveBrand`.
//
// The tokens are emitted as a stylesheet (not inline style on <html>) because a
// brand overrides the SAME custom properties in both themes, and inline style would
// win over `.dark` too — painting every dark mode with the light ramp.
// =============================================================================

import { qmanager } from "./qmanager";
import { zlt } from "./zlt";
import type { RouterBrand } from "./types";

export type { RouterBrand, BrandTokens, BrandFont } from "./types";

/** Every brand this build knows. Order is the documented listing order. */
export const BRANDS = { qmanager, zlt } as const satisfies Record<string, RouterBrand>;

/** The default when `NEXT_PUBLIC_ROUTER_BRAND` is unset. */
export const DEFAULT_BRAND_ID = "qmanager";

/** The brand this build is. Resolved once; safe to import anywhere. */
export const BRAND: RouterBrand = resolveBrand(process.env.NEXT_PUBLIC_ROUTER_BRAND);

/**
 * Resolve a brand id, never throwing.
 *
 * Unknown ids are a build-time configuration mistake, and the honest handling is to
 * say so loudly where the mistake was made and then still build a working image —
 * a device in the field cannot be reflashed because of a typo in a brand name.
 */
export function resolveBrand(id: string | undefined): RouterBrand {
  const wanted = (id ?? "").trim().toLowerCase();
  if (!wanted) return BRANDS[DEFAULT_BRAND_ID];

  const found = BRANDS[wanted as keyof typeof BRANDS];
  if (found) return found;

  // eslint-disable-next-line no-console -- build-time configuration error, not runtime noise
  console.warn(
    `[branding] NEXT_PUBLIC_ROUTER_BRAND="${id}" is not a known brand ` +
      `(known: ${Object.keys(BRANDS).join(", ")}). ` +
      `Falling back to "${DEFAULT_BRAND_ID}".`,
  );
  return BRANDS[DEFAULT_BRAND_ID];
}

/**
 * The brand's token overrides as CSS, scoped to `data-brand` so the canonical
 * `:root` / `.dark` blocks in `app/globals.css` stay untouched.
 *
 * Specificity: `:root[data-brand="zlt"]` is (0,2,0) and beats the canon's `.dark`
 * (0,1,0); the dark variant `:root[data-brand="zlt"].dark` is (0,3,0) and beats
 * both. So this works regardless of stylesheet order.
 *
 * Returns an empty string for a brand that overrides nothing, which keeps the
 * canonical build's DOM byte-identical to what it was before branding existed.
 */
export function brandStyleSheet(brand: RouterBrand = BRAND): string {
  const block = (tokens: Record<string, string>) =>
    Object.entries(tokens)
      .map(([name, value]) => `${name}:${value}`)
      .join(";");

  const light = block(brand.tokens.light as Record<string, string>);
  const dark = block(brand.tokens.dark as Record<string, string>);
  if (!light && !dark) return "";

  const sel = `:root[data-brand="${brand.id}"]`;
  return [
    light ? `${sel}{${light}}` : "",
    dark ? `${sel}.dark{${dark}}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The font wiring, as CSS custom properties for `<html>`.
 *
 * The layout declares every vendored face with `next/font/local` (they must be
 * declared at module scope for Next to emit the @font-face rules), and this picks
 * which one feeds `--font-sans`. The canonical brand returns nothing: its face is
 * already the fallback in `@theme inline`.
 */
export function brandFontVars(brand: RouterBrand = BRAND): Record<string, string> {
  if (brand.id === DEFAULT_BRAND_ID) return {};
  return { "--font-brand-sans": `var(${brand.font.cssVar})` };
}
