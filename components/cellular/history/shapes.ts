// =============================================================================
// Cell History — one module for the page's geometry and its tone maps
// =============================================================================
// Shapes only: no colour decision of its own (every value is a `DESIGN.md` step
// or a token that already exists in `app/globals.css`), and no JSX. The card
// shells are plain `div`s rather than `components/ui/card.tsx` because that
// primitive carries a border and the Fill-Over-Stroke Rule bans a hairline on a
// filled surface — the same call `detailed-metrics/shapes.ts` and
// `cell-scanner/shapes.ts` made.
//
// Every shell is a CONTAINER (`@container/card`), not a viewport breakpoint:
// these cards sit in a two-up grid whose column is far narrower than the
// window, so a `md:` rule inside one would fire while the card is still 380px
// wide (The Container-Query Rule).
//
// THE BAND STRINGS ARE DISPLAY-READY. `.lte.band` arrives as `"B3"` and
// `.nr.band` as `"N78"` — `parse_serving_cell` in the backend adds the letters
// itself. There is deliberately no helper here that prefixes a band, because a
// second prefix would render "BB3"; a `null` band means the modem did not
// report one and the call site prints `history.timeline.band_not_reported`.
// =============================================================================

/** The page column. Matches the detailed-metrics family so the two read as peers. */
export const PAGE_SHELL = "@container/main mx-auto flex w-full flex-col gap-5 p-2";

/**
 * The controls row under the page header: range pill, Refresh, Panels.
 *
 * It declares its own container so the seven-range pill can fall back to the
 * house `Select` on a narrow row — `SegmentedField`'s steps key off
 * `@…/card`, and the page column is named `main`, so without this wrapper the
 * pill would render its Select branch at every width (a `@container card`
 * query cannot match a container with no `card` name).
 */
export const CONTROLS = {
  ROW: "@container/card flex flex-wrap items-center gap-2",
  /** The state block under the controls: the figures, then any coverage note. */
  NOTES_BLOCK: "flex flex-col gap-1",
  NOTES: "flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-on-surface-variant tabular-nums",
  NOTE: "text-[0.6875rem] leading-relaxed text-on-surface-variant text-pretty",
} as const;

/** A grid peer card. */
export const CARD =
  "@container/card flex min-w-0 flex-col gap-4 rounded-card border-0 bg-surface p-5 shadow-[var(--shadow-whisper)] sm:p-6";

/** The availability hero — the one card that anchors the surface. */
export const HERO =
  "@container/card flex min-w-0 flex-col gap-5 rounded-hero border-0 bg-surface p-5 shadow-[var(--shadow-whisper)] sm:p-6";

/** The hero's eyebrow + headline stack. */
export const HERO_HEAD = {
  ROOT: "flex flex-col gap-1",
  EYEBROW: "text-xs font-semibold text-on-surface-variant",
} as const;

/** Card header: title and description stacked, nothing on the right. */
export const HEAD = {
  ROOT: "flex flex-col gap-1",
  TITLE: "text-base font-semibold",
  DESC: "max-w-[56ch] text-sm text-on-surface-variant text-pretty",
} as const;

/** The page's one grid. Peers two-up once the content column allows it. */
export const GRID = "grid grid-cols-1 gap-5 @3xl/main:grid-cols-2";

/** A single card on its own row, at the page's own gap. */
export const STACK = "flex flex-col gap-5";

/** Anything that owns a whole row (the hero, and any card too wide to pair). */
export const FULL = "@3xl/main:col-span-2";

/**
 * The four availability stops, as fill + height pairs.
 *
 * HEIGHT IS THE NON-HUE CHANNEL, and it is load-bearing rather than decorative.
 * The four stops are a lightness staircase on one hue plus one negative tone,
 * and `--primary` and `--destructive` measure only 0.035 apart in OKLab
 * lightness in dark mode — a colour-blind reader would otherwise be reading the
 * hero off hue alone, which The Glyph-Carries-The-State Rule forbids. So each
 * stop also owns a bar height inside the strip's track, and the legend's
 * swatches are drawn at the same heights: the ladder is legible in greyscale,
 * and the per-bucket readout names the stop in words.
 *
 * `unknown` draws nothing at all: the recessed track showing through IS the
 * statement "the bucket exists and nothing was recorded", which is a different
 * claim from "5G was down" and must never look like one.
 */
export const TIER = {
  up: { fill: "bg-primary", height: "h-full" },
  partial: { fill: "bg-primary/55", height: "h-2/3" },
  down: { fill: "bg-destructive", height: "h-1/3" },
  unknown: { fill: "bg-transparent", height: "h-full" },
} as const;

