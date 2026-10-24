"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

import { formatAxisTick } from "./derive";
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

  const tick = (ts: number) => formatAxisTick(ts, longSpan);
  const decimals =
    points.some((point) => point.v !== null && !Number.isInteger(point.v));

  return (
    <ChartContainer
      config={config}
      className={CHART_BOX}
      role="img"
      aria-label={unit ? `${label} · ${unit}` : label}
    >
      <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="ts"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
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
          content={
            // The series row's own label carries the metric and its unit, so
            // the tooltip needs no formatter: only the timestamp is formatted.
            <ChartTooltipContent labelFormatter={(value) => tick(Number(value))} />
          }
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
