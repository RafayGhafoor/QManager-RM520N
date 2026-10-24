// =============================================================================
// format.ts — the SmartDNS page's read-only formatting helpers
// =============================================================================
// Presentation only. Nothing here decides a state or reads a payload's shape;
// those live in the card that renders them.
//
// Two rules from DESIGN.md are enforced here rather than at each call site:
//
//   Machine-Voice Rule   an upstream URL, a domain and an answer IP are opaque
//                        strings (mono, at the call site); a millisecond figure
//                        is a quantity (`tabular-nums`, UI face). These helpers
//                        only produce the NUMBERS and the SHORT LABELS; the
//                        class that spells the voice stays with the caller.
//   Tabular-Number Rule  every figure that can change on screen goes through
//                        `formatNumber`, so digits are grouped in the reader's
//                        locale and never restated as a raw `String(n)`.
// =============================================================================

import type { SmartDnsTestRow } from "@/types/smartdns";

/** Short unit suffixes, translated by the caller. */
export interface DurationUnits {
  day: string;
  hour: string;
  minute: string;
  second: string;
}

/**
 * "2d 3h", "3h 14m", "41s" — the two largest non-zero units, which is as much
 * precision as an uptime readout is worth.
 *
 * A daemon that has just started reports `0`, and that is drawn as `0s` rather
 * than as an em dash: zero is a reading here, not an absence. `null` is the
 * absence, and the caller renders the dash for it.
 */
export function formatDuration(
  totalSeconds: number,
  units: DurationUnits,
): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = seconds % 60;

  if (days > 0) return `${days}${units.day} ${hours}${units.hour}`;
  if (hours > 0) return `${hours}${units.hour} ${minutes}${units.minute}`;
  if (minutes > 0) return `${minutes}${units.minute} ${secs}${units.second}`;
  return `${secs}${units.second}`;
}

/**
 * Grouping and decimal places for a figure, in the reader's locale.
 *
 * `null` is not 0 and must not be printed as one: the caller draws an em dash.
 * This returns `null` for `null` so the decision stays in one place.
 */
export function formatNumber(
  value: number | null,
  locale: string,
  fractionDigits = 0,
): string | null {
  if (value === null || Number.isNaN(value)) return null;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/**
 * A timestamps-as-epoch-seconds field, in the reader's locale.
 *
 * Contract 3 does not state the unit for `config_mtime`, `last_refresh` or
 * `sampled_at`; every other epoch field in this product's CGI payloads is
 * SECONDS (Contract 1's `generated_at`, Contract 2's `tested_at`), so seconds is
 * the reading here. A value that is clearly milliseconds is divided rather than
 * displayed as a year-55000 date, and anything unparseable returns `null` so the
 * caller prints an em dash instead of "Invalid Date".
 */
export function formatMoment(
  epochSeconds: number | null,
  locale: string,
): string | null {
  if (epochSeconds === null || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return null;
  }
  const ms = epochSeconds > 1e12 ? epochSeconds : epochSeconds * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The tester's rows, fastest first.
 *
 * Contract 2 already states `fastest` / `slowest` / `spread`, but it does not
 * order `results`, and the whole point of the table is that the eye reads the
 * answer top-down. Rows that did not answer (`rtt_ms === null`) sort last: they
 * are a result, and burying them mid-table between measurements would imply a
 * latency they do not have.
 */
export function sortByFastest(rows: SmartDnsTestRow[]): SmartDnsTestRow[] {
  return [...rows].sort((a, b) => {
    if (a.rtt_ms === null && b.rtt_ms === null) return a.short.localeCompare(b.short);
    if (a.rtt_ms === null) return 1;
    if (b.rtt_ms === null) return -1;
    return a.rtt_ms - b.rtt_ms;
  });
}

/**
 * A readable name for an upstream the measurement has not labelled yet.
 *
 * Contract 1 emits `short`, but a member of the live edge group reaches the UI
 * only as a URL string (Contract 3's `edge.members[]`), so the first column needs
 * a label before any probe has run. This is presentation, not parsing of the
 * resolver's semantics: the host is what a reader recognises, and the full URL
 * stays visible underneath it.
 */
export function shortUpstream(upstream: string): string {
  const withoutScheme = upstream.replace(/^[a-z0-9+.-]+:\/\//i, "");
  const host = withoutScheme.split("/")[0];
  return host.length > 0 ? host : upstream;
}
