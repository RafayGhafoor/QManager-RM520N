"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useTranslation } from "react-i18next";

import { MetricBar } from "@/components/ui/metric-bar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { MetricId } from "@/lib/metric-glossary";
import {
  DETAILED_METRIC_PANELS,
  type DetailedMetricPanel,
  type DetailedMetricRange,
  type DetailedMetricSeriesPoint,
  type DetailedMetricsSuccess,
} from "@/types/detailed-metrics";

import { GroupCard } from "./group-card";
import { MetricEmptyState } from "./empty-state";
import { MetricHint } from "./metric-figure";
import { CHART_BOX, DISTRIBUTION } from "./shapes";

// =============================================================================
// Distributions — the range view
// =============================================================================
// The page's only card that reads the archive rather than the live snapshot, so
// it is the only card whose content depends on the selected RANGE. It answers
// two questions about one panel: what did it do over the range, and how were its
// samples spread.
//
// WHY A SELECT AND NOT A SECOND PILL. `SegmentedField` is the house control for
// two to four short options; this control has ten, several with eight-character
// labels, and ten segments do not fit one row inside a card column. The
// primitive's own answer for a row that does not fit is a `Select`, which is
// what this is — not a bespoke dropdown.
//
// WHY MISSING PANELS ARE DISABLED RATHER THAN EMPTY. `missing[]` means the
// archive has no coverage for that panel in this range, which is not the same
// answer as "it archived nothing" and is not something the reader can fix by
// waiting. An option that cannot draw anything is disabled and says so in its
// hint; it never draws an empty plot.
//
// `range=now` carries no series at all (`bucket_sec` is null), so the card
// states that once instead of showing ten disabled controls.
// =============================================================================

/**
 * Recharts is the heaviest dependency on the page and this is the only surface
 * that draws with it, so it is fetched when the card is, not with the first
 * paint. `ssr: false` because the export is static — there is no server to
 * render it and a mismatch would be the only thing it produced.
 */
const TrendChart = dynamic(() => import("./trend-chart").then((m) => m.TrendChart), {
  ssr: false,
  loading: () => <Skeleton className={CHART_BOX} />,
});

/** Five bands: the coarsest split that still shows a shape, per the spec. */
const BUCKETS = 5;

/** Ranges at or past a day read a date on the axis, not a clock time. */
const LONG_SPANS: ReadonlySet<DetailedMetricRange> = new Set(["7d", "30d", "90d"]);

/** Panel → its glossary entry, unit and label key. One row per wire panel. */
const PANEL_SPEC = {
  rsrp: { metric: "panel.rsrp", unit: "dBm" },
  sinr: { metric: "panel.sinr", unit: "dB" },
  rsrq: { metric: "panel.rsrq", unit: "dB" },
  rssi: { metric: "panel.rssi", unit: "dBm" },
  temp: { metric: "panel.temp", unit: "°C" },
  cqi: { metric: "panel.cqi", unit: undefined },
  rank: { metric: "panel.rank", unit: undefined },
  mcs: { metric: "panel.mcs", unit: undefined },
  tx_power: { metric: "panel.tx_power", unit: "dBm" },
  total_cells: { metric: "panel.total_cells", unit: undefined },
} as const satisfies Record<
  DetailedMetricPanel,
  { metric: MetricId; unit: string | undefined }
>;

interface Band {
  from: number;
  to: number;
  count: number;
}

/**
 * The samples of one panel, split into five equal bands over their own min–max.
 *
 * Bands come from the DATA, not from a fixed scale: a CQI of 3 in a range where
 * the modem never exceeded 4 is the top of what happened, and pinning the bands
 * to 0–15 would draw five rows of nothing around one bar. `null` samples are
 * excluded rather than counted as zero — they are buckets the poller did not
 * measure, and counting them would invent a spike at the bottom of the scale.
 */
function distribution(points: DetailedMetricSeriesPoint[]): Band[] {
  const values: number[] = [];
  for (const point of points) {
    if (point.v !== null) values.push(point.v);
  }
  if (values.length === 0) return [];

  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }

  // A constant series has no width to divide, so it is one band holding every
  // sample. Drawing five empty bands beside one full one would read as a
  // distribution when the fact is that nothing varied.
  if (min === max) return [{ from: min, to: max, count: values.length }];

  const width = (max - min) / BUCKETS;
  const bands: Band[] = Array.from({ length: BUCKETS }, (_, i) => ({
    from: min + width * i,
    to: i === BUCKETS - 1 ? max : min + width * (i + 1),
    count: 0,
  }));
  for (const value of values) {
    const index = Math.min(BUCKETS - 1, Math.floor((value - min) / width));
    bands[index].count += 1;
  }
  return bands;
}

