"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { ChartTooltipTime } from "@/components/ui/chart-tooltip-time";
import { axisTicks, formatAxisTick, toMs } from "@/lib/chart-time";

import { CHART_BOX } from "./shapes";

// =============================================================================
// TrendChart — one archived metric over the selected range
// =============================================================================
// Imported through `next/dynamic` by `chart-card.tsx`, so the chart stack is
// not in this page's first paint: the card shells, their headings and their
// empty states all render from the payload alone, and recharts arrives after
// them (spec R10). This is the same construction
// `detailed-metrics/distributions-card.tsx` uses.
//
// THREE RULES DECIDE EVERYTHING HERE:
//
//  * A GAP IS A GAP. `connectNulls={false}` and a `null` `v` — a bucket in
//    which the poller recorded nothing is a break in the line, never a line
//    drawn through zero. `history.charts.gap_note` says the same thing on the
//    card, because a reader who wonders why the line stops deserves the answer
//    without a hover (`docs/reference/latency-monitor.md:65`).
//  * NO ENTRANCE ANIMATION. The series retargets on a 30 s poll, and a draw-in
//    that replayed on every retarget would dim the one line being watched, once
//    every half minute (`docs/reference/motion-preference.md`; this page has no
//    entrance to honour because it never animates data).
//  * THE X AXIS IS LOCAL TIME, from epoch seconds. Under a day the ticks read
//    `HH:MM`; past a day they read the date, because `HH:MM` repeats itself
//    across a week's axis and stops locating anything.
// =============================================================================

export interface TrendChartProps {
  /** Buckets in the plotted unit; `v: null` is a bucket with no reading. */
  points: { ts: number; v: number | null }[];
  /** Already-translated metric label — the series name in the tooltip. */
  label: string;
  unit: string | null;
  /** A role token, never a raw hex. */
  color: string;
  /** A fixed reporting bracket, or `null` where the metric has none. */
  domain: readonly [number, number] | null;
  longSpan: boolean;
}

export function TrendChart({
  points,
  label,
  unit,
  color,
  domain,
  longSpan,
}: TrendChartProps) {
  const config = {
    v: {
      label: unit ? `${label} · ${unit}` : label,
      color,
    },
  } satisfies ChartConfig;

  const tick = (ts: unknown) => formatAxisTick(ts, longSpan);

  // One extra field per point, not a second array: a time axis measures its
  // domain in milliseconds while everything else on the page — and the payload
  // contract — is epoch seconds.
  const data = points.map((point) => ({
    ...point,
    ms: toMs(point.ts) ?? NaN,
  }));

  // EXPLICIT TICKS, in milliseconds. Left to itself the chart library generates
  // its own time ticks as `Date` objects and hands them to `tickFormatter`; that
  // path is what printed "Invalid Date" across this axis. Handing it the array
  // fixes the formatter's input type here rather than inside the library.
  const first = data.length > 0 ? data[0].ms : NaN;
  const last = data.length > 0 ? data[data.length - 1].ms : NaN;
  const ticks = axisTicks(
    Number.isFinite(first) ? first : null,
    Number.isFinite(last) ? last : null,
  );
  const decimals =
    points.some((point) => point.v !== null && !Number.isInteger(point.v));

  return (
    <ChartContainer
      config={config}
      className={CHART_BOX}
      role="img"
      aria-label={unit ? `${label} · ${unit}` : label}
    >
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          // MILLISECONDS, because `scale="time"` measures its domain in ms:
          // fed epoch seconds it resolves 1970 and ticks the axis at the wrong
          // century. `ms` is derived here rather than in the payload, which
          // stays in the archive's own unit (seconds) everywhere else.
          dataKey="ms"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          ticks={ticks}
          tickFormatter={tick}
          tickLine={false}
          axisLine={false}
          minTickGap={28}
        />
        <YAxis
          width={44}
          tickLine={false}
          axisLine={false}
          allowDecimals={decimals}
          domain={domain === null ? ["auto", "auto"] : [domain[0], domain[1]]}
        />
        <ChartTooltip
          // The shared ChartTooltipContent is NOT used here: for a numeric
          // x-axis its labelFormatter receives the series name, not the time.
          // This one reads the timestamp out of the hovered datum.
          content={<ChartTooltipTime unit={unit} />}
        />
        <Line
          dataKey="v"
          type="monotone"
          stroke="var(--color-v)"
          strokeWidth={2}
          dot={false}
          // The gap rule. See the header.
          connectNulls={false}
          // The motion rule. See the header.
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

export default TrendChart;
