"use client";

import { useTranslation } from "react-i18next";

import type { CellHistoryWindow, CellRun } from "@/types/cell-history";
import { cn } from "@/lib/utils";

import {
  bandVariant,
  formatClock,
  formatMoment,
  formatPct,
  formatSpan,
  hourTicks,
  runBand,
  timelineSegments,
  type TimelineSegment,
} from "./derive";
import { PanelEmpty } from "./empty-state";
import { CARD, FULL, HEAD, STRIP, TIMELINE, BAND_TONE } from "./shapes";

// =============================================================================
// TimelineCard — which cell and band served, over time
// =============================================================================
// A gantt of `cells.timeline`: one contiguous run of a single serving cell is
// one segment, positioned by its start and end as a fraction of the window. Two
// lanes, because a run carries both radio legs and dropping one would answer
// half the question:
//
//   LTE   the band the device camped on — always present, and the thing that
//         actually changes when the field complaint ("sometimes band 1") does.
//   5G    the NR band, where the modem reported one. An empty 5G lane is the
//         statement "no NR leg in this range" and it is drawn as such, with
//         `band_not_reported` in the track rather than a silent void.
//
// WHY THE 5G LANE SAYS `no_pci` RATHER THAN A PCI. `cells.timeline` carries the
// LTE PCI only (the field an operator recognises, and the one the CGI diffs on);
// there is no NR PCI in the contract, so the tooltip states that instead of
// borrowing the LTE figure and implying it applies to the NR leg.
//
// COLOUR IS A PAIRING AID, NOT THE DATUM. A band's tone is a stable function of
// the band string, so two runs of the same band look the same and a change
// looks like a change. The band itself is printed inside every segment wide
// enough to hold it, and in the tooltip of every segment that is not — the
// shades are only there to make the boundaries legible before the labels are
// read, because this system's identity hues are deliberately clustered in
// lightness and cannot carry a category on their own.
// =============================================================================

export interface TimelineCardProps {
  runs: CellRun[];
  window: CellHistoryWindow;
  /** True past a day, where a bare `HH:MM` in a tooltip loses the date. */
  longSpan: boolean;
}

/** Below this width a segment's label would be clipped mid-band, so it is hover only. */
const LABEL_MIN_PCT = 12;

const DASH = "—";

interface LaneSegment {
  segment: TimelineSegment;
  band: string | null;
  fill: string;
  ink: string;
}

export function TimelineCard({ runs, window, longSpan }: TimelineCardProps) {
  const { t } = useTranslation("cellular");
  const segments = timelineSegments(runs, window);
  const ticks = hourTicks(window);

  const moment = (ts: number) => (longSpan ? formatMoment(ts) : formatClock(ts));

  const lane = (leg: "lte" | "nr"): LaneSegment[] => {
    const out: LaneSegment[] = [];
    for (const segment of segments) {
      const band = runBand(segment.run, leg);
      // The NR lane has nothing to draw where the modem reported no NR band;
      // the LTE lane keeps its run with the neutral "not reported" tone, because
      // the run itself is a fact about the LTE leg either way.
      if (leg === "nr" && band === null) continue;
      const tone =
        band === null
          ? BAND_TONE.unknown
          : BAND_TONE[leg][bandVariant(band)];
      out.push({ segment, band, fill: tone.fill, ink: tone.ink });
    }
    return out;
  };

  const runDetail = (entry: LaneSegment, leg: "lte" | "nr"): string => {
    const { run } = entry.segment;
    return t("history.timeline.run_detail", {
      pci: leg === "lte" ? (run.lte_pci ?? t("history.timeline.no_pci")) : t("history.timeline.no_pci"),
      band: entry.band ?? t("history.timeline.band_not_reported"),
      pct: run.nr_avail_pct === null ? DASH : formatPct(run.nr_avail_pct),
    });
  };

  const renderLane = (leg: "lte" | "nr") => {
    const entries = lane(leg);
    return (
      <div className={TIMELINE.LANE}>
        <span className={TIMELINE.LANE_LABEL}>
          {t(leg === "lte" ? "history.timeline.lte_row" : "history.timeline.nr_row")}
        </span>
        <div className={TIMELINE.TRACK}>
          {entries.length === 0 ? (
            <span className="absolute inset-0 grid place-items-center text-[0.6875rem] text-on-surface-variant">
              {t("history.timeline.band_not_reported")}
            </span>
          ) : null}
          {entries.map((entry) => {
            const { segment } = entry;
            const wide = segment.widthPct >= LABEL_MIN_PCT;
            return (
              <span
                key={`${leg}-${segment.key}`}
                className={cn(TIMELINE.SEGMENT, entry.fill, entry.ink)}
                // A real 2px gutter between segments, cut out of the fill rather
                // than drawn as a border (The No-Hairline-On-Fill Rule), so a
                // band change is visible even when both bands wear the same
                // tone. `max()` keeps a one-minute run on a 30-day range from
                // rounding away to nothing.
                style={{
                  left: `${segment.leftPct}%`,
                  width: `max(2px, calc(${segment.widthPct}% - 2px))`,
                }}
                title={runDetail(entry, leg)}
              >
                {wide ? (
                  <span className={TIMELINE.SEGMENT_LABEL}>
                    {t("history.timeline.run", {
                      cell:
                        entry.band ?? t("history.timeline.band_not_reported"),
                      duration: formatSpan(
                        Math.max(0, segment.run.end_ts - segment.run.start_ts),
                      ),
                    })}
                  </span>
                ) : null}
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <section className={cn(CARD, FULL)}>
      <header className={HEAD.ROOT}>
        <h2 className={HEAD.TITLE}>{t("history.timeline.title")}</h2>
        <p className={HEAD.DESC}>{t("history.timeline.description")}</p>
      </header>

      {runs.length === 0 ? (
        <PanelEmpty icon="timeline" body={t("history.timeline.empty")} />
      ) : (
        <>
          <div className={TIMELINE.LANES}>
            {renderLane("lte")}
            {renderLane("nr")}
          </div>
          {ticks.length > 0 ? (
            <div className="ps-11">
              <div className={STRIP.TICKS} aria-hidden="true">
                {ticks.map((tick) => (
                  <span
                    key={tick.ts}
                    className={STRIP.TICK}
                    style={{ left: `${tick.leftPct}%` }}
                  >
                    {moment(tick.ts)}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export default TimelineCard;
