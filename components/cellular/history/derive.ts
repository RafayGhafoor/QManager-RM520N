// =============================================================================
// derive.ts — Cell History's pure derivations
// =============================================================================
// No React, no `fetch`, no `localStorage`, and never an implicit `new Date()`
// for a *window*: every window arrives as a parameter from the payload, so two
// cards on one page cannot disagree about where the range starts. Formatting
// helpers are here for the same reason `lib/schedule-timeline.ts` keeps its own
// — this page needs one spelling of "local time", and a second one in a card
// would eventually read the clock differently from its neighbour.
//
// TWO RULES FROM THE CONTRACT, ENFORCED HERE:
//
//  * AN ABSENT READING IS `null`, NEVER `0`. Nothing below coalesces. A bucket
//    with `n: 0` is "nothing was recorded", not "5G was down", and the two must
//    never reach the same branch.
//  * A GAP IS A GAP. `GAP_THRESHOLD_SECONDS` is the backend's cutoff for
//    breaking a run; nothing here bridges across a hole and calls it a run.
//
// BAND STRINGS ARE DISPLAY-READY AND ARE NEVER REWRITTEN. `parse_serving_cell`
// adds the `B`/`N` prefix in the backend, so an `lte_band` of `"B3"` is already
// the string a reader should see; prefixing it here would render "BB3". A
// `null`/empty band means the modem reported none, and the call site states
// that rather than inventing a letter.
// =============================================================================

import type {
  AvailabilityBucket,
  CellChangeField,
  CellHistoryCoverage,
  CellHistoryPoint,
  CellHistoryRange,
  CellHistoryWindow,
  CellRun,
  CellStat,
  NrOutage,
} from "@/types/cell-history";

import { SERIES_TONE } from "./shapes";

// -----------------------------------------------------------------------------
// Time and duration
// -----------------------------------------------------------------------------

/** The requested width of every range the pill offers, in seconds. */
export const RANGE_SECONDS: Record<CellHistoryRange, number> = {
  "1h": 3_600,
  "3h": 10_800,
  "6h": 21_600,
  "12h": 43_200,
  "24h": 86_400,
  "7d": 604_800,
  "30d": 2_592_000,
};

/** The window the payload actually covers, in seconds. Never negative. */
export function windowSeconds(window: CellHistoryWindow): number {
  return Math.max(0, window.end - window.start);
}

/**
 * True when the archive could not fill the requested range.
 *
 * `0.9` rather than `1.0`: the window ends at the newest archived row, which is
 * up to a poll cycle behind the wall clock, so a freshly-filled 24h range
 * legitimately comes back ~2 % short. Anything past a tenth is the archive
 * genuinely not reaching that far back, and the page has to say so — otherwise
 * "5G never dropped" is a claim about hours nobody recorded.
 */
export function isWindowShort(
  window: CellHistoryWindow,
  range: CellHistoryRange,
): boolean {
  const requested = RANGE_SECONDS[range];
  return windowSeconds(window) < requested * 0.9;
}

/**
 * True when the window reaches back further than cell-identity logging does.
 *
 * A one-minute slack absorbs the bucket rounding between `cell_from` (a sample
 * timestamp) and `window.start` (a bucket edge); without it every single range
 * would announce a coverage gap of two seconds.
 */
export function identityLagsWindow(
  coverage: CellHistoryCoverage,
  window: CellHistoryWindow,
): boolean {
  return coverage.cell_from !== null && coverage.cell_from > window.start + 60;
}

/**
 * Whatever a caller hands us, as a real Date — or `null` when it is not one.
 *
 * THIS EXISTS BECAUSE THE INPUT IS NOT ALWAYS EPOCH SECONDS. Three shapes reach
 * these formatters and only the first is ours:
 *
 *   * epoch SECONDS  — the archive's own unit, and what the payload contract
 *     says every timestamp is;
 *   * epoch MILLISECONDS — recharts' `scale="time"` measures its domain in ms,
 *     so with that scale the axis hands a tick formatter millisecond values;
 *   * a `Date` — d3's time scale generates its ticks as Date objects, so the
 *     very same tick formatter receives Dates (this is what produced a page of
 *     "Invalid Date" labels: `new Date(aDate * 1000)` is NaN);
 *   * `null` — a window or an "as of" that has no sample behind it yet.
 *
 * The seconds/milliseconds split is decided by MAGNITUDE, not by a flag: every
 * real timestamp on this device is > 1e9 seconds and < 1e12 ms, so `1e12` is
 * the boundary and it cannot be crossed by either unit in this century. A
 * formatter that guesses wrong shows 1970, which is at least a date; one that
 * does not normalise at all shows "Invalid Date", which is worse than nothing.
 */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The em dash every formatter falls back to. Never the word "Invalid". */
