// IP Passthrough: this family's geometry, imported by the loaded views and their skeletons.
// Restated from the Watchdog and Latency Monitor families, never imported across families.

// -----------------------------------------------------------------------------
// Page shell
// -----------------------------------------------------------------------------

/** The route wrapper. Container queries key off `@container/main`. */
export const PAGE_ROOT = "@container/main flex flex-col gap-5 px-4 pb-6 lg:px-6";

export const PAGE_HEAD = {
  ROOT: "flex flex-col gap-5 @3xl/main:flex-row @3xl/main:items-end",
  TITLES: "flex max-w-[41rem] min-w-0 flex-col gap-1.5",
  TITLE: "text-3xl font-bold tracking-[-0.02em]",
  DESC: "text-on-surface-variant text-sm leading-relaxed text-pretty",
  ACTIONS: "flex flex-wrap items-center gap-2.5 @3xl/main:ml-auto",
} as const;

/** The rest tone for a ghost pill in the page header. */
export const HEADER_PILL =
  "bg-surface-container text-on-surface-variant hover:bg-surface-container-high";

/** The lucide glyph inside a pill. */
export const PILL_GLYPH = "size-4";

// -----------------------------------------------------------------------------
// Card shells
// -----------------------------------------------------------------------------

/** The important marker is required: twMerge reads an arbitrary shadow as a colour. */
export const CARD_SHELL =
  "@container/card gap-5 rounded-card border-0 bg-card py-6 shadow-[var(--shadow-whisper)]!";

/** The anchor: the device-reported configured-state strip. */
export const HERO_SHELL =
  "@container/card gap-0 rounded-hero border-0 bg-card py-6 shadow-[var(--shadow-whisper)]!";

export const CARD_PAD = "px-6";
export const HERO_PAD = "px-6 @[40rem]/main:px-7";

export const CARD_TITLE = "min-w-0 text-lg leading-tight";

/** `CardDescription` hardcodes a retired ink token, so every call site re-inks it. */
export const CARD_DESC = "text-on-surface-variant text-sm";

const EYEBROW_LH = "leading-[0.875rem]";
export const EYEBROW = `text-on-surface-variant text-[0.6875rem] ${EYEBROW_LH} font-semibold tracking-[0.06em] uppercase`;

// -----------------------------------------------------------------------------
// The Last applied strip
// -----------------------------------------------------------------------------

/** The disc carries the mode colour; the card body stays neutral. */
export const DISC_TONE = {
  neutral: "bg-surface-container-high text-on-surface-variant",
  info: "bg-primary text-primary-foreground",
} as const;

/** Scoped to two properties, and every custom property takes `var()`. */
export const DISC_TRANSITION =
  "transition-[background-color,color] duration-[var(--duration-standard)] ease-[var(--ease-standard)] motion-reduce:transition-none";

const STATUS_LINE = {
  TITLE: "leading-6",
  BLURB: "leading-5",
} as const;

/** Phase on the left edge, figures on the right edge; one line from a 64rem card. */
export const STATUS = {
  BODY: "flex flex-wrap items-center gap-x-10 gap-y-[1.125rem]",
  PHASE: "flex min-w-0 flex-[1_1_16rem] items-center gap-3.5",
  DISC: "grid size-11 flex-none place-items-center rounded-pill",
  GLYPH: "size-[1.375rem]",
  TEXT: "flex min-w-0 flex-col gap-0.5",
  TITLE: `text-xl ${STATUS_LINE.TITLE} font-bold tracking-[-0.01em]`,
  BLURB: `text-on-surface-variant text-[0.8125rem] ${STATUS_LINE.BLURB} text-pretty`,
} as const;

/** A failed read: one horizontal block in place of the strip's body. */
export const CONDITION = {
  ROOT: "flex flex-wrap items-center gap-x-3.5 gap-y-3 rounded-tile bg-surface-container px-4 py-3.5 text-on-surface",
  DISC: "grid size-11 flex-none place-items-center rounded-pill bg-surface-container-high text-on-surface-variant",
  GLYPH: "size-[1.375rem]",
  TEXT: "flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5",
  TITLE: "text-[0.9375rem] font-semibold",
  BODY: "text-on-surface-variant text-[0.8125rem] text-pretty",
  ACTION: "ml-auto h-9 bg-on-surface/10 px-4 text-on-surface hover:bg-on-surface/15",
} as const;

// -----------------------------------------------------------------------------
// The settings card
// -----------------------------------------------------------------------------

const ROW_MIN_H = "min-h-[2.625rem]";
/** A SegmentedField track: 34px segments in a 4px-padded pill. */
const PILL_H = "h-[2.625rem]";
const KEY_LH = "leading-5";

/** Two groups side by side from a 56rem card, stacked below it. */
export const SETTING = {
  BODY: "grid grid-cols-1 items-start gap-y-7",
  GROUP: "flex min-w-0 flex-col gap-3.5",
  LABEL: EYEBROW,
  /** Key left, control right; on a narrow card the control wraps, still right-aligned. */
  ROW: `flex ${ROW_MIN_H} flex-wrap items-center justify-between gap-x-4 gap-y-2`,
  KEY: "flex min-w-0 flex-col gap-px",
  KEY_LINE: `inline-flex items-center gap-1.5 text-sm ${KEY_LH} font-medium`,
  KEY_SUB: "text-on-surface-variant text-xs",
  /** A held row dims its text; the disabled control dims itself, so the two never compound. */
  HELD: "opacity-55",
  CONTROL: "ml-auto flex max-w-full flex-col items-end gap-1.5",
  /** The dirty marker is reserved on every row and fades in on the quick token. */
  DOT: "size-[7px] flex-none rounded-pill bg-primary transition-[opacity,transform] duration-[var(--duration-quick)] ease-[var(--ease-standard)] motion-reduce:transition-none",
  DOT_OFF: "scale-[0.6] opacity-0",
  DOT_ON: "scale-100 opacity-100",
  UNREAD: "text-on-surface-variant py-2.5 text-[0.8125rem]",
} as const;

/** The lockout note on Mode; promoted in place (Highlight-by-Container) while Mode is dirty. */
export const MODE_NOTE = {
  ROOT: "flex items-start gap-2 rounded-field text-[0.78125rem] leading-[1.5] text-pretty transition-[background-color,color] duration-[var(--duration-standard)] ease-[var(--ease-standard)] motion-reduce:transition-none",
  REST: "text-on-surface-variant",
  DIRTY: "bg-destructive-container text-on-destructive-container px-3.5 py-[0.5625rem] font-medium",
  GLYPH: "mt-0.5 size-3.5 flex-none",
  GLYPH_REST: "text-warning-on-surface",
} as const;

export const FOOT = {
  LINE: "flex min-w-0 items-center gap-2",
  DOT: "size-[7px] flex-none rounded-pill bg-primary",
} as const;

// -----------------------------------------------------------------------------
// Skeletons
// -----------------------------------------------------------------------------

/** Every box reads the loaded view's own line box. */
export const SKELETON = {
  EYEBROW: `h-3.5 w-24 rounded-inline`,
  TITLE: `h-6 w-40 rounded-inline`,
  BLURB: `h-5 w-52 max-w-full rounded-inline`,
  ROW_KEY: `h-5 w-24 rounded-inline`,
  /** One line of the Mode note (12.5px at leading 1.5). */
  NOTE_LINE: "h-[1.171875rem] rounded-inline",
  PILL: `${PILL_H} rounded-pill`,
} as const;
