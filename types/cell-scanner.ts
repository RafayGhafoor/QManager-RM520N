// =============================================================================
// Cell Scanner — result and transport types
// =============================================================================
// These lived in `components/cellular/cell-scanner/scan-result.tsx`, and
// `hooks/use-cell-scanner.ts` imported them BACKWARDS — a data hook reaching
// into a table component for the shape of the data it fetches. That inversion is
// what made the table impossible to replace without touching the hook, and it is
// the reason the neighbour route forked rather than shared.
//
// The direction is now the usual one: the transport shape is declared here, and
// both the hook that fetches it and the components that render it import from
// this file. Nothing in `types/` imports from `components/`.
// =============================================================================

/** One cell reported by `AT+QSCAN=3,1`, as normalised by `cell_scan_status.sh`. */
export interface CellScanResult {
  /** Stable row key assigned by the worker. */
  id: string;
  /** `LTE` or `NR5G-SA`. Drives the radio-identity chip and the lock payload. */
  networkType: string;
  earfcn: number;
  pci: number;
  band: number;
  bandwidth: number;
  cellID: number;
  tac: number;
  /** RSRP in dBm. The worker emits 0 for an unreported reading — see `signalTier`. */
  signalStrength: number;
  mcc: number;
  mnc: number;
  provider: string;
  /**
   * Subcarrier spacing, kHz. NR only, and only when the modem reported one — a
   * tower lock on an NR cell needs it, so a missing value falls back to the
   * common 30 kHz at the point of use rather than being invented here.
   */
  scs?: number | null;
}

/**
 * The worker's own state machine, which is NOT the same vocabulary as the
 * surface's `RunPosture`. `shapes.ts > runPosture` is the one place the two are
 * mapped, so a new transport state cannot silently render untinted.
 */
export type ScanStatus = "idle" | "running" | "complete" | "error";

/** The envelope returned by `at_cmd/cell_scan_status.sh`. */
export interface CellScanStatusResponse {
  status: ScanStatus;
  results?: CellScanResult[];
  message?: string;
}

// -----------------------------------------------------------------------------
// The neighbour read
// -----------------------------------------------------------------------------
// A DIFFERENT SHAPE FROM `CellScanResult`, deliberately not merged with it. The
// two workers ask the modem different questions and get different answers back:
// a sweep reports a cell's full identity (operator, MCC/MNC, cell ID, TAC,
// bandwidth), a neighbour read reports a measurement of a cell the serving tower
// already knows about (RSRQ, RSSI, SINR, and whether it is on this frequency or
// another). Only `id`, `networkType`, `pci` and `signalStrength` genuinely
// overlap, and they even disagree on what to call the channel — `earfcn` here is
// `frequency`.
//
// Widening one type to cover both would make ten fields optional and push the
// "which of these is actually populated?" question into every call site. The
// SHELL is shared; the shapes are not.

/** How the neighbour was reported, relative to the serving cell's own frequency. */
export type NeighbourCellType = "intra" | "inter" | "nr5g";

/** One cell reported by `AT+QENG="neighbourcell"` / `AT+QNWCFG="nr5g_meas_info"`. */
export interface NeighbourCellResult {
  id: string;
  /** `LTE` or `NR5G`. Only LTE neighbours are lockable — see the actions column. */
  networkType: string;
  cellType: NeighbourCellType;
  /** EARFCN / NR-ARFCN. The worker emits 0 when the modem did not report one. */
  frequency: number;
  /** The worker emits 0 for an unreported PCI. */
  pci: number;
  /** RSRP in dBm. 0 means unmeasured, NOT 0 dBm — see `signalTier`. */
  signalStrength: number;
  /** These three are `null` when unreported. NR5G rows never carry RSSI by design. */
  rsrq: number | null;
  rssi: number | null;
  sinr: number | null;
}

/** The envelope returned by `at_cmd/neighbour_scan_status.sh`. */
export interface NeighbourScanStatusResponse {
  status: ScanStatus;
  results?: NeighbourCellResult[];
  message?: string;
}

// -----------------------------------------------------------------------------
// The two RANGES of that endpoint
// -----------------------------------------------------------------------------
// A request with no query string keeps answering with the envelope above, and
// that path is untouched. `?range=` adds a view of the same data for the aiming
// surface: `last` is the final scan row set plus how old it is, `now` is the
// live QMI sample the poller publishes while the browser holds a lease.
//
// The row shape differs by design. A live row is a QMI measurement of an LTE
// neighbour (`type`/`rat`/`source`, and `earfcn`/`pci` as digit STRINGS because
// they are identities), while a last-read row is the AT worker's own shape. Both
// are mapped onto `NeighbourCellResult` by one function before the table sees
// them — see `lib/neighbour-live.ts`.

export type NeighbourRange = "last" | "now";

/** One LTE neighbour in a live sample, as `qm_qmi_neighbours` emits it. */
export interface LiveNeighbourCell {
  /** Intra-frequency neighbours share the serving cell's EARFCN. */
  type: "intra" | "inter";
  /** QMI reports LTE neighbours only; NR neighbours stay an AT read. */
  rat: "LTE";
  /** EARFCN as a digit string, or `null` when the modem reported none. */
  earfcn: string | null;
  pci: string | null;
  rsrp: number | null;
  rsrq: number | null;
  rssi: number | null;
  /** True for the cell whose PCI matched the serving cell ID. */
  serving: boolean;
  source: "qmi";
}

/**
 * The camped cell's own readings.
 *
 * `sinr` exists only on a live sample: `range=last` fills this object from the
 * poller's AT status cache, which carries no SINR. See `LiveServingReadings`.
 */
export interface ServingReadings {
  pci: string | null;
  earfcn: string | null;
  rsrp: number | null;
  rsrq: number | null;
  rssi: number | null;
}

export interface LiveServingReadings extends ServingReadings {
  sinr: number | null;
}

/**
 * `?range=now` — the live sample, served while the lease is fresh.
 *
 * `live_at` is `null` (with `cells: []`) when there is no sample, or when the
 * sample is older than the CGI's 6 s window. A stale sample is never passed off
 * as current: an operator aiming an antenna would chase a tower the dish left
 * behind. `registered` is what makes the signal values interpretable at all —
 * QMI reports a strong reading for a cell the modem is not attached to.
 */
export interface NeighbourNowResponse {
  success: true;
  range: "now";
  live_at: number | null;
  age_s: number | null;
  registered: boolean;
  carrier: string | null;
  serving: LiveServingReadings | null;
  cells: LiveNeighbourCell[];
}

/**
 * `?range=last` — the last completed scan, plus its age and the serving cell.
 *
 * `cells` is the AT worker's row shape, unchanged. `serving` comes from the AT
 * status cache rather than from those rows: a neighbour report carries no
 * serving-cell marker, and mixing the two transports for one value is what
 * `docs/specs/neighbour-live-aim.md` forbids.
 */
export interface NeighbourLastResponse {
  success: true;
  range: "last";
  generated_at: number | null;
  age_s: number | null;
  registered: boolean;
  carrier: string | null;
  serving: ServingReadings | null;
  cells: NeighbourCellResult[];
}

/** Any `range` the CGI does not serve. */
export interface NeighbourRangeFailure {
  success: false;
  error: string;
  message: string;
}
