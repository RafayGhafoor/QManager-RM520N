"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CellularPageHeader } from "@/components/cellular/page-header";
import { Button } from "@/components/ui/button";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import { SegmentedField } from "@/components/ui/segmented-field";
import { Skeleton } from "@/components/ui/skeleton";
import { TonalBanner } from "@/components/ui/tonal-banner";
import { useCellHistory } from "@/hooks/use-cell-history";
import {
  CELL_HISTORY_RANGES,
  type CellHistoryRange,
} from "@/types/cell-history";
import { cn } from "@/lib/utils";

import { AvailabilityCard } from "./availability-card";
import { BandsCard } from "./bands-card";
import { ChartCard } from "./chart-card";
import {
  formatMoment,
  identityLagsWindow,
  isWindowShort,
  windowSeconds,
} from "./derive";
import { EventsCard } from "./events-card";
import { IdentityCard } from "./identity-card";
import { Legend } from "./legend";
import { OutagesCard } from "./outages-card";
import { PanelsPopover } from "./panels-popover";
import {
  loadPanels,
  savePanels,
  type PanelId,
  type PanelVisibility,
} from "./panels";
import { PatternCard } from "./pattern-card";
import { CONTROLS, FULL, GRID, PAGE_SHELL, STACK } from "./shapes";
import { TimelineCard } from "./timeline-card";

// =============================================================================
// Cell History — what the radio actually did over the selected range
// =============================================================================
// One ranged read, one page of panels, and one sentence at the top about what
// the archive could and could not see.
//
// NO LIVE BAND AND NO `now` RANGE. The dashboard is the live surface; this page
// reads the archive, whose newest row is up to a poll cycle old. A `now` tab
// shipped once on /monitoring/latency and was deleted because a live view above
// range cards disagrees with them the moment the range's last bucket ages
// (`docs/reference/latency-monitor.md:74`). So the pill offers named ranges
// only, and every card below reads the same window.
//
// THE WINDOW IS THE PAYLOAD'S, NOT THE PILL'S. Two lines under the controls
// state how many samples came back and what span they cover, and they say so
// when that span is materially shorter than the range asked for or when cell
// identity only starts part-way through it. Without them the page would happily
// print "5G never dropped" about hours it could not see — the one claim a
// history surface must never make by omission.
//
// PANELS ARE A VIEWER PREFERENCE. Which of the nine panels are on lives in
// `localStorage` (`./panels`); the availability hero is not one of them,
// because a page about 5G availability that can hide its own answer is a
// settings screen. The stored object is merged ONTO the defaults, so a panel
// added in a later build appears at its own default instead of vanishing.
//
// THE BANDS CARD IS ITS OWN PANEL, NOT A RIDER ON `rf`. It sits immediately
// after the RF charts so "Radio signal" reads as measurements-then-bands, but
// it is hideable on its own terms: a reader checking the signal curves should
// not have to give up the band strip's fourth of the page, and a panel that
// disappears when a DIFFERENT panel is switched off is a picker that lies.
// =============================================================================

/** Range → its pill label key. The pill offers every range the CGI serves. */
const RANGE_LABEL_KEY = {
  "1h": "history.range.h1",
  "3h": "history.range.h3",
  "6h": "history.range.h6",
  "12h": "history.range.h12",
  "24h": "history.range.h24",
  "7d": "history.range.d7",
  "30d": "history.range.d30",
} satisfies Record<CellHistoryRange, string>;

/**
 * A day, by default: the page's subject is a nightly dropout, and the shortest
 * range that can show one is a night. It is also the shortest range the pattern
 * panel can draw, so the first impression is never a card explaining that it
 * needs a longer range.
 */
const DEFAULT_RANGE: CellHistoryRange = "24h";

/** The RF group: the serving-cell measurements the archive records per minute. */
const RF_METRICS = ["rsrp", "sinr", "rsrq", "rssi"] as const;

/** The PHY depth group. */
const PHY_METRICS = ["cqi", "rank", "mcs", "tx_power"] as const;

/** The device-load group: temperature, CPU, memory and the two throughput rates. */
const SYSTEM_METRICS = ["temp", "cpu", "mem", "dl", "ul"] as const;

function PageSkeleton() {
  return (
    <div className={GRID} aria-hidden>
      <Skeleton className={cn(FULL, "h-48 rounded-hero")} />
      <Skeleton className="h-56 rounded-card" />
      <Skeleton className="h-56 rounded-card" />
      <Skeleton className={cn(FULL, "h-64 rounded-card")} />
    </div>
  );
}

