"use client";

import * as React from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import {
  SegmentedField,
  type SegmentedOption,
} from "@/components/ui/segmented-field";
import { useNeighbourScanner } from "@/hooks/use-neighbour-scanner";
import { downloadCSV } from "@/lib/download-csv";
import { staggerItem } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { NeighbourCellResult, NeighbourRange } from "@/types/cell-scanner";

import LockCellDialog, { type LockCellTarget } from "../lock-cell-dialog";
import RunHero from "../run-hero";
import LedgerRows, { type LedgerRow } from "../run-summary";
import { ScanErrorState } from "../scan-states";
import { ScannerSkeleton } from "../scanner-skeleton";
import SiblingRouteLink from "../sibling-link";
import {
  EMPTY_PANEL,
  PILL_QUIET,
  SCAN_RESULTS_CARD,
  SECTION_HEAD,
  runPosture,
} from "../shapes";
import { summariseNeighbours } from "../summaries";
import AimStrip, { AimStripSkeleton } from "./aim-strip";
import NeighbourScanResultView, {
  CELL_TYPE_KEY,
  type NeighbourSampleContext,
} from "./neighbour-scan-result";

// =============================================================================
// Neighbour cells — the read and its results
// =============================================================================
// The sweep's launch bar, ledger and results card; no progress bar (a read takes
// seconds).
//
// TWO RANGES, ONE SURFACE (2026-10-22). "Last read" is this page as it was: the
// one-shot AT neighbour read and its rows. "Live" is the aiming view: the QMI
// neighbour sample the poller publishes while this tab holds a lease, with the
// camped cell's own readings above it. It is a RANGE and not a second route
// because an existing decision in this repo says so — a separate live surface
// that reports the same measurement in two places drifts, and was removed once
// already (`docs/reference/latency-monitor.md`: "No separate Live chart or status
// band"). So the range picker lives in whichever card is currently the anchor,
// in the same spot: the page does not change shape when the range does.
// =============================================================================

function buildCsvRows(results: NeighbourCellResult[]): string[] {
  return results.map((r) =>
    [
      r.networkType,
      r.cellType,
      r.frequency,
      r.pci,
      r.signalStrength,
      r.rsrq ?? "",
      r.rssi ?? "",
      r.sinr ?? "",
    ].join(","),
  );
}

const NEIGHBOUR_CSV_HEADER =
  "Network,Cell Type,Frequency,PCI,Signal (dBm),RSRQ,RSSI,SINR";

/** Posture -> its copy keys, as literals for `i18n:check`. */
const POSTURE_COPY = {
  idle: {
    title: "cell_scanner.neighbour.run.idle_title",
    body: "cell_scanner.neighbour.run.idle_body",
  },
  scanning: {
    title: "cell_scanner.neighbour.run.scanning_title",
    body: "cell_scanner.neighbour.run.scanning_body",
  },
  // No body on complete: the figure is the count.
  complete: { title: "cell_scanner.neighbour.run.complete_title" },
  failed: {
    title: "cell_scanner.neighbour.run.failed_title",
    body: "cell_scanner.neighbour.run.failed_body",
  },
} as const;

/** The full-sweep route, for the header cross-link. */
const SWEEP_ROUTE = "/cellular/cell-scanner";

/** The ledger's dBm figure, or `null` for the blank mark. */
function formatDbm(value: number | null): string | null {
  return value === null ? null : String(value);
}

