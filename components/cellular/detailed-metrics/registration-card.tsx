"use client";

import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import { Tag, type TagVariant } from "@/components/ui/tag";
import type { RrcStateSnapshot } from "@/types/detailed-metrics";

import { GroupCard } from "./group-card";
import { AbsentFigure, MetricRow } from "./metric-figure";
import { METRIC_GRID } from "./shapes";

// =============================================================================
// Registration — who the modem is attached to
// =============================================================================
// These four facts are deliberately the FIRST group, before any PHY figure.
// The radio reports signal for whatever cell it can HEAR, attachment or not —
// observed live on this hardware with the modem detached and still reporting a
// plausible 5G reading (`docs/reference/qmi-transport.md` > "The trap: signal is
// not attachment"). A page of strong numbers beside a `Not registered` badge is
// information; the numbers alone are the reading that sends an operator to the
// wrong tower.
// =============================================================================

/** RAT identity, as an outline tag. Identity, never a verdict. */
const RAT_TAG: Record<string, TagVariant> = {
  NR: "nr",
  LTE: "lte",
};

export interface RegistrationCardProps {
  carrier: string | null;
  rrc: RrcStateSnapshot;
  /** `null` = the poller has not read the attach state yet. Not "detached". */
  registered: boolean | null;
  stale: boolean;
}

export function RegistrationCard({
  carrier,
  rrc,
  registered,
  stale,
}: RegistrationCardProps) {
  const { t } = useTranslation("cellular");
  const rat = rrc.rat;
  const tagVariant = rat ? RAT_TAG[rat.toUpperCase()] ?? "neutral" : "neutral";

  return (
    <GroupCard
      title={t("detailed_metrics.group.registration.title")}
      description={t("detailed_metrics.group.registration.description")}
      stale={stale}
    >
      <div className={METRIC_GRID}>
        <MetricRow metric="registered" label={t("detailed_metrics.metric.registered")}>
          {registered === null ? (
            <AbsentFigure />
          ) : registered ? (
            <Badge variant="success">
              <MaterialSymbol name="check_circle" size={12} />
              {t("detailed_metrics.registered_yes")}
            </Badge>
          ) : (
            <Badge variant="warning">
              <MaterialSymbol name="signal_disconnected" size={12} />
              {t("detailed_metrics.registered_no")}
            </Badge>
          )}
        </MetricRow>

        <MetricRow metric="carrier" label={t("detailed_metrics.metric.carrier")}>
          {carrier ? (
            <span className="max-w-[14ch] truncate">{carrier}</span>
          ) : (
            <AbsentFigure />
          )}
        </MetricRow>

        <MetricRow metric="rrc.rat" label={t("detailed_metrics.metric.rat")}>
          {rat ? (
            <Tag variant={tagVariant}>{rat}</Tag>
          ) : (
            <AbsentFigure />
          )}
        </MetricRow>

        <MetricRow
          metric="rrc.state"
          label={t("detailed_metrics.metric.rrc_state")}
        >
          {rrc.state === null ? (
            <AbsentFigure />
          ) : (
            rrc.state
          )}
        </MetricRow>
      </div>
    </GroupCard>
  );
}

export default RegistrationCard;
