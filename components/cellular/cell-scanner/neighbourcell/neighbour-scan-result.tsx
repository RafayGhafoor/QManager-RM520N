"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import type {
  ColumnDef,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ALL_BANDS,
  ageParts,
  bandOf,
  bandsInRows,
  deltaRsrp,
  dlFrequencyOf,
  inBand,
  isServingRow,
  topMeasured,
  type RowBand,
  type ServingIdentity,
} from "@/lib/neighbour-live";
import { cn } from "@/lib/utils";
import type {
  NeighbourCellResult,
  NeighbourCellType,
} from "@/types/cell-scanner";

import ScanTable from "../scan-table";
import ScanTableNote from "../table-note";
import { NetworkTypeBadge, SignalBadge } from "../signal-badges";
import { signalSortingFn, signalSortValue } from "../sort";
import { BADGE_GLYPH_SIZE, TABLE, TOOLBAR } from "../shapes";
import { summariseNeighbours } from "../summaries";

// =============================================================================
// The neighbour read's columns
// =============================================================================
// Definitions only; the shell is `scan-table.tsx`. Opens sorted by signal,
// strongest first, unmeasured rows last (`sort.ts`). Only LTE rows lock.
//
// FIVE COLUMNS WERE ADDED FOR THE AIMING VIEW (2026-10-22): Serving, Band, DL
// MHz, delta RSRP, Age. Four of them are derived, not reported — nothing in the
// AT worker's row carries a band, a frequency, a serving-cell comparison or an
// age — so they are computed here from `lib/neighbour-live.ts` rather than
// requested from the modem. That is the one place the two ranges' rows become
// comparable, which is why both are mapped onto one row shape before this file
// sees them.
// =============================================================================

/**
 * The measurements fold away first. They are the columns a reader can recover
 * from the CSV export, and the identity columns are what makes a row findable.
 *
 * The Serving column is deliberately NOT in here: it is the one thing a reader
 * on a phone must still be able to see, because "which of these is my own cell"
 * is what the whole aiming comparison is against.
 */
export const NEIGHBOUR_NARROW_HIDDEN: VisibilityState = {
  rsrq: false,
  rssi: false,
  sinr: false,
  cellType: false,
};

/** `intra` / `inter` / `nr5g` -> its copy key, spelled out as LITERALS so
 *  `i18n:check` can see every one of them. An interpolated stem is invisible to
 *  it, and a key it cannot see is a key nothing will ever report as missing.
 *  Exported: `neighbour-scanner.tsx`'s summary tiles key off the same map. */
export const CELL_TYPE_KEY: Record<NeighbourCellType, string> = {
  intra: "cell_scanner.neighbour.cell_type.intra",
  inter: "cell_scanner.neighbour.cell_type.inter",
  nr5g: "cell_scanner.neighbour.cell_type.nr5g",
};

/** See the note on `CellScanColumnCopy` — a type alias, not an interface, so it
 *  satisfies the shell's `Record<string, string>` column-label map. */
export type NeighbourColumnCopy = {
  networkType: string;
  cellType: string;
  frequency: string;
  pci: string;
  signalStrength: string;
  rsrq: string;
  rssi: string;
  sinr: string;
  serving: string;
  band: string;
  dlMhz: string;
  delta: string;
  age: string;
};

/**
 * What the columns need from the SAMPLE rather than from the row: which cell the
 * modem is camped on (the Serving badge and the delta both compare against it)
 * and how old the sample is (the Age column).
 *
 * A sample, not a row, because all three facts are properties of the read: the
 * modem is camped on one cell, and every row of one sample was measured at the
 * same instant. See the Age column's note for why it is nevertheless a column.
 */
export interface NeighbourSampleContext {
  serving: ServingIdentity | null;
  servingRsrp: number | null;
  ageS: number | null;
}

export const NO_SAMPLE_CONTEXT: NeighbourSampleContext = {
  serving: null,
  servingRsrp: null,
  ageS: null,
};

/** An unreported value. The workers emit 0 for channel/PCI/RSRP and null for the
 *  rest, so both funnel to one mark rather than rendering a real-looking `0`. */
function Unreported({ label }: { label: string }) {
  return (
    <span className="text-on-surface-variant" aria-label={label}>
      &mdash;
    </span>
  );
}