/** The availability strip: one cell per bucket over a recessed track. */
export const STRIP = {
  ROOT: "flex flex-col gap-1",
  TRACK: "flex h-10 w-full items-end gap-[2px] rounded-field bg-surface-container p-1",
  /**
   * Past a couple of hundred buckets a 2px gutter costs more width than the
   * strip has: the cells shrink to nothing and the gutter eats the row. The
   * pattern is the reading at that density, so the gutter goes and the strip
   * becomes a continuous band.
   */
  TRACK_DENSE: "gap-0",
  CELL: "min-w-0 flex-1 rounded-[2px]",
  /** Hour-of-day ticks under the strip, positioned as a percentage of the window. */
  TICKS: "relative h-4 w-full",
  TICK: "absolute top-0 -translate-x-1/2 text-[0.6875rem] font-medium tabular-nums whitespace-nowrap text-on-surface-variant",
  LEGEND: "flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-on-surface-variant",
  LEGEND_ITEM: "flex items-center gap-1.5",
  LEGEND_TRACK: "flex h-3 w-3 items-end",
  LEGEND_SWATCH: "w-2 rounded-[1px]",
  READOUT: "min-h-5 text-xs font-medium tabular-nums",
  HEADLINE: "text-[1.75rem] leading-tight font-semibold tracking-[-0.01em] tabular-nums",
  SUB: "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-on-surface-variant tabular-nums",
} as const;

/** The night-pattern matrix: a day label column, then 24 hour columns. */
export const PATTERN = {
  SCROLL: "w-full overflow-x-auto",
  GRID: "grid min-w-[26rem] items-center gap-[3px]",
  ROW_LABEL: "whitespace-nowrap pe-2 text-[0.6875rem] font-medium tabular-nums text-on-surface-variant",
  CELL: "aspect-square w-full rounded-[2px]",
  /** An hour nothing was recorded in: one container step in, and no hue. */
  CELL_UNKNOWN: "aspect-square w-full rounded-[2px] bg-surface-container-high",
  HOUR_LABEL: "text-center text-[0.625rem] font-medium tabular-nums text-on-surface-variant",
  AXIS: "text-[0.6875rem] text-on-surface-variant",
} as const;

/** The serving-cell gantt: one lane per radio leg, segments positioned by fraction. */
export const TIMELINE = {
  LANES: "flex flex-col gap-2",
  LANE: "flex items-center gap-3",
  LANE_LABEL: "w-8 shrink-0 text-xs font-semibold tabular-nums",
  TRACK: "relative h-8 w-full overflow-hidden rounded-field bg-surface-container",
  SEGMENT:
    "absolute inset-y-0 flex items-center overflow-hidden rounded-[2px] px-1.5",
  SEGMENT_LABEL: "truncate text-[0.6875rem] font-semibold tabular-nums",
} as const;

/**
 * A band's tone inside a lane. Both variants of a leg are AUTHORED fill/ink
 * pairs — never an alpha wash — because a wash over a light track loses the ink
 * that sits on top of it.
 *
 * The variant is chosen by the band string itself (see `bandVariant`), so the
 * same band always wears the same tone and two adjacent runs of different bands
 * are told apart before the label is read. The label, not the shade, carries
 * the band: this system's identity hues are a lightness-clustered set on
 * purpose (DESIGN.md > The three layers), so a shade is a pairing aid and must
 * never be presented as a category key on its own.
 */
export const BAND_TONE = {
  lte: [
    { fill: "bg-lte", ink: "text-lte-foreground" },
    { fill: "bg-lte-container", ink: "text-on-lte-container" },
  ],
  nr: [
    { fill: "bg-primary", ink: "text-primary-foreground" },
    { fill: "bg-primary-container", ink: "text-on-primary-container" },
  ],
  /** No band reported: a band is identity, so its absence has no hue. */
  unknown: { fill: "bg-surface-container-high", ink: "text-on-surface-variant" },
} as const;

/**
 * The band/CA strip: ONE lane, because a run's combo is a single fact.
 *
 * Deliberately the gantt's own track (`TIMELINE.TRACK`'s height, radius and
 * recessed ground) with no lane label: the gantt has two legs to name, this
 * strip has one line of combos and the card's heading above it already says
 * what it is. A second, shorter track style here would read as a different
 * kind of object on a page where every other bar is a gantt lane.
 */
export const BANDS = {
  TRACK: "relative h-8 w-full overflow-hidden rounded-field bg-surface-container",
  SEGMENT:
    "absolute inset-y-0 flex items-center overflow-hidden rounded-[2px] px-1.5",
  SEGMENT_LABEL: "truncate text-[0.6875rem] font-semibold tabular-nums",
  /** A combo key in the table: its strip tone, then the combo string. */
  COMBO: "flex items-center gap-2 text-sm font-semibold tabular-nums",
  SWATCH: "h-3 w-3 shrink-0 rounded-[2px]",
} as const;

