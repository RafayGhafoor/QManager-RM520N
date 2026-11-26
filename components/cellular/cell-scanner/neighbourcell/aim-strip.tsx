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
import { aimTrend, type AimTrend } from "@/lib/aim-audio";
import { useAimAudio } from "@/hooks/use-aim-audio";
import { cn } from "@/lib/utils";
import type { NeighbourCellResult } from "@/types/cell-scanner";
import {
  RSSI_THRESHOLDS,
  RSRP_THRESHOLDS,
  RSRQ_THRESHOLDS,
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
// The aim console — the `now` range, rebuilt around one question
// =============================================================================
// "Is turning the dish this way better, worse, or neither?"
//
// That question has one answer, and the surface is built to give it in the time
// it takes to glance up from a mount. Everything else on the card is ranked
// below it:
//
//   1. THE SERVING RSRP, at the largest size on the page, with the direction of
//      travel beside it and a one-minute trace under it. A single figure tells
//      you where you are; the trace tells you which way you just came from, which
//      is the thing an operator actually acts on.
//   2. THE CARRIER'S OTHER READINGS — SINR, RSRQ, RSSI — as one row of smaller
//      readouts. They answer "is this a clean strong signal or a loud dirty one",
//      which is a follow-up question, not the first one.
//   3. THE NEIGHBOURS, ranked, with the peak each has reached since the range
//      opened, so a sweet spot swept past is still visible.
//
// WHAT WAS HERE BEFORE, and why it went. This card used to be a strip: two
// equal-sized readouts, three neighbour rows, a caption, a cost line, and two
// audio toggles at the bottom — with the full sortable table of the SAME cells
// directly beneath it, competing for the same attention. Two lists of the same
// neighbours on one screen is not redundancy, it is indecision: nothing tells the
// reader which one to look at, so they read neither while turning a dish. The
// table is still there, behind a disclosure (see `neighbour-scanner.tsx`), because
// it is genuinely useful when you have PUT the dish down and want to know what is
// out there.
//
// CONTROLS SIT AT THE TOP. Pause, the audible aid and the export are on the
// console's own toolbar rather than under the fold: an operator who has just
// walked twenty metres to the antenna must not have to scroll to silence the
// beeps.
// =============================================================================

/** How many neighbours the console ranks. Four: what fits above the fold on a
 *  phone in landscape, which is how this page is read in the field. */
const TOP_NEIGHBOURS = 4;

/** The metric bars' threshold props. Both are inert: the tone comes from the
 *  three-tier scale, not from a percentage crossing a cut. */
const NO_ALERT = 101;

/** One serving readout in the secondary row. */
interface SecondaryMetric {
  id: "sinr" | "rsrq" | "rssi";
  label: string;
  value: number | null;
  unit: "dB" | "dBm";
  thresholds: SignalThresholds;
}

/**
 * The trace under the hero figure.
 *
 * A 30-line inline SVG rather than a chart library: this draws at most 90 points
 * from a fixed window, it must not animate (the figures retarget at 1 Hz and a
 * redraw would compete with the number above it), and pulling recharts in here
 * would cost a route chunk for a polyline. The scale is the RSRP quality window
 * — the same one the bar under the figure uses — so the trace and the bar cannot
 * disagree about where −80 dBm sits.
 *
 * Absent readings are GAPS, not zeros: dropping the point leaves a break in the
 * line, where a zero would draw a dive to the floor that never happened.
 */
function RsrpTrace({ points }: { points: (number | null)[] }) {
  const { t } = useTranslation("cellular");
  const width = 300;
  const height = 56;

  const segments = React.useMemo(() => {
    const range = RSRP_THRESHOLDS.range;
    const span = range.max - range.min;
    const stepX = points.length > 1 ? width / (points.length - 1) : width;
    const paths: string[] = [];
    let current: string[] = [];

    points.forEach((value, index) => {
      if (value === null) {
        if (current.length > 0) paths.push(current.join(" "));
        current = [];
        return;
      }
      const clamped = Math.min(Math.max(value, range.min), range.max);
      const y = height - ((clamped - range.min) / span) * height;
      current.push(`${current.length === 0 ? "M" : "L"}${(index * stepX).toFixed(1)},${y.toFixed(1)}`);
    });
    if (current.length > 0) paths.push(current.join(" "));
    return paths;
  }, [points]);

  return (
    <svg
      className="h-14 w-full"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={t("cell_scanner.neighbour.live.trace_label")}
    >
      {segments.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-quality-4"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

/**
 * The direction of travel, as a chip.
 *
 * The visual twin of the beep: the same `aimTrend()` decision drives both, so a
 * sound and a chip cannot disagree about which way the dish moved. Three states
 * and three GLYPHS — up arrow, down arrow, flat waveform — because on this
 * surface the chip is read in sunlight, where a fill difference between
 * `success-container` and `destructive-container` is not a difference at all.
 */
function TrendChip({ trend, delta }: { trend: AimTrend; delta: number }) {
  const { t } = useTranslation("cellular");
  if (trend === "unknown") return null;
  const rounded = Math.round(Math.abs(delta));

  if (trend === "steady") {
    return (
      <Badge variant="muted" className="text-sm">
        <MaterialSymbol name="graphic_eq" size={BADGE_GLYPH_SIZE} filled />
        {t("cell_scanner.neighbour.live.trend_steady")}
      </Badge>
    );
  }

  return trend === "improving" ? (
    <Badge variant="success" className="text-sm">
      <MaterialSymbol name="arrow_upward" size={BADGE_GLYPH_SIZE} filled />
      {t("cell_scanner.neighbour.live.trend_up", { value: rounded })}
    </Badge>
  ) : (
    <Badge variant="destructive" className="text-sm">
      <MaterialSymbol name="arrow_downward" size={BADGE_GLYPH_SIZE} filled />
      {t("cell_scanner.neighbour.live.trend_down", { value: rounded })}
    </Badge>
  );
}

/**
 * One secondary reading: label, figure, bar.
 *
 * No quality chip and no ramp ink on the figure — the bar's length carries the
 * reading, which is the one channel DESIGN.md lets a minuscule row rely on.
 */
function SecondaryReadout({ metric, index }: { metric: SecondaryMetric; index: number }) {
  const { t } = useTranslation("cellular");
  const tier = signalTier(metric.value);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-on-surface-variant">
          {metric.label}
        </span>
        <span className="flex items-baseline gap-1">
          <span className="text-[18px] font-semibold tabular-nums">
            {metric.value === null ? "\u2014" : metric.value}
          </span>
          {metric.value === null ? null : (
            <span className="text-[13px] font-semibold text-on-surface-variant">
              {metric.unit}
            </span>
          )}
        </span>
      </div>
      <div aria-hidden="true">
        <MetricBar
          value={
            metric.value === null
              ? null
              : signalToProgress(metric.value, metric.thresholds)
          }
          max={100}
          warnAt={NO_ALERT}
          dangerAt={NO_ALERT}
          colorOverride={signalBarTone(metric.value)}
          track="surface-container-high"
          index={index}
        />
      </div>
      <span className="sr-only">
        {metric.value === null
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
  );
}

/**
 * One ranked neighbour: rank, identity, bar with its peak, reading, and how far
 * it just moved.
 *
 * The peak marker is the affordance: it marks the best this cell has managed
 * since the range was entered, so a reader who swept past the sweet spot can see
 * it without having watched the number at the right instant. It is positioned
 * with `left` and deliberately NOT transitioned — a new best is a discrete event.
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
  /** Pause/resume, export — the page's own actions, placed by this card. */
  actions?: React.ReactNode;
}

export function AimStrip({
  live,
  liveStop,
  liveFailed,
  onResume,
  rangePicker,
  actions,
}: AimStripProps) {
  const { t } = useTranslation("cellular");

  const rsrp = normalizeMetricValue(live.serving?.rsrp ?? null, "rsrp");
  const sinr = normalizeMetricValue(live.serving?.sinr ?? null, "sinr");
  const rsrq = normalizeMetricValue(live.serving?.rsrq ?? null, "rsrq");
  const rssi = normalizeMetricValue(live.serving?.rssi ?? null, "rssi");

  // ── The one-minute trace ───────────────────────────────────────────────────
  // A ring buffer of the last TRACE_POINTS samples, appended once per FRESH
  // sample. Held samples append nothing: repeating a reading would draw a flat
  // stretch that looks like "the antenna is not moving" when the truth is "the
  // modem is not publishing".
  const [trace, setTrace] = React.useState<(number | null)[]>([]);
  React.useEffect(() => {
    if (live.stale) return;
    if (live.liveAt === null) return;
    setTrace((points) =>
      [...points, rsrp].slice(-TRACE_POINTS),
    );
  }, [live.liveAt, live.stale, rsrp]);

  // Neighbours ranked by measured RSRP; the peak-hold resets when this card
  // unmounts, which is exactly when the range leaves `now`.
  const neighbours = React.useMemo(
    () => topMeasured(live.cells, TOP_NEIGHBOURS),
    [live.cells],
  );

  const [peaks, setPeaks] = React.useState<PeakMap>({});
  React.useEffect(() => {
    setPeaks((held) => recordPeaks(held, live.cells));
  }, [live.cells]);

  // ── Direction of travel, and the audible aid ───────────────────────────────
  // ONE decision feeds three outputs: the chip, the beep and the spoken line, so
  // what you hear is what is on screen. The comparison metric is the serving RSRP
  // and NOT the best neighbour — the serving cell is the one the dish is pointed
  // at and the one a lock will apply to.
  //
  // A HELD sample is never compared: repeating a figure with a new timestamp
  // would read as "steady", which is a claim about the antenna that no fresh
  // reading supports.
  //
  // Destructured so the effect depends on STABLE callbacks: the hook returns a
  // fresh object every render, and an object dependency would re-fire the beep
  // once a render instead of once a sample.
  const {
    beep,
    speak,
    beepsOn,
    voiceOn,
    toggleBeeps,
    toggleVoice,
    voiceSupported,
  } = useAimAudio();

  const previousRsrpRef = React.useRef<number | null>(null);
  const [trend, setTrend] = React.useState<{ dir: AimTrend; delta: number }>({
    dir: "unknown",
    delta: 0,
  });

  React.useEffect(() => {
    if (live.stale) return;
    const previous = previousRsrpRef.current;
    const dir = aimTrend(previous, rsrp);
    const delta = previous === null || rsrp === null ? 0 : rsrp - previous;
    previousRsrpRef.current = rsrp;
    setTrend({ dir, delta });

    if (rsrp === null) return;
    beep(dir);
    // Speech carries the figure the beep cannot: which metric, what value, and
    // which way it just went. Throttled inside the hook, so calling it on every
    // sample is correct — the hook decides when a line is due.
    if (dir === "improving" || dir === "degrading") {
      speak(
        `${t("cell_scanner.neighbour.live.speech_reading", { value: rsrp })} ${
          dir === "improving"
            ? t("cell_scanner.neighbour.live.speech_improving")
            : t("cell_scanner.neighbour.live.speech_worse")
        }`,
      );
    }
  }, [rsrp, live.stale, beep, speak, t]);

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

  const tier = signalTier(rsrp);

  const secondary: SecondaryMetric[] = [
    {
      id: "sinr",
      label: t("cell_scanner.neighbour.live.serving_sinr"),
      value: sinr,
      unit: "dB",
      thresholds: SINR_THRESHOLDS,
    },
    {
      id: "rsrq",
      label: t("cell_scanner.neighbour.live.serving_rsrq"),
      value: rsrq,
      unit: "dB",
      thresholds: RSRQ_THRESHOLDS,
    },
    {
      id: "rssi",
      label: t("cell_scanner.neighbour.live.serving_rssi"),
      value: rssi,
      unit: "dBm",
      thresholds: RSSI_THRESHOLDS,
    },
  ];

  return (
    <Card className={SCAN_RESULTS_CARD}>
      {/* ── Toolbar: the range, the actions, the audible aid ─────────────── */}
      <div className={SECTION_HEAD.ROOT}>
        <div className={SECTION_HEAD.TITLES}>
          <h2 className={SECTION_HEAD.TITLE}>
            {t("cell_scanner.neighbour.live.title")}
          </h2>
          <p className={SECTION_HEAD.DESC}>
            {t("cell_scanner.neighbour.live.description")}
          </p>
        </div>
        <div className={cn(SECTION_HEAD.META, "flex-wrap")}>
          {live.stale && ageText ? (
            <Badge variant="warning">
              <MaterialSymbol name="schedule" size={BADGE_GLYPH_SIZE} filled />
              {t("cell_scanner.neighbour.live.holding", { age: ageText })}
            </Badge>
          ) : ageText ? (
            <span className={AIM.CAPTION}>
              {t("cell_scanner.neighbour.live.updated", { age: ageText })}
            </span>
          ) : null}
          {rangePicker}
          {actions}
        </div>
      </div>

      {/* The audible aid, directly under the toolbar and above the fold. Two
          word-only toggles: the icon subset carries no speaker, ear or
          microphone mark, and the words are unambiguous while the filled pill is
          what changes. `aria-pressed` is what makes them toggles to a screen
          reader rather than two buttons that might navigate. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={AIM.CAPTION}>
          {t("cell_scanner.neighbour.live.audio_title")}
        </span>
        <Button
          type="button"
          variant={beepsOn ? "tonal" : "tonal-neutral"}
          className={PILL_QUIET}
          aria-pressed={beepsOn}
          onClick={toggleBeeps}
        >
          {t("cell_scanner.neighbour.live.audio_beeps")}
        </Button>
        {voiceSupported ? (
          <Button
            type="button"
            variant={voiceOn ? "tonal" : "tonal-neutral"}
            className={PILL_QUIET}
            aria-pressed={voiceOn}
            onClick={toggleVoice}
          >
            {t("cell_scanner.neighbour.live.audio_voice")}
          </Button>
        ) : null}
        <span className={cn(AIM.CAPTION, "text-pretty")}>
          {t("cell_scanner.neighbour.live.audio_hint")}
        </span>
      </div>

      {live.liveAt === null ? (
        // No sample yet, or one the CGI judged too old to serve. Both mean the
        // same thing to the reader: nothing to aim by until the modem publishes.
        <p className={cn(AIM.CAPTION, "text-pretty")}>
          {t("cell_scanner.neighbour.live.waiting")}
        </p>
      ) : (
        <>
          {/* ── The hero: one figure, one direction, one trace ──────────── */}
          <div className={AIM.HERO}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className={AIM.EYEBROW}>
                {t("cell_scanner.neighbour.live.serving_rsrp")}
              </span>
              <MaterialSymbol
                name={SIGNAL_BADGE[tier].glyph}
                size={18}
                filled
                className="text-on-surface-variant"
              />
              <TrendChip trend={trend.dir} delta={trend.delta} />
            </div>

            <div className="flex items-baseline gap-2">
              <span className={AIM.HERO_FIGURE}>
                {rsrp === null ? "\u2014" : rsrp}
              </span>
              {rsrp === null ? null : (
                <span className={AIM.HERO_UNIT}>dBm</span>
              )}
              <span className="sr-only">
                {rsrp === null
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

            <RsrpTrace points={trace} />

            {/* Attachment, beside the figures it makes interpretable and never
                above them: QMI reports signal for whatever cell the radio can
                HEAR, attached or not, so a strong figure beside a detached modem
                is the one reading that would send an operator to the wrong
                tower. `registered: false` with no sample is NOT shown — the CGI
                answers that whenever it has no live file, and printing it would
                accuse a healthy modem. */}
            {live.registered ? (
              <div className={AIM.STATE}>
                <Badge variant="success">
                  <MaterialSymbol
                    name="check_circle"
                    size={BADGE_GLYPH_SIZE}
                    filled
                  />
                  {t("cell_scanner.neighbour.live.registered")}
                </Badge>
                {live.carrier ? (
                  <span className={AIM.CAPTION}>{live.carrier}</span>
                ) : null}
              </div>
            ) : (
              <div className={AIM.STATE}>
                <Badge variant="warning">
                  <MaterialSymbol
                    name="warning"
                    size={BADGE_GLYPH_SIZE}
                    filled
                  />
                  {t("cell_scanner.neighbour.live.not_registered")}
                </Badge>
                {live.carrier ? (
                  <span className={AIM.CAPTION}>{live.carrier}</span>
                ) : null}
                <span className={cn(AIM.CAPTION, "text-pretty")}>
                  {t("cell_scanner.neighbour.live.detached_note")}
                </span>
              </div>
            )}
          </div>

          {/* ── The carrier's other readings ─────────────────────────────── */}
          <div className="grid grid-cols-1 gap-4 @md/section:grid-cols-3">
            {secondary.map((metric, index) => (
              <SecondaryReadout key={metric.id} metric={metric} index={index} />
            ))}
          </div>

          {/* ── The neighbours ───────────────────────────────────────────── */}
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
          says what it costs, the other says it has stopped costing it. */}
      <div
        className={cn(
          AIM.CAPTION,
          "flex flex-wrap items-center gap-x-4 gap-y-2",
        )}
      >
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

/** How many samples the trace holds: one minute at the poller's 1 Hz cadence. */
const TRACE_POINTS = 60;

/**
 * The console's loading state, mirroring the loaded geometry by import.
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

      <div className={AIM.HERO}>
        <Skeleton className={SKELETON_SHAPE.DESC} />
        <Skeleton className={cn(SKELETON_SHAPE.TITLE, "h-12 w-40")} />
        <Skeleton className={cn(SKELETON_SHAPE.ROW, "h-14")} />
      </div>

      <div className="grid grid-cols-1 gap-4 @md/section:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className={SKELETON_SHAPE.DESC} />
            <Skeleton className={SKELETON_SHAPE.ROW} />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2.5">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className={SKELETON_SHAPE.ROW} />
        ))}
      </div>
    </Card>
  );
}

export default AimStrip;
