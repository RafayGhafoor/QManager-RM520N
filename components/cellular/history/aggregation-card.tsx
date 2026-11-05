"use client";

import dynamic from "next/dynamic";
import { useTranslation } from "react-i18next";

import type { BandRun } from "@/types/cell-history";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { comboCarriers, runStepPoints } from "./derive";
import { CARD, CHART, CHART_BOX, FULL, HEAD } from "./shapes";

// =============================================================================
// AggregationCard — how many carriers served, and how much bandwidth, over time
// =============================================================================
// Built from `cells.bands` RUNS, not from the bucketed `bw` / `ca` /
// `total_cells` panels, and that is the whole design:
//
//   · a run is one contiguous stretch of ONE carrier set — exact, with its own
//     combo string and its own bandwidth;
//   · the panels are bucket AVERAGES, so a bucket that straddles a carrier
//     change reports "1.4 carriers" and "29.1 MHz". An average is a fine
//     statistic for a measurement and a nonsense one for a count of discrete
//     things: it answers neither "how many" nor "when did it change".
//
// Both series are therefore STEP charts (`stepAfter`): the radio held that
// carrier set until the next run began. A sloped line between 1 and 2 carriers
// would draw aggregation that never existed — the same rule that keeps
// `connectNulls={false}` on every other chart on this page.
//
// The carrier count is the number of tokens in the combo ("B3+N41" -> 2), which
// is what the radio reported; `ca_cc` is deliberately NOT used for it, because
// that column counts LTE SECONDARY carriers only and reads 0 on this device's
// normal NSA link (one LTE PCC + one NR SCC).
//
// Recharts is loaded through `next/dynamic` for the same reason as ChartCard:
// the shell and the headings render from the payload, the chart stack arrives in
// its own chunk (spec R10), and `ssr: false` because the build is a static
// export.
// =============================================================================

const TrendChart = dynamic(() => import("./trend-chart"), {
  ssr: false,
  loading: () => <Skeleton className={cn(CHART_BOX, "rounded-tile")} />,
});

/** Same violet the page's other radio figures use — one tone per stroke. */
const AGG_TONE = "var(--chart-nr)";

export function AggregationCard({
  runs,
  longSpan,
}: {
  runs: readonly BandRun[];
  longSpan: boolean;
}) {
  const { t } = useTranslation("cellular");

  const carriers = runStepPoints(runs, comboCarriers);
  const bandwidth = runStepPoints(runs, (run) => run.bw_mhz);

  const hasCarriers = carriers.some((point) => point.v !== null);
  const hasBandwidth = bandwidth.some((point) => point.v !== null);

  const plots = [
    {
      key: "carriers",
      label: t("history.charts.metric.total_cells"),
      unit: null as string | null,
      points: carriers,
      drawn: hasCarriers,
      domain: [0, 8] as readonly [number, number] | null,
    },
    {
      key: "bw",
      label: t("history.charts.metric.bw"),
      unit: t("history.charts.metric.bw_unit"),
      points: bandwidth,
      drawn: hasBandwidth,
      domain: null,
    },
  ];

  return (
    <section className={cn(CARD, FULL)}>
      <header className={HEAD.ROOT}>
        <h2 className={HEAD.TITLE}>{t("history.charts.agg_title")}</h2>
        <p className={HEAD.DESC}>{t("history.charts.agg_note")}</p>
      </header>

      <div className={CHART.GRID}>
        {plots.map((plot) => (
          <div key={plot.key} className={CHART.ROOT}>
            <h3 className={CHART.TITLE}>
              {plot.label}
              {plot.unit ? <span className={CHART.UNIT}>{plot.unit}</span> : null}
            </h3>
            {!plot.drawn ? (
              <p className={cn(CHART_BOX, CHART.EMPTY)}>
                {t("history.charts.no_data")}
              </p>
            ) : (
              <TrendChart
                points={plot.points}
                label={plot.label}
                unit={plot.unit}
                color={AGG_TONE}
                domain={plot.domain}
                longSpan={longSpan}
                step
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export default AggregationCard;
