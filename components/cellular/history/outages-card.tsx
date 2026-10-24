"use client";

import { useTranslation } from "react-i18next";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CellRun, NrOutage } from "@/types/cell-history";

import {
  formatMoment,
  formatSpan,
  outageRows,
  totalOutageSeconds,
} from "./derive";
import { PanelEmpty } from "./empty-state";
import { CARD, HEAD, STRIP, TABLE } from "./shapes";

// =============================================================================
// OutagesCard — every stretch 5G was down, with the cell that was serving
// =============================================================================
// The table the hero strip summarises: one row per contiguous `nr_avail === 0`
// span, newest first, each carrying the identity that was serving when the span
// began.
//
// THE SERVING CELL IS READ OFF THE GANTT, NOT GUESSED. `cells.timeline` is cut
// at every band/PCI change and at the same three-minute gap threshold the
// outages are cut at, so "the run containing this instant" is what the modem
// reported. When no run covers it, the row says `unknown_serving` rather than
// printing the nearest cell and implying a fact about a minute nobody recorded.
//
// Durations are wall-clock seconds of the SPAN, while `samples` is how many
// rows were observed inside it. They answer different questions — a 40-minute
// span with 3 samples is a mostly-unrecorded outage, not a 3-minute one — and
// the two columns are deliberately side by side so that stays visible.
// =============================================================================

export interface OutagesCardProps {
  outages: NrOutage[];
  runs: CellRun[];
}

export function OutagesCard({ outages, runs }: OutagesCardProps) {
  const { t } = useTranslation("cellular");
  const rows = outageRows(outages, runs);

  const serving = (row: (typeof rows)[number]): string => {
    if (row.uncovered) return t("history.outages.unknown_serving");
    const pci = row.ltePci ? `PCI ${row.ltePci}` : t("history.timeline.no_pci");
    const band = row.lteBand ?? t("history.timeline.band_not_reported");
    return `${pci} · ${band}`;
  };

  return (
    <section className={CARD}>
      <header className={HEAD.ROOT}>
        <h2 className={HEAD.TITLE}>{t("history.outages.title")}</h2>
        <p className={HEAD.DESC}>{t("history.outages.description")}</p>
      </header>

      {rows.length === 0 ? (
        <PanelEmpty icon="check_circle" body={t("history.outages.empty")} />
      ) : (
        <>
          <p className={STRIP.SUB}>
            <span>
              {t("history.availability.downtime", {
                duration: formatSpan(totalOutageSeconds(outages)),
              })}
            </span>
            <span>
              {t("history.availability.outage_count", { count: rows.length })}
            </span>
          </p>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={TABLE.HEAD}>
                  {t("history.outages.col_start")}
                </TableHead>
                <TableHead className={TABLE.HEAD}>
                  {t("history.outages.col_duration")}
                </TableHead>
                <TableHead className={TABLE.HEAD}>
                  {t("history.outages.col_serving")}
                </TableHead>
                <TableHead className={`${TABLE.HEAD} text-right`}>
                  {t("history.outages.col_samples")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className={TABLE.CELL}>
                    {formatMoment(row.startTs)}
                  </TableCell>
                  <TableCell className={TABLE.CELL}>
                    {formatSpan(row.seconds)}
                  </TableCell>
                  <TableCell className={TABLE.CELL_MUTED}>
                    {serving(row)}
                  </TableCell>
                  <TableCell className={`${TABLE.CELL} text-right`}>
                    {row.samples}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </section>
  );
}

export default OutagesCard;
