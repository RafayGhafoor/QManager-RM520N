// =============================================================================
// smartdns.ts — the SmartDNS page's wire types
// =============================================================================
// These mirror docs/specs/dns-edge-selection.md EXPLICITLY. That document is the
// integration contract between three pieces that are written independently — the
// measurement engine (`qmanager_dns_edge_probe` / `qmanager_dns_test`, Contract 1
// and 2), the CGI (`network/smartdns.sh`, `network/smartdns_stats.sh`,
// `network/dns_test.sh`, Contract 3) and this UI — so a field renamed on one side
// and not the others is a silent break, not a compile error. Names and shapes
// here change only when that spec changes first.
//
// Endpoints:
//   GET/POST /cgi-bin/quecmanager/network/smartdns.sh
//   GET      /cgi-bin/quecmanager/network/smartdns_stats.sh
//   GET      /cgi-bin/quecmanager/network/dns_test.sh?domain=<d>
//
// -----------------------------------------------------------------------------
// NULLABILITY, AND WHERE IT COMES FROM
// -----------------------------------------------------------------------------
// Contract 1 states its nulls (`quality_ms: null` on a failed provider,
// `fastest: null` when nobody answered). Contract 3 states almost none, so the
// fields a stopped or half-initialised daemon cannot report are typed `| null`
// here and rendered as an em dash rather than as 0 — a 0 ms lookup and "no
// sample" must never look alike on an instrument console. `null` is not
// "unknown to the type system"; it is a real answer the CGI is allowed to give.
// =============================================================================

// --- Contract 1 — shared vocabulary -----------------------------------------

/**
 * A provider's measured standing. `failed` is a RESULT, not an error: Contract 1
 * emits every provider row even when it did not answer.
 */
export type SmartDnsVerdict = "good" | "slow" | "failed";

/**
 * Which latency class an answer fell into, cut at `threshold_ms`.
 * `unknown` means no answer, never "did not measure".
 */
export type SmartDnsAnswerClass = "near" | "far" | "unknown";

/**
 * What the algorithm decided about the live edge block. `insufficient` means
 * fewer than `MIN_MEMBERS` providers measured good, so nothing is written.
 */
export type SmartDnsEdgeAction = "rewrite" | "keep" | "insufficient";

/** One provider's answer for one probe domain (Contract 1, `providers[].domains[]`). */
export interface SmartDnsDomainAnswer {
  domain: string;
  ok: boolean;
  ips: string[];
  /** Min RTT over the answers, or `null` when the upstream did not answer. */
  rtt_ms: number | null;
  class: SmartDnsAnswerClass;
}

/** One upstream in the pool, measured (Contract 1, `providers[]`). */
export interface SmartDnsProbeProvider {
  /** The upstream as the config spells it, e.g. `https://dns.google/dns-query`. */
  upstream: string;
  /** The short label the engine prints, e.g. `dns.google`. */
  short: string;
  ok: boolean;
  /** Median of the per-domain RTTs this upstream answered; `null` when none. */
  quality_ms: number | null;
  verdict: SmartDnsVerdict;
  /** True when this upstream is in the block that is live on the device now. */
  in_live_group: boolean;
  domains: SmartDnsDomainAnswer[];
}

/** A provider the algorithm dropped, with the sentence that says why. */
export interface SmartDnsDroppedProvider {
  upstream: string;
  /** Human-facing reason, e.g. `median 338 ms > 150 ms`. Rendered verbatim. */
  reason: string;
}

/** The algorithm's decision (Contract 1, `recommendation`). */
export interface SmartDnsRecommendation {
  good: string[];
  dropped: SmartDnsDroppedProvider[];
  action: SmartDnsEdgeAction;
  reason: string;
}

/**
 * The full engine report (Contract 1). The UI does not receive this over HTTP —
 * Contract 3 exposes no endpoint for it — so it is not rendered here. It is typed
 * because Contract 2 and Contract 3 reuse its vocabulary, and because the spec is
 * the source of truth for both.
 */
export interface SmartDnsProbeReport {
  generated_at: number;
  binary: string;
  config: string;
  threshold_ms: number;
  live_group: string[];
  probe_domains: string[];
  providers: SmartDnsProbeProvider[];
  recommendation: SmartDnsRecommendation;
}

// --- Contract 2 — the domain tester -----------------------------------------

/** One upstream's answer for the domain under test (Contract 2, `results[]`). */
export interface SmartDnsTestRow {
  upstream: string;
  short: string;
  ok: boolean;
  ips: string[];
  rtt_ms: number | null;
  class: SmartDnsAnswerClass;
}

