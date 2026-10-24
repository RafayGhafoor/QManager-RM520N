"use client";

import dynamic from "next/dynamic";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";
import type {
  CellHistoryPanel,
  CellHistorySuccess,
} from "@/types/cell-history";
import { cn } from "@/lib/utils";

import {
  METRIC_AXIS,
  plotPoints,
  yDomain,
  type ChartMetric,
} from "./derive";
import { CARD, CHART, CHART_BOX, FULL, HEAD, LEGEND } from "./shapes";

// =============================================================================
// ChartCard — a titled group of metric charts, used three times
// =============================================================================
// One card per GROUP, not one per metric: the RF group, the PHY group and the
// device group are each this component with a different metric list, so the
// three cannot drift into three chart idioms (axis width, gap handling, empty
// state, tooltip voice).
//
// RECHARTS IS LOADED THROUGH `next/dynamic`, NOT IMPORTED. This file, and
// therefore this card's shell, heading, per-chart titles and "no readings"
// states, all render from the payload alone; the chart stack arrives in a
// separate chunk after hydration (spec R10). `ssr: false` because the build is
// a static export — there is no server to render it and a mismatch would be the
// only thing it produced.
//
// ONE FIXED HEIGHT PER CHART BOX. Loaded, loading and empty all draw a
// `CHART_BOX`-tall region, so a 30 s retarget or a panel arriving never moves
// the card under the reader's cursor.
//
// A MISSING PANEL AND AN EMPTY ONE ARE THE SAME HOLE, deliberately: `missing[]`
// means the archive had no coverage for that panel in this range and an empty
// series means it had coverage but no reading. Neither can be filled by
// waiting, and drawing an empty plot for either would read as "flat", which is
// a value.
//
// THE SERIES KEY IS A SWATCH OF THE STROKE ITSELF. Every drawn series is named
// under the heading with a 2px rule in `METRIC_AXIS`'s own tone — the same
// value handed to the chart as its stroke, so the key cannot drift from the
// line. It is derived from the metrics this card was given, never authored
// alongside them, and it is absent when fewer than two series are drawn: a
// one-line key would only repeat the chart's own titles.
//
// ONE ENTRY PER STROKE, NOT PER METRIC, because three of this page's four chart
// tones are SHARED (`--chart-nr` draws RSRP, SINR, RSRQ, RSSI, and every PHY
// and device-load figure). Four identical violet rules would read as a drawing
// bug rather than a key, so metrics that share a tone share an entry and are
// named in one line. The colour is never the only thing naming a series — each
// chart still prints its own title above it.
// =============================================================================

const TrendChart = dynamic(
  () => import("./trend-chart").then((module) => module.TrendChart),
  { ssr: false, loading: () => <Skeleton className={CHART_BOX} /> },
);

export interface ChartCardProps {
  /** Already-translated group title (`history.charts.*_title`). */
  title: string;
  metrics: readonly ChartMetric[];
  series: CellHistorySuccess["series"];
  missing: CellHistoryPanel[];
  /** True past a day, where axis ticks read the date instead of the clock. */
  longSpan: boolean;
  /** True for a card that owns a whole row. */
  full?: boolean;
}

export function ChartCard({
  title,
  metrics,
  series,
  missing,
  longSpan,
  full = false,
}: ChartCardProps) {
  const { t } = useTranslation("cellular");

  // One entry per plotted series, resolved once so the key and the chart grid
  // read the same tone and the same "is there a reading" verdict.
  const plots = metrics.map((metric) => {
    const axis = METRIC_AXIS[metric];
    const points = plotPoints(metric, series[metric] ?? []);
    const hasReading = points.some((point) => point.v !== null);
    return {
      metric,
      axis,
      points,
      label: t(`history.charts.metric.${metric}`),
      drawn: !missing.includes(metric) && hasReading,
    };
  });
  const drawn = plots.filter((plot) => plot.drawn);

  // Grouped by tone, in first-appearance order: one swatch per stroke.
  const keys: { tone: string; label: string }[] = [];
  for (const plot of drawn) {
    const existing = keys.find((entry) => entry.tone === plot.axis.tone);
    if (existing) existing.label = `${existing.label} · ${plot.label}`;
    else keys.push({ tone: plot.axis.tone, label: plot.label });
  }

  return (
    <section className={cn(CARD, full && FULL)}>
      <header className={HEAD.ROOT}>
        <h2 className={HEAD.TITLE}>{title}</h2>
        <p className={HEAD.DESC}>{t("history.charts.gap_note")}</p>
      </header>

      {drawn.length > 1 ? (
        <ul className={LEGEND.ITEMS} aria-label={t("history.legend.series")}>
          {keys.map((entry) => (
            <li key={entry.tone} className={LEGEND.ITEM}>
              <span
                className={LEGEND.LINE}
                style={{ backgroundColor: entry.tone }}
                aria-hidden="true"
              />
              {entry.label}
            </li>
          ))}
        </ul>
      ) : null}

      <div className={CHART.GRID}>
        {plots.map((plot) => {
          const { axis, metric, points, label } = plot;

          return (
            <div key={metric} className={CHART.ROOT}>
              <h3 className={CHART.TITLE}>
                {label}
                {axis.unit ? <span className={CHART.UNIT}>{axis.unit}</span> : null}
              </h3>
              {!plot.drawn ? (
                <p className={cn(CHART_BOX, CHART.EMPTY)}>
                  {t("history.charts.no_data")}
                </p>
              ) : (
                <TrendChart
                  points={points}
                  label={label}
                  unit={axis.unit}
                  color={axis.tone}
                  domain={yDomain(metric, points)}
                  longSpan={longSpan}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default ChartCard;