const NO_DATE = "—";

/** Local `HH:MM`, 24-hour. */
export function formatClock(ts: unknown): string {
  const date = toDate(ts);
  if (date === null) return NO_DATE;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Local date plus `HH:MM` — the voice of an event, an outage's start, an "as of". */
export function formatMoment(ts: unknown): string {
  const date = toDate(ts);
  if (date === null) return NO_DATE;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Local calendar day, short form — a matrix row label. */
export function formatDay(ts: unknown): string {
  const date = toDate(ts);
  if (date === null) return NO_DATE;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * An axis tick. A range of a day or more repeats `HH:MM` across the axis, so
 * past a day the tick prints the date instead (the same call
 * `detailed-metrics/trend-chart.tsx` made).
 *
 * `unknown` in, because recharts' time scale hands this either milliseconds or
 * a `Date`; see `toDate`.
 */
export function formatAxisTick(ts: unknown, longSpan: boolean): string {
  return longSpan ? formatDay(ts) : formatClock(ts);
}

/**
 * "3h 05m", "42m", "18s" — two units at most.
 *
 * The `h`/`m`/`s` are unit SYMBOLS, not prose: `history.outages.col_duration`
 * is the column heading and this is the figure under it. Same treatment as the
 * inline units in `detailed-metrics/distributions-card.tsx`.
 */
export function formatSpan(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** A whole-number percentage, already rounded — never a fraction of a percent. */
export function formatPct(value: number): string {
  return `${Math.round(value)}%`;
}

// -----------------------------------------------------------------------------
// Availability
// -----------------------------------------------------------------------------

/**
 * The four stops the strip and the matrix share.
 *
 * `unknown` is not a fourth *state of the radio*; it is the absence of one, and
 * it is why this is a string union rather than a ratio bucket. `n: 0` means no
 * sample in the bucket determined availability, so nothing may be inferred
 * about it.
 */
export type AvailabilityTier = "up" | "partial" | "down" | "unknown";

/**
 * A bucket's stop. `up`/`down` require near-unanimity (19 of 20 samples) so a
 * single missed sample inside a 15-minute bucket does not paint a solid
 * "5G down" cell over a quarter of an hour; anything genuinely mixed is
 * `partial`.
 */
export function availabilityTier(bucket: {
  n: number;
  up: number;
}): AvailabilityTier {
  if (bucket.n <= 0) return "unknown";
  const ratio = bucket.up / bucket.n;
  if (ratio >= 0.95) return "up";
  if (ratio <= 0.05) return "down";
  return "partial";
}

export interface AvailabilitySummary {
  /** Samples in the window where availability was DETERMINED. */
  known: number;
  /** Of those, how many had the NR leg. */
  up: number;
  /** `null` when nothing was determined — never `0`. */
  pct: number | null;
}

export function availabilitySummary(
  buckets: AvailabilityBucket[],
): AvailabilitySummary {
  let known = 0;
  let up = 0;
  for (const bucket of buckets) {
    known += bucket.n;
    up += bucket.up;
  }
  return { known, up, pct: known > 0 ? (up / known) * 100 : null };
}

/** True when every bucket in the range holds no determined sample. */
export function isAvailabilityUnknown(buckets: AvailabilityBucket[]): boolean {
  if (buckets.length === 0) return true;
  return buckets.every((bucket) => bucket.n <= 0);
}

/**
 * The local hour boundaries inside the window, thinned to at most
 * `MAX_HOUR_TICKS` of them.
 *
 * Boundaries are walked with `Date#setHours`, never by adding 3600 to a
 * timestamp, so a half-hour zone (UTC+05:30) and a DST step both land on the
 * hour the reader's own clock shows.
 */
const MAX_HOUR_TICKS = 7;
const TICK_STEPS = [1, 2, 3, 6, 12, 24] as const;

export interface HourTick {
  ts: number;
  /** Position along the window, in percent. */
  leftPct: number;
}

export function hourTicks(window: CellHistoryWindow): HourTick[] {
  const span = windowSeconds(window);
  if (span <= 0) return [];

  const step =
    TICK_STEPS.find((candidate) => span / (candidate * 3_600) <= MAX_HOUR_TICKS) ??
    24;

  const cursor = new Date(window.start * 1000);
  cursor.setMinutes(0, 0, 0);
  if (cursor.getTime() / 1000 < window.start) cursor.setHours(cursor.getHours() + 1);

  const ticks: HourTick[] = [];
  while (cursor.getTime() / 1000 <= window.end) {
    if (cursor.getHours() % step === 0) {
      const ts = Math.floor(cursor.getTime() / 1000);
      ticks.push({ ts, leftPct: ((ts - window.start) / span) * 100 });
    }
    cursor.setHours(cursor.getHours() + 1);
  }
  return ticks;
}

// -----------------------------------------------------------------------------
// The night pattern
// -----------------------------------------------------------------------------

export interface PatternCell {
  key: string;
  /** Local hour, 0…23. */
  hour: number;
  n: number;
  up: number;
}

export interface PatternRow {
  key: string;
  /** Local calendar day, short form. */
  label: string;
  /** Exactly 24 entries, hour 0…23. An hour with no bucket holds `n: 0`. */
  cells: PatternCell[];
}

/** A local calendar-day key. Days are the reader's days, never UTC days. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * The day × hour matrix.
 *
 * Rows are the local calendar days the WINDOW covers, oldest first — seeded
 * from the window rather than from the buckets, so a day whose every hour was
 * recorded as unknown still gets its row (a missing row would read as "that
 * night did not happen"). Columns are local hours 00…23.
 */
export function patternRows(
  buckets: AvailabilityBucket[],
  window: CellHistoryWindow,
): PatternRow[] {
  const rows: PatternRow[] = [];
  const byKey = new Map<string, PatternRow>();

  const cursor = new Date(window.start * 1000);
  cursor.setHours(0, 0, 0, 0);
  const last = new Date(window.end * 1000);
  last.setHours(0, 0, 0, 0);

  while (cursor.getTime() <= last.getTime() && rows.length < 40) {
    const key = dayKey(cursor);
    const row: PatternRow = {
      key,
      label: cursor.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      cells: Array.from({ length: 24 }, (_, hour) => ({
        key: `${key}T${hour}`,
        hour,
        n: 0,
        up: 0,
      })),
    };
    rows.push(row);
    byKey.set(key, row);
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const bucket of buckets) {
    // A bucket that straddles the window edge belongs to whichever local hour
    // its own timestamp falls in; the window is clamped upstream, not here.
    const at = new Date(bucket.ts * 1000);
    const row = byKey.get(dayKey(at));
    if (!row) continue;
    const cell = row.cells[at.getHours()];
    cell.n += bucket.n;
    cell.up += bucket.up;
  }

  return rows;
}

// -----------------------------------------------------------------------------
// The serving-cell gantt
// -----------------------------------------------------------------------------

export interface TimelineSegment {
  key: string;
  run: CellRun;
  leftPct: number;
  widthPct: number;
}

/**
 * Runs as percentages of the window.
 *
 * A segment is floored at `MIN_SEGMENT_PCT` so a one-minute run on a 30-day
 * range is still a visible mark rather than a sub-pixel sliver: the gantt is
 * read as "the cell changed here", and a change nobody can see is the failure
 * this floor exists to prevent.
 */
const MIN_SEGMENT_PCT = 0.5;

export function timelineSegments(
  runs: CellRun[],
  window: CellHistoryWindow,
): TimelineSegment[] {
  const span = windowSeconds(window);
  if (span <= 0) return [];

  const segments: TimelineSegment[] = [];
  for (const run of runs) {
    const start = Math.max(run.start_ts, window.start);
    const end = Math.min(run.end_ts, window.end);
    if (end <= start) continue;
    const leftPct = Math.min(
      ((start - window.start) / span) * 100,
      100 - MIN_SEGMENT_PCT,
    );
    const widthPct = Math.min(
      Math.max(((end - start) / span) * 100, MIN_SEGMENT_PCT),
      100 - leftPct,
    );
    segments.push({
      key: `${run.start_ts}-${run.lte_pci ?? "-"}-${run.nr_band ?? "-"}`,
      run,
      leftPct,
      widthPct,
    });
  }
  return segments;
}

/**
 * Which of a leg's two tones a band wears.
 *
 * A hash of the band string, so the same band always lands on the same tone —
 * across a re-render, a range switch and a reload. Deriving it from the array
 * index instead would repaint every segment whenever the window moved, which is
 * the "colour keyed stably by band" requirement inverted.
 *
 * It is a TWO-way split, and that is stated rather than hidden: short band
 * strings that differ in one digit do not spread across it (B1 and B3 land on
 * the same tone). Nothing depends on the shade being unique — the gantt draws a
 * gap between every segment and prints the band inside each one, so a boundary
 * is legible before any colour is read. The shade only makes two runs of the
 * SAME band look like the same thing.
 */
export function bandVariant(band: string | null): 0 | 1 {
  const text = band ?? "";
  // Seeded with the LENGTH so two bands of different widths are not separated
  // by their trailing digit alone, which is the only character "B1" and "B3"
  // have apart.
  let hash = 5381 + text.length * 131;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 2) as 0 | 1;
}

/** A run's own band for one leg, or `null` when the modem reported none. */
export function runBand(run: CellRun, leg: "lte" | "nr"): string | null {
  const band = leg === "lte" ? run.lte_band : run.nr_band;
  return band && band.trim() !== "" ? band : null;
}

// -----------------------------------------------------------------------------
// Outages
// -----------------------------------------------------------------------------

export interface OutageRow {
  key: string;
  startTs: number;
  endTs: number;
  seconds: number;
  samples: number;
  /** The serving identity at `start_ts`, derived from the gantt's own runs. */
  ltePci: string | null;
  lteBand: string | null;
  nrBand: string | null;
  /** True when no run covers the outage's start — the timeline is blind there. */
  uncovered: boolean;
}

/**
 * Outage spans, newest first, each carrying the cell that was serving when it
 * began.
 *
 * The serving cell is read off `cells.timeline` rather than guessed: the
 * backend cuts a run at a band/PCI change or at a gap, so "the run containing
 * this instant" is the identity the modem reported, and `uncovered` says so
 * honestly when no run does.
 */
export function outageRows(outages: NrOutage[], runs: CellRun[]): OutageRow[] {
  const ordered = [...outages].sort((a, b) => b.start_ts - a.start_ts);
  return ordered.map((outage) => {
    let serving: CellRun | undefined;
    for (const run of runs) {
      if (run.start_ts <= outage.start_ts && run.end_ts >= outage.start_ts) {
        serving = run;
        break;
      }
      if (run.start_ts <= outage.start_ts) serving = run;
    }
    return {
      key: `${outage.start_ts}-${outage.end_ts}`,
      startTs: outage.start_ts,
      endTs: outage.end_ts,
      seconds: Math.max(0, outage.end_ts - outage.start_ts),
      samples: outage.samples,
      ltePci: serving?.lte_pci ?? null,
      lteBand: serving?.lte_band ?? null,
      nrBand: serving?.nr_band ?? null,
      uncovered: serving === undefined,
    };
  });
}

/** Total down-time across the spans. Wall-clock seconds, not a sample count. */
export function totalOutageSeconds(outages: NrOutage[]): number {
  return outages.reduce(
    (total, outage) => total + Math.max(0, outage.end_ts - outage.start_ts),
    0,
  );
}

// -----------------------------------------------------------------------------
// Time-on-cell, and the change list
// -----------------------------------------------------------------------------

/** greenpacket's floor: a cell the device merely brushed past never counts. */
const PROBLEM_MIN_KNOWN = 3;
const PROBLEM_DOWN_RATIO = 0.8;

/** 5G-down ratio on one cell in percent, or `null` when nothing was determined. */
export function cellDownPct(stat: CellStat): number | null {
  if (stat.nr_known <= 0) return null;
  return (stat.nr_down / stat.nr_known) * 100;
}

/**
 * The cells worth naming in prose above the rollup.
 *
 * The floor is deliberately two-sided — at least three determined samples AND
 * at least 80 % of them down. A handover that brushed one unrecorded sample
 * would otherwise brand a cell as broken, which is an opinion the device cannot
 * back (the spec's own Out of Scope: no per-cell verdict, only measurements).
 */
export function problemCells(stats: CellStat[]): CellStat[] {
  return stats.filter(
    (stat) =>
      stat.nr_known >= PROBLEM_MIN_KNOWN &&
      stat.nr_down / stat.nr_known >= PROBLEM_DOWN_RATIO,
  );
}

/** What a before/after value in the change list actually says. */
export type ChangeValue =
  | { kind: "flag"; flag: "up" | "down" | "unknown" }
  | { kind: "text"; text: string };

/**
 * One side of a change.
 *
 * `nr_avail` is three-valued on the wire (`"1"`, `"0"`, or absent), so it is a
 * word rather than a numeral: "5G 1 → 0" is a state transition, and the reader
 * should not have to decode it. A band keeps the string the modem sent, prefix
 * and all.
 */
export function changeValue(
  field: CellChangeField,
  value: string | null,
): ChangeValue {
  const text = value === null ? "" : value.trim();
  if (field === "nr_avail") {
    if (text === "1") return { kind: "flag", flag: "up" };
    if (text === "0") return { kind: "flag", flag: "down" };
    return { kind: "flag", flag: "unknown" };
  }
  if (text === "") return { kind: "flag", flag: "unknown" };
  return { kind: "text", text };
}

// -----------------------------------------------------------------------------
// Charts
// -----------------------------------------------------------------------------

/**
 * A metric's plotting contract.
 *
 * `domain` is set only where the metric HAS a reporting range the reader can
 * learn once (RSRP is −140…−44 dBm by 3GPP, a percentage is 0…100), and is
 * `null` everywhere else — a TX power or a throughput that re-derives its axis
 * every poll encodes nothing about magnitude. The plotted ranges are the
 * product's own grading brackets, deliberately narrower than the 3GPP limits:
 * a reading outside is drawn at the edge rather than rescaling the whole chart
 * around one outlier.
 *
 * `scale` converts a wire value to its plotted unit (bps → Mbit/s); the unit
 * label beside the title is the plotted one, so the axis can never lie about
 * what it is showing.
 */
export interface MetricAxis {
  unit: string | null;
  domain: readonly [number, number] | null;
  tone: string;
  scale: number;
}

export const METRIC_AXIS = {
  rsrp: { unit: "dBm", domain: [-125, -55], tone: SERIES_TONE.nr, scale: 1 },
  sinr: { unit: "dB", domain: [-20, 30], tone: SERIES_TONE.nr, scale: 1 },
  rsrq: { unit: "dB", domain: [-20, -3], tone: SERIES_TONE.nr, scale: 1 },
  rssi: { unit: "dBm", domain: [-100, -40], tone: SERIES_TONE.nr, scale: 1 },
  cqi: { unit: null, domain: [0, 15], tone: SERIES_TONE.nr, scale: 1 },
  rank: { unit: null, domain: [0, 8], tone: SERIES_TONE.nr, scale: 1 },
  mcs: { unit: null, domain: [0, 28], tone: SERIES_TONE.nr, scale: 1 },
  tx_power: { unit: "dBm", domain: null, tone: SERIES_TONE.nr, scale: 1 },
  temp: { unit: "°C", domain: null, tone: SERIES_TONE.nr, scale: 1 },
  cpu: { unit: "%", domain: [0, 100], tone: SERIES_TONE.nr, scale: 1 },
  mem: { unit: "%", domain: [0, 100], tone: SERIES_TONE.nr, scale: 1 },
  dl: { unit: "Mbit/s", domain: null, tone: SERIES_TONE.down, scale: 1e-6 },
  ul: { unit: "Mbit/s", domain: null, tone: SERIES_TONE.up, scale: 1e-6 },
} as const;

export type ChartMetric = keyof typeof METRIC_AXIS;

/**
 * A series converted to its plotted unit, `null` preserved.
 *
 * A bucket with no reading stays `null` — the conversion must never turn an
 * absence into a zero, which is the one thing a scale factor is dangerous for.
 * Two decimals rather than full precision: a throughput in Mbit/s with six
 * decimals produces ticks nobody can read.
 */
export function plotPoints(
  metric: ChartMetric,
  points: CellHistoryPoint[],
): { ts: number; v: number | null }[] {
  const { scale } = METRIC_AXIS[metric];
  return points.map((point) => ({
    ts: point.ts,
    v: point.v === null ? null : Math.round(point.v * scale * 100) / 100,
  }));
}

/**
 * The Y domain for one chart.
 *
 * A metric with a reporting bracket keeps that bracket, so the same reading
 * sits at the same height across ranges and its shape can be compared with
 * another range's. It is widened — never clipped — when a reading genuinely
 * falls outside it: an axis that hides the sample it is drawing is worse than
 * an axis that moves. Metrics with no bracket (`domain: null`) auto-scale, and
 * say nothing about magnitude, which is why nothing in the UI reads an axis as
 * a graded position.
 */
export function yDomain(
  metric: ChartMetric,
  points: { v: number | null }[],
): [number, number] | null {
  const bracket = METRIC_AXIS[metric].domain;
  if (bracket === null) return null;

  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (point.v === null) continue;
    if (point.v < min) min = point.v;
    if (point.v > max) max = point.v;
  }
  if (!Number.isFinite(min)) return [bracket[0], bracket[1]];
  return [Math.min(bracket[0], min), Math.max(bracket[1], max)];
}
