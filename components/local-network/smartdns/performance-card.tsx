"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  CircleAlertIcon,
  DatabaseIcon,
  GaugeIcon,
  Loader2Icon,
  NetworkIcon,
  RefreshCcwIcon,
  ShieldOffIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SmartDnsStatsResponse } from "@/types/smartdns";

import CardNotice from "./card-notice";
import { formatMoment, formatNumber } from "./format";
import {
  CARD_HEAD,
  CARD_PAD,
  CARD_SHELL,
  CARD_TITLE,
  DISC_TONE,
  FOOTNOTE,
  READOUT,
  SECTION_LABEL,
  TILE,
} from "./shapes";

// =============================================================================
// PerformanceCard — what the resolver buys, with the source of every figure
// =============================================================================
// Contract 4's third card, and the one place on this page where the honesty of
// the panel is the design requirement rather than a nicety.
//
// -----------------------------------------------------------------------------
// NONE OF THESE ARE SMARTDNS COUNTERS, SO NONE OF THEM IS PRESENTED AS ONE
// -----------------------------------------------------------------------------
// `smartdns --help` exposes run/update/service/resolve/symlink/test and the
// binary has no statistics endpoint on 0.13.1 (measured; docs/specs/smartdns-o5a.md
// > "The stats problem"). Every figure here is DERIVED, from four different
// places, and each tile's caption names its own source:
//
//   cache hit rate      dnsmasq's SIGUSR1 cache line   "dnsmasq cache stats"
//   lookup speed-up     the carrier-vs-LAN DNS samples  "carrier vs LAN probe"
//   pool size           `server` lines in the config    "smartdns config"
//   blocked rules       `address /…/#` rules in config  "smartdns config"
//
// A tile that dropped its caption would read as the daemon's own telemetry, and
// this page would be claiming a measurement it does not have. The secondary
// figures carry the same discipline as section labels — one label per group,
// naming the source once rather than once per row.
//
// -----------------------------------------------------------------------------
// A MISSING FIGURE IS AN EM DASH, NEVER A ZERO
// -----------------------------------------------------------------------------
// `hit_rate_pct: null` means no dnsmasq sample has been taken since the last
// restart, and `speedup_x: null` means the Connection Quality probe has not run.
// A 0 % hit rate and a 0× speed-up are both real readings with a completely
// different meaning, so the em dash is the only honest glyph for the absence.
// =============================================================================

const K = "smartdns";

export interface PerformanceCardProps {
  stats: SmartDnsStatsResponse | null;
  isLoading: boolean;
  /** Resolves when the re-read finishes; `silent` skips the card's skeleton. */
  onRefresh: (silent: boolean) => Promise<void>;
}