/** A completed measurement (Contract 2). Emitted even when nobody answered. */
export interface SmartDnsTestResponse {
  domain: string;
  threshold_ms: number;
  tested_at: number;
  /** The fastest answer's IP, or `null` when no provider answered. */
  fastest: string | null;
  fastest_ms: number | null;
  slowest_ms: number | null;
  spread_ms: number | null;
  results: SmartDnsTestRow[];
}

/**
 * The CGI's failure shape — `cgi_error` in `lib/qmanager/cgi_base.sh`, which is
 * what `dns_test.sh` emits for `invalid_domain`, `timeout`, `probe_failed`,
 * `helper_missing` and `malformed_result`.
 *
 * This is NOT Contract 2's CLI error (`{"error":"invalid_domain"}`, exit 2): the
 * CGI is the trust boundary and wraps it with `success:false` plus a `detail`.
 * Both readings are accepted by `isSmartDnsTestResponse` below.
 */
export interface SmartDnsCgiError {
  success?: false;
  error: string;
  detail?: string;
}

/** Whatever `dns_test.sh` returned, before it is discriminated. */
export type SmartDnsTestPayload = SmartDnsTestResponse | SmartDnsCgiError;

/**
 * True when the payload is a measurement rather than an error.
 *
 * Discriminating on the PRESENCE OF `results` (an array) is what the CGI itself
 * checks before emitting a body, so the two sides agree by construction; `success`
 * is absent on the success path and cannot be used as the test.
 */
export function isSmartDnsTestResponse(
  payload: SmartDnsTestPayload | null,
): payload is SmartDnsTestResponse {
  return (
    payload !== null &&
    Array.isArray((payload as SmartDnsTestResponse).results)
  );
}

// --- Contract 3 — the status endpoint ---------------------------------------

/**
 * The live edge block, as the device has it (Contract 3, `edge`).
 *
 * `mode` is a free string on purpose: Contract 3 names the field but not its
 * vocabulary, so the UI prints it verbatim instead of inventing an enum the
 * backend has never agreed to.
 */
export interface SmartDnsEdgeState {
  mode: string;
  /** Upstreams in the generated `# BEGIN QMANAGER-EDGE v1` block. */
  members: string[];
  /** Epoch seconds of the last successful refresh, or `null` if it never ran. */
  last_refresh: number | null;
}

/** Response from GET /cgi-bin/quecmanager/network/smartdns.sh */
export interface SmartDnsStatusResponse {
  /** What the operator asked for — the value the toggle reflects. */
  enabled: boolean;
  /** What is actually running. `enabled && !running` is a state worth showing. */
  running: boolean;
  /** Daemon PID, `null` when it is not running. */
  pid: number | null;
  uptime_sec: number | null;
  rss_kb: number | null;
  config_path: string;
  config_size: number | null;
  /** Epoch seconds. */
  config_mtime: number | null;
  /**
   * ALWAYS `null`. `smartdns test -c` validates nothing on 0.13.1 (measured; see
   * Contract 3), so the endpoint must not pretend to have validated the file. The
   * real gate is the throwaway-port run inside `save`. Typed as the literal `null`
   * rather than `boolean | null` so no caller can render a verdict that cannot
   * exist.
   */
  config_valid: null;
  /** Configured cache cap (`cache-size` in the config). */
  cache_size: number | null;
  /** Records loaded at daemon start, from its own log line. */
  cache_loaded: number | null;
  provider_count: number | null;
  blocked_count: number | null;
  /** `ERROR` lines in the bounded log. */
  error_count: number | null;
  edge: SmartDnsEdgeState | null;
  /** Recent daemon log lines, oldest first. */
  logs_tail: string[];
  /**
   * The live config TEXT, for the editor.
   *
   * NOT SPELLED OUT IN CONTRACT 3, and it is the one field this UI needs that the
   * contract's field list omits: Contract 4 requires a config editor, `save` takes
   * config text, and no other endpoint returns the file. Typed optional so a
   * backend that follows Contract 3 literally still type-checks here — and the
   * editor then renders its "could not read the config" state with Save blocked,
   * rather than showing an empty box whose Save would overwrite the file with
   * nothing.
   */
  config?: string | null;
}

/** Response to POST `{action:"enable"|"disable"}` (Contract 3). */
export interface SmartDnsToggleResponse {
  enabled: boolean;
  running: boolean;
  /** The resolver answered a probe after the switch. */
  dns_ok: boolean;
  /** Always `"carrier"`: dnsmasq's strict-order still falls back to it. */
  fallback: "carrier";
}

/** POST `{action:"save"}` succeeded. */
export interface SmartDnsSaveSuccess {
  saved: true;
  restarted: boolean;
  /** True when the daemon was confirmed listening on 127.0.0.1:5353 again. */
  listening: boolean;
}

