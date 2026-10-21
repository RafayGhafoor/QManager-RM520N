"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CellularPageHeader } from "@/components/cellular/page-header";
import { Button } from "@/components/ui/button";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import { SegmentedField } from "@/components/ui/segmented-field";
import { Skeleton } from "@/components/ui/skeleton";
import { TonalBanner } from "@/components/ui/tonal-banner";
import { useDetailedMetrics } from "@/hooks/use-detailed-metrics";
import { useModemStatus } from "@/hooks/use-modem-status";
import type { DetailedMetricRange } from "@/types/detailed-metrics";

import { CarrierAggregationCard } from "./carrier-aggregation-card";
import { DistributionsCard } from "./distributions-card";
import { LtePhyCard, NrPhyCard } from "./phy-cards";
import { RegistrationCard } from "./registration-card";
import { GROUP_CARD, GROUPS_GRID, PAGE_SHELL } from "./shapes";
import { SsbBeamsCard } from "./ssb-beams";

// =============================================================================
// Detailed Metrics — the PHY layer, live and over a range
// =============================================================================
// One range pill for the whole page, `now` FIRST. `now` is the live view: it is
// not a separate page, tab or band, because a live band that reads a different
// window than the cards under it is exactly the shape /monitoring/latency
// shipped once and deleted (`docs/reference/latency-monitor.md:74`).
//
// THE PILL OFFERS FOUR OF THE NINE RANGES THE CGI ACCEPTS. The endpoint serves
// `now|1h|3h|6h|12h|24h|7d|30d|90d`; the archive gains a row a minute and a 3h,
// 6h or 12h window at this device's history depth answers with a handful of
// buckets, so the pill shows the four that mean something and the rest stay
// reachable from `curl` (`sites-card.tsx:48` made the same call for the same
// reason).
//
// TWO SOURCES, ONE PAGE, AND THEY ARE NOT INTERCHANGEABLE:
//   `useDetailedMetrics(range)` — the PHY block, the RRC/registration block and
//       the archive. This is the page's subject.
//   `useModemStatus()` — carrier aggregation and the freshness verdict. The CA
//       block is already produced by the poller's `AT+QCAINFO` read, and
//       `isStale` is the poller's own statement about its snapshot. Nothing here
//       starts a second timer to answer either question.
//
// LIVE GATING LIVES IN THE HOOK. A hidden tab reads nothing; the request that
// renews the CGI's live lease is the `?range=now` GET, so not asking is what
// lets the lease age out (see `hooks/use-detailed-metrics.ts`).
// =============================================================================

/** The pill's subset, in order. `now` first, always. */
type PillRange = Extract<DetailedMetricRange, "now" | "1h" | "24h" | "7d">;

const PILL_RANGES: readonly PillRange[] = ["now", "1h", "24h", "7d"];

const RANGE_LABEL_KEY = {
  now: "detailed_metrics.range.now",
  "1h": "detailed_metrics.range.h1",
  "24h": "detailed_metrics.range.h24",
  "7d": "detailed_metrics.range.d7",
} satisfies Record<PillRange, string>;

/**
 * The poller snapshot's cadence on this page. It feeds only the CA block and the
 * staleness chip, so it does not need the 2 s the dashboard uses — and the live
 * figures' cadence comes from `useDetailedMetrics`, not from here.
 */
const MODEM_POLL_MS = 5_000;

function GroupsSkeleton() {
  return (
    <div className={GROUPS_GRID} aria-hidden>
      {Array.from({ length: 4 }).map((_, card) => (
        <div key={card} className={GROUP_CARD}>
          <Skeleton className="h-4 w-32 rounded-inline" />
          <Skeleton className="h-3 w-56 rounded-inline" />
          <div className="grid grid-cols-1 gap-4 @lg/card:grid-cols-2">
            {Array.from({ length: 6 }).map((__, row) => (
              <div key={row} className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-20 rounded-inline" />
                <Skeleton className="h-2 w-full rounded-pill" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DetailedMetrics() {
  const { t } = useTranslation("cellular");
  const [range, setRange] = useState<PillRange>("now");
  const { data, dataRange, isLoading, error, refresh } = useDetailedMetrics(range);
  const modem = useModemStatus({ pollInterval: MODEM_POLL_MS });

  const snapshot = data?.snapshot ?? null;
  // `isStale` is the poller's verdict on the snapshot it serves, so it drives
  // every group's chip. One clock, stated once.
  const stale = modem.isStale;

  return (
    <div className={PAGE_SHELL}>
      <CellularPageHeader
        title={t("detailed_metrics.page.title")}
        description={t("detailed_metrics.page.description")}
        actions={
          <SegmentedField
            value={range}
            onValueChange={(next) => setRange(next)}
            options={PILL_RANGES.map((value) => ({
              value,
              label: t(RANGE_LABEL_KEY[value]),
              numeric: value !== "now",
            }))}
            ariaLabel={t("detailed_metrics.range_aria")}
            breakpoint="never"
            // The active pill's fill marks it; a check glyph beside a range
            // label would be a second, redundant mark (latency-monitor.md:118).
            glyph={() => null}
          />
        }
      />

      {/* A failed read with figures already on screen keeps the figures and says
          they are not updating. A failed FIRST read has nothing to keep, so it
          gets the panel below instead. */}
      {error && data ? (
        <TonalBanner
          tone="warning"
          icon="warning"
          title={t("detailed_metrics.notice_title")}
          size="compact"
        >
          {t("detailed_metrics.notice_body")}
        </TonalBanner>
      ) : null}

      {!data && isLoading ? <GroupsSkeleton /> : null}

      {!data && !isLoading ? (
        <TonalBanner
          tone="destructive"
          icon="error"
          title={t("detailed_metrics.error_title")}
        >
          <span className="flex flex-wrap items-center gap-3">
            {t("detailed_metrics.error_body")}
            <Button type="button" variant="tonal-neutral" size="sm" onClick={refresh}>
              <MaterialSymbol name="refresh" size={16} />
              {t("detailed_metrics.retry")}
            </Button>
          </span>
        </TonalBanner>
      ) : null}

      {snapshot && data ? (
        <div className={GROUPS_GRID}>
          <RegistrationCard
            carrier={snapshot.carrier}
            rrc={snapshot.rrc}
            registered={snapshot.registered}
            stale={stale}
          />
          <CarrierAggregationCard
            network={modem.data?.network ?? null}
            stale={stale}
          />
          <LtePhyCard lte={snapshot.lte} stale={stale} />
          <NrPhyCard nr={snapshot.nr} stale={stale} />
          <SsbBeamsCard beams={snapshot.beams} stale={stale} />
          <DistributionsCard
            series={data.series}
            missing={data.missing}
            hasArchive={dataRange !== "now"}
            range={dataRange ?? range}
            stale={stale}
          />
        </div>
      ) : null}
    </div>
  );
}

export default DetailedMetrics;
