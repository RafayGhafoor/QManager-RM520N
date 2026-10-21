"use client";

import { useTranslation } from "react-i18next";

import {
  qualityInkClass,
  qualityMeterTone,
} from "@/components/cellular/signal-quality-display";
import { HintIcon } from "@/components/ui/hint-icon";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import { MetricBar } from "@/components/ui/metric-bar";
import { glossaryFor, type MetricId } from "@/lib/metric-glossary";
import { cn } from "@/lib/utils";
import {
  getSignalQuality,
  signalToProgress,
  type SignalThresholds,
} from "@/types/modem-status";

import { METRIC_ROW, UNAVAILABLE_ROW } from "./shapes";

// =============================================================================
// Metric cells
// =============================================================================
// Three row shapes, one geometry:
//
//   MetricFigure        a measured value. A `null` reading is an em dash — never
//                       a zero, never a blank — and, when the row is graded, an
//                       EMPTY TRACK rather than a zero-length fill.
//   MetricRow           the same row for a figure that is not a number (a
//                       carrier name, an RAT tag, an RRC state code).
//   UnavailableMetricRow a field this module cannot report at all. It has no
//                       figure slot, so it cannot decay into a dash or a 0.
//
// Two helpers serve them: `MetricHint` (the tip body alone, for a table column
// header) and `AbsentFigure` (the dash and its screen-reader word).
//
// EVERY cell's tip is fed from `lib/metric-glossary.ts` through a `MetricId`
// prop, which is what makes an unexplained metric a `tsc` error rather than a
// bare ⓘ on a shipped page.
//
// QUALITY IS NOT HUE. A graded row carries it three ways: the bar's LENGTH on a
// fixed 0–100 scale, the numeral's own digits, and an `sr-only` quality word.
// The ramp hue is reinforcement on top of those, which is why the bar is
// `aria-hidden` — it repeats the number and the word, and announcing it again as
// an unlabelled percentage would be the third reading of one fact
// (DESIGN.md > Quality bars; `antenna-statistics/tech-card.tsx` is the pattern).
// =============================================================================

/** The em dash every absent reading renders as. One character, no plural. */
const DASH = "—";

/**
 * A measured figure, as reported. An integer prints as an integer; a fractional
 * reading keeps one decimal rather than being rounded to a whole number the
 * modem never reported.
 */
function figureText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * An absent reading: a dash for the eye and a word for the screen reader. The
 * dash alone would be announced as "dash" or skipped, and the finding is the
 * word.
 */
export function AbsentFigure() {
  const { t } = useTranslation("cellular");
  return (
    <>
      <span className={METRIC_ROW.ABSENT} aria-hidden="true">
        {DASH}
      </span>
      <span className="sr-only">{t("radio_info.common.value_unavailable")}</span>
    </>
  );
}

export interface MetricHintProps {
  metric: MetricId;
  /** Already-translated label, used for the trigger's accessible name. */
  label: string;
}

/**
 * The tip for one metric: what it means, the span it is reported in, and which
 * direction is good. All three come from the glossary, so a metric cannot be
 * displayed with a different explanation in two groups.
 */
export function MetricHint({ metric, label }: MetricHintProps) {
  const { t } = useTranslation("cellular");
  const entry = glossaryFor(metric);

  return (
    <HintIcon label={t("detailed_metrics.hint_label", { metric: label })}>
      <span className="flex flex-col gap-1">
        <span>{t(entry.explanation)}</span>
        {entry.range ? (
          <span className="text-on-surface-variant">
            {t("detailed_metrics.reporting_range", { range: entry.range })}
          </span>
        ) : null}
        <span className="text-on-surface-variant">
          {t(`detailed_metrics.better.${entry.better}`)}
        </span>
      </span>
    </HintIcon>
  );
}

