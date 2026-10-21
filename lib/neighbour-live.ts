// =============================================================================
// neighbour-live — the derived readings of the two neighbour ranges
// =============================================================================
// Pure functions over a sample: map a live QMI answer onto the table's row
// shape, resolve a row's band and downlink frequency, compare a row with the
// serving cell, hold each cell's best RSRP, and rank the measured cells.
//
// They live here rather than in the components for the reason
// `components/cellular/cell-scanner/summaries.ts` gives for the aggregates: this
// is where a reading can quietly become a lie — a `0` sentinel read as a real
// level, a missing serving reading subtracted as zero, a band guessed from an
// EARFCN that matches none — so it is where the sentinel policy is stated once
// and can be read in one file.
//
// NO COPY IN THIS FILE. Every string the surface shows is produced by the
// component through the i18n path; these functions return numbers, booleans and
// discriminant units. A pure function that returns English is an i18n hole the
// gate cannot see.
//
// The band and frequency maths is `lib/earfcn.ts`'s, not a second band table.
// `docs/specs/neighbour-live-aim.md` states that rule for the same reason: two
// band tables disagree the first time one of them is corrected.
// =============================================================================

import {
  findAllMatchingLTEBands,
  findAllMatchingNRBands,
  getBandName,
  getDLFrequency,
} from "@/lib/earfcn";
import type {
  LiveNeighbourCell,
  NeighbourCellResult,
  ServingReadings,
} from "@/types/cell-scanner";

/**
 * Whether a reading is a reading at all, in the worker's own sentinel language.
 *
 * `0` is what both the AT worker and this table use for "not reported", and 0
 * dBm is not a physically meaningful RSRP. `null`/`undefined` mean the same
 * thing on the paths that can say it properly. This mirrors `sort.ts`'s
 * `isMeasuredSignal`, which cannot be imported here without a lib → components
 * dependency; the two must keep agreeing.
 */
export function measuredRsrp(
  strength: number | null | undefined,
): number | null {
  if (strength === null || strength === undefined || strength === 0) return null;
  return strength;
}

/** `"LTE"` for anything that is not an NR cell; the table's identity tag reads the same field. */
function technologyOf(networkType: string): "LTE" | "NR" {
  return networkType.toUpperCase().startsWith("NR") ? "NR" : "LTE";
}

/**
 * A live QMI cell -> the table's row shape.
 *
 * The two shapes disagree about the CHANNEL's name and its type (`earfcn` as a
 * digit string there, `frequency` as a number here) and about how "not
 * reported" is spelled (`null` there, `0` here). Both differences are resolved
 * once, here, so every column below is written against one row shape.
 *
 * `id` is derived from the cell's identity, not from the sample, so the same
 * physical neighbour keeps its identity across ticks — which is what lets a
 * peak hold onto it (see `recordPeaks`).
 *
 * `sinr` is always `null`: this QMI call reports no per-neighbour SINR
 * (`docs/reference/qmi-transport.md` > Field availability).
 */
export function liveCellsToRows(
  cells: readonly LiveNeighbourCell[],
): NeighbourCellResult[] {
  return cells.map((cell) => {
    const frequency = cell.earfcn === null ? 0 : Number(cell.earfcn) || 0;
    const pci = cell.pci === null ? 0 : Number(cell.pci) || 0;
    return {
      id: `qmi:${frequency}:${pci}`,
      networkType: cell.rat,
      cellType: cell.type,
      frequency,
      pci,
      signalStrength: cell.rsrp ?? 0,
      rsrq: cell.rsrq,
      rssi: cell.rssi,
      sinr: null,
    };
  });
}

/** What identifies the cell the modem is camped on, for `isServingRow`. */
export interface ServingIdentity {
  pci: string | null;
  earfcn: string | null;
}

