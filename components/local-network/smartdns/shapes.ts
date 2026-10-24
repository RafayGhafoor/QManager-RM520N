import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2Icon,
  CircleHelpIcon,
  ClockIcon,
  MinusCircleIcon,
  XCircleIcon,
} from "lucide-react";

import type { BadgeVariant } from "@/components/ui/badge";
import type {
  SmartDnsAnswerClass,
  SmartDnsVerdict,
} from "@/types/smartdns";

// =============================================================================
// SmartDNS — shared geometry and tone contract
// =============================================================================
// The `/local-network/smartdns` family's shapes module, and the FOURTH under
// `/local-network/` — ethernet, traffic-engine and custom-dns landed first, so the
// convention here is inherited rather than invented: geometry is restated per
// family (never imported across siblings), tone maps key onto the exported
// `BadgeVariant` type so a state without a chip role fails the build, and every
// skeleton imports its box from here rather than restating a number.
//
// The values are the system's, verbatim:
//
//   104px pinned tile   12px radius   52px disc   42px control   16px card
//
// -----------------------------------------------------------------------------
// COLOUR: ONLY THE VERDICT AND CLASS CHIPS MOVE
// -----------------------------------------------------------------------------
// Cards are neutral. Colour sits on the filled status chip and on the glyph disc
// of a notice, which is what The Data-Ink Rule asks for at this scale. Two things
// on this page carry a verdict and both are chips keyed onto a map:
//
//   VERDICT   good / slow / failed, from Contract 1. `slow` is a warning, not a
//             failure: a 338 ms provider still answers, it just hands out a far
//             edge. `failed` is the only destructive one.
//   CLASS     near / far / unknown, from Contract 1 and 2, cut at `threshold_ms`.
//             A category with a quality meaning — `unknown` is neutral because
//             "nobody answered" is an absence, not a fault.
//
// No two states in a slot share a glyph. `success-container` and
// `warning-container` measure 1.03:1 apart — the same surface to the eye, and
// identical under deuteranopia — so the glyph is the only thing separating
// "answered fast" from "answered slowly".
// =============================================================================

// -----------------------------------------------------------------------------
// Page shell
// -----------------------------------------------------------------------------

/** The route wrapper's layout. `@container/main` is declared at the route root. */
export const PAGE_ROOT = "mx-auto flex flex-col gap-5 p-2";

/** Header: display title, one-sentence description, actions on the right edge. */
export const PAGE_HEAD = {
  ROOT: "flex flex-col gap-5 @3xl/main:flex-row @3xl/main:items-end",
  TITLES: "flex max-w-[41rem] flex-col gap-1.5",
  TITLE: "text-3xl font-bold tracking-[-0.02em]",
  DESC: "text-on-surface-variant text-sm leading-relaxed text-pretty",
  ACTIONS: "flex flex-wrap items-center gap-2.5 @3xl/main:ml-auto",
} as const;

/** Placeholder for a `size="action"` Button in a skeleton. */
export const ACTION_SKELETON = "h-[2.625rem] rounded-pill";

// -----------------------------------------------------------------------------
// Cards
// -----------------------------------------------------------------------------

/**
 * The card shell. `rounded-card` (16px) with the whisper shadow, `border-0`
 * explicit — a tonal surface never also carries a hairline. The `!` on the
 * shadow is load-bearing: `card.tsx` ships `shadow-sm` and tailwind-merge cannot
 * dedupe an arbitrary `var()` against it, so the marker wins by construction
 * instead of by alphabet. Kept on one line for the design-language grep.
 */
export const CARD_SHELL = "@container/card flex flex-col gap-5 rounded-card border-0 bg-surface py-6 shadow-[var(--shadow-whisper)]!";

/** Card padding: 28px, matching every sibling surface. */
export const CARD_PAD = "px-7";

/** The card's title. Sized at the call site; `CardTitle` ships only the weight. */
export const CARD_TITLE = "min-w-0 text-lg font-semibold leading-tight";

/** Header layout: titles left, one chip or action group pushed right. */
export const CARD_HEAD = {
  ROOT: "flex flex-wrap items-start gap-x-4 gap-y-3",
  TITLES: "flex min-w-0 flex-col gap-1.5",
  DESC: "text-on-surface-variant text-sm leading-relaxed text-pretty",
  ACTIONS: "flex flex-none items-center gap-2 @lg/card:ml-auto",
} as const;

/** Section label inside a card — the one sanctioned inner-level marker. */
export const SECTION_LABEL =
  "text-on-surface-variant text-[0.6875rem] font-semibold uppercase tracking-[0.06em]";

/**
 * A quiet footnote under a card's content: the sentence that keeps a reading
 * honest ("none of these are the resolver's own counters").
 */
export const FOOTNOTE = "text-on-surface-variant text-[0.8125rem] leading-relaxed";

// -----------------------------------------------------------------------------
// The performance tiles
// -----------------------------------------------------------------------------