export interface MetricFigureProps {
  metric: MetricId;
  label: string;
  /** `null` means the modem did not report it. Never pass a sentinel. */
  value: number | null;
  unit?: string;
  /**
   * Present ⇒ the reading is a signal measurement with a vetted scale in
   * `types/modem-status.ts`: the row draws a bar and tints the numeral. Absent
   * ⇒ a plain indexed figure (CQI, RI, MCS, a TM mode), which has no scale here
   * and must not be given an invented one.
   */
  scale?: SignalThresholds;
  /** Row position, for the meters' arrival cascade. */
  index?: number;
}

export function MetricFigure({
  metric,
  label,
  value,
  unit,
  scale,
  index = 0,
}: MetricFigureProps) {
  const { t } = useTranslation("cellular");

  // One decision drives the numeral, the tone AND the word. `getSignalQuality`
  // returns `none` for a missing value and for one outside the metric's
  // reported range, and `qualityMeterTone` returns `null` for `none` — so a
  // reading the radio did not take can never be painted as the bottom of the
  // ramp, which is the single most misleading thing a signal bar can do.
  const quality = scale ? getSignalQuality(value, scale) : null;
  const tone = quality ? qualityMeterTone(quality) : null;
  const reading = quality === null ? value : tone === null ? null : value;

  const absent = reading === null;

  return (
    <div className={METRIC_ROW.ROOT}>
      <div className={METRIC_ROW.HEAD}>
        <span className={METRIC_ROW.LABEL}>{label}</span>
        <MetricHint metric={metric} label={label} />
        <span
          className={cn(
            METRIC_ROW.FIGURE,
            absent
              ? METRIC_ROW.ABSENT
              : quality
                ? qualityInkClass(quality)
                : undefined,
          )}
        >
          {absent ? (
            <AbsentFigure />
          ) : (
            <>
              {figureText(reading)}
              {unit ? <span className={METRIC_ROW.UNIT}>{unit}</span> : null}
              {/* The quality word, for the ramp tone and the bar length to have
                  a text counterpart. Decorative only when there is no scale. */}
              {quality ? (
                <span className="sr-only">
                  {t(`radio_info.bands.quality.${quality}`)}
                </span>
              ) : null}
            </>
          )}
        </span>
      </div>
      {scale ? (
        <div aria-hidden="true">
          <MetricBar
            value={absent ? null : signalToProgress(reading, scale)}
            max={100}
            // Unreachable on purpose: `colorOverride` pins the tone from the
            // quality bucket, so the built-in steps never apply.
            warnAt={101}
            dangerAt={101}
            colorOverride={tone}
            index={index}
          />
        </div>
      ) : null}
    </div>
  );
}

export interface MetricRowProps {
  metric: MetricId;
  label: string;
  /** The figure slot. Text, a `Tag`, a badge — anything but a metric bar. */
  children: React.ReactNode;
}

/**
 * The row shell for a figure that is not a plain number — a carrier name, an
 * RAT identity, an RRC state code. Same label, same tip, same trailing slot as
 * `MetricFigure`, so the groups read as one column rather than as two idioms.
 */
export function MetricRow({ metric, label, children }: MetricRowProps) {
  return (
    <div className={METRIC_ROW.ROOT}>
      <div className={METRIC_ROW.HEAD}>
        <span className={METRIC_ROW.LABEL}>{label}</span>
        <MetricHint metric={metric} label={label} />
        <span className={METRIC_ROW.FIGURE}>{children}</span>
      </div>
    </div>
  );
}

export interface UnavailableMetricRowProps {
  metric: MetricId;
  label: string;
}

/**
 * A field this module cannot report at all, stated as such. Not a dash: a dash
 * says "not this time", which invites a reload, and a `0` would be a lie the
 * reader could act on.
 */
export function UnavailableMetricRow({ metric, label }: UnavailableMetricRowProps) {
  const { t } = useTranslation("cellular");

  return (
    <div className={UNAVAILABLE_ROW.ROOT}>
      <span className={UNAVAILABLE_ROW.LABEL}>
        <MaterialSymbol name="info" size={16} className="text-on-surface-variant" />
        {label}
        <MetricHint metric={metric} label={label} />
      </span>
      <span className={UNAVAILABLE_ROW.NOTE}>
        {t("detailed_metrics.not_reported_by_modem")}
      </span>
    </div>
  );
}
