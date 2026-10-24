"use client";

import { useTranslation } from "react-i18next";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  BandCombo,
  BandRun,
  CellHistoryWindow,
} from "@/types/cell-history";
import { cn } from "@/lib/utils";

import {
  formatClock,
  formatMoment,
  formatPct,
  formatSpan,
  hourTicks,
  windowSeconds,
} from "./derive";
import { PanelEmpty } from "./empty-state";
import { BANDS, CARD, FULL, HEAD, STRIP, TABLE } from "./shapes";

// =============================================================================
// BandsCard — which bands served, and every aggregation combo that appeared
// =============================================================================
// The answer to the second half of the field complaint. The timeline shows the
// SERVING CELL; this shows the BAND SET, and the two differ on purpose: an
// aggregated carrier can come and go without the serving cell changing at all,
// and that is exactly the transition a reader chasing "band 1 vanished at
// night" is looking for.
//
//  * A SEGMENT BOUNDARY IS A COMBO CHANGE. `cells.bands` is cut by the backend
//    wherever the `+`-joined band string changes, so a strip segment is one
//    uninterrupted combo, positioned by its start and end as a fraction of the
//    window — the gantt's geometry, not a second one.
//  * COLOUR IS A PAIRING AID, NOT THE DATUM. A combo's tone is a stable hash of
//    the combo STRING (`comboTone`), so `B3+B1+N78` looks the same on every
//    render, range and reload, and two adjacent runs of different combos are
//    told apart before the label is read. Deriving it from the array index
//    would repaint the whole strip whenever the window moved. The shade is
//    never the key: the combo is printed inside every segment wide enough to
//    hold it, in the tooltip of every segment that is not, and in the table
//    below with its own swatch.
//  * NO EMPTY AXIS. A window that predates band recording has no runs, and an
//    empty track would read as "one combo, all range". It says so instead.
//  * `ca_cc` AND `bw_mhz` ARE INDEPENDENT. A run may report a carrier count
//    with no bandwidth, or the reverse, so the tooltip renders whichever exists
//    and nothing at all when neither does — the same never-coalesce rule the
//    contract states for every other absent reading.
// =============================================================================

export interface BandsCardProps {
  /** Combo runs, oldest first. Empty for a pre-v3 window. */
  runs: BandRun[];
  /** Per-combo rollup, most samples first (the backend sorts it). */
  combos: BandCombo[];
  window: CellHistoryWindow;
  /** True past a day, where a bare `HH:MM` in a tick loses the date. */
  longSpan: boolean;
}

/** Below this width a segment's label would be clipped mid-combo, so it is hover only. */
const LABEL_MIN_PCT = 12;
/** A one-minute run on a 30-day range must still be a visible mark. */
const MIN_SEGMENT_PCT = 0.5;

const DASH = "—";

/**
 * The tone ramp a combo is hashed into.
 *
 * FOUR authored fill/ink pairs, and every one of them is a `DESIGN.md` role the
 * page already paints with (`BAND_TONE` uses the first and the third, the
 * availability strip the second) — never a raw hex, never a `--chart-*` stroke.
 * A stroke token has no ink of its own, and the label sits ON the fill, so a
 * stroke here would need a foreground invented for it. The order is fixed: it
 * is the hash's modulo, so reordering this array repaints every combo.
 */
const COMBO_TONE = [
  { fill: "bg-lte", ink: "text-lte-foreground" },
  { fill: "bg-primary", ink: "text-primary-foreground" },
  { fill: "bg-lte-container", ink: "text-on-lte-container" },
  { fill: "bg-primary-container", ink: "text-on-primary-container" },
] as const;

export type ComboTone = (typeof COMBO_TONE)[number];

/**
 * A combo's tone, stable across renders, ranges and reloads.
 *
 * Exported because the page legend keys the top three combos with the SAME
 * function: a legend swatch that drifted from the strip would be worse than no
 * legend (the two would disagree about what violet means).
 *
 * It is a djb2 hash of the whole string, seeded with the length so two combos
 * of different widths are not separated by their last character alone — the
 * same construction as `bandVariant`, one step wider because a combo string
 * carries far more information than a single band. The modulo is the ramp's
 * length; nothing here is random, and nothing reads the clock.
 */
export function comboTone(bands: string | null): ComboTone {
  const text = bands ?? "";
  let hash = 5381 + text.length * 131;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return COMBO_TONE[(hash >>> 0) % COMBO_TONE.length];
}

interface BandSegment {
  key: string;
  run: BandRun;
  leftPct: number;
  widthPct: number;
}

/** Runs as percentages of the window, clamped to it and floored at a visible width. */
function bandSegments(
  runs: BandRun[],
  window: CellHistoryWindow,
): BandSegment[] {
  const span = windowSeconds(window);
  if (span <= 0) return [];

  const segments: BandSegment[] = [];
  for (const run of runs) {
    const start = Math.max(run.start_ts, window.start);
    const end = Math.min(run.end_ts, window.end);
    if (end <= start) continue;
    const leftPct = Math.min(
      ((start - window.start) / span) * 100,
      100 - MIN_SEGMENT_PCT,
    );
    const widthPct = Math.min(
      Math.max(((end - start) / span) * 100, MIN_SEGMENT_PCT),
      100 - leftPct,
    );
    segments.push({
      key: `${run.start_ts}-${run.bands ?? "-"}`,
      run,
      leftPct,
      widthPct,
    });
  }
  return segments;
}