/**
 * The tile box, PINNED at 104px, with `HEIGHT` exported so the skeleton mirrors
 * the pin by reference rather than by a restated number (The Skeleton-Mirror
 * Rule).
 *
 * The caption is where this family departs from its siblings in PURPOSE rather
 * than in shape: on every other surface the caption names a state, and here it
 * names the SOURCE of the figure — because not one of these four is a smartdns
 * counter. The binary exposes no statistics endpoint on 0.13.1
 * (docs/specs/smartdns-o5a.md > "The stats problem"), so a panel that did not
 * say where each number came from would be presenting derived figures as the
 * daemon's own.
 */
export const TILE = {
  GRID: "grid grid-cols-1 gap-3.5 @xl/card:grid-cols-2 @4xl/card:grid-cols-4",
  ROOT: "flex h-[6.5rem] items-center gap-3.5 rounded-tile px-5 py-4",
  /** Mirrors ROOT's pinned height, for the skeleton. */
  HEIGHT: "h-[6.5rem]",
  DISC: "grid size-[3.25rem] flex-none place-items-center rounded-pill",
  BODY: "bg-surface-container text-on-surface",
  TEXT: "flex min-w-0 flex-1 flex-col gap-[3px]",
  GLYPH: "size-[1.625rem]",
  EYEBROW:
    "text-on-surface-variant truncate text-[0.6875rem] font-semibold tracking-[0.02em]",
  /** A live measurement, so `tabular-nums` in the UI face — never mono. */
  VALUE:
    "flex min-w-0 items-center gap-2 text-[1.375rem] font-bold leading-[1.1] tracking-[-0.015em] tabular-nums",
  VALUE_TEXT: "truncate",
  CAPTION: "text-on-surface-variant truncate text-xs",
  /** A figure with no reading. An em dash reads as an absence in all five locales. */
  NONE: "—",
} as const;

/** Disc fills, and the only colour on a tile. Always a fill with its own ink. */
export const DISC_TONE = {
  neutral: "bg-surface-container-high text-on-surface-variant",
  primary: "bg-primary text-primary-foreground",
  warning: "bg-warning text-warning-foreground",
  destructive: "bg-destructive text-destructive-foreground",
} as const;

export type DiscTone = keyof typeof DISC_TONE;

// -----------------------------------------------------------------------------
// Readout rows
// -----------------------------------------------------------------------------

/**
 * One read-only figure: key on the left edge, value on the right, 40px pill on
 * `surface-container`. The product's glance-surface metric row, unchanged.
 *
 * `GRID` steps the rows into columns once the card is wide, which is the
 * Row-Span Rule's remedy: past roughly 600px of row the key and its value stop
 * reading as a pair, and the answer is to recompose the card rather than to cap
 * the page.
 */
export const READOUT = {
  GRID: "grid grid-cols-1 gap-1.5 @xl/card:grid-cols-2 @4xl/card:grid-cols-3",
  ROOT: "flex h-10 min-w-0 items-center gap-3 rounded-pill bg-surface-container px-4",
  KEY: "truncate text-[0.8125rem] font-semibold text-on-surface-variant",
  /** A reported quantity. */
  VALUE: "ml-auto flex-none text-[0.8125rem] font-semibold tabular-nums",
  /** An opaque string — a path, an upstream URL, a domain. */
  VALUE_MONO:
    "ml-auto min-w-0 truncate font-mono text-[0.75rem] font-semibold tabular-nums",
} as const;

/**
 * A scrolled log/answer block.
 *
 * The scrollbar is themed here because nothing themes it globally; the gutter
 * pair gives the thumb its own lane so text never sits underneath it.
 */
export const LOG_VIEWPORT =
  "-mr-2 max-h-40 overflow-y-auto overscroll-contain pr-2 [scrollbar-width:thin] [scrollbar-color:var(--color-surface-container-high)_transparent]";

export const LOG_BODY =
  "m-0 flex flex-col gap-1 font-mono text-[0.75rem] leading-relaxed text-on-surface-variant";

// -----------------------------------------------------------------------------
// Tables — the provider table and the tester's answer table
// -----------------------------------------------------------------------------

/**
 * A genuine data table keeps hairline rows on `--border`, because density
 * survives there where pills would not (DESIGN.md > Metric rows). The header is
 * the label step and is deliberately not a chip.
 */
export const TABLE = {
  ROOT: "w-full min-w-[34rem] border-collapse text-left",
  HEAD_CELL:
    "pb-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-on-surface-variant",
  /** `border-b-0` because the `Table` primitive already ships a bottom rule. */
  ROW: "border-t border-b-0 border-border",
  CELL: "py-3 align-middle",
  /** The provider / upstream cell: a name over its opaque identifier. */
  NAME: "flex min-w-0 flex-col gap-0.5",
  LABEL: "truncate text-[0.875rem] font-semibold",
  SUB: "truncate font-mono text-[0.6875rem] text-on-surface-variant",
  /** A measurement. */
  NUM: "text-[0.875rem] font-semibold tabular-nums",
  UNIT: "ml-1 text-xs font-medium text-on-surface-variant",
  /** An answer set: one IP per line, in the machine voice. */
  ANSWER: "flex flex-col gap-0.5 font-mono text-[0.75rem] text-on-surface-variant",
  EMPTY: "text-[0.8125rem] text-on-surface-variant",
} as const;