/**
 * Whether this row IS the serving cell.
 *
 * Matched on channel AND PCI when both sides know them, because a PCI is only
 * unique within one frequency: PCI 104 is a different tower on 250 than on 6300.
 * Where either channel is missing, the PCI alone decides — that is exactly the
 * match `qm_qmi_neighbours` itself makes (PCI against `Serving Cell ID`).
 */
export function isServingRow(
  row: NeighbourCellResult,
  serving: ServingIdentity | null,
): boolean {
  if (serving === null || serving.pci === null) return false;
  const servingPci = Number(serving.pci);
  if (!Number.isFinite(servingPci) || row.pci !== servingPci) return false;
  if (serving.earfcn === null) return true;
  const servingEarfcn = Number(serving.earfcn);
  if (!Number.isFinite(servingEarfcn)) return true;
  return row.frequency === servingEarfcn;
}

/**
 * RSRP relative to the serving cell, in dB.
 *
 * `null` — never `0` — when either side has no reading. A row that is 4 dB
 * WEAKER than serving and a row whose serving reference is unknown are
 * different facts, and 0 would state the first while meaning the second. `0` is
 * reserved for the genuine case: a neighbour reporting the same level as the
 * cell it is measured against.
 */
export function deltaRsrp(
  row: NeighbourCellResult,
  servingRsrp: number | null | undefined,
): number | null {
  const rowRsrp = measuredRsrp(row.signalStrength);
  const reference = measuredRsrp(servingRsrp ?? null);
  if (rowRsrp === null || reference === null) return null;
  return rowRsrp - reference;
}

/** A row's operating band, resolved from its channel by `lib/earfcn.ts`. */
export interface RowBand {
  /** The 3GPP label as the product writes it: `B3` for LTE, `n78` for NR. */
  label: string;
  /** The band's common name ("DCS 1800"), or `""` when the table has none. */
  name: string;
}

/**
 * Resolve a row's band.
 *
 * `findAllMatching*` is used rather than a first-match helper because the NR
 * table has no public first-match lookup, and because the honest statement at
 * this point is "every band whose range contains this ARFCN". The first match
 * is displayed: overlapping ranges are a table artifact (an ARFCN inside both
 * n41 and n90 is one carrier, not two), and a neighbour report names no band to
 * disambiguate with. `0` means the worker reported no channel, so there is
 * nothing to resolve.
 */
export function bandOf(row: NeighbourCellResult): RowBand | null {
  if (row.frequency === 0) return null;
  if (technologyOf(row.networkType) === "NR") {
    const [band] = findAllMatchingNRBands(row.frequency);
    if (!band) return null;
    const label = `n${band.band}`;
    return { label, name: getBandName(label, "NR") };
  }
  const [band] = findAllMatchingLTEBands(row.frequency);
  if (!band) return null;
  const label = `B${band.band}`;
  return { label, name: getBandName(label, "LTE") };
}

/**
 * The downlink frequency in MHz for a row's channel, or `null`.
 *
 * For NR this is the global raster (`nrArfcnToFrequency`), so it is a real
 * frequency even when no band matched; for LTE it needs a band, because the
 * formula is band-relative.
 */
export function dlFrequencyOf(row: NeighbourCellResult): number | null {
  if (row.frequency === 0) return null;
  return getDLFrequency(row.frequency, technologyOf(row.networkType));
}

/**
 * Every band present in a row set, for the toolbar filter.
 *
 * Sorted by band number, so `B3` precedes `B20` and `n78` sorts after `B20`
 * only in the NR group's own order. The list is built from the rows on screen a
 * sample at a time, so a band that has just come into view cannot be named in
 * the trigger while missing from the menu.
 */
export function bandsInRows(rows: readonly NeighbourCellResult[]): RowBand[] {
  const byLabel = new Map<string, RowBand>();
  for (const row of rows) {
    const band = bandOf(row);
    if (band) byLabel.set(band.label, band);
  }
  return [...byLabel.values()].sort(
    (a, b) => bandNumber(a.label) - bandNumber(b.label),
  );
}

