"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { ChartTooltipTime } from "@/components/ui/chart-tooltip-time";
import { axisTicks, formatAxisTick, toMs } from "@/lib/chart-time";
import type { DetailedMetricSeriesPoint } from "@/types/detailed-metrics";

import { CHART_BOX } from "./shapes";

// =============================================================================
// TrendChart — the archived series for one panel
// =============================================================================
// Imported through `next/dynamic` by `distributions-card.tsx` so recharts is not
// in the page's first paint: this is one card on a page that is mostly static
// readouts, and the chart stack is by far the largest thing an unread
// `/cellular/detailed-metrics` could carry.
//
// TWO RULES DECIDE EVERYTHING HERE:
//
//  * A GAP IS A GAP. `connectNulls={false}` and a `null` `v` — a bucket in which
//    the poller recorded no measurement is a break in the line, never a line
//    drawn through 0. Joining across it would draw a plausible trend through
//    data that does not exist, which is the single most expensive kind of lie a
//    chart can tell (`docs/reference/latency-monitor.md:65`).
//  * NO ENTRANCE ANIMATION. The series retargets on a 30 s poll, and a draw-in
//    that replayed on every retarget would dim the one line being watched, once
//    every half minute (`docs/reference/motion-preference.md`). The chart's
//    arrival is the card's transition, not the line's.
// =============================================================================

/**
 * The axis label. Delegated to `lib/chart-time` rather than formatted here: this
 * chart fed `new Date(ts * 1000)` a value that was already milliseconds (the
 * time axis measures in ms and ticks as `Date`), so the axis and every hover
 * read "Invalid Date". One shared conversion is the fix.
 */
function tickFormatterFor(longSpan: boolean) {
  return (ts: unknown) => formatAxisTick(ts, longSpan);
}

export interface TrendChartProps {
  points: DetailedMetricSeriesPoint[];
  /** Already-translated panel label — the series name in the tooltip. */
  label: string;
  unit?: string;
  /**
   * True for a range of a day or more, where an `HH:MM` tick would repeat
   * itself across the axis.
   */
  longSpan: boolean;
}

export function TrendChart({ points, label, unit, longSpan }: TrendChartProps) {
  const config = {
    v: { label: unit ? `${label} · ${unit}` : label, color: "var(--primary)" },
  } satisfies ChartConfig;

  const tickFormatter = tickFormatterFor(longSpan);

  // Milliseconds on the axis (the time scale's own unit) with EXPLICIT ticks, so
  // the formatter's input is a number this module produced and not a `Date` the
  // chart library invented.
  const data = points.map((point) => ({ ...point, ms: toMs(point.ts) ?? NaN }));
  const ticks = axisTicks(
    data.length > 0 ? data[0].ms : null,
    data.length > 0 ? data[data.length - 1].ms : null,
  );

  return (
    <ChartContainer
      config={config}
      className={CHART_BOX}
      // One image, named by its panel: recharts renders decorative marks, and
      // the distribution rows below carry the same numbers as real text.
      role="img"
      aria-label={label}
    >
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="ms"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          ticks={ticks}
          tickFormatter={tickFormatter}
          tickLine={false}
          axisLine={false}
          minTickGap={28}
        />
        <YAxis
          width={44}
          tickLine={false}
          axisLine={false}
          allowDecimals
          domain={["auto", "auto"]}
        />
        <ChartTooltip
          // Not ChartTooltipContent: for a numeric x-axis its labelFormatter
          // receives the series name rather than the time, which is what made
          // every hover read "Invalid Date".
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
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

export default TrendChart;
