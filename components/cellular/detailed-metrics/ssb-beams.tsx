"use client";

import { useTranslation } from "react-i18next";

import type { SsbBeam } from "@/types/detailed-metrics";

import { MetricEmptyState } from "./empty-state";
import { GroupCard } from "./group-card";
import { MetricHint } from "./metric-figure";
import { BEAMS, METRIC_ROW } from "./shapes";

// =============================================================================
// SsbBeams — the beam table
// =============================================================================
// `AT+QNWCFG="ssb_beam_id"` is the only working NR-neighbour source on this
// module, and each row is one SSB beam the serving cell is transmitting. Its
// parse contract is easy to get wrong in a way that is invisible on screen: the
// response puts the beam COUNT in the field before the first beam id, so a
// reader that shifts by one prints "6" as the strongest beam. Nothing about a
// number 6 in a beam column looks wrong — which is why the backend is the one
// that parses and this file only renders what it is given.
//
// An empty list is `[]`, never `null`, so "the modem detected no beams" can be
// stated as exactly that rather than as an unavailable field.
// =============================================================================

export interface SsbBeamsCardProps {
  beams: SsbBeam[];
  stale: boolean;
}

/** A figure as reported, or the em dash for one that was not. */
function figureText(value: number | null): string {
  return value === null ? "—" : String(value);
}

export function SsbBeamsCard({ beams, stale }: SsbBeamsCardProps) {
  const { t } = useTranslation("cellular");

  const columns = [
    { metric: "beams.beam", label: t("detailed_metrics.metric.beam") },
    { metric: "beams.rsrp", label: t("radio_info.bands.metric.rsrp") },
    { metric: "beams.rsrq", label: t("radio_info.bands.metric.rsrq") },
    { metric: "beams.pci", label: t("radio_info.bands.detail.pci") },
  ] as const;

  return (
    <GroupCard
      title={t("detailed_metrics.group.beams.title")}
      description={t("detailed_metrics.group.beams.description")}
      stale={stale}
      className="@3xl/main:col-span-2"
    >
      {beams.length === 0 ? (
        <MetricEmptyState
          icon="radar"
          title={t("detailed_metrics.beams.empty_title")}
          body={t("detailed_metrics.beams.empty_body")}
        />
      ) : (
        <table className={BEAMS.TABLE}>
          <caption className={BEAMS.CAPTION}>
            {t("detailed_metrics.group.beams.title")}
          </caption>
          <thead>
            <tr>
              {columns.map((column, i) => (
                <th
                  key={column.metric}
                  scope="col"
                  // The first column is the beam's own identity; the rest are
                  // measurements, which are right-aligned over their figures.
                  className={`${BEAMS.HEAD_CELL} ${
                    i === 0 ? "text-left" : "text-right"
                  }`}
                >
                  <span
                    className={`${BEAMS.HEAD_WRAP} ${
                      i === 0 ? "justify-start" : "justify-end"
                    }`}
                  >
                    {column.label}
                    <MetricHint metric={column.metric} label={column.label} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {beams.map((beam, rowIndex) => (
              <tr
                key={`${beam.pci ?? "no-pci"}-${beam.beam ?? rowIndex}`}
                className={BEAMS.ROW}
              >
                <td className={BEAMS.CELL}>{figureText(beam.beam)}</td>
                <td className={`${BEAMS.CELL} text-right`}>
                  {figureText(beam.rsrp)}
                  <span className={METRIC_ROW.UNIT}> dBm</span>
                </td>
                <td className={`${BEAMS.CELL} text-right`}>
                  {figureText(beam.rsrq)}
                  <span className={METRIC_ROW.UNIT}> dB</span>
                </td>
                <td className={`${BEAMS.LAST_CELL} text-right`}>
                  {figureText(beam.pci)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </GroupCard>
  );
}

export default SsbBeamsCard;
