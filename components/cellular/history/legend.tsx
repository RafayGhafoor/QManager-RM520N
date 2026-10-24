"use client";

import { useTranslation } from "react-i18next";

import type { BandCombo } from "@/types/cell-history";
import { cn } from "@/lib/utils";

import { comboTone } from "./bands-card";
import { METRIC_AXIS, type AvailabilityTier } from "./derive";
import { LEGEND, SERIES_TONE, STRIP, TIER } from "./shapes";

// =============================================================================
// Legend — how to read this page, stated once, in one strip
// =============================================================================
// Three swatch groups, each one a fact the panels below rely on and none of
// them a restatement of a panel's own legend:
//
//   availability  the four stops of the hero strip, drawn with `TIER`'s own
//                 fill AND height. Imported, not restated: the strip and this
//                 key are the same map, so they cannot drift into two
//                 vocabularies for the same four states. Height matters here
//                 for the reason `shapes.ts` gives — the stops are a lightness
//                 staircase, and the ladder must be legible in greyscale.
//   series        a stroke key drawn as the stroke itself (a 2px rule, the
//                 line's own width), one entry per tone the charts below
//                 actually plot. The list is DERIVED from `METRIC_AXIS`, so a
//                 metric moving to another tone changes this key with it.
//   bands         the top three combos by time share, wearing the tone
//                 `comboTone` gives them. That function is IMPORTED from the
//                 bands card rather than re-implemented: two hashes would
//                 eventually disagree, and a legend that lies about which
//                 violet is which is worse than no legend.
//
// Then TWO PLAIN LINES — the gap rule and the cadence. Neither is a swatch,
// because neither is a colour: they are the two claims a reader must hold to
// read any panel correctly, and they apply to the whole page rather than to one
// group.
//
// NOT A CARD. It sits between the controls and the panels, so it may not carry
// a surface or a shadow — a card there would read as the first panel. It does
// declare its own container, because its three groups reflow on the PAGE
// COLUMN's width (one column, then two-up, then three across), not the window's.
// =============================================================================

export interface LegendProps {
  /**
   * Per-combo rollup, most samples first. The key shows the first three; an
   * empty list (no payload yet, or a pre-v3 window) hides the band group
   * entirely rather than showing a colour key with nothing to key.
   */
  combos: BandCombo[];
}

/** How many combos the key names before it stops being a key and becomes a list. */
const LEGEND_COMBOS = 3;

const TIERS: readonly AvailabilityTier[] = ["up", "partial", "down", "unknown"];

/**
 * The tones the charts below actually draw with, in the order the page uses
 * them, each with the label it is known by.
 *
 * `--chart-lte` is deliberately absent: no entry in `METRIC_AXIS` plots with it
 * (every signal metric is `--chart-nr`), and a key for a stroke that appears
 * nowhere is a false statement about the page. `SERIES_TONE` is the same source
 * the charts read, so a chart changing its tone changes this row.
 */
const SERIES_KEYS = [
  { tone: SERIES_TONE.nr, labelKey: "history.charts.series.nr" },
  { tone: SERIES_TONE.down, labelKey: "history.charts.metric.dl" },
  { tone: SERIES_TONE.up, labelKey: "history.charts.metric.ul" },
] as const;

/** Which of those tones any plottable metric is on — derived, never hard-coded. */
const PLOTTED_TONES: ReadonlySet<string> = new Set(
  Object.values(METRIC_AXIS).map((axis) => axis.tone),
);

export function Legend({ combos }: LegendProps) {
  const { t } = useTranslation("cellular");
  const top = combos.slice(0, LEGEND_COMBOS);
  const series = SERIES_KEYS.filter((entry) => PLOTTED_TONES.has(entry.tone));

  return (
    <section className={LEGEND.ROOT} aria-label={t("history.legend.legend_aria")}>
      <h2 className={LEGEND.TITLE}>{t("history.legend.title")}</h2>

      <div className={LEGEND.GROUPS}>
        <div className={LEGEND.GROUP}>
          <h3 className={LEGEND.GROUP_LABEL}>{t("history.legend.availability")}</h3>
          <ul className={LEGEND.ITEMS}>
            {TIERS.map((tier) => (
              <li key={tier} className={LEGEND.ITEM}>
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

        <div className={LEGEND.GROUP}>
          <h3 className={LEGEND.GROUP_LABEL}>{t("history.legend.series")}</h3>
          <ul className={LEGEND.ITEMS}>
            {series.map((entry) => (
              <li key={entry.labelKey} className={LEGEND.ITEM}>
                <span
                  className={LEGEND.LINE}
                  style={{ backgroundColor: entry.tone }}
                  aria-hidden="true"
                />
                {t(entry.labelKey)}
              </li>
            ))}
          </ul>
        </div>

        {top.length > 0 ? (
          <div className={LEGEND.GROUP}>
            <h3 className={LEGEND.GROUP_LABEL}>{t("history.legend.bands")}</h3>
            <ul className={LEGEND.ITEMS}>
              {top.map((combo) => (
                <li
                  key={`${combo.bands ?? "-"}-${combo.first_ts}`}
                  className={LEGEND.ITEM}
                >
                  <span
                    className={cn(
                      LEGEND.BAND_SWATCH,
                      comboTone(combo.bands).fill,
                    )}
                    aria-hidden="true"
                  />
                  {combo.bands ?? t("history.bands.unknown")}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {/* The two claims that are not colours. They sit BELOW the swatch grid
          rather than in a fourth cell, because a heading over a whole sentence
          would be a label for a sentence — and both lines apply to every panel
          on the page, not to one group. */}
      <div className={LEGEND.NOTES}>
        <p className={LEGEND.NOTE}>{t("history.legend.gap")}</p>
        <p className={LEGEND.NOTE}>{t("history.legend.cadence")}</p>
      </div>
    </section>
  );
}

export default Legend;