/** The column widths. The first column takes the slack; the rest size to content. */
export const TABLE_COLS = {
  PROVIDERS: "w-full min-w-0",
  QUALITY: "w-[6.5rem] whitespace-nowrap",
  VERDICT: "w-[7.5rem] whitespace-nowrap",
  GROUP: "w-[8.5rem] whitespace-nowrap",
  ANSWERS: "w-full min-w-0",
  RTT: "w-[5.5rem] whitespace-nowrap",
  CLASS: "w-[6.5rem] whitespace-nowrap",
} as const;

// -----------------------------------------------------------------------------
// Verdict and class chips
// -----------------------------------------------------------------------------

/**
 * A provider's measured standing, plus the UI's own `unmeasured` state.
 *
 * `unmeasured` is NOT a Contract-1 verdict — the engine never emits it, because
 * a provider that answered is measured. It exists because the UI can hold a
 * provider it has no measurement for yet: a member of the live group between
 * refreshes. Drawing that as `failed` would be a lie about a working upstream.
 */
export type VerdictSlot = SmartDnsVerdict | "unmeasured";

export const VERDICT_BADGE: Record<VerdictSlot, BadgeVariant> = {
  good: "success",
  slow: "warning",
  failed: "destructive",
  unmeasured: "muted",
};

export const VERDICT_GLYPH: Record<VerdictSlot, LucideIcon> = {
  good: CheckCircle2Icon,
  slow: ClockIcon,
  failed: XCircleIcon,
  unmeasured: MinusCircleIcon,
};

/**
 * The answer class chips. `near` is the fast class (≤ `threshold_ms`), `far` is
 * the 330–350 ms class measured on this device, and `unknown` means the provider
 * gave no answer at all.
 */
export const CLASS_BADGE: Record<SmartDnsAnswerClass, BadgeVariant> = {
  near: "success",
  far: "warning",
  unknown: "muted",
};

export const CLASS_GLYPH: Record<SmartDnsAnswerClass, LucideIcon> = {
  near: CheckCircle2Icon,
  far: ClockIcon,
  unknown: CircleHelpIcon,
};

/** The glyph inside any status chip. 12px, matching the chip's own text step. */
export const CHIP_GLYPH = "size-3";

/** The "in the live edge group" indicator — a glyph and a word, never a chip. */
export const GROUP_MARK = {
  ROOT: "flex items-center gap-1.5 text-[0.8125rem] font-medium",
  IN: "text-success-on-surface",
  OUT: "text-on-surface-variant",
  GLYPH: "size-4 flex-none",
} as const;

// -----------------------------------------------------------------------------
// The toggle row and the config editor
// -----------------------------------------------------------------------------

/** A settings row inside a card. The consequence sentence is required. */
export const SETTING_ROW = {
  ROOT: "flex flex-col gap-3 rounded-tile bg-surface-container p-4 @2xl/card:flex-row @2xl/card:items-center",
  TEXT: "flex min-w-0 flex-1 flex-col gap-1",
  LABEL: "text-[0.9375rem] font-semibold",
  HINT: "text-on-surface-variant text-[0.8125rem] leading-relaxed text-pretty",
  CONTROL: "flex flex-none items-center gap-2 @2xl/card:ml-auto",
} as const;

/**
 * The config editor. Monospace and tall: the file is what the daemon reads, so
 * it is a machine string in the machine voice, and the height is a comfortable
 * working window rather than a one-line field.
 */
export const CONFIG_EDITOR =
  "font-mono text-[0.75rem] leading-relaxed min-h-[22rem] resize-y [tab-size:2] whitespace-pre overflow-x-auto";

/** The domain input: a hostname is typed against, so it takes the machine voice. */
export const DOMAIN_FIELD = "font-mono text-sm";

/** The field and its button, side by side once the CARD is wide enough. */
export const FIELD_ROW = "flex flex-col gap-2.5 @lg/card:flex-row";

// -----------------------------------------------------------------------------
// Errors and notices
// -----------------------------------------------------------------------------

/**
 * A solid tonal container, never a wash, and never with a hairline on the fill.
 * This is where the config validator's own message lands, verbatim.
 */
export const ERROR_BOX =
  "flex flex-col gap-1 rounded-field bg-destructive-container px-4 py-3 text-on-destructive-container";
export const ERROR_TEXT = "text-[0.8125rem] leading-relaxed text-pretty";

/** The resting/notice block: a filled disc, a title, one line, an optional action. */
export const NOTICE = {
  ROOT: "flex flex-col items-center gap-3 rounded-tile bg-surface-container px-6 py-8 text-center",
  DISC: "grid size-14 flex-none place-items-center rounded-pill bg-surface-container-high text-on-surface-variant",
  GLYPH: "size-[1.625rem]",
  TITLE: "text-[0.9375rem] font-semibold",
  BODY: "text-on-surface-variant max-w-[46ch] text-[0.8125rem] leading-relaxed text-pretty",
  ACTION: "mt-1",
} as const;