export function CellHistory() {
  const { t } = useTranslation("cellular");
  const [range, setRange] = useState<CellHistoryRange>(DEFAULT_RANGE);
  const { data, dataRange, isLoading, error, refresh } = useCellHistory(range);

  // Lazy and guarded: this page is prerendered during the static export, where
  // `window` does not exist. Reading storage in the initialiser (not in an
  // effect) is also what keeps the first client paint from flashing the
  // defaults before the saved choice lands.
  const [panels, setPanels] = useState<PanelVisibility>(() => loadPanels());

  const togglePanel = (id: PanelId) => {
    setPanels((previous) => {
      const next: PanelVisibility = { ...previous, [id]: !previous[id] };
      savePanels(next);
      return next;
    });
  };

  const window = data?.window ?? null;
  const longSpan = window !== null && windowSeconds(window) >= 86_400;
  // The range every payload-shaped decision keys on: `range` moves the moment a
  // pill is clicked, `dataRange` moves when the answer for it lands. Reading the
  // pill instead would price a 30d payload against the 1h just selected.
  const shownRange = dataRange ?? range;
  const rangeLabel = t(RANGE_LABEL_KEY[shownRange]);

  return (
    <div className={PAGE_SHELL}>
      <CellularPageHeader
        title={t("history.page.title")}
        description={t("history.page.description")}
      />

      <div className={CONTROLS.ROW}>
        <SegmentedField
          value={range}
          onValueChange={(next) => setRange(next)}
          options={CELL_HISTORY_RANGES.map((value) => ({
            value,
            label: t(RANGE_LABEL_KEY[value]),
            numeric: true,
          }))}
          ariaLabel={t("history.range_aria")}
          breakpoint="5xl"
          // The active pill's fill marks it; a check glyph beside a range label
          // would be a second, redundant mark (latency-monitor.md:118).
          glyph={() => null}
        />
        <Button
          type="button"
          variant="tonal-neutral"
          size="sm"
          onClick={refresh}
          disabled={isLoading}
        >
          <MaterialSymbol name="refresh" size={16} />
          {isLoading && !data ? t("history.refreshing") : t("history.refresh")}
        </Button>
        <PanelsPopover visibility={panels} onToggle={togglePanel} />
      </div>

      {/* Directly under the controls and above every panel, and outside the
          payload branches: what the marks mean does not depend on whether a
          read has landed yet. Only the band group waits for `combos`. */}
      <Legend combos={data?.cells.combos ?? []} />

      {window !== null && data !== null ? (
        <div className={CONTROLS.NOTES_BLOCK}>
          <div className={CONTROLS.NOTES}>
            <span>{t("history.window.samples", { count: window.samples })}</span>
            <span>
              {t("history.window.span", {
                first: formatMoment(window.start),
                last: formatMoment(window.end),
              })}
            </span>
          </div>
          {/* An empty window is stated once, below, rather than also being
              called "shorter than requested" — the two say the same thing and
              the shorter one is the less useful sentence. */}
          {window.samples > 0 && isWindowShort(window, shownRange) ? (
            <p className={CONTROLS.NOTE}>
              {t("history.window.short", { range: rangeLabel })}
            </p>
          ) : null}
          {data.coverage.cell_from !== null &&
          identityLagsWindow(data.coverage, window) ? (
            <p className={CONTROLS.NOTE}>
              {t("history.window.identity_from", {
                time: formatMoment(data.coverage.cell_from),
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* A failed read with figures already on screen keeps the figures and says
          they are not updating. A failed FIRST read has nothing to keep. */}
      {error && data ? (
        <TonalBanner tone="warning" icon="warning" size="compact" title={t("history.stale")}>
          {t("history.error.read")}
        </TonalBanner>
      ) : null}

      {!data && isLoading ? <PageSkeleton /> : null}

      {!data && !isLoading ? (
        <TonalBanner tone="destructive" icon="error" title={t("history.error.read")}>
          <Button type="button" variant="tonal-neutral" size="sm" onClick={refresh}>
            <MaterialSymbol name="refresh" size={16} />
            {t("history.refresh")}
          </Button>
        </TonalBanner>
      ) : null}

      {data && window !== null ? (
        window.samples === 0 ? (
          <TonalBanner tone="info" icon="info">
            {t("history.window.empty")}
          </TonalBanner>
        ) : (
          <div className="flex flex-col gap-5">
            <AvailabilityCard
              buckets={data.cells.availability}
              outages={data.cells.outages}
              window={window}
              longSpan={longSpan}
            />

            {panels.pattern ? (
              <PatternCard
                buckets={data.cells.availability}
                window={window}
                range={shownRange}
              />
            ) : null}

            {panels.timeline ? (
              <TimelineCard
                runs={data.cells.timeline}
                window={window}
                longSpan={longSpan}
              />
            ) : null}

            {panels.rf ? (
              <ChartCard
                title={t("history.charts.rf_title")}
                metrics={RF_METRICS}
                series={data.series}
                missing={data.missing}
                longSpan={longSpan}
                full
              />
            ) : null}

            {panels.bands ? (
              <BandsCard
                runs={data.cells.bands}
                combos={data.cells.combos}
                window={window}
                longSpan={longSpan}
              />
            ) : null}

            {panels.events || panels.outages ? (
              <div
                className={panels.events && panels.outages ? GRID : STACK}
              >
                {panels.events ? (
                  <EventsCard
                    stats={data.cells.stats}
                    events={data.cells.events}
                    coverage={data.coverage}
                  />
                ) : null}
                {panels.outages ? (
                  <OutagesCard
                    outages={data.cells.outages}
                    runs={data.cells.timeline}
                  />
                ) : null}
              </div>
            ) : null}

            {panels.phy ? (
              <ChartCard
                title={t("history.charts.phy_title")}
                metrics={PHY_METRICS}
                series={data.series}
                missing={data.missing}
                longSpan={longSpan}
                full
              />
            ) : null}

            {/* Identity and the device-load group do NOT pair: a seven-chart
                card beside a thirteen-row grid leaves one of them holding a
                row's worth of slack, and DESIGN.md's answer to that is a
                full-width band, not a symmetric row. */}
            {panels.identity ? (
              <IdentityCard
                cell={data.snapshot.cell}
                asOf={data.snapshot.as_of}
                coverage={data.coverage}
              />
            ) : null}

            {panels.system ? (
              <ChartCard
                title={t("history.charts.system_title")}
                metrics={SYSTEM_METRICS}
                series={data.series}
                missing={data.missing}
                longSpan={longSpan}
                full
              />
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

export default CellHistory;