export interface DistributionsCardProps {
  series: DetailedMetricsSuccess["series"];
  missing: DetailedMetricPanel[];
  /** False for `range=now`, whose response carries no series by contract. */
  hasArchive: boolean;
  range: DetailedMetricRange;
  stale: boolean;
}

export function DistributionsCard({
  series,
  missing,
  hasArchive,
  range,
  stale,
}: DistributionsCardProps) {
  const { t } = useTranslation("cellular");
  const [chosen, setChosen] = useState<DetailedMetricPanel>("rsrp");

  const available = DETAILED_METRIC_PANELS.filter((panel) => !missing.includes(panel));
  // Derived, not stored: a range change can remove the selected panel, and an
  // effect that rewrote the state would render one frame of a dead selection.
  const panel = available.includes(chosen) ? chosen : available[0];
  const points = panel ? (series[panel] ?? []) : [];
  const bands = distribution(points);
  const bandsTotal = bands.reduce((sum, band) => sum + band.count, 0);
  const label = panel ? t(`detailed_metrics.panel.${panel}`) : "";
  const spec = panel ? PANEL_SPEC[panel] : null;

  let body: React.ReactNode;
  if (!hasArchive) {
    body = (
      <MetricEmptyState
        icon="stacked_line_chart"
        title={t("detailed_metrics.distributions.now_title")}
        body={t("detailed_metrics.distributions.now_body")}
      />
    );
  } else if (!panel) {
    body = (
      <MetricEmptyState
        icon="info"
        title={t("detailed_metrics.distributions.missing_title")}
        body={t("detailed_metrics.distributions.missing_body")}
      />
    );
  } else if (bands.length === 0) {
    body = (
      <MetricEmptyState
        icon="info"
        title={t("detailed_metrics.distributions.no_samples_title")}
        body={t("detailed_metrics.distributions.no_samples", { panel: label })}
      />
    );
  } else {
    body = (
      <>
        <TrendChart
          points={points}
          label={label}
          unit={spec?.unit}
          longSpan={LONG_SPANS.has(range)}
        />
        <div className={DISTRIBUTION.BUCKETS}>
          {bands.map((band) => (
            <div key={band.from} className={DISTRIBUTION.BUCKET_ROW}>
              <span className={DISTRIBUTION.BUCKET_LABEL}>
                {Math.round(band.from)}…{Math.round(band.to)}
                {spec?.unit ? ` ${spec.unit}` : ""}
              </span>
              <MetricBar
                value={bandsTotal === 0 ? 0 : (band.count / bandsTotal) * 100}
                max={100}
                warnAt={101}
                dangerAt={101}
              />
              <span className={DISTRIBUTION.BUCKET_COUNT}>{band.count}</span>
            </div>
          ))}
        </div>
        <p className={DISTRIBUTION.CAPTION}>
          {t("detailed_metrics.distributions.caption", { samples: bandsTotal })}
        </p>
      </>
    );
  }

  return (
    <GroupCard
      title={t("detailed_metrics.group.distributions.title")}
      description={t("detailed_metrics.group.distributions.description")}
      stale={stale}
      className="@3xl/main:col-span-2"
    >
      {hasArchive && available.length > 0 ? (
        <div className={DISTRIBUTION.TOOLBAR}>
          <span className={DISTRIBUTION.TOOLBAR_LABEL}>
            {t("detailed_metrics.distributions.panel_label")}
          </span>
          <Select
            value={panel}
            onValueChange={(next) => setChosen(next as DetailedMetricPanel)}
          >
            <SelectTrigger
              className={DISTRIBUTION.SELECT}
              aria-label={t("detailed_metrics.distributions.panel_label")}
            >
              <SelectValue>{label}</SelectValue>
            </SelectTrigger>
            <SelectContent className="rounded-tile">
              {DETAILED_METRIC_PANELS.map((option) => (
                <SelectItem
                  key={option}
                  value={option}
                  disabled={missing.includes(option)}
                >
                  {t(`detailed_metrics.panel.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {spec ? <MetricHint metric={spec.metric} label={label} /> : null}
        </div>
      ) : null}
      {body}
    </GroupCard>
  );
}

export default DistributionsCard;