export function BandsCard({ runs, combos, window, longSpan }: BandsCardProps) {
  const { t } = useTranslation("cellular");
  const segments = bandSegments(runs, window);
  const ticks = hourTicks(window);

  const moment = (ts: number) => (longSpan ? formatMoment(ts) : formatClock(ts));

  const comboText = (bands: string | null) =>
    bands ?? t("history.bands.unknown");

  /** The duration line, then whichever of carriers/bandwidth the run reported. */
  const runDetail = (run: BandRun): string => {
    const lines = [
      t("history.bands.run_tip", {
        bands: comboText(run.bands),
        duration: formatSpan(Math.max(0, run.end_ts - run.start_ts)),
      }),
    ];
    if (run.ca_cc !== null && run.bw_mhz !== null) {
      lines.push(
        t("history.bands.run_meta", { ca: run.ca_cc, bw: run.bw_mhz }),
      );
    } else if (run.ca_cc !== null) {
      lines.push(t("history.bands.run_meta_ca", { ca: run.ca_cc }));
    } else if (run.bw_mhz !== null) {
      lines.push(t("history.bands.run_meta_bw", { bw: run.bw_mhz }));
    }
    return lines.join("\n");
  };

  const total = combos.reduce((sum, combo) => sum + combo.samples, 0);

  return (
    <section className={cn(CARD, FULL)}>
      <header className={HEAD.ROOT}>
        <h2 className={HEAD.TITLE}>{t("history.bands.title")}</h2>
        <p className={HEAD.DESC}>{t("history.bands.description")}</p>
      </header>

      {runs.length === 0 ? (
        <PanelEmpty icon="layers" body={t("history.bands.empty")} />
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <div
              className={BANDS.TRACK}
              role="img"
              aria-label={t("history.bands.strip_aria")}
            >
              {segments.map((segment) => {
                const tone = comboTone(segment.run.bands);
                const wide = segment.widthPct >= LABEL_MIN_PCT;
                return (
                  <span
                    key={segment.key}
                    className={cn(BANDS.SEGMENT, tone.fill, tone.ink)}
                    // A 2px gutter cut out of the fill, not drawn as a border
                    // (The No-Hairline-On-Fill Rule), so a combo change is
                    // visible even when both combos hash to the same tone.
                    style={{
                      left: `${segment.leftPct}%`,
                      width: `max(2px, calc(${segment.widthPct}% - 2px))`,
                    }}
                    title={runDetail(segment.run)}
                  >
                    {wide ? (
                      <span className={BANDS.SEGMENT_LABEL}>
                        {comboText(segment.run.bands)}
                      </span>
                    ) : null}
                  </span>
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
                    {moment(tick.ts)}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {combos.length > 0 ? (
            <div className="flex flex-col gap-2">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={TABLE.HEAD}>
                      {t("history.bands.col_combo")}
                    </TableHead>
                    <TableHead className={`${TABLE.HEAD} text-right`}>
                      {t("history.bands.col_share")}
                    </TableHead>
                    <TableHead className={`${TABLE.HEAD} text-right`}>
                      {t("history.bands.col_samples")}
                    </TableHead>
                    <TableHead className={`${TABLE.HEAD} text-right`}>
                      {t("history.bands.col_bw")}
                    </TableHead>
                    <TableHead className={`${TABLE.HEAD} text-right`}>
                      {t("history.bands.col_last")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {combos.map((combo) => {
                    const tone = comboTone(combo.bands);
                    return (
                      <TableRow key={`${combo.bands ?? "-"}-${combo.first_ts}`}>
                        <TableCell className={TABLE.CELL}>
                          <span className={BANDS.COMBO}>
                            <span
                              className={cn(BANDS.SWATCH, tone.fill)}
                              aria-hidden="true"
                            />
                            {comboText(combo.bands)}
                          </span>
                        </TableCell>
                        <TableCell className={`${TABLE.CELL} text-right`}>
                          {/* A share of zero samples is not a share: the window
                              held none, so there is no denominator to divide. */}
                          {total > 0
                            ? formatPct((combo.samples / total) * 100)
                            : DASH}
                        </TableCell>
                        <TableCell className={`${TABLE.CELL} text-right`}>
                          {combo.samples}
                        </TableCell>
                        <TableCell className={`${TABLE.CELL_MUTED} text-right`}>
                          {combo.bw_mhz === null
                            ? DASH
                            : t("history.bands.run_meta_bw", {
                                bw: combo.bw_mhz,
                              })}
                        </TableCell>
                        <TableCell className={`${TABLE.CELL_MUTED} text-right`}>
                          {formatMoment(combo.last_ts)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <p className={TABLE.PROSE}>{t("history.bands.foot")}</p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export default BandsCard;
