"use client";

import { NO_DATE, formatMoment, toMs } from "@/lib/chart-time";
import { cn } from "@/lib/utils";

// =============================================================================
// ChartTooltipTime — a hover card that shows WHEN, then every series
// =============================================================================
// The shared `ChartTooltipContent` takes its label from `labelFormatter`, and for
// a numeric x-axis that callback receives the SERIES name ("RSRP · dBm") rather
// than the x value — so formatting it as a time produced "Invalid Date" on every
// hover of every trend chart on this device. This component does not use that
// path at all: it reads the timestamp out of the hovered DATUM (`payload[0]
// .payload`), which is the plotted row and therefore always carries `ts` in the
// archive's own unit.
//
// It is deliberately small and dumb: a time, then one row per series in the
// series' own stroke colour. It knows nothing about metrics, axes or units
// beyond the one string each series is handed, which is what lets both the Cell
// History charts and the Detailed Metrics chart share it.
// =============================================================================

/** The shape recharts hands a tooltip's `content` element. */
interface TooltipDatum {
  name?: string | number;
  value?: number | string | null;
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

export interface ChartTooltipTimeProps {
  active?: boolean;
  payload?: readonly TooltipDatum[];
  /** Appended to every value once (" dBm", " %"). */
  unit?: string | null;
  /**
   * Overrides the timestamp lookup. Charts whose datum key is not `ts` pass
   * their own field; everything sourced from the archive leaves it alone.
   */
  timeKey?: string;
  /** Rendered when a series has no reading at this bucket. */
  empty?: string;
  className?: string;
}

function readTime(
  payload: readonly TooltipDatum[],
  timeKey: string,
): string | null {
  for (const item of payload) {
    const row = item.payload;
    if (!row) continue;
    const raw = row[timeKey] ?? row.ts ?? row.ms;
    if (toMs(raw) !== null) return formatMoment(raw);
  }
  return null;
}

export function ChartTooltipTime({
  active,
  payload,
  unit,
  timeKey = "ts",
  empty,
  className,
}: ChartTooltipTimeProps) {
  // A UI primitive does not pick a translation namespace: the dash is the
  // language-neutral default and a page that wants a sentence passes one.
  const missing = empty ?? NO_DATE;

  if (!active || !payload || payload.length === 0) return null;

  const when = readTime(payload, timeKey);

  return (
    <div
      className={cn(
        "min-w-[9rem] rounded-tile border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md",
        className,
      )}
    >
      {/* The time is the header because it is the axis the reader is following;
          an em dash here means the datum carried no timestamp, which is worth
          seeing rather than hiding behind an empty row. */}
      <div className="mb-1 text-xs font-semibold tabular-nums">
        {when ?? missing}
      </div>
      <ul className="flex flex-col gap-0.5">
        {payload.map((item, index) => {
          const value = item.value;
          const shown =
            value === null || value === undefined || value === ""
              ? missing
              : `${value}${unit ?? ""}`;
          return (
            <li
              key={`${item.dataKey ?? item.name ?? index}`}
              className="flex items-center gap-2 text-xs"
            >
              <span
                aria-hidden
                className="inline-block h-0.5 w-3 shrink-0 rounded-full"
                style={{ background: item.color ?? "currentColor" }}
              />
              <span className="min-w-0 truncate text-on-surface-variant">
                {item.name}
              </span>
              <span className="ms-auto font-semibold tabular-nums">{shown}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default ChartTooltipTime;
