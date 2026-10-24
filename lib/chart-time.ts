// =============================================================================
// chart-time.ts — one place that turns an archive timestamp into a Date
// =============================================================================
// Every chart on this device plots epoch SECONDS, because that is what the
// archive stores and what every CGI contract says. Two things then hand those
// numbers back in a different shape, and both of them produced a page of
// "Invalid Date" before this file existed:
//
//   * `scale="time"` — a recharts time axis measures its domain in MILLISECONDS
//     and generates its ticks as `Date` objects, so a formatter written as
//     `new Date(ts * 1000)` receives a Date, multiplies it by 1000, gets NaN,
//     and prints "Invalid Date" for every label.
//   * a tooltip's `labelFormatter` — the shared ChartTooltipContent passes it the
//     SERIES name ("RSRP · dBm") when the x-axis is numeric, not the x value, so
//     formatting that argument as a date is NaN again.
//
// The answer is not to remember the multiplication at each call site. It is this
// module: `toMs` is the ONE conversion, and everything above it takes `unknown`
// and cannot produce the string "Invalid".
//
// The seconds/milliseconds split is decided by MAGNITUDE — every real timestamp
// on this device is > 1e9 s and < 1e12 ms — so no caller has to say which unit
// it is holding, and neither unit can cross that line in this century. A wrong
// guess shows 1970 rather than "Invalid Date", which is at least a date; but the
// magnitude rule means there is no wrong guess to make.
// =============================================================================

/** Half-way house for the boundary: 1e12 ms is 2001-09-09, 1e12 s is year 33658. */
const MS_BOUNDARY = 1e12;

/**
 * Any timestamp shape → milliseconds since the epoch, or `null`.
 *
 * Accepts a `Date`, epoch seconds, epoch milliseconds, or a numeric string.
 * Returns `null` for anything else (including `0` and negatives, which are not
 * timestamps this device can hold — there is no RTC before NTP, and a 1970
 * reading means "the clock is not set", not "the event happened").
 */
export function toMs(value: unknown): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < MS_BOUNDARY ? n * 1000 : n;
}

/** The same thing as a `Date`, or `null`. */
export function toDate(value: unknown): Date | null {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms);
}

/** What every formatter says when there is no timestamp. Never "Invalid". */
export const NO_DATE = "—";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local `HH:MM`, 24-hour. */
export function formatClock(value: unknown): string {
  const ms = toMs(value);
  if (ms === null) return NO_DATE;
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local `MMM D, HH:MM` — a hover label, an event row, an "as of". */
export function formatMoment(value: unknown): string {
  const ms = toMs(value);
  if (ms === null) return NO_DATE;
  const d = new Date(ms);
  const month = d.toLocaleDateString(undefined, { month: "short" });
  return `${month} ${d.getDate()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local `MMM D` — a matrix row label, a tick past a day. */
export function formatDay(value: unknown): string {
  const ms = toMs(value);
  if (ms === null) return NO_DATE;
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: "short" })} ${d.getDate()}`;
}

/**
 * A tick label. Past a day `HH:MM` repeats itself across the axis and stops
 * locating anything, so the date answers instead.
 */
export function formatAxisTick(value: unknown, longSpan: boolean): string {
  return longSpan ? formatDay(value) : formatClock(value);
}

/**
 * Explicit axis ticks in MILLISECONDS, evenly spaced, `count + 1` of them.
 *
 * EXPLICIT IS THE POINT. Left to itself a `scale="time"` axis generates its own
 * ticks as Dates, which is the shape that broke these charts; passing the array
 * makes the axis render exactly the numbers this module produced, so the
 * formatter's input type is fixed by us and not by the chart library. It is also
 * the construction `latency-monitoring/history-card.tsx:243` already shipped and
 * that has never printed an invalid tick.
 *
 * `count` is clamped: fewer than two ticks is not an axis, and more than eight
 * collide on a phone. A degenerate span (0 or inverted) yields an empty array,
 * which makes the axis fall back to its own behaviour rather than draw a single
 * point.
 */
export function axisTicks(
  startMs: number | null,
  endMs: number | null,
  count = 5,
): number[] {
  if (startMs === null || endMs === null) return [];
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  if (endMs <= startMs) return [];
  const steps = Math.min(8, Math.max(2, Math.round(count)));
  return Array.from(
    { length: steps + 1 },
    (_, i) => Math.round(startMs + ((endMs - startMs) * i) / steps),
  );
}

/**
 * True when a range is long enough that a bare `HH:MM` tick loses its day.
 *
 * One shared threshold rather than a number at each call site: two charts that
 * disagreed about it would label the same span two different ways.
 */
export function isLongSpan(seconds: number): boolean {
  return seconds >= 86_400;
}