/**
 * A frequency for display: whole MHz where the maths lands on one, one decimal
 * otherwise. `getDLFrequency` returns EARFCN × 0.1 + the band's low edge, so an
 * LTE channel frequently lands on a clean 0.1 boundary and an NR one on a long
 * decimal. The unit word comes from the catalogue (`{{value}} MHz`), not from a
 * template string here.
 */
function mhzValue(freq: number): string {
  return Number.isInteger(freq) ? freq.toFixed(0) : freq.toFixed(1);
}

/**
 * A delta for display, signed and trimmed.
 *
 * The sign is part of the reading: "+3 dB" and "3 dB" are not the same claim
 * about a neighbour, and a reader sweeping a mast needs to know which side of
 * the serving cell a candidate sits on without reading the sign off the numeral.
 * A whole-number delta loses the `.0` because `-81.0 - (-77.9)` is a floating
 * artefact, not precision.
 */
function deltaValue(delta: number): string {
  const rounded = Math.round(delta * 10) / 10;
  const body = Number.isInteger(rounded)
    ? rounded.toFixed(0)
    : rounded.toFixed(1);
  return rounded > 0 ? `+${body}` : body;
}

export function createNeighbourColumns(
  copy: NeighbourColumnCopy,
  labels: {
    rowMenu: string;
    lockCell: string;
    lockUnavailable: string;
    unreported: string;
    notServing: string;
    serving: string;
    cellType: (value: NeighbourCellType) => string;
    age: (seconds: number) => string;
    decibel: (value: string) => string;
    mhz: (value: string) => string;
  },
  format: { signal: (value: number) => string; decibel: (value: number) => string },
  sample: NeighbourSampleContext,
  onLockCell?: (cell: NeighbourCellResult) => void,
): ColumnDef<NeighbourCellResult>[] {
  return [
    {
      // The row's flag, on its leading edge, so it lines up with the inset rule
      // `TABLE.ROW_SERVING` draws there. A flag column is mostly empty by
      // nature; a reader scans the header once and then only sees the rows that
      // are marked.
      id: "serving",
      header: () => <span>{copy.serving}</span>,
      enableSorting: false,
      cell: ({ row }) =>
        isServingRow(row.original, sample.serving) ? (
          <Badge variant="info">
            <MaterialSymbol name="cell_tower" size={BADGE_GLYPH_SIZE} />
            {labels.serving}
          </Badge>
        ) : (
          // Nothing visible, because "this is not your cell" is the ordinary
          // case and a column of marks would make every row shout. Assistive
          // tech still gets the distinction the tone and badge carry.
          <span className="sr-only">{labels.notServing}</span>
        ),
    },
    {
      accessorKey: "networkType",
      header: () => <span>{copy.networkType}</span>,
      cell: ({ row }) => <NetworkTypeBadge type={row.original.networkType} />,
    },
    {
      accessorKey: "cellType",
      header: () => <span>{copy.cellType}</span>,
      cell: ({ row }) => <span>{labels.cellType(row.original.cellType)}</span>,
    },
    {
      accessorKey: "frequency",
      header: ({ column }) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          {copy.frequency}
          <MaterialSymbol name="unfold_more" size={16} />
        </Button>
      ),
      cell: ({ row }) =>
        row.original.frequency === 0 ? (
          <Unreported label={labels.unreported} />
        ) : (
          <span className={TABLE.IDENT}>{row.original.frequency}</span>
        ),
    },
    {
      accessorKey: "pci",
      header: () => <span>{copy.pci}</span>,
      cell: ({ row }) =>
        row.original.pci === 0 ? (
          <Unreported label={labels.unreported} />
        ) : (
          <span className={TABLE.IDENT}>{row.original.pci}</span>
        ),
    },
    {
      // Derived from the channel by `lib/earfcn.ts`. The band's common name
      // ("DCS 1800") rides the `title`, because it is a second string for the
      // same fact and a column wide enough for both would push the readings off
      // the row.
      id: "band",
      header: () => <span>{copy.band}</span>,
      enableSorting: false,
      cell: ({ row }) => {
        const band: RowBand | null = bandOf(row.original);
        if (!band) return <Unreported label={labels.unreported} />;
        return (
          <span className={TABLE.IDENT} title={band.name || undefined}>
            {band.label}
          </span>
        );
      },
    },
    {
      id: "dlMhz",
      header: () => <span>{copy.dlMhz}</span>,
      enableSorting: false,
      cell: ({ row }) => {
        const freq = dlFrequencyOf(row.original);
        if (freq === null) return <Unreported label={labels.unreported} />;
        return (
          <span className={TABLE.FIGURE}>{labels.mhz(mhzValue(freq))}</span>
        );
      },
    },
    {
      // The accessor feeds sorting only; the cell reads `row.original`.
      id: "signalStrength",
      accessorFn: (row) => signalSortValue(row.signalStrength),
      sortingFn: signalSortingFn,
      sortUndefined: "last",
      header: ({ column }) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          {copy.signalStrength}
          <MaterialSymbol name="unfold_more" size={16} />
        </Button>
      ),
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          {/* 0 is "unreported": the chip says No data and no value is printed. */}
          <SignalBadge strength={row.original.signalStrength} />
          {row.original.signalStrength !== 0 ? (
            <span className={TABLE.FIGURE}>
              {format.signal(row.original.signalStrength)}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      /**
       * RSRP relative to the serving cell — the column an operator aims by.
       *
       * `null` (never `0`) when either side has no reading: a row with no
       * serving reference and a row that happens to match the serving level are
       * different facts, and only the second is `0`. The column is sortable for
       * that reason: "which neighbour is stronger than mine" is the question,
       * and sorting answers it without reading every cell.
       *
       * A delta of exactly 0 renders as `0`, not an em dash: it is a real
       * measurement. The em-dash rule guards the reading columns, where the
       * worker's `0` means "unreported"; here the absent case is `null`.
       */
      id: "delta",
      accessorFn: (row) => deltaRsrp(row, sample.servingRsrp) ?? undefined,
      sortingFn: signalSortingFn,
      sortUndefined: "last",
      header: ({ column }) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          {copy.delta}
          <MaterialSymbol name="unfold_more" size={16} />
        </Button>
      ),
      cell: ({ row }) => {
        const delta = deltaRsrp(row.original, sample.servingRsrp);
        return delta === null ? (
          <Unreported label={labels.unreported} />
        ) : (
          <span className={TABLE.FIGURE}>{labels.decibel(deltaValue(delta))}</span>
        );
      },
    },
    {
      accessorKey: "rsrq",
      header: () => <span>{copy.rsrq}</span>,
      cell: ({ row }) =>
        row.original.rsrq === null ? (
          <Unreported label={labels.unreported} />
        ) : (
          <span className={TABLE.FIGURE}>
            {format.decibel(row.original.rsrq)}
          </span>
        ),
    },
    {
      accessorKey: "rssi",
      header: () => <span>{copy.rssi}</span>,
      // RSSI is dBm, where RSRQ and SINR are dB — so this one takes the signal
      // formatter, not the decibel one. Also: NR5G rows never carry RSSI, the
      // worker leaves the field empty by design, so a null here is an absence
      // rather than a fault.
      cell: ({ row }) =>
        row.original.rssi === null ? (
          <Unreported label={labels.unreported} />
        ) : (
          <span className={TABLE.FIGURE}>
            {format.signal(row.original.rssi)}
          </span>
        ),
    },
    {
      accessorKey: "sinr",
      header: () => <span>{copy.sinr}</span>,
      cell: ({ row }) =>
        row.original.sinr === null ? (
          <Unreported label={labels.unreported} />
        ) : (
          <span className={TABLE.FIGURE}>
            {format.decibel(row.original.sinr)}
          </span>
        ),
    },
    {
      /**
       * How old the sample behind this row is.
       *
       * It reads the same on every row, and that is not an oversight: a scan is
       * one measurement of every cell it lists, so the age belongs to the read,
       * not to the row. It is a COLUMN because the reader must be able to see it
       * without leaving the table — in `now` it is the only per-row evidence
       * that the list is a second old rather than an hour old, and in `last` it
       * is what stops a memorable scan from being read as a current one.
       */
      id: "age",
      header: () => <span>{copy.age}</span>,
      enableSorting: false,
      cell: () =>
        sample.ageS === null ? (
          <Unreported label={labels.unreported} />
        ) : (
          <span className={cn(TABLE.FIGURE, "text-on-surface-variant")}>
            {labels.age(sample.ageS)}
          </span>
        ),
    },
    {
      id: "actions",
      header: () => null,
      enableHiding: false,
      cell: ({ row }) => {
        // Only LTE neighbours are lockable: `tower/lock.sh`'s NR branch needs a
        // band and an SCS, and a neighbour report carries neither.
        const lockable =
          row.original.networkType.toUpperCase().startsWith("LTE") &&
          row.original.pci !== 0 &&
          row.original.frequency !== 0;

        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-on-surface-variant data-[state=open]:bg-surface-container-high"
                aria-label={labels.rowMenu}
              >
                <MaterialSymbol name="more_vert" size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* The incumbent SUPPRESSED this row entirely for non-LTE cells.
                  A control that cannot work explains itself rather than
                  vanishing — an absent affordance leaves the reader to infer
                  the rule, which is the one thing the product's honesty
                  principle rules out. */}
              <DropdownMenuItem
                disabled={!lockable}
                onClick={() => onLockCell?.(row.original)}
              >
                <MaterialSymbol name="lock" size={16} />
                {lockable ? labels.lockCell : labels.lockUnavailable}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];
}

