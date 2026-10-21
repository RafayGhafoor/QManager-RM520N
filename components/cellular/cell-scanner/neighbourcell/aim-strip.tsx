"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import { MetricBar } from "@/components/ui/metric-bar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ageParts,
  bandOf,
  cellKey,
  measuredRsrp,
  recordPeaks,
  topMeasured,
  type PeakMap,
} from "@/lib/neighbour-live";
import { cn } from "@/lib/utils";
import type { NeighbourCellResult } from "@/types/cell-scanner";
import {
  RSRP_THRESHOLDS,
  SINR_THRESHOLDS,
  normalizeMetricValue,
  signalToProgress,
  type SignalThresholds,
} from "@/types/modem-status";

import {
  AIM,
  BADGE_GLYPH_SIZE,
  PILL_QUIET,
  SCAN_RESULTS_CARD,
  SECTION_HEAD,
  SIGNAL_BADGE,
  SKELETON_SHAPE,
  signalBarTone,
  signalTier,
} from "../shapes";
import type { LiveStop, NeighbourLiveView } from "@/hooks/use-neighbour-scanner";

// =============================================================================
// AimStrip — the `now` range's anchor
// =============================================================================
// Pointing a directional antenna is a closed physical loop: rotate, watch, hold
// still, remember. Three of those the interface can do, and the one it cannot is
// "remember" — so the peak is the feature, not the decoration. While the strip is
// on screen the reader is outside, in sunlight, looking at a phone in one hand.
// Everything here is sized for that: one figure per metric, a bar you can compare
// across rows, and no interaction beyond the range picker above it.
//
// WHY THE REGISTRATION STATE IS BESIDE THE FIGURES. QMI reports RSRP/RSRQ/SNR for
// whatever cell the radio can HEAR, attached or not — observed live with the modem
// at 'not-registered-searching' while it reported a plausible 5G reading
// (`docs/reference/qmi-transport.md` > The trap: signal is not attachment). A
// strong figure beside a detached modem is the one reading that would send an
// operator to the wrong tower, so the two are never separated.
//
// WHY THE COST IS STATED. Live mode is a browser-held lease that spends ~4 % of
// this device's single core. That is a fair trade for the feature — and a hidden
// one if the surface does not say so.
//
// NO ANIMATION, deliberately. The figures retarget at 1 Hz, so the change is
// already visible without help; a tick or a fade would dim, once a second, the
// one number being watched. The peak marker snaps for the same reason it exists:
// a new best is a discrete event.
// =============================================================================

/** How many neighbours the strip ranks. Three: the number of candidates an
 *  operator compares while sweeping, and what the aim panel has room for. */
const TOP_NEIGHBOURS = 3;

/** The metric bars' threshold props. Both are inert: the tone comes from the
 *  three-tier scale below, not from a percentage crossing a cut. */
const NO_ALERT = 101;

/** The dBm/dB figure, as reported. One decimal when the modem gives one. */
function figureText(value: number): string {
  return String(value);
}

/**
 * The registration chip.
 *
 * `success`/`warning` are the functional roles and each carries its own glyph, so
 * the two states are told apart without colour. Words, not a symbol alone: this is
 * the reading that makes the figures above trustworthy.
 */
function RegistrationState({
  registered,
  carrier,
}: {
  registered: boolean;
  carrier: string | null;
}) {
  const { t } = useTranslation("cellular");
  return (
    <div className={AIM.STATE}>
      {registered ? (
        <Badge variant="success">
          <MaterialSymbol name="check_circle" size={BADGE_GLYPH_SIZE} filled />
          {t("cell_scanner.neighbour.live.registered")}
        </Badge>
      ) : (
        <Badge variant="warning">
          <MaterialSymbol name="warning" size={BADGE_GLYPH_SIZE} filled />
          {t("cell_scanner.neighbour.live.not_registered")}
        </Badge>
      )}
      {carrier ? (
        <span className={AIM.CAPTION}>{carrier}</span>
      ) : null}
      {!registered ? (
        <span className={cn(AIM.CAPTION, "text-pretty")}>
          {t("cell_scanner.neighbour.live.detached_note")}
        </span>
      ) : null}
    </div>
  );
}

