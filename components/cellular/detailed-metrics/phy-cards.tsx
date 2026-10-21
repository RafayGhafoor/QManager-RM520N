"use client";

import { useTranslation } from "react-i18next";

import type { LtePhyMetrics, NrPhyMetrics } from "@/types/detailed-metrics";
import {
  RSRP_THRESHOLDS,
  RSRQ_THRESHOLDS,
  SINR_THRESHOLDS,
} from "@/types/modem-status";

import { GroupCard } from "./group-card";
import { MetricFigure, UnavailableMetricRow } from "./metric-figure";
import { METRIC_GRID } from "./shapes";

// =============================================================================
// The two PHY groups
// =============================================================================
// One card per radio, not one card split by metric, because every figure in a
// card is read against the same radio: a CQI of 9 means nothing until you know
// which leg produced it. The grouping is also what lets each card carry its own
// staleness chip.
//
// Only four figures are GRADED (RSRP, RSRQ, SINR — and RSSI on the LTE leg):
// those are the metrics this repo has vetted scales for
// (`types/modem-status.ts` > METRIC_RANGES, 3GPP reporting ranges). CQI, RI,
// MCS, PMI, layer counts and TM modes are INDEXES. They get a numeral and no
// bar, because inventing a scale for them would be inventing the answer to
// "is 9 good" — and the honest answer is that it depends on the MCS table the
// network scheduled.
//
// `null` is a dash everywhere. The backend already refuses to publish 0 for an
// absent field, so a 0 that arrives here is a real 0 and is rendered as one.
// =============================================================================

export interface LtePhyCardProps {
  lte: LtePhyMetrics;
  stale: boolean;
}

export function LtePhyCard({ lte, stale }: LtePhyCardProps) {
  const { t } = useTranslation("cellular");
  const m = (key: string) => t(`detailed_metrics.metric.${key}`);

  return (
    <GroupCard
      title={t("detailed_metrics.group.lte.title")}
      description={t("detailed_metrics.group.lte.description")}
      stale={stale}
    >
      <div className={METRIC_GRID}>
        <MetricFigure
          metric="lte.rsrp"
          label={t("radio_info.bands.metric.rsrp")}
          value={lte.rsrp}
          unit="dBm"
          scale={RSRP_THRESHOLDS}
          index={0}
        />
        <MetricFigure
          metric="lte.rsrq"
          label={t("radio_info.bands.metric.rsrq")}
          value={lte.rsrq}
          unit="dB"
          scale={RSRQ_THRESHOLDS}
          index={1}
        />
        <MetricFigure
          metric="lte.sinr"
          label={t("radio_info.bands.metric.sinr")}
          value={lte.sinr}
          unit="dB"
          scale={SINR_THRESHOLDS}
          index={2}
        />
        <MetricFigure
          metric="lte.rssi"
          label={t("radio_info.bands.metric.rssi")}
          value={lte.rssi}
          unit="dBm"
          index={3}
        />
        <MetricFigure metric="lte.cqi" label={m("cqi")} value={lte.cqi} />
        <MetricFigure metric="lte.ri" label={m("ri")} value={lte.ri} />
        <MetricFigure metric="lte.pmi" label={m("pmi")} value={lte.pmi} />
        <MetricFigure
          metric="lte.mimo_layers"
          label={m("mimo_layers")}
          value={lte.mimo_layers}
        />
        <MetricFigure metric="lte.tm_mode" label={m("tm_mode")} value={lte.tm_mode} />
        <MetricFigure metric="lte.ul_mcs" label={m("ul_mcs")} value={lte.ul_mcs} />
        <UnavailableMetricRow metric="lte.tx_power" label={m("tx_power")} />
      </div>
    </GroupCard>
  );
}

export interface NrPhyCardProps {
  nr: NrPhyMetrics;
  stale: boolean;
}

export function NrPhyCard({ nr, stale }: NrPhyCardProps) {
  const { t } = useTranslation("cellular");
  const m = (key: string) => t(`detailed_metrics.metric.${key}`);

  return (
    <GroupCard
      title={t("detailed_metrics.group.nr.title")}
      description={t("detailed_metrics.group.nr.description")}
      stale={stale}
    >
      <div className={METRIC_GRID}>
        <MetricFigure
          metric="nr.rsrp"
          label={t("radio_info.bands.metric.rsrp")}
          value={nr.rsrp}
          unit="dBm"
          scale={RSRP_THRESHOLDS}
          index={0}
        />
        <MetricFigure
          metric="nr.rsrq"
          label={t("radio_info.bands.metric.rsrq")}
          value={nr.rsrq}
          unit="dB"
          scale={RSRQ_THRESHOLDS}
          index={1}
        />
        {/* 3GPP calls the NR-side calculation SNR, and this label says so:
            relabelling it SINR would name a measurement the radio is not making
            (the same call `radio_info.bands.metric.snr` records). */}
        <MetricFigure
          metric="nr.sinr"
          label={t("radio_info.bands.metric.snr")}
          value={nr.sinr}
          unit="dB"
          scale={SINR_THRESHOLDS}
          index={2}
        />
        <MetricFigure metric="nr.cqi" label={m("cqi")} value={nr.cqi} />
        <MetricFigure metric="nr.ri" label={m("ri")} value={nr.ri} />
        <MetricFigure metric="nr.pmi" label={m("pmi")} value={nr.pmi} />
        <MetricFigure
          metric="nr.mimo_layers"
          label={m("mimo_layers")}
          value={nr.mimo_layers}
        />
        <MetricFigure metric="nr.dl_mcs" label={m("dl_mcs")} value={nr.dl_mcs} />
        <MetricFigure metric="nr.ul_mcs" label={m("ul_mcs")} value={nr.ul_mcs} />
        <MetricFigure
          metric="nr.tx_power"
          label={m("tx_power")}
          value={nr.tx_power}
          unit="dBm"
        />
        <UnavailableMetricRow metric="nr.pathloss" label={m("pathloss")} />
      </div>
    </GroupCard>
  );
}
