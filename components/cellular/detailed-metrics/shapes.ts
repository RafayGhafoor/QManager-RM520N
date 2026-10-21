// =============================================================================
// Detailed Metrics — one module for the page's geometry
// =============================================================================
// Shapes only: no colour decisions of its own, and every value is either a
// `DESIGN.md` step or a token that already exists in `app/globals.css`. The
// card shells are plain `div`s rather than `components/ui/card.tsx` because
// that primitive carries a border, and the Fill-Over-Stroke Rule bans a
// hairline on a filled surface; `components/cellular/cell-scanner/shapes.ts`
// solved the same problem the same way.
//
// Every shell is a CONTAINER (`@container/card`), not a viewport breakpoint:
// these cards sit in a two-up grid whose column is much narrower than the
// window, so a `md:` rule inside one would fire while the card is still 380px
// wide. The Container-Query Rule.
// =============================================================================

/** The page column. Matches the cell-scanner family so the two read as peers. */
export const PAGE_SHELL = "@container/main mx-auto flex w-full flex-col gap-5 p-2";

/** A group of metric cells. */
export const GROUP_CARD =
  "@container/card flex min-w-0 flex-col gap-4 rounded-card border-0 bg-surface p-5 shadow-[var(--shadow-whisper)] sm:p-6";

/**
 * The group header: title and description on the left, the staleness chip on
 * the right. `flex-wrap` so the chip drops to its own line on a narrow card
 * rather than squeezing the description into three words.
 */
export const GROUP_HEAD = {
  ROOT: "flex flex-wrap items-start gap-x-4 gap-y-2",
  TITLES: "flex min-w-0 flex-1 flex-col gap-1",
  TITLE: "text-base font-semibold",
  DESC: "max-w-[56ch] text-sm text-on-surface-variant text-pretty",
  CHIP: "ms-auto shrink-0",
} as const;

/** Two cells per row once the CARD is wide enough, one below that. */
export const METRIC_GRID = "grid grid-cols-1 gap-x-6 gap-y-4 @lg/card:grid-cols-2";

/**
 * One metric cell: label + hint on a line, the figure trailing it, and the
 * meter under both when the reading is graded. The rows are stacked rather than
 * tabular so a long label and a long figure cannot collide — the figure never
 * wraps and the label truncates.
 */
export const METRIC_ROW = {
  ROOT: "flex min-w-0 flex-col gap-1.5",
  HEAD: "flex min-w-0 items-center gap-1",
  LABEL: "min-w-0 truncate text-xs font-medium text-on-surface-variant",
  FIGURE:
    "ms-auto flex shrink-0 items-baseline gap-1 text-sm font-semibold tabular-nums",
  UNIT: "text-xs font-medium text-on-surface-variant",
  /** A reading the modem did not report: the numeral step, no ink, no colour. */
  ABSENT: "text-on-surface-variant",
} as const;

/**
 * The "this modem cannot report that" row. Deliberately NOT a metric cell: it
 * carries no figure slot at all, so there is nothing that can be mistaken for a
 * value, a zero or a dash.
 */
export const UNAVAILABLE_ROW = {
  ROOT: "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-tile bg-surface-container px-3 py-2",
  LABEL: "flex min-w-0 items-center gap-1 text-xs font-medium",
  NOTE: "ms-auto text-xs font-medium text-on-surface-variant",
} as const;

/** The SSB beam table. Four columns, all numeric, all `tabular-nums`. */
export const BEAMS = {
  TABLE: "w-full border-collapse text-left",
  CAPTION: "sr-only",
  HEAD_CELL:
    "pb-2 text-xs font-medium text-on-surface-variant whitespace-nowrap",
  HEAD_WRAP: "flex items-center gap-1",
  ROW: "border-t border-border",
  CELL: "py-2 pr-3 text-sm font-semibold tabular-nums whitespace-nowrap",
  LAST_CELL: "py-2 text-sm font-semibold tabular-nums whitespace-nowrap",
} as const;

/** The range/distribution card's chart box: one height in every state. */
export const CHART_BOX = "h-[240px] w-full";

/** Header row of the distributions card: the panel picker above the plot. */
export const DISTRIBUTION = {
  TOOLBAR: "flex flex-wrap items-center gap-x-3 gap-y-2",
  TOOLBAR_LABEL: "text-xs font-medium text-on-surface-variant",
  SELECT: "min-w-[10rem]",
  CAPTION: "text-xs text-on-surface-variant text-pretty",
  BUCKETS: "flex flex-col gap-2",
  BUCKET_ROW: "grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_3.5rem] items-center gap-3",
  BUCKET_LABEL: "truncate text-xs font-medium tabular-nums text-on-surface-variant",
  BUCKET_COUNT: "text-right text-xs font-semibold tabular-nums",
} as const;

/** The aggregated-carrier list under the CA counts. */
export const CARRIER_LIST = {
  ROOT: "flex min-w-0 flex-col gap-2",
  HEAD: "flex items-center gap-1 text-xs font-medium text-on-surface-variant",
  ROW: "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-tile bg-surface-container px-3 py-2",
  FIGURE: "text-sm font-semibold tabular-nums",
  ROLE: "text-xs font-medium text-on-surface-variant",
  NOTE: "text-xs text-on-surface-variant",
} as const;

/**
 * The page's one group grid. Shared with the skeleton on purpose: a skeleton
 * that lays out differently from the thing it stands in for is a layout jump
 * with extra steps.
 */
export const GROUPS_GRID = "grid grid-cols-1 gap-5 @3xl/main:grid-cols-2";