/**
 * The page legend: a strip, NOT a card.
 *
 * It sits under the controls and above the panels, so it may not carry a
 * surface of its own — a card there would read as the first panel and push the
 * hero down. It declares its own container anyway, because its three swatch
 * groups must reflow on the page column's width (one column, then two-up, then
 * three across), not the window's.
 */
export const LEGEND = {
  ROOT: "@container/card flex flex-col gap-2 rounded-tile bg-surface-container px-4 py-3",
  TITLE: "text-xs font-semibold text-on-surface-variant",
  GROUPS: "grid grid-cols-1 gap-x-6 gap-y-2.5 @md/card:grid-cols-2 @4xl/card:grid-cols-3",
  GROUP: "flex min-w-0 flex-col gap-1",
  GROUP_LABEL: "text-[0.6875rem] font-semibold text-on-surface-variant",
  ITEMS: "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant",
  ITEM: "flex items-center gap-1.5",
  /** A series key drawn as the stroke itself: a 2px rule, `TrendChart`'s width. */
  LINE: "h-0.5 w-4 shrink-0 rounded-full",
  /** A combo key: one square of the combo's strip tone, in the table's size. */
  BAND_SWATCH: "h-3 w-3 shrink-0 rounded-[2px]",
  NOTES: "flex flex-col gap-0.5",
  NOTE: "text-[0.6875rem] leading-relaxed text-on-surface-variant text-pretty",
} as const;

/** The two chart series tones, straight from the design system's stroke pair. */
export const SERIES_TONE = {
  nr: "var(--chart-nr)",
  lte: "var(--chart-lte)",
  down: "var(--downlink)",
  up: "var(--uplink)",
} as const;

/** One chart box, ONE height in every state — loaded, loading, empty and error. */
export const CHART_BOX = "h-[190px] w-full";

/** A chart's own title above its box. */
export const CHART = {
  ROOT: "flex min-w-0 flex-col gap-2",
  TITLE: "flex flex-wrap items-baseline gap-x-2 text-xs font-medium text-on-surface-variant",
  UNIT: "text-[0.6875rem] text-on-surface-variant",
  GRID: "grid grid-cols-1 gap-x-6 gap-y-5 @2xl/card:grid-cols-2",
  /** The "no readings" hole: the chart box's own height, so nothing jumps. */
  EMPTY:
    "grid place-items-center rounded-tile bg-surface-container px-4 text-center text-xs text-on-surface-variant",
} as const;

/** The gantt / strip hour axis label. */
export const AXIS_LABEL = "text-[0.6875rem] font-medium text-on-surface-variant";

/**
 * Tables. `tabular-nums` on every figure, the label column truncating rather
 * than the figure, and no cell wrap: these are scanned, not read
 * (The Two-Edge Rule).
 */
export const TABLE = {
  HEAD: "text-xs font-medium whitespace-nowrap text-on-surface-variant",
  CELL: "text-sm tabular-nums whitespace-nowrap",
  CELL_MUTED: "text-sm tabular-nums whitespace-nowrap text-on-surface-variant",
  PROSE: "text-xs leading-relaxed text-on-surface-variant text-pretty",
  PROSE_BLOCK: "flex flex-col gap-1",
  /** A problem row: no fill, just the reading's own ink (The Data-Ink Rule). */
  PROBLEM_ROW: "bg-surface-container",
} as const;

/** The per-cell change list behind the disclosure: field · from → to. */
export const CHANGE = {
  LIST: "flex flex-col gap-2",
  ROW: "flex flex-col gap-1 rounded-tile bg-surface-container px-3 py-2",
  MOMENT: "text-xs font-medium tabular-nums text-on-surface-variant",
  FIELDS: "flex flex-wrap items-center gap-x-3 gap-y-1",
  FIELD: "flex items-center gap-1.5 text-xs",
  LABEL: "font-medium text-on-surface-variant",
  FROM: "tabular-nums text-on-surface-variant",
  ARROW: "text-on-surface-variant",
  TO: "font-semibold tabular-nums",
  /** The disclosure's trigger holds the card's left edge, alone on its line. */
  TRIGGER: "self-start",
  /** Separates the revealed list from the trigger above it. */
  BODY: "mt-2",
} as const;

/** The identity grid: label/value pairs, two or three columns on a wide card. */
export const IDENTITY = {
  GRID: "grid grid-cols-2 gap-x-6 gap-y-3 @xl/card:grid-cols-3",
  ROW: "flex min-w-0 flex-col gap-0.5",
  LABEL: "truncate text-xs font-medium text-on-surface-variant",
  VALUE: "text-sm font-semibold tabular-nums",
  ABSENT: "text-sm font-semibold text-on-surface-variant",
  AS_OF: "text-xs text-on-surface-variant",
} as const;