/** Strongest signal first; a module constant so its identity is stable. */
const DEFAULT_SORTING: SortingState = [{ id: "signalStrength", desc: true }];

/** The row limits the toolbar offers. `all` is the unclipped read. */
const ROW_LIMITS = [
  { value: "all", count: null },
  { value: "3", count: 3 },
  { value: "5", count: 5 },
  { value: "10", count: 10 },
] as const;

type RowLimit = (typeof ROW_LIMITS)[number]["value"];

export interface NeighbourScanResultViewProps {
  data: NeighbourCellResult[];
  /** The serving cell and the sample's age — see `NeighbourSampleContext`. */
  sample?: NeighbourSampleContext;
  onLockCell?: (cell: NeighbourCellResult) => void;
  /** Rendered in the table toolbar, before the column menu (Download CSV). */
  toolbarActions?: React.ReactNode;
}

export function NeighbourScanResultView({
  data,
  sample = NO_SAMPLE_CONTEXT,
  onLockCell,
  toolbarActions,
}: NeighbourScanResultViewProps) {
  const { t } = useTranslation("cellular");

  // Two filters live with the table they filter. Both reset with the card: a
  // band chosen during one read has no meaning in the next one, and a reader
  // who picked "Top 3" to aim is not asking for three rows of every later scan.
  const [band, setBand] = React.useState<string>(ALL_BANDS);
  const [limit, setLimit] = React.useState<RowLimit>("all");

  const bands = React.useMemo(() => bandsInRows(data), [data]);

  const shown = React.useMemo(() => {
    const filtered = data.filter((row) => inBand(row, band));
    const selected = ROW_LIMITS.find((option) => option.value === limit);
    if (!selected || selected.count === null) return filtered;
    return topMeasured(filtered, selected.count);
  }, [band, data, limit]);

  // A live sample can lose a band between ticks. Without its own item Radix
  // renders an empty trigger while the filter is still being applied — the same
  // trap `transcript-card.tsx` documents for its component filter, and worse
  // here because the row it filtered by has just disappeared.
  const staleBand = band !== ALL_BANDS && !bands.some((b) => b.label === band);

  const columnCopy: NeighbourColumnCopy = React.useMemo(
    () => ({
      networkType: t("cell_scanner.columns.network"),
      cellType: t("cell_scanner.neighbour.columns.cell_type"),
      frequency: t("cell_scanner.neighbour.columns.frequency"),
      pci: t("cell_scanner.columns.pci"),
      signalStrength: t("cell_scanner.columns.signal"),
      rsrq: t("cell_scanner.neighbour.columns.rsrq"),
      rssi: t("cell_scanner.neighbour.columns.rssi"),
      sinr: t("cell_scanner.neighbour.columns.sinr"),
      serving: t("cell_scanner.neighbour.columns.serving"),
      band: t("cell_scanner.columns.band"),
      dlMhz: t("cell_scanner.neighbour.columns.dl_mhz"),
      delta: t("cell_scanner.neighbour.columns.delta_rsrp"),
      age: t("cell_scanner.neighbour.columns.age"),
    }),
    [t],
  );

  const columns = React.useMemo(
    () =>
      createNeighbourColumns(
        columnCopy,
        {
          rowMenu: t("cell_scanner.a11y.row_menu"),
          lockCell: t("cell_scanner.actions.lock_cell"),
          lockUnavailable: t("cell_scanner.neighbour.actions.lock_lte_only"),
          unreported: t("cell_scanner.neighbour.cells.unreported"),
          notServing: t("cell_scanner.neighbour.cells.not_serving"),
          serving: t("cell_scanner.neighbour.cells.serving"),
          cellType: (value) => t(CELL_TYPE_KEY[value]),
          age: (seconds) => {
            const parts = ageParts(seconds);
            const key =
              parts.unit === "s"
                ? "cell_scanner.neighbour.cells.age_seconds"
                : parts.unit === "min"
                  ? "cell_scanner.neighbour.cells.age_minutes"
                  : "cell_scanner.neighbour.cells.age_hours";
            return t(key, { value: parts.value });
          },
          decibel: (value) => t("cell_scanner.neighbour.cells.decibel", { value }),
          mhz: (value) => t("radio_info.bands.units.mhz", { value }),
        },
        {
          signal: (value) => t("cell_scanner.cells.signal", { value }),
          decibel: (value) => t("cell_scanner.neighbour.cells.decibel", { value }),
        },
        sample,
        onLockCell,
      ),
    [columnCopy, onLockCell, sample, t],
  );

  // Measured versus channel-only, over the whole read rather than the filtered view.
  const tally = React.useMemo(() => {
    const summary = summariseNeighbours(data);
    return [
      t("cell_scanner.results.tally_rows", { count: summary.total }),
      t("cell_scanner.neighbour.results.tally_measured", {
        count: summary.measured,
      }),
      t("cell_scanner.neighbour.results.tally_channel_only", {
        count: summary.channelOnly,
      }),
    ];
  }, [data, t]);

  const toolbarLeading = (
    <>
      <Select value={band} onValueChange={setBand}>
        <SelectTrigger
          aria-label={t("cell_scanner.neighbour.toolbar.band_label")}
          className={cn(TOOLBAR.SELECT)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_BANDS}>
            {t("cell_scanner.neighbour.toolbar.band_all")}
          </SelectItem>
          {staleBand ? <SelectItem value={band}>{band}</SelectItem> : null}
          {bands.map((option) => (
            <SelectItem key={option.label} value={option.label}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={limit}
        onValueChange={(next) => setLimit(next as RowLimit)}
      >
        <SelectTrigger
          aria-label={t("cell_scanner.neighbour.toolbar.limit_label")}
          className={cn(TOOLBAR.SELECT)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROW_LIMITS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.count === null
                ? t("cell_scanner.neighbour.toolbar.limit_all")
                : t("cell_scanner.neighbour.toolbar.limit_top", {
                    count: option.count,
                  })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );

  return (
    <ScanTable
      data={shown}
      columns={columns}
      footer={
        <ScanTableNote
          glyph="lock"
          text={t("cell_scanner.neighbour.results.note_channel_only")}
          tally={tally}
        />
      }
      columnLabels={columnCopy}
      // Bound to the channel: the relation's three words are not something to type.
      filterColumnId="frequency"
      narrowHidden={NEIGHBOUR_NARROW_HIDDEN}
      initialSorting={DEFAULT_SORTING}
      toolbarLeading={toolbarLeading}
      toolbarActions={toolbarActions}
      rowClassName={(row) =>
        isServingRow(row, sample.serving) ? TABLE.ROW_SERVING : undefined
      }
      labels={{
        filterPlaceholder: t(
          "cell_scanner.neighbour.results.filter_placeholder",
        ),
        columns: t("cell_scanner.results.columns"),
        previous: t("cell_scanner.results.previous"),
        next: t("cell_scanner.results.next"),
        noMatchTitle: t("cell_scanner.neighbour.results.no_match_title"),
        noMatchBody: t("cell_scanner.neighbour.results.no_match_body"),
      }}
      // No `countLabel`: the footer tally already counts the read.
    />
  );
}

export default NeighbourScanResultView;