function bandNumber(label: string): number {
  const digits = label.replace(/^\D+/, "");
  const value = Number(digits);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/**
 * The band filter's "every band" token.
 *
 * `inBand` and the toolbar's `Select` must agree on it, and they did not: the
 * matcher accepted `""` while the control sent `"all"`, which silently filtered
 * every row out of the table. One exported constant is what stops that
 * recurring, and a non-empty token is required anyway because Radix refuses an
 * empty-string item value.
 */
export const ALL_BANDS = "all";

/**
 * Whether a row belongs to the named band. `ALL_BANDS` matches everything, which
 * is what the filter's default option selects.
 */
export function inBand(row: NeighbourCellResult, bandLabel: string): boolean {
  if (bandLabel === ALL_BANDS) return true;
  return bandOf(row)?.label === bandLabel;
}

/**
 * The N strongest measured rows, strongest first.
 *
 * Unmeasured rows are EXCLUDED rather than padding the list: a "top 5" that
 * includes two cells with no reading is a claim about five cells that could not
 * be ranked. The reader's own column sort reorders what is left; membership is
 * always by signal.
 */
export function topMeasured(
  rows: readonly NeighbourCellResult[],
  n: number,
): NeighbourCellResult[] {
  return rows
    .filter((row) => measuredRsrp(row.signalStrength) !== null)
    .slice()
    .sort((a, b) => b.signalStrength - a.signalStrength)
    .slice(0, n);
}

/**
 * A stable key for one physical cell, shared by the peak map and the ranked
 * rows. PCI plus channel, because a PCI repeats on every frequency.
 */
export function cellKey(row: NeighbourCellResult): string {
  return `${row.frequency}:${row.pci}`;
}

/** Each cell's best RSRP seen so far, keyed by `cellKey`. */
export type PeakMap = Readonly<Record<string, number>>;

/**
 * Fold one sample into the peak map: a cell's entry only ever moves UP.
 *
 * Peak-hold is the affordance a single current reading cannot provide. Pointing
 * a dish means rotating it while watching a number, and nobody can remember the
 * best value they saw ten seconds ago while doing that — so the maximum is what
 * makes the sweep measurable. It is deliberately session-scoped and never
 * persisted: a peak from this morning's aiming is not evidence about where the
 * antenna points now.
 *
 * Unmeasured rows are skipped so the map cannot hold a `0` as a best-ever.
 */
export function recordPeaks(
  peaks: PeakMap,
  rows: readonly NeighbourCellResult[],
): PeakMap {
  let next: Record<string, number> | null = null;
  for (const row of rows) {
    const value = measuredRsrp(row.signalStrength);
    if (value === null) continue;
    const key = cellKey(row);
    const held = peaks[key];
    if (held !== undefined && held >= value) continue;
    next ??= { ...peaks };
    next[key] = value;
  }
  return next ?? peaks;
}

/** A sample's age, cut into the unit the surface prints. */
export interface AgeParts {
  value: number;
  unit: "s" | "min" | "h";
}

/**
 * Break an age in seconds into a count and a unit.
 *
 * A live sample is 0-6 s old and a last-read one is routinely minutes, so one
 * unit cannot serve both: "312 s" is a number a reader has to divide, and
 * "0 min" hides that the table is a second behind the radio. The component
 * translates the unit; this function only decides which one.
 */
export function ageParts(seconds: number): AgeParts {
  if (seconds < 60) return { value: Math.max(0, Math.round(seconds)), unit: "s" };
  if (seconds < 3600) return { value: Math.floor(seconds / 60), unit: "min" };
  return { value: Math.floor(seconds / 3600), unit: "h" };
}

/** The serving cell's RSRP, already stripped of the sentinel, or `null`. */
export function servingRsrpOf(
  serving: ServingReadings | null,
): number | null {
  return serving === null ? null : serving.rsrp;
}
