"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  CellEventGroup,
  CellHistoryCoverage,
  CellStat,
} from "@/types/cell-history";
import { cn } from "@/lib/utils";

import {
  cellDownPct,
  changeValue,
  formatMoment,
  formatPct,
  formatSpan,
  problemCells,
} from "./derive";
import { PanelEmpty } from "./empty-state";
import { CARD, CHANGE, HEAD, TABLE } from "./shapes";

// =============================================================================
// EventsCard — time on each cell, and every change the archive recorded
// =============================================================================
// Two halves, in the order a reader needs them:
//
//   ROLLUP   one row per serving cell: how long it served, and how often 5G was
//            available while it did. This is the measurement, not a verdict —
//            the page never scores a cell.
//   CHANGES  the chronological `cells.events` list behind a disclosure, with
//            every field's before → after. Collapsed by default because a busy
//            range produces dozens of groups and the rollup already answers
//            "which cell".
//
// A PROBLEM CELL IS NAMED IN PROSE ABOVE, and the floor is greenpacket's:
// at least three determined samples AND at least 80 % of them down. Without the
// floor, a handover that brushed one unrecorded sample brands a cell as broken
// on no evidence — the exact opinion the spec put out of scope.
//
// `5G available` is drawn from `nr_known`, never from `samples`: a cell camped
// on while the modem was silent has no availability figure at all, and the em
// dash says so where a 0 % would read as "5G was down there".
// =============================================================================

export interface EventsCardProps {
  stats: CellStat[];
  events: CellEventGroup[];
  coverage: CellHistoryCoverage;
}

const DASH = "—";

/** `PCI 342 · B3` — the identity as an operator reads it, PCI first. */
function cellLabel(stat: CellStat, fallbackPci: string): string {
  const pci = stat.lte_pci ? `PCI ${stat.lte_pci}` : fallbackPci;
  const band = stat.lte_band ?? "—";
  return `${pci} · ${band}`;
}

export function EventsCard({ stats, events, coverage }: EventsCardProps) {
  const { t } = useTranslation("cellular");
  const [open, setOpen] = useState(false);

  // Newest first on the wire; the list reads as a chronicle, so it is oldest
  // first here.
  const chronological = [...events].sort((a, b) => a.ts - b.ts);
  const problems = problemCells(stats);
  const noIdentity = coverage.cell_from === null && stats.length === 0;

  const flagText = (flag: "up" | "down" | "unknown") =>
    t(`history.events.value_${flag}`);

  return (
    <section className={CARD}>
      <header className={HEAD.ROOT}>
        <h2 className={HEAD.TITLE}>{t("history.events.title")}</h2>
        <p className={HEAD.DESC}>{t("history.events.description")}</p>
      </header>

      {noIdentity ? (
        <PanelEmpty icon="info" body={t("history.events.no_identity")} />
      ) : (
        <>
          {problems.length > 0 ? (
            <div className={TABLE.PROSE_BLOCK}>
              {problems.map((stat) => (
                <p key={stat.key} className={TABLE.PROSE}>
                  {t("history.events.problem", {
                    cell: cellLabel(stat, t("history.timeline.no_pci")),
                    pct: formatPct(cellDownPct(stat) ?? 0),
                    count: stat.nr_known,
                  })}
                </p>
              ))}
            </div>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={TABLE.HEAD}>
                  {t("history.events.rollup_cell")}
                </TableHead>
                <TableHead className={TABLE.HEAD}>
                  {t("history.events.rollup_cellid")}
                </TableHead>
                <TableHead className={`${TABLE.HEAD} text-right`}>
                  {t("history.events.rollup_time")}
                </TableHead>
                <TableHead className={`${TABLE.HEAD} text-right`}>
                  {t("history.events.rollup_availability")}
                </TableHead>
                <TableHead className={`${TABLE.HEAD} text-right`}>
                  {t("history.events.rollup_last")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.map((stat) => {
                const down = cellDownPct(stat);
                const available = down === null ? null : 100 - down;
                const isProblem = problems.some((p) => p.key === stat.key);
                return (
                  <TableRow
                    key={stat.key}
                    className={cn(isProblem && TABLE.PROBLEM_ROW)}
                  >
                    <TableCell className={TABLE.CELL}>
                      {cellLabel(stat, t("history.timeline.no_pci"))}
                    </TableCell>
                    <TableCell className={TABLE.CELL_MUTED}>
                      {stat.lte_cellid ?? DASH}
                    </TableCell>
                    {/* One archive row a minute, so the sample count IS the
                        time on the cell. Stated here rather than hidden in a
                        helper: it is the one assumption in this table. */}
                    <TableCell className={`${TABLE.CELL} text-right`}>
                      {formatSpan(stat.samples * 60)}
                    </TableCell>
                    <TableCell className={`${TABLE.CELL} text-right`}>
                      {available === null ? DASH : formatPct(available)}
                    </TableCell>
                    <TableCell className={`${TABLE.CELL_MUTED} text-right`}>
                      {formatMoment(stat.last_ts)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={CHANGE.TRIGGER}
              >
                <MaterialSymbol
                  name="expand_more"
                  size={16}
                  className={cn(
                    "transition-transform duration-[var(--duration-quick)] ease-out motion-reduce:transition-none",
                    open && "rotate-180",
                  )}
                />
                {open
                  ? t("history.events.hide_all")
                  : t("history.events.show_all", { count: chronological.length })}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {chronological.length === 0 ? (
                <PanelEmpty
                  icon="swap_horiz"
                  body={t("history.events.empty")}
                  className={CHANGE.BODY}
                />
              ) : (
                <ul className={cn(CHANGE.LIST, CHANGE.BODY)}>
                  {chronological.map((group) => (
                    <li key={group.ts} className={CHANGE.ROW}>
                      <span className={CHANGE.MOMENT}>
                        {formatMoment(group.ts)}
                      </span>
                      <span className={CHANGE.FIELDS}>
                        {group.changes.map((change) => {
                          const from = changeValue(change.field, change.from);
                          const to = changeValue(change.field, change.to);
                          return (
                            <span
                              key={`${group.ts}-${change.field}`}
                              className={CHANGE.FIELD}
                            >
                              <span className={CHANGE.LABEL}>
                                {t(`history.events.field.${change.field}`)}
                              </span>
                              <span className={CHANGE.FROM}>
                                {from.kind === "flag"
                                  ? flagText(from.flag)
                                  : from.text}
                              </span>
                              <MaterialSymbol
                                name="chevron_right"
                                size={12}
                                className={CHANGE.ARROW}
                              />
                              <span className={CHANGE.TO}>
                                {to.kind === "flag" ? flagText(to.flag) : to.text}
                              </span>
                            </span>
                          );
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </section>
  );
}

export default EventsCard;