export function NeighbourScanner() {
  const { t } = useTranslation("cellular");

  // `last` opens the page, because that is what this route has always shown and
  // a surface that starts sampling the modem before the reader asks for it is
  // the always-on sampler the spec rules out.
  const [range, setRange] = React.useState<NeighbourRange>("last");
  const {
    status,
    results,
    error,
    startScan,
    last,
    live,
    liveStop,
    liveFailed,
    pauseLive,
    resumeLive,
  } = useNeighbourScanner(range);

  const [lockTarget, setLockTarget] = React.useState<LockCellTarget | null>(
    null,
  );

  const isLive = range === "now";
  const paused = liveStop !== null;

  const posture = runPosture(status);
  const isScanning = posture === "scanning";

  /** The rows on screen: the live sample's, or the completed read's. */
  const rows = React.useMemo(
    () => (isLive ? (live?.cells ?? []) : results),
    [isLive, live, results],
  );

  const hasResults = posture === "complete" && results.length > 0;

  /** The results card follows the anchor: in `now` it waits for the first sample. */
  const showResultsCard = isLive ? live !== null : posture !== "idle";

  /**
   * What the columns need from the sample rather than from the row. Memoised by
   * its three facts, not by the sample object, so a live tick that changes
   * nothing the comparator sees does not rebuild every column definition.
   */
  const serving = isLive ? (live?.serving ?? null) : (last?.serving ?? null);
  const servingRsrp = serving?.rsrp ?? null;
  const ageS = isLive ? (live?.ageS ?? null) : (last?.ageS ?? null);
  const sample: NeighbourSampleContext = React.useMemo(
    () => ({ serving, servingRsrp, ageS }),
    [ageS, serving, servingRsrp],
  );

  const handleLockCell = React.useCallback((cell: NeighbourCellResult) => {
    // Always the LTE payload: a neighbour report carries no band or SCS for NR.
    setLockTarget({
      kind: "lte",
      networkType: cell.networkType,
      pci: cell.pci,
      earfcn: cell.frequency,
    });
  }, []);

  const handleDownload = React.useCallback(() => {
    downloadCSV(
      NEIGHBOUR_CSV_HEADER,
      buildCsvRows(rows),
      `neighbour_cells_${new Date().toISOString().slice(0, 10)}.csv`,
    );
  }, [rows]);

  const copy = POSTURE_COPY[posture];

  const summary = React.useMemo(() => summariseNeighbours(results), [results]);

  const ledgerRows = React.useMemo<LedgerRow[]>(
    () =>
      summary.groups.map((group) => ({
        id: group.type,
        name: t(CELL_TYPE_KEY[group.type]),
        cells: group.count,
        cellsUnit: t("cell_scanner.run.ledger.cells_unit", {
          count: group.count,
        }),
        bands: [],
        strength: group.best,
        dbmText: formatDbm(group.best),
      })),
    [summary, t],
  );

  const usesModemMessage = posture === "failed" && Boolean(error);
  const postureTitle = usesModemMessage && error ? error : t(copy.title);
  const postureBody = "body" in copy ? t(copy.body) : null;

  // Scanning or complete only: on failed, `results` may hold the previous read.
  const ledgerRowsNode =
    isScanning || posture === "complete" ? (
      <LedgerRows
        rows={ledgerRows}
        isLoading={isScanning}
        emptyText={t("cell_scanner.neighbour.run.summary_empty")}
        head={{
          carrier: t("cell_scanner.neighbour.columns.cell_type"),
          cells: t("cell_scanner.run.ledger.col_cells"),
          best: t("cell_scanner.run.ledger.col_best"),
        }}
        dbmUnit={t("cell_scanner.run.ledger.dbm_unit")}
      />
    ) : null;

  const rangeOptions = React.useMemo<SegmentedOption<NeighbourRange>[]>(
    () => [
      { value: "now", label: t("cell_scanner.neighbour.range.now") },
      { value: "last", label: t("cell_scanner.neighbour.range.last") },
    ],
    [t],
  );

  /**
   * The range picker, rendered in whichever card is the anchor.
   *
   * No glyph: the active pill's own fill marks the selection. Two range pickers
   * in this product already decided that (`docs/reference/latency-monitor.md`,
   * 2026-10-12), and a check mark would also shift the two labels apart every
   * time the selection moved.
   */
  const rangePicker = (
    <SegmentedField<NeighbourRange>
      value={range}
      onValueChange={setRange}
      options={rangeOptions}
      ariaLabel={t("cell_scanner.neighbour.range.label")}
      // Two short options always fit, so the Select fallback is never needed.
      breakpoint="never"
      glyph={() => null}
    />
  );

  /** Pause, and only in the live range: there is no lease to stop in `last`. */
  const pauseAction = isLive ? (
    <Button
      type="button"
      variant="tonal-neutral"
      className={PILL_QUIET}
      onClick={paused ? resumeLive : pauseLive}
    >
      {/* No glyph: the icon subset carries no `pause` or `stop` mark, and the
          nearest ones (`block`, `do_not_disturb_on`) mean "banned" and "no
          entry", which is the opposite of a control that starts again. The word
          is unambiguous, and it is what changes. */}
      {paused
        ? t("cell_scanner.neighbour.toolbar.resume")
        : t("cell_scanner.neighbour.toolbar.pause")}
    </Button>
  ) : null;

  const downloadAction = (
    <Button
      type="button"
      variant="tonal-neutral"
      className={cn(PILL_QUIET, "gap-1.5")}
      onClick={handleDownload}
      aria-label={t("cell_scanner.run.download")}
    >
      <MaterialSymbol name="download" size={16} />
      <span className="hidden @sm/section:inline">
        {t("cell_scanner.run.download")}
      </span>
    </Button>
  );

  return (
    <>
      {isLive ? (
        // The anchor is the aim strip, not the run hero: in this range there is
        // no run to launch, and a hero whose action started a different read
        // would offer a button whose result this table does not show.
        <motion.div variants={staggerItem}>
          {live === null ? (
            <AimStripSkeleton rangePicker={rangePicker} />
          ) : (
            <AimStrip
              live={live}
              liveStop={liveStop}
              liveFailed={liveFailed}
              onResume={resumeLive}
              rangePicker={rangePicker}
            />
          )}
        </motion.div>
      ) : (
        <motion.div variants={staggerItem}>
          <RunHero
            posture={posture}
            title={t("cell_scanner.neighbour.run.title")}
            description={t("cell_scanner.neighbour.run.description")}
            link={
              <SiblingRouteLink
                href={SWEEP_ROUTE}
                glyph="radar"
                label={t("cell_scanner.neighbour.run.link_sweep")}
                blockedReason={
                  isScanning ? t("cell_scanner.neighbour.run.link_blocked") : null
                }
              />
            }
            postureTitle={postureTitle}
            postureTitleIsMachine={usesModemMessage}
            postureBody={postureBody}
            metric={posture === "complete" ? summary.total : null}
            metricUnit={
              posture === "complete"
                ? t("cell_scanner.neighbour.run.ledger.figure_unit", {
                    count: summary.total,
                  })
                : null
            }
            rows={ledgerRowsNode}
            idleCollapsed
            actions={
              // None on failed: the results card carries the retry.
              posture === "failed" ? (
                rangePicker
              ) : (
                <>
                  {rangePicker}
                  <Button
                    type="button"
                    onClick={startScan}
                    disabled={isScanning}
                    size="action"
                  >
                    <MaterialSymbol
                      name={isScanning ? "progress_activity" : "cell_tower"}
                      size={18}
                      className={
                        isScanning
                          ? "motion-safe:animate-spin"
                          : undefined
                      }
                    />
                    {isScanning
                      ? t("cell_scanner.neighbour.run.scanning_action")
                      : hasResults
                        ? t("cell_scanner.neighbour.run.rerun")
                        : t("cell_scanner.neighbour.run.start")}
                  </Button>
                </>
              )
            }
          />
        </motion.div>
      )}

      {showResultsCard ? (
        <motion.div variants={staggerItem} initial="hidden" animate="visible">
          <Card className={SCAN_RESULTS_CARD}>
            <div className={SECTION_HEAD.ROOT}>
              <div className={SECTION_HEAD.TITLES}>
                <h2 className={SECTION_HEAD.TITLE}>
                  {t("cell_scanner.neighbour.results.title")}
                </h2>
                <p className={SECTION_HEAD.DESC}>
                  {t("cell_scanner.neighbour.results.description")}
                </p>
              </div>
            </div>

            {isLive ? (
              rows.length > 0 ? (
                <NeighbourScanResultView
                  // Keyed by range, so the band filter and the row limit reset
                  // when the range changes: a limit chosen while aiming is not
                  // an instruction for the next read.
                  key="live"
                  data={rows}
                  sample={sample}
                  onLockCell={handleLockCell}
                  toolbarActions={
                    <>
                      {pauseAction}
                      {downloadAction}
                    </>
                  }
                />
              ) : (
                // A live sample with no rows. The AT worker's "nothing was
                // found" panel does not apply: this list is whatever the modem
                // is currently measuring, and it can legitimately be one cell.
                // The Pause control lives in the table's toolbar and is therefore
                // absent here; leaving the range stops the lease just as well,
                // and that control is on the card above.
                <Empty className={EMPTY_PANEL}>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MaterialSymbol name="radar" size={24} aria-hidden />
                    </EmptyMedia>
                    <EmptyTitle>
                      {t("cell_scanner.neighbour.live.empty_title")}
                    </EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      {t("cell_scanner.neighbour.live.empty_body")}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )
            ) : isScanning ? (
              <ScannerSkeleton />
            ) : posture === "failed" ? (
              // No `message`: the hero's status cell already names the reason.
              <ScanErrorState
                title={t("cell_scanner.neighbour.results.error_title")}
                body={t("cell_scanner.neighbour.run.failed_body")}
                retryLabel={t("cell_scanner.neighbour.results.error_retry")}
                onRetry={startScan}
              />
            ) : rows.length > 0 ? (
              <NeighbourScanResultView
                key="last"
                data={rows}
                sample={sample}
                onLockCell={handleLockCell}
                toolbarActions={downloadAction}
              />
            ) : (
              // Only after a completed read that listed nothing; no button.
              <Empty className={EMPTY_PANEL}>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MaterialSymbol name="radar" size={24} aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>
                    {t("cell_scanner.neighbour.results.empty_title")}
                  </EmptyTitle>
                  <EmptyDescription className="text-pretty">
                    {t("cell_scanner.neighbour.results.empty_body")}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </Card>
        </motion.div>
        ) : null}

      <LockCellDialog
        target={lockTarget}
        onOpenChange={(open) => {
          if (!open) setLockTarget(null);
        }}
      />
    </>
  );
}

export default NeighbourScanner;
