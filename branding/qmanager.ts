// =============================================================================
// branding/qmanager.ts — the canonical face (QManager on Quectel hardware)
// =============================================================================
// This is the DEFAULT, and it deliberately overrides NOTHING.
//
// Every value a brand can set also has a definition in `app/globals.css`, which
// DESIGN.md declares normative. Repeating those values here would create a second
// source of truth that drifts the first time someone retunes a token — and the
// symptom would be "the default brand looks subtly wrong on one route", which is
// exactly the class of bug nobody attributes to a branding file.
//
// So: empty token maps mean "inherit the design system". Add values only where this
// specific instance needs to differ from the canon.
// =============================================================================

import type { RouterBrand } from "./types";

export const qmanager: RouterBrand = {
  id: "qmanager",
  vendor: "Quectel",
  productName: "QManager",
  markSrc: "/qmanager-mark.svg",
  font: {
    cssVar: "--font-rethink-sans",
    family: "Rethink Sans",
    fallback: "system-ui, sans-serif",
  },
  tokens: { light: {}, dark: {} },
  notes:
    "The instrument-console baseline: cool neutrals, the mark's blue as the only hue that acts, Rethink Sans.",
};
