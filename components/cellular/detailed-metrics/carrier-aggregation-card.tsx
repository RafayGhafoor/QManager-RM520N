"use client";

import { useTranslation } from "react-i18next";

import { Tag } from "@/components/ui/tag";
import type { NetworkStatus } from "@/types/modem-status";

import { GroupCard } from "./group-card";
import { AbsentFigure, MetricFigure, MetricHint } from "./metric-figure";
import { CARRIER_LIST, METRIC_GRID } from "./shapes";

// =============================================================================
// Carrier Aggregation — how many carriers the network is aggregating
// =============================================================================
// The only group on this page read from the poller's snapshot rather than the
// PHY block: `AT+QCAINFO` already produces the carrier list, and a second read
// of the same fact would be a second source that can disagree with the Radio
// Information page.
//
// A count of 0 is a STATEMENT, not an absence — "no carriers are aggregated
// right now" is something the radio positively reported, and it is the normal
// answer while idle or between handovers. That is why the counter is rendered
// as-is and only a missing snapshot becomes a dash.
// =============================================================================

export interface CarrierAggregationCardProps {
  /** `null` until the poller snapshot lands; the card then shows dashes. */
  network: NetworkStatus | null;
  stale: boolean;
}

export function CarrierAggregationCard({
  network,
  stale,
}: CarrierAggregationCardProps) {
  const { t } = useTranslation("cellular");
  const components = network?.carrier_components ?? [];
  const label = t("detailed_metrics.metric.carrier_components");

  return (
    <GroupCard
      title={t("detailed_metrics.group.ca.title")}
      description={t("detailed_metrics.group.ca.description")}
      stale={stale}
    >
      <div className={METRIC_GRID}>
        <MetricFigure
          metric="ca.lte_carriers"
          label={t("detailed_metrics.metric.lte_carriers")}
          value={network ? network.ca_count : null}
        />
        <MetricFigure
          metric="ca.nr_carriers"
          label={t("detailed_metrics.metric.nr_carriers")}
          value={network ? network.nr_ca_count : null}
        />
        <MetricFigure
          metric="ca.total_bandwidth"
          label={t("detailed_metrics.metric.total_bandwidth")}
          value={network ? network.total_bandwidth_mhz : null}
          unit="MHz"
        />
      </div>

      <div className={CARRIER_LIST.ROOT}>
        <div className={CARRIER_LIST.HEAD}>
          {label}
          <MetricHint metric="ca.component" label={label} />
        </div>
        {components.length === 0 ? (
          <span className={CARRIER_LIST.NOTE}>
            {network
              ? t("detailed_metrics.ca.no_carriers")
              : t("radio_info.common.value_unavailable")}
          </span>
        ) : (
          components.map((component, i) => (
            <div
              key={`${component.technology}-${component.band}-${i}`}
              className={CARRIER_LIST.ROW}
            >
              <Tag variant={component.technology === "NR" ? "nr" : "lte"}>
                {component.band}
              </Tag>
              <span className={CARRIER_LIST.ROLE}>{component.type}</span>
              <span className={CARRIER_LIST.FIGURE}>
                {component.bandwidth_mhz} MHz
              </span>
              <span className={CARRIER_LIST.FIGURE}>
                {component.rsrp === null ? (
                  <AbsentFigure />
                ) : (
                  <>
                    {component.rsrp}
                    <span className={CARRIER_LIST.ROLE}> dBm</span>
                  </>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </GroupCard>
  );
}

export default CarrierAggregationCard;