/**
 * POST `{action:"save"}` was refused. `detail` carries the throwaway-port
 * validator's own message and is rendered VERBATIM in the editor — it is the only
 * place a user can learn what in their config the daemon refused.
 */
export interface SmartDnsSaveFailure {
  saved: false;
  error: string;
  detail?: string;
}

export type SmartDnsSaveResponse = SmartDnsSaveSuccess | SmartDnsSaveFailure;

/**
 * POST `{action:"refresh_edges"}` — the Contract-1 recommendation, plus whether it
 * was applied.
 *
 * `providers` is an addition, not a licence. Contract 3 describes this response as
 * "the Contract-1 recommendation object + {applied:bool}" and says nothing about
 * the provider rows, but they are exactly what makes the edge panel legible (which
 * upstream measured what, and why it was kept) and the endpoint's own measurement
 * already contains them. So the type carries them OPTIONALLY: a reply that follows
 * Contract 3 literally renders the panel from `edge.members` and the last domain
 * test instead, and a reply that includes them renders the full Contract-1 table.
 * Either way nothing is invented — see `normaliseRefreshEdges` for the two wire
 * shapes this accepts and why it accepts both.
 */
export type SmartDnsRefreshEdgesResponse = SmartDnsRecommendation & {
  applied: boolean;
  /** Contract-1 provider rows, when the CGI returns them alongside the decision. */
  providers?: SmartDnsProbeProvider[];
};

/** What `refresh_edges` can return before it is normalised. */
export type SmartDnsRefreshEdgesPayload =
  | SmartDnsRefreshEdgesResponse
  | (SmartDnsCgiError & { recommendation?: SmartDnsRecommendation | null });

function isRecommendation(value: unknown): value is SmartDnsRecommendation {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.action === "string" &&
    Array.isArray(record.good) &&
    Array.isArray(record.dropped)
  );
}

/**
 * The recommendation from whichever shape arrived, or `null`.
 *
 * Two shapes are accepted, and the SECOND is the one that matters:
 *
 *   1. Contract 3 — the recommendation object with `applied` added, flat.
 *   2. What `network/smartdns.sh` emits today — `{applied, recommendation:{…},
 *      providers:[…]}`, i.e. the same decision one level down.
 *
 * The reason this is a normaliser rather than a cast: a card that read
 * `recommendation.dropped.length` off the second shape would throw on
 * `undefined` and take the page down, and a contract mismatch must never be able
 * to do that. A reply that is neither shape returns `null`, which the caller
 * reports as a refresh error rather than rendering a half-empty decision block.
 */
export function normaliseRefreshEdges(
  payload: unknown,
): SmartDnsRefreshEdgesResponse | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;

  const applied = record.applied === true;
  const providers = Array.isArray(record.providers)
    ? (record.providers as SmartDnsProbeProvider[])
    : undefined;

  const source = isRecommendation(record) ? record : record.recommendation;
  if (!isRecommendation(source)) return null;

  return {
    good: source.good,
    dropped: source.dropped,
    action: source.action,
    reason: typeof source.reason === "string" ? source.reason : "",
    applied,
    providers,
  };
}

// --- Contract 3 — the stats endpoint ----------------------------------------

/**
 * Response from GET /cgi-bin/quecmanager/network/smartdns_stats.sh
 *
 * NONE of these are smartdns counters: the binary has no statistics endpoint on
 * 0.13.1 (measured; docs/specs/smartdns-o5a.md > "The stats problem"). Every
 * figure is derived from dnsmasq's cache statistics, the Connection Quality
 * probe, the config file and the daemon log — which is why the UI labels the
 * SOURCE of each one instead of presenting them as the resolver's own.
 */
export interface SmartDnsStatsResponse {
  cache: {
    /** Configured cap, from `cache-size`. */
    size: number | null;
    /** dnsmasq's `N/M cache insertions re-used` line. */
    insertions: number | null;
    evictions: number | null;
    reused: number | null;
    hit_rate_pct: number | null;
  };
  /** The two paths of the same lookup: carrier resolver vs the LAN resolver. */
  latency: {
    carrier_ms: number | null;
    lan_ms: number | null;
    speedup_x: number | null;
  };
  pool: {
    /** Upstream `server` lines in the live config. */
    members: number | null;
    /** `ERROR` lines in the bounded daemon log. */
    errors: number | null;
  };
  /** `address /domain/#` rules in the config. */
  blocked: {
    rules: number | null;
  };
  /** Epoch seconds. */
  sampled_at: number | null;
}
