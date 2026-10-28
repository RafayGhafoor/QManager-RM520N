import type { Metadata } from "next";
import "./globals.css";

import localFont from "next/font/local";
import { ThemeProvider } from "@/components/theme-provider";
import { MotionProvider } from "@/components/motion-provider";
import { MotionPreferenceProvider } from "@/components/motion-preference";
import { MOTION_BOOT_SCRIPT } from "@/lib/motion-preference";
import { I18nProvider } from "@/components/i18n/i18n-provider";
import { Toaster } from "@/components/ui/sonner";
import { BRAND, brandFontVars, brandStyleSheet } from "@/branding";

// Machine-voice mono font — bound to --font-jetbrains-mono, which globals.css
// maps to --font-mono (font-mono utility).
//
// VENDORED, NOT `next/font/google`. That loader self-hosts its OUTPUT but still
// makes a live request to fonts.googleapis.com on every cold build; on a slow
// link it times out and the production build dies. This app is built to be
// served BY the modem, often from a field machine on a poor connection, so a
// build-time dependency on a third-party CDN is the wrong shape. All faces here
// are local; the build touches no network.
//
// The file is Google's own latin cut of the variable font, byte-for-byte:
//   https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbV2o-flEEny0FZhsfKu5WU4xD7OwE.woff2
//   sha256 18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e
// `weight: "100 800"` and the `unicode-range` below are copied from that same
// stylesheet, so the declaration the browser sees is unchanged — only where the
// bytes come from changed. Re-vendoring means re-fetching the `css2?family=
// JetBrains+Mono:wght@100..800` stylesheet and taking its `/* latin */` block.
const jetbrainsMono = localFont({
  variable: "--font-jetbrains-mono",
  display: "swap",
  src: [
    {
      path: "./fonts/JetBrainsMono-Variable.woff2",
      weight: "100 800",
      style: "normal",
    },
  ],
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

// Icon typeface for the sidebar and the dashboard route (DESIGN.md > Icons:
// the Icon-Boundary Rule; every other route stays on lucide). Self-hosted and
// subset at build time to the 53 glyphs those two surfaces render — 19.3 KB
// instead of the family's 3.4 MB.
// The modem serves this app and may have no internet, so a CDN <link> would
// render every nav item as the literal ligature text ("cell_tower") in the
// field. Regenerate with `bun run icons:subset` when the glyph set changes,
// and remember the union and the generator's list are hand-synced
// (docs/reference/icon-system.md).
//
// display: "block" (not "swap") for the same reason: during the brief load
// window an icon font must render nothing rather than its ligature source text.
const materialSymbols = localFont({
  variable: "--font-material-symbols",
  display: "block",
  src: [
    {
      path: "./fonts/MaterialSymbolsRounded-subset.woff2",
      weight: "400",
      style: "normal",
    },
  ],
});

// Router branding (see branding/README.md). Every face a brand can choose must be
// declared HERE at module scope: `next/font/local` emits the @font-face rules at
// build time, so a face declared inside a conditional is either inlined for every
// build or not compiled at all. Declaring all of them costs one small woff2 in the
// output — the unused family is never referenced by any rule, so no browser fetches
// it — and keeps `NEXT_PUBLIC_ROUTER_BRAND` a pure build-time choice with no
// dynamic import (this is a static export; there is no server to branch in).
//
// ZLT brand face — Space Grotesk, latin subset, variable 300..700, OFL-1.1.
// Vendored under the repo's all-faces-are-local rule (the build touches no network).
//   https://fonts.gstatic.com/s/spacegrotesk/v22/V8mDoQDjQSkFtoMM3T6r8E7mPbF4C_k3HqU.woff2
//   sha256 a0d054c4af557de20afd6ca59f47ab353bcaec49c63ff04b6c9d39d0f8910557
const spaceGrotesk = localFont({
  variable: "--font-space-grotesk",
  display: "swap",
  src: [
    {
      path: "./fonts/SpaceGrotesk-Variable.woff2",
      weight: "300 700",
      style: "normal",
    },
  ],
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

// Interface font — a true variable font (wght 400-800), so one file per style
// covers every weight the app uses instead of a static cut per weight.
const rethinkSans = localFont({
  variable: "--font-rethink-sans",
  src: [
    {
      path: "./fonts/RethinkSans-Variable.woff2",
      weight: "400 800",
      style: "normal",
    },
    {
      path: "./fonts/RethinkSans-Italic-Variable.woff2",
      weight: "400 800",
      style: "italic",
    },
  ],
});

// Which declared face the ACTIVE brand speaks in.
//
// `--font-sans` alone is not enough: `body` gets its family from
// `localFont(...).className` (app/globals.css sets no body font-family), and only
// four call sites use the `font-sans` utility. So the brand's face has to be the
// body class too, or a badged build would render Rethink Sans everywhere except
// those four places. Keyed by the cssVar the brand file declares, so adding a brand
// is still a one-file change plus its `localFont` declaration above.
const BRAND_FACES: Record<string, typeof rethinkSans> = {
  "--font-rethink-sans": rethinkSans,
  "--font-space-grotesk": spaceGrotesk,
};
const brandFace = BRAND_FACES[BRAND.font.cssVar] ?? rethinkSans;
if (BRAND.id !== "qmanager" && !BRAND_FACES[BRAND.font.cssVar]) {
  // eslint-disable-next-line no-console -- build-time configuration error
  console.warn(
    `[branding] brand "${BRAND.id}" asks for font ${BRAND.font.cssVar}, which no ` +
      `localFont() declares in app/layout.tsx — falling back to Rethink Sans.`,
  );
}

export const metadata: Metadata = {
  // A badged build still says who the software is: the OEM's name comes first
  // (it is the product on the shelf) and QManager follows, so a field tech
  // looking at a browser tab knows both what box and what UI this is.
  title:
    BRAND.id === "qmanager" ? "QManager" : `${BRAND.productName} · QManager`,
  description:
    "QManager is a modern web-based GUI for managing Quectel modems — from APN and band locking to advanced diagnostics and cellular device management.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // data-brand is what the brand's token overrides are scoped to (see
    // branding/index.ts); it is always emitted, so a canonical build and a badged
    // one differ by exactly one attribute plus the brand's own tokens.
    <html
      lang="en"
      data-brand={BRAND.id}
      style={brandFontVars(BRAND) as React.CSSProperties}
      suppressHydrationWarning
    >
      <head>
        {/* The brand's token overrides, scoped so `app/globals.css` stays the
            single source of truth for every token a brand does not touch. Empty
            string for a brand that overrides nothing — the canonical build
            renders no extra style element at all. */}
        {brandStyleSheet(BRAND) ? (
          <style
            id="brand-tokens"
            // Build-time constant, not user input.
            dangerouslySetInnerHTML={{ __html: brandStyleSheet(BRAND) }}
          />
        ) : null}
      </head>
      <body
        className={`${rethinkSans.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} ${materialSymbols.variable} ${brandFace.className} antialiased`}
      >
        {/* Render-blocking: stamps data-motion on <html> from localStorage
            BEFORE anything paints, the same way next-themes avoids a theme
            flash. Without it a user on "Reduced" would see exactly one frame of
            the entrance animations they asked to suppress. <html> already
            carries suppressHydrationWarning for the theme script's sake. */}
        <script
          dangerouslySetInnerHTML={{ __html: MOTION_BOOT_SCRIPT }}
        />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {/* Owns the System/Full/Reduced choice; MotionProvider re-renders on it. */}
          <MotionPreferenceProvider>
            <MotionProvider>
              {/* Client-only i18next provider — wraps BOTH the pre-auth (login /
                  setup) shell and the authenticated app so every surface can call
                  t(). Nested under MotionProvider because the root layout is a
                  server component and the provider is "use client". */}
              <I18nProvider>
                {children}
                <Toaster />
              </I18nProvider>
            </MotionProvider>
          </MotionPreferenceProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