export function PerformanceCard({
  stats,
  isLoading,
  onRefresh,
}: PerformanceCardProps) {
  const { t, i18n } = useTranslation("common");
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  // The USER-INITIATED re-read, and it is deliberately silent: this component
  // keeps its own spinner, so a full-card skeleton would replace the figures the
  // user is watching for. The read itself still happens.
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh(true);
    } finally {
      setIsRefreshing(false);
    }
  };

  const num = (value: number | null | undefined, fractionDigits = 0) =>
    formatNumber(value ?? null, i18n.language, fractionDigits) ?? TILE.NONE;

  const hitRate =
    stats?.cache?.hit_rate_pct === null || stats?.cache?.hit_rate_pct === undefined
      ? TILE.NONE
      : `${num(stats.cache.hit_rate_pct, 1)}%`;

  const speedup =
    stats?.latency?.speedup_x === null || stats?.latency?.speedup_x === undefined
      ? TILE.NONE
      : `${num(stats.latency.speedup_x, 1)}×`;

  const tiles = [
    {
      key: "hit_rate",
      glyph: DatabaseIcon,
      value: hitRate,
    },
    {
      key: "speedup",
      glyph: GaugeIcon,
      value: speedup,
    },
    {
      key: "pool",
      glyph: NetworkIcon,
      value: num(stats?.pool?.members),
    },
    {
      key: "blocked",
      glyph: ShieldOffIcon,
      value: num(stats?.blocked?.rules),
    },
  ] as const;

  const groups = [
    {
      key: "cache",
      title: t(`${K}.perf.cache_section.title`),
      source: t(`${K}.perf.cache_section.source`),
      rows: [
        { key: "cache_size", value: num(stats?.cache?.size) },
        { key: "insertions", value: num(stats?.cache?.insertions) },
        { key: "evictions", value: num(stats?.cache?.evictions) },
        { key: "reused", value: num(stats?.cache?.reused) },
      ],
    },
    {
      key: "lookup",
      title: t(`${K}.perf.lookup_section.title`),
      source: t(`${K}.perf.lookup_section.source`),
      rows: [
        {
          key: "lan_ms",
          value:
            stats?.latency?.lan_ms === null || stats?.latency?.lan_ms === undefined
              ? TILE.NONE
              : `${num(stats.latency.lan_ms, 1)} ms`,
        },
        {
          key: "carrier_ms",
          value:
            stats?.latency?.carrier_ms === null ||
            stats?.latency?.carrier_ms === undefined
              ? TILE.NONE
              : `${num(stats.latency.carrier_ms, 1)} ms`,
        },
      ],
    },
    {
      key: "health",
      title: t(`${K}.perf.health_section.title`),
      source: t(`${K}.perf.health_section.source`),
      rows: [{ key: "pool_errors", value: num(stats?.pool?.errors) }],
    },
  ] as const;

  const sampledAt = formatMoment(stats?.sampled_at ?? null, i18n.language);

  return (
    <Card className={CARD_SHELL}>
      <CardHeader className={cn(CARD_PAD, CARD_HEAD.ROOT)}>
        <div className={CARD_HEAD.TITLES}>
          <CardTitle className={CARD_TITLE}>{t(`${K}.perf.title`)}</CardTitle>
          <span className={CARD_HEAD.DESC}>{t(`${K}.perf.description`)}</span>
        </div>
        <div className={CARD_HEAD.ACTIONS}>
          <Button
            type="button"
            variant="ghost"
            size="action"
            onClick={() => {
              void handleRefresh();
            }}
            disabled={isRefreshing}
          >
            {isRefreshing ? (
              <Loader2Icon className="size-4 motion-safe:animate-spin" />
            ) : (
              <RefreshCcwIcon className="size-4" />
            )}
            {t(`${K}.perf.refresh`)}
          </Button>
        </div>
      </CardHeader>

      <CardContent className={cn(CARD_PAD, "flex flex-col gap-4")}>
        {isLoading ? (
          <PerformanceCardSkeleton />
        ) : stats === null ? (
          <CardNotice
            glyph={CircleAlertIcon}
            tone="alert"
            title={t(`${K}.perf.empty_title`)}
            body={t(`${K}.perf.empty_body`)}
          />
        ) : (
          <>
            <div className={TILE.GRID}>
              {tiles.map((tile) => (
                <div key={tile.key} className={cn(TILE.ROOT, TILE.BODY)}>
                  {/* Four neutral discs, deliberately. The Neutral-Default Rule
                      is the reason: none of these four figures owns an honest
                      hue — a hit rate, a ratio, a pool size and a rule count are
                      all quantities, and the speed-up in particular is not a
                      direction and not an identity. The system's own precedent
                      is the ethernet strip's negotiated rate, which made the
                      same call for the same reason. Emphasising one disc here
                      would be decoration on the one tile that happens to lead. */}
                  <span className={cn(TILE.DISC, DISC_TONE.neutral)}>
                    <tile.glyph className={TILE.GLYPH} aria-hidden="true" />
                  </span>
                  <div className={TILE.TEXT}>
                    <span className={TILE.EYEBROW}>
                      {t(`${K}.perf.${tile.key}.label`)}
                    </span>
                    <span className={TILE.VALUE}>
                      <span className={TILE.VALUE_TEXT}>{tile.value}</span>
                    </span>
                    {/* THE CAPTION IS THE SOURCE. See the module header. */}
                    <span className={TILE.CAPTION}>
                      {t(`${K}.perf.${tile.key}.source`)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-4">
              {groups.map((group) => (
                <div key={group.key} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className={SECTION_LABEL}>{group.title}</span>
                    <span className="text-on-surface-variant text-[0.75rem]">
                      {group.source}
                    </span>
                  </div>
                  <div className={READOUT.GRID}>
                    {group.rows.map((row) => (
                      <div key={row.key} className={READOUT.ROOT}>
                        <span className={READOUT.KEY}>
                          {t(`${K}.perf.rows.${row.key}`)}
                        </span>
                        <span className={READOUT.VALUE}>{row.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* A headline tile that can never fill would read as a broken panel.
                When the CGI reports no hit rate, the card says why instead of
                leaving an unexplained dash under a label. */}
            {stats.cache.hit_rate_pct === null ? (
              <span className={FOOTNOTE}>{t(`${K}.perf.hit_rate_note`)}</span>
            ) : null}

            {sampledAt ? (
              <span className={FOOTNOTE}>
                {t(`${K}.perf.sampled`, { time: sampledAt })}
              </span>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Four tiles at their pinned height, then the readout pills. */
export function PerformanceCardSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className={TILE.GRID}>
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className={cn(TILE.HEIGHT, "rounded-tile")} />
        ))}
      </div>
      <div className={READOUT.GRID}>
        {Array.from({ length: 7 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full rounded-pill" />
        ))}
      </div>
    </div>
  );
}

export default PerformanceCard;
