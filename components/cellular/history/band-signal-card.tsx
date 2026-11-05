"use client";

import dynamic from "next/dynamic";
import { useTranslation } from "react-i18next";

import type { CellHistoryPoint } from "@/types/cell-history";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  RSRP_THRESHOLDS,
  getSignalQuality,
  type SignalQuality,
} from "@/types/modem-status";

import { yDomain } from "./derive";
import { CARD, CHART, CHART_BOX, FULL, HEAD, LEGEND } from "./shapes";

// =============================================================================
// BandSignalCard — one RSRP line per band, not one per serving cell
// =============================================================================
// The owner asked for "multiple bars for each rsrp of bands": the Radio signal
// charts plot the SERVING cell, so an aggregated carrier (an SCC on its own band)
// is invisible there. This card plots every carrier the radio reported, one line
// per band token, from the archive's `cc_sig` column (schema v4).
//
// WHY LINES AND NOT BARS. The x axis is time, so a "bar per band" would be a bar
// per (time, band) pair — grouped bars on a 24 h axis with 96 buckets and two
// bands means 192 bars in a 300px box, which is a smear. A line per band carries
// the same information and keeps the shape readable. The bar idiom belongs to a
// *snapshot* (what is each band at right now), and the Cellular Information page
// already draws that.
//
// COLOUR IS QUALITY, NOT IDENTITY, and it is the same five-stop ramp the rest of
// the product uses (`getSignalQuality` + `qualityInkClass`), evaluated per band
// over the band's OWN samples — never the page's aggregate. Two channels carry
// it, per DESIGN.md: the stroke takes the ramp tone of the band's median, and
// every point gets a dot in the ramp tone of ITS OWN value, so a band that
// improved over the window is visibly two colours rather than one average. The
// legend names each band with its quality word, because colour alone is not an
// accessible channel.
//
// A band with no reading in a bucket keeps a `null`, so `connectNulls={false}`
// breaks the line instead of drawing through a hole — the same rule as every
// other chart on this page.
// =============================================================================

const TrendChart = dynamic(() => import("./trend-chart"), {
  ssr: false,
  loading: () => <Skeleton className={cn(CHART_BOX, "rounded-tile")} />,
});

/** The ramp's stroke tones, in quality order. Same tokens as the meters. */
const QUALITY_TONE: Record<SignalQuality, string> = {
  excellent: "var(--quality-5-bar)",
  good: "var(--quality-4-bar)",
  fair: "var(--quality-3-bar)",
  poor: "var(--quality-2-bar)",
  bad: "var(--quality-1-bar)",
  none: "var(--on-surface-variant)",
};

const QUALITY_LABEL: Record<SignalQuality, string> = {
  excellent: "excellent",
  good: "good",
  fair: "fair",
  poor: "poor",
  bad: "bad",
  none: "none",
};

/** Median of the band's readings — the figure the stroke is tinted by. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function BandSignalCard({
  bandSeries,
  longSpan,
}: {
  bandSeries: Record<string, CellHistoryPoint[]>;
  longSpan: boolean;
}) {
  const { t } = useTranslation("cellular");

  const bands = Object.entries(bandSeries)
    .map(([band, points]) => {
      const values = points
        .map((point) => point.v)
        .filter((v): v is number => v !== null);
      const mid = median(values);
      const quality = getSignalQuality(mid, RSRP_THRESHOLDS);
      return { band, points, mid, quality, samples: values.length };
    })
    .filter((entry) => entry.samples > 0)
    // Weakest band first: the band that needs aiming is the one to read first.
    .sort((a, b) => (a.mid ?? 0) - (b.mid ?? 0));

  return (
    <section className={cn(CARD, FULL)}>
      <header className={HEAD.ROOT}>
        <h2 className={HEAD.TITLE}>{t("history.charts.band_signal_title")}</h2>
        <p className={HEAD.DESC}>{t("history.charts.band_signal_note")}</p>
      </header>

      {bands.length === 0 ? (
        <p className={cn(CHART_BOX, CHART.EMPTY)}>
          {t("history.charts.band_signal_none")}
        </p>
      ) : (
        <>
          <ul className={LEGEND.ITEMS} aria-label={t("history.legend.series")}>
            {bands.map((entry) => (
              <li key={entry.band} className={LEGEND.ITEM}>
                <span
                  className={LEGEND.LINE}
                  style={{ backgroundColor: QUALITY_TONE[entry.quality] }}
                  aria-hidden="true"
                />
                {entry.band}
                {" · "}
                {entry.mid !== null ? `${Math.round(entry.mid)} dBm` : "—"}
                {" · "}
                {t(`history.charts.quality.${QUALITY_LABEL[entry.quality]}`)}
              </li>
            ))}
          </ul>

          <div className={CHART.GRID}>
            {bands.map((entry) => (
              <div key={entry.band} className={CHART.ROOT}>
                <h3 className={CHART.TITLE}>
                  {entry.band}
                  <span className={CHART.UNIT}>{t("history.charts.metric.rsrp")}</span>
                </h3>
                <TrendChart
                  points={entry.points}
                  label={entry.band}
                  unit="dBm"
                  color={QUALITY_TONE[entry.quality]}
                  domain={yDomain("rsrp", entry.points)}
                  longSpan={longSpan}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export default BandSignalCard;
