"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  AvailabilityBucket,
  CellHistoryWindow,
  NrOutage,
} from "@/types/cell-history";
import { cn } from "@/lib/utils";

import {
  availabilitySummary,
  availabilityTier,
  formatClock,
  formatMoment,
  formatPct,
  formatSpan,
  hourTicks,
  isAvailabilityUnknown,
  totalOutageSeconds,
  type AvailabilityTier,
} from "./derive";
import { HERO, HERO_HEAD, STRIP, TIER } from "./shapes";

// =============================================================================
// AvailabilityCard — the page's answer, and its one hero
// =============================================================================
// "Was 5G up, and when was it not" in one sentence plus one strip. Three things
// here are contractual:
//
//  * NO MEANINGLESS 0 %. If every bucket in the range holds no determined
//    sample, there is no percentage to print — a 0 % would read as "5G was down
//    the whole time", which is the opposite of "nobody recorded anything". That
//    case states itself and draws no strip.
//  * A BUCKET WITH `n: 0` IS EMPTY, NOT DOWN. It renders as the recessed track
//    with nothing on it, and its readout says `bucket_unknown`. This is the
//    three-valued rule the whole feature exists to honour.
//  * QUALITY IS NEVER HUE-ONLY. The four stops differ in lightness by design
//    and each also owns a bar height inside the track, the legend swatches are
//    drawn at those same heights, and every bucket has a readout in words. A
//    reader in greyscale, in sunlight, or with deuteranopia still gets the
//    shape of the range before they read a single label.
//
// The strip is `role="img"` with one accessible name: 2880 individually
// announced cells would be a worse experience than the sentence above them,
// which is where the figure actually is.
// =============================================================================

export interface AvailabilityCardProps {
  buckets: AvailabilityBucket[];
  outages: NrOutage[];
  window: CellHistoryWindow;
  /** True past a day, where a bare `HH:MM` in a readout loses the date. */
  longSpan: boolean;
}

const TIERS: readonly AvailabilityTier[] = ["up", "partial", "down", "unknown"];

export function AvailabilityCard({
  buckets,
  outages,
  window,
  longSpan,
}: AvailabilityCardProps) {
  const { t } = useTranslation("cellular");
  const [hover, setHover] = useState<number | null>(null);

  const summary = availabilitySummary(buckets);
  const unknown = isAvailabilityUnknown(buckets);
  const downSeconds = totalOutageSeconds(outages);
  const ticks = hourTicks(window);

  const moment = (ts: number) => (longSpan ? formatMoment(ts) : formatClock(ts));

  const pick = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * buckets.length);
    setHover(Math.max(0, Math.min(buckets.length - 1, index)));
  };

  const hovered = hover === null ? null : (buckets[hover] ?? null);

  return (
    <section className={HERO}>
      <div className={HERO_HEAD.ROOT}>
        <h2 className={HERO_HEAD.EYEBROW}>
          {t("history.availability.title")}
        </h2>
        <p className={STRIP.HEADLINE}>
          {unknown || summary.pct === null
            ? t("history.availability.headline_unknown")
            : t("history.availability.headline", { pct: formatPct(summary.pct) })}
        </p>
      </div>

      {unknown ? (
        <p className={STRIP.SUB}>{t("history.availability.awaiting")}</p>
      ) : (
        <>
          <div className={STRIP.SUB}>
            <span>
              {t("history.availability.coverage", {
                known: summary.known.toLocaleString(),
                samples: window.samples.toLocaleString(),
              })}
            </span>
            {outages.length > 0 ? (
              <>
                <span>
                  {t("history.availability.downtime", {
                    duration: formatSpan(downSeconds),
                  })}
                </span>
                <span>
                  {t("history.availability.outage_count", { count: outages.length })}
                </span>
              </>
            ) : (
              <span>{t("history.availability.no_outage")}</span>
            )}
          </div>

          <div className={STRIP.ROOT}>
            {/* The readout holds its line height so hovering never shifts the
                strip under the pointer. */}
            <p className={STRIP.READOUT}>
              {hovered === null
                ? ""
                : hovered.n > 0
                  ? t("history.availability.bucket", {
                      time: moment(hovered.ts),
                      up: hovered.up,
                      known: hovered.n,
                    })
                  : t("history.availability.bucket_unknown", {
                      time: moment(hovered.ts),
                    })}
            </p>
            <div
              className={cn(
                STRIP.TRACK,
                // One cell per bucket, but not one gutter per cell: at a month
                // of buckets the gutters are wider than the strip.
                buckets.length > 180 && STRIP.TRACK_DENSE,
              )}
              role="img"
              aria-label={t("history.availability.strip_aria")}
              onPointerMove={pick}
              onPointerDown={pick}
              onPointerLeave={() => setHover(null)}
            >
              {buckets.map((bucket) => {
                const tier = availabilityTier(bucket);
                return (
                  <span
                    key={bucket.ts}
                    className={cn(STRIP.CELL, TIER[tier].fill, TIER[tier].height)}
                  />
                );
              })}
            </div>
            {ticks.length > 0 ? (
              <div className={STRIP.TICKS} aria-hidden="true">
                {ticks.map((tick) => (
                  <span
                    key={tick.ts}
                    className={STRIP.TICK}
                    style={{ left: `${tick.leftPct}%` }}
                  >
                    {formatClock(tick.ts)}
                  </span>
                ))}
              </div>
            ) : null}
            <ul className={STRIP.LEGEND}>
              {TIERS.map((tier) => (
                <li key={tier} className={STRIP.LEGEND_ITEM}>
                  <span className={STRIP.LEGEND_TRACK} aria-hidden="true">
                    <span
                      className={cn(
                        STRIP.LEGEND_SWATCH,
                        TIER[tier].fill,
                        TIER[tier].height,
                      )}
                    />
                  </span>
                  {t(`history.availability.legend.${tier}`)}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}

export default AvailabilityCard;
