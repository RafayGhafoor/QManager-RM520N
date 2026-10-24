"use client";

import { useTranslation } from "react-i18next";

import type { CellHistoryCoverage, ServingCellIdentity } from "@/types/cell-history";
import { cn } from "@/lib/utils";

import { formatMoment } from "./derive";
import { PanelEmpty } from "./empty-state";
import { CARD, HEAD, IDENTITY } from "./shapes";

// =============================================================================
// IdentityCard — the newest serving cell in the range, as an identity grid
// =============================================================================
// Not a live card: it is the newest SAMPLE in the selected range, which is why
// it says "as of" with a timestamp rather than presenting itself as current.
// The dashboard is the live surface (`docs/reference/latency-monitor.md:74`).
//
// A NULL IS AN EM DASH AND A WORD. This modem reports no NR identity at all
// while the NR leg is inactive, so on a live box the four NR rows are the
// normal state, not an error — each one prints the dash and the screen-reader
// word for "not reported" instead of a 0 or a blank, because "0 MHz" is a
// bandwidth and "no PCI" is a fact about the modem.
//
// `nr_avail` is three-valued and is drawn as a word: up / down / unknown. A
// dash there would be the same mark as a missing PCI, and the two are opposite
// claims — "nobody looked" versus "there is no NR leg".
// =============================================================================

export interface IdentityCardProps {
  cell: ServingCellIdentity;
  asOf: number | null;
  coverage: CellHistoryCoverage;
}

interface IdentityRow {
  key: string;
  label: string;
  value: string | null;
}

const DASH = "—";

export function IdentityCard({ cell, asOf, coverage }: IdentityCardProps) {
  const { t } = useTranslation("cellular");

  const band = (value: string | null) =>
    value && value.trim() !== "" ? value : null;
  const number = (value: number | null) => (value === null ? null : String(value));
  const bw = (value: number | null) => (value === null ? null : `${value} MHz`);

  const registered =
    cell.registered === null
      ? null
      : t(
          cell.registered
            ? "detailed_metrics.registered_yes"
            : "detailed_metrics.registered_no",
        );

  const nrAvail =
    cell.nr_avail === null
      ? t("history.events.value_unknown")
      : cell.nr_avail === 1
        ? t("history.events.value_up")
        : t("history.events.value_down");

  const rows: IdentityRow[] = [
    { key: "lte_pci", label: "history.identity.lte_pci", value: number(cell.lte_pci) },
    {
      key: "lte_earfcn",
      label: "history.identity.lte_earfcn",
      value: number(cell.lte_earfcn),
    },
    { key: "lte_band", label: "history.identity.lte_band", value: band(cell.lte_band) },
    { key: "lte_bw", label: "history.identity.lte_bw", value: bw(cell.lte_bw) },
    { key: "nr_pci", label: "history.identity.nr_pci", value: number(cell.nr_pci) },
    {
      key: "nr_arfcn",
      label: "history.identity.nr_arfcn",
      value: number(cell.nr_arfcn),
    },
    { key: "nr_band", label: "history.identity.nr_band", value: band(cell.nr_band) },
    { key: "nr_bw", label: "history.identity.nr_bw", value: bw(cell.nr_bw) },
    {
      key: "cellid",
      label: "history.identity.cellid",
      value: number(cell.lte_cellid ?? cell.nr_cellid),
    },
    {
      key: "tac",
      label: "history.identity.tac",
      value: number(cell.lte_tac ?? cell.nr_tac),
    },
    {
      key: "network_type",
      label: "history.identity.network_type",
      value: cell.network_type,
    },
    { key: "registered", label: "history.identity.registered", value: registered },
    { key: "nr_avail", label: "history.identity.nr_avail", value: nrAvail },
  ];

  // Read off the RAW fields, never off the rendered rows: `nr_avail` and
  // `registered` always resolve to a word, so a rows-based test would call a
  // snapshot with no identity at all "present" and print a grid of dashes.
  const hasIdentity =
    coverage.cell_from !== null ||
    cell.lte_pci !== null ||
    cell.nr_pci !== null ||
    cell.lte_cellid !== null ||
    cell.nr_cellid !== null ||
    cell.lte_band !== null ||
    cell.nr_band !== null;

  return (
    <section className={CARD}>
      <header className={HEAD.ROOT}>
        <h2 className={HEAD.TITLE}>{t("history.identity.title")}</h2>
        {asOf !== null ? (
          <p className={IDENTITY.AS_OF}>
            {t("history.identity.as_of", { time: formatMoment(asOf) })}
          </p>
        ) : null}
      </header>

      {hasIdentity ? (
        <dl className={IDENTITY.GRID}>
          {rows.map((row) => (
            <div key={row.key} className={IDENTITY.ROW}>
              <dt className={IDENTITY.LABEL}>{t(row.label)}</dt>
              <dd
                className={cn(
                  row.value === null ? IDENTITY.ABSENT : IDENTITY.VALUE,
                )}
              >
                {row.value === null ? DASH : row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <PanelEmpty icon="info" body={t("history.identity.empty")} />
      )}
    </section>
  );
}

export default IdentityCard;