/**
 * One big reading: key, figure, unit, meter, and the quality word for assistive
 * tech. A missing reading is an EMPTY TRACK and an em dash — never a zero-length
 * fill, which reads as "measured, and as bad as this metric goes".
 */
function AimReadout({
  label,
  value,
  unit,
  thresholds,
  index,
}: {
  label: string;
  value: number | null;
  unit: string;
  thresholds: SignalThresholds;
  index: number;
}) {
  const { t } = useTranslation("cellular");
  const tier = signalTier(value);

  return (
    <div className={AIM.READOUT}>
      <div className={AIM.READOUT_HEAD}>
        <span className={AIM.EYEBROW}>{label}</span>
        <MaterialSymbol
          name={SIGNAL_BADGE[tier].glyph}
          size={16}
          filled
          className="text-on-surface-variant"
        />
      </div>

      <div className="flex items-baseline gap-1">
        <span className={AIM.FIGURE}>
          {value === null ? "\u2014" : figureText(value)}
        </span>
        {value === null ? null : <span className={AIM.UNIT}>{unit}</span>}
        {/* The tint lives on the bar, not on the numeral: bar LENGTH is the
            channel DESIGN.md makes the ramp's non-chromatic partner, and a
            tinted figure with no bar beside it would be colour carrying a
            verdict alone. The word is the third channel, for a screen reader. */}
        <span className="sr-only">
          {value === null
            ? t("cell_scanner.neighbour.cells.unreported")
            : t(
                tier === "good"
                  ? "cell_scanner.signal.good"
                  : tier === "fair"
                    ? "cell_scanner.signal.fair"
                    : "cell_scanner.signal.poor",
              )}
        </span>
      </div>

      <div aria-hidden="true">
        <MetricBar
          /* A percentage for the LENGTH, from the product's own signal scale
             (`signalToProgress`, [floor, excellent] -> [0, 100]); the tone comes
             from this family's three-tier cut. Length is magnitude, the tier is
             the verdict — two ladders, and neither is asked to stand in for the
             other. */
          value={value === null ? null : signalToProgress(value, thresholds)}
          max={100}
          warnAt={NO_ALERT}
          dangerAt={NO_ALERT}
          colorOverride={signalBarTone(value)}
          track="surface-container-high"
          index={index}
        />
      </div>
    </div>
  );
}

/**
 * One ranked neighbour: rank, identity, a bar lane with the cell's peak, and the
 * reading.
 *
 * The peak marker is the affordance: it marks the best this cell has managed
 * since the range was entered, so a reader who swept past the sweet spot can see
 * it without having watched the number at the right instant. It is positioned
 * with `left` and is deliberately NOT transitioned — DESIGN.md's Transform-Only
 * Rule keeps layout properties out of transitions, and snapping is the honest
 * gesture for a discrete new high.
 */
