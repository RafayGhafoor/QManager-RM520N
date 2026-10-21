// =============================================================================
// detailed-metrics.ts — the `fetch_signal_history.sh?range=` contract
// =============================================================================
// Mirrors `GET /cgi-bin/quecmanager/at_cmd/fetch_signal_history.sh` when it is
// given a `range`. The no-query form of that endpoint still returns the bare
// array `SignalHistoryEntry[]` and is untouched by this file — the dashboard
// chart is the consumer there and it must stay byte-identical
// (`docs/reference/dashboard-chart-cards.md`).
//
// One rule governs every field: an ABSENT reading is `null`, never `0`. A
// `0` RSRP, a `0` CQI and a `0` MCS index are all readings the radio can
// legitimately report, so a missing value that arrived as `0` would be
// indistinguishable from a measured one and would render as a real figure.
// The backend follows the same rule; do not "helpfully" coalesce here.
//
// Fields this modem cannot report are ABSENT FROM THE CONTRACT, not `null` in
// it: `AT+QNWCFG="lte_tx_pwr"` and `AT+QNWCFG="nr5g_pathloss"` both answer
// `ERROR: command_failed` on RG520N-EB (measured 2026-10-22, recorded in
// `docs/specs/detailed-metrics-parity.md` → R1). The UI states both as
// unavailable and the glossary carries the note; there is no `lte.tx_power`
// and no `nr.pathloss` key to read by accident.
// =============================================================================

/**
 * Every range the CGI accepts. Only a subset is offered by the page's pill —
 * the endpoint serves more than any one surface shows
 * (`sites.sh` / `sites-card.tsx:48` precedent).
 */
export const DETAILED_METRIC_RANGES = [
  "now",
  "1h",
  "3h",
  "6h",
  "12h",
  "24h",
  "7d",
  "30d",
  "90d",
] as const;

export type DetailedMetricRange = (typeof DETAILED_METRIC_RANGES)[number];

/**
 * The archived panels the CGI can return a series for. These are the archive's
 * column names, so they are a wire vocabulary, not a UI one: the page labels
 * them from the glossary and never prints an id.
 */
export const DETAILED_METRIC_PANELS = [
  "rsrp",
  "sinr",
  "rsrq",
  "rssi",
  "temp",
  "cqi",
  "rank",
  "mcs",
  "tx_power",
  "total_cells",
] as const;

export type DetailedMetricPanel = (typeof DETAILED_METRIC_PANELS)[number];

/** LTE PHY block. `tm_mode` is `AT+QNWCFG="lte_dl_tx_mode"`'s numeric mode. */
export interface LtePhyMetrics {
  rsrp: number | null;
  rsrq: number | null;
  rssi: number | null;
  sinr: number | null;
  cqi: number | null;
  /** Rank indicator — the layer count the UE reports back. */
  ri: number | null;
  /** Precoding matrix index. */
  pmi: number | null;
  mimo_layers: number | null;
  tm_mode: number | null;
  /** Uplink MCS index. */
  ul_mcs: number | null;
}

/** NR PHY block. `tx_power` is `AT+QNWCFG="nr5g_tx_pwr"`'s reported figure. */
export interface NrPhyMetrics {
  rsrp: number | null;
  rsrq: number | null;
  sinr: number | null;
  cqi: number | null;
  ri: number | null;
  pmi: number | null;
  mimo_layers: number | null;
  /** Downlink MCS index. */
  dl_mcs: number | null;
  /** Uplink MCS index. */
  ul_mcs: number | null;
  tx_power: number | null;
}

/**
 * RRC state as `AT+QNWCFG="rrc_state"` answers it: the RAT name plus the
 * firmware's own numeric state code (measured `"rrc_state",1,"LTE",4`).
 *
 * `state` is deliberately NOT decoded. No capture in either repo maps the code
 * to a name, and inventing one would put a confident word on a number nobody
 * verified on this firmware.
 */
export interface RrcStateSnapshot {
  rat: string | null;
  state: number | null;
}

/** One detected SSB beam. `beam` is the beam id, never the beam count. */
export interface SsbBeam {
  beam: number | null;
  rsrp: number | null;
  rsrq: number | null;
  pci: number | null;
}

export interface DetailedMetricsSnapshot {
  lte: LtePhyMetrics;
  nr: NrPhyMetrics;
  rrc: RrcStateSnapshot;
  /**
   * Whether the modem is attached to the network, not merely receiving.
   *
   * THREE-VALUED, and the third value is the point: `null` is the poller saying
   * it has not read the attach state yet (a fresh boot before the first Tier-3
   * pass). The endpoint normalises an absent block to `null` rather than to
   * `false`, because "we did not look" and "it is not attached" are opposite
   * claims about a modem and only one of them is a fault.
   */
  registered: boolean | null;
  carrier: string | null;
  /** Strongest first, already capped by the backend. Absent list ⇒ `[]`. */
  beams: SsbBeam[];
}

/** One archived sample. `v` is `null` for a bucket with no measurement. */
export interface DetailedMetricSeriesPoint {
  ts: number;
  v: number | null;
}

export interface DetailedMetricsSuccess {
  success: true;
  range: DetailedMetricRange;
  generated_at: number;
  /** The bucket width in seconds; `null` for `range=now`, which has no series. */
  bucket_sec: number | null;
  snapshot: DetailedMetricsSnapshot;
  /**
   * Only the panels the caller asked for, only the ranges with an archive.
   * `range=now` carries `{}` — the current values live in `snapshot`.
   */
  series: Partial<Record<DetailedMetricPanel, DetailedMetricSeriesPoint[]>>;
  /**
   * Panels with no archive coverage for this range. The page disables those
   * rather than drawing an empty chart, because "no archive" and "archived
   * nothing" are different answers and only one of them is the user's fault.
   */
  missing: DetailedMetricPanel[];
}

export interface DetailedMetricsFailure {
  success: false;
  error: string;
  message?: string;
}

export type DetailedMetricsResponse = DetailedMetricsSuccess | DetailedMetricsFailure;

/** Type guard for the failure arm, so callers do not narrow by hand. */
export function isDetailedMetricsFailure(
  response: DetailedMetricsResponse,
): response is DetailedMetricsFailure {
  return response.success === false;
}