function NeighbourRow({
  rank,
  row,
  peak,
  index,
}: {
  rank: number;
  row: NeighbourCellResult;
  peak: number | undefined;
  index: number;
}) {
  const { t } = useTranslation("cellular");
  const value = measuredRsrp(row.signalStrength);
  const band = bandOf(row);

  return (
    <div className={AIM.ROW}>
      <span className={AIM.RANK}>{rank}</span>

      <div className={AIM.ROW_IDENTITY}>
        <span className={AIM.ROW_PCI}>
          {row.pci === 0
            ? t("cell_scanner.neighbour.cells.unreported")
            : `${t("cell_scanner.columns.pci")} ${row.pci}`}
        </span>
        <span className={AIM.ROW_BAND}>
          {band ? band.label : t("cell_scanner.neighbour.cells.unreported")}
        </span>
      </div>

      <div className={AIM.ROW_LANE} aria-hidden="true">
        <MetricBar
          value={value === null ? null : signalToProgress(value, RSRP_THRESHOLDS)}
          max={100}
          warnAt={NO_ALERT}
          dangerAt={NO_ALERT}
          colorOverride={signalBarTone(value)}
          track="surface-container-high"
          index={index}
        />
        {peak !== undefined && value !== null && peak > value ? (
          <span
            className={AIM.PEAK_TICK}
            style={{ left: `calc(${signalToProgress(peak, RSRP_THRESHOLDS)}% - 1px)` }}
          />
        ) : null}
      </div>

      <span className={AIM.ROW_VALUE}>
        {value === null ? (
          <>
            <span aria-hidden="true">&mdash;</span>
            <span className="sr-only">
              {t("cell_scanner.neighbour.cells.unreported")}
            </span>
          </>
        ) : (
          t("cell_scanner.cells.signal", { value })
        )}
        {peak !== undefined ? (
          <span className="sr-only">
            {" "}
            {t("cell_scanner.neighbour.live.peak_sr", { value: peak })}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export interface AimStripProps {
  live: NeighbourLiveView;
  liveStop: LiveStop;
  liveFailed: boolean;
  /** Clear a pause or the five-minute stop. Owned by the transport hook. */
  onResume: () => void;
  /** The range picker, held in this card's head so it does not move when the range does. */
  rangePicker: React.ReactNode;
}

export function AimStrip({
  live,
  liveStop,
  liveFailed,
  onResume,
  rangePicker,
}: AimStripProps) {
  const { t } = useTranslation("cellular");

  const rsrp = normalizeMetricValue(live.serving?.rsrp ?? null, "rsrp");
  const sinr = normalizeMetricValue(live.serving?.sinr ?? null, "sinr");

  const neighbours = React.useMemo(
    () => topMeasured(live.cells, TOP_NEIGHBOURS),
    [live.cells],
  );

  // Peak-hold, per cell, since the component mounted — and it unmounts when the
  // range leaves `now`, which is exactly the reset R5 asks for. `recordPeaks`
  // returns the SAME object when nothing improved, so a steady sample does not
  // re-render the strip once a second for nothing.
  const [peaks, setPeaks] = React.useState<PeakMap>({});
  React.useEffect(() => {
    setPeaks((held) => recordPeaks(held, live.cells));
  }, [live.cells]);

  const age = live.ageS === null ? null : ageParts(live.ageS);
  const ageText =
    age === null
      ? null
      : t(
          age.unit === "s"
            ? "cell_scanner.neighbour.cells.age_seconds"
            : age.unit === "min"
              ? "cell_scanner.neighbour.cells.age_minutes"
              : "cell_scanner.neighbour.cells.age_hours",
          { value: age.value },
        );

  const stopNote =
    liveStop === "paused"
      ? t("cell_scanner.neighbour.live.stopped_paused")
      : liveStop === "expired"
        ? t("cell_scanner.neighbour.live.stopped_expired")
        : liveFailed
          ? t("cell_scanner.neighbour.live.stopped_failed")
          : null;

  return (
    <Card className={SCAN_RESULTS_CARD}>
      <div className={SECTION_HEAD.ROOT}>
        <div className={SECTION_HEAD.TITLES}>
          <h2 className={SECTION_HEAD.TITLE}>
            {t("cell_scanner.neighbour.live.title")}
          </h2>
          <p className={SECTION_HEAD.DESC}>
            {t("cell_scanner.neighbour.live.description")}
          </p>
        </div>
        <div className={SECTION_HEAD.META}>
          {ageText ? (
            <span className={AIM.CAPTION}>
              {t("cell_scanner.neighbour.live.updated", { age: ageText })}
            </span>
          ) : null}
          {rangePicker}
        </div>
      </div>

      {/* The attachment state is shown ONLY with a sample beside it. The CGI
          answers `registered: false` whenever it has no live file to read, and
          printing "Not registered" over that would accuse a perfectly healthy
          modem of being off the network. */}
      {live.liveAt === null ? (
        // No sample yet, or one the CGI judged too old to serve. Both mean the
        // same thing to the reader: the modem has not published a reading
        // recently, so there is nothing to aim by until it does.
        <p className={cn(AIM.CAPTION, "text-pretty")}>
          {t("cell_scanner.neighbour.live.waiting")}
        </p>
      ) : (
        <>
          <RegistrationState
            registered={live.registered}
            carrier={live.carrier}
          />

          <div className={AIM.READOUTS}>
            <AimReadout
              label={t("cell_scanner.neighbour.live.serving_rsrp")}
              value={rsrp}
              /* Units are symbols, not words: the repo passes them as literals
                 (`antenna-alignment/live-aim.tsx` does the same for dB/dBm)
                 rather than routing them through the catalogue. */
              unit="dBm"
              thresholds={RSRP_THRESHOLDS}
              index={0}
            />
            <AimReadout
              label={t("cell_scanner.neighbour.live.serving_sinr")}
              value={sinr}
              unit="dB"
              thresholds={SINR_THRESHOLDS}
              index={1}
            />
          </div>

          <div className={AIM.NEIGHBOURS}>
            <span className={AIM.EYEBROW}>
              {t("cell_scanner.neighbour.live.neighbours_title")}
            </span>
            {neighbours.length === 0 ? (
              <p className={cn(AIM.CAPTION, "text-pretty")}>
                {t("cell_scanner.neighbour.live.no_neighbours")}
              </p>
            ) : (
              neighbours.map((row, index) => (
                <NeighbourRow
                  key={cellKey(row)}
                  rank={index + 1}
                  row={row}
                  peak={peaks[cellKey(row)]}
                  index={index}
                />
              ))
            )}
          </div>
        </>
      )}

      {/* Both lines are facts about the surface, not states of the radio: one
          says what it costs, the other says it has stopped costing it. Neither
          carries a glyph: `schedule` would be true of the five-minute stop and
          false of a pause, and a mark that means something different in each of
          three states is the ambiguity the glyph rules exist to prevent. */}
      <div className={cn(AIM.CAPTION, "flex flex-wrap items-center gap-x-4 gap-y-2")}>
        <span className="text-pretty">
          {t("cell_scanner.neighbour.live.cost")}
        </span>
        {stopNote ? (
          <span className="flex flex-wrap items-center gap-2 text-on-surface">
            {stopNote}
            {liveStop !== null ? (
              <Button
                type="button"
                variant="tonal-neutral"
                className={PILL_QUIET}
                onClick={onResume}
              >
                {t("cell_scanner.neighbour.live.resume")}
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The strip's loading state, mirroring the loaded geometry by import.
 *
 * A live sample takes one poller cycle (~1 s) to exist at all, so this is on
 * screen only briefly — but a blank card that becomes a full one is a reflow
 * under the reader's thumb, and the shapes below come from the same constants
 * the loaded card uses.
 */
export function AimStripSkeleton({
  rangePicker,
}: {
  rangePicker: React.ReactNode;
}) {
  const { t } = useTranslation("cellular");

  return (
    <Card className={SCAN_RESULTS_CARD}>
      <div className={SECTION_HEAD.ROOT}>
        <div className={SECTION_HEAD.TITLES}>
          <h2 className={SECTION_HEAD.TITLE}>
            {t("cell_scanner.neighbour.live.title")}
          </h2>
        </div>
        <div className={SECTION_HEAD.META}>
          <Skeleton className={SKELETON_SHAPE.CHIP} />
          {rangePicker}
        </div>
      </div>

      <div className={AIM.READOUTS}>
        {[0, 1].map((index) => (
          <div key={index} className={AIM.READOUT}>
            <Skeleton className={SKELETON_SHAPE.DESC} />
            <Skeleton className={SKELETON_SHAPE.TITLE} />
            <Skeleton className={SKELETON_SHAPE.ROW} />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className={SKELETON_SHAPE.ROW} />
        ))}
      </div>
    </Card>
  );
}

export default AimStrip;
