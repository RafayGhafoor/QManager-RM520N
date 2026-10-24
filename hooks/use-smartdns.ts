"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { authFetch } from "@/lib/auth-fetch";
import {
  isSmartDnsTestResponse,
  normaliseRefreshEdges,
  type SmartDnsCgiError,
  type SmartDnsRefreshEdgesPayload,
  type SmartDnsRefreshEdgesResponse,
  type SmartDnsSaveFailure,
  type SmartDnsSaveResponse,
  type SmartDnsStatsResponse,
  type SmartDnsStatusResponse,
  type SmartDnsTestPayload,
  type SmartDnsTestResponse,
  type SmartDnsToggleResponse,
} from "@/types/smartdns";

// =============================================================================
// use-smartdns — the SmartDNS page's three reads and four writes
// =============================================================================
// Contracts 3 in docs/specs/dns-edge-selection.md is the whole of this file:
//
//   GET/POST  network/smartdns.sh        status · enable/disable · save · refresh_edges
//   GET       network/smartdns_stats.sh  the derived performance figures
//   GET       network/dns_test.sh        one domain through every provider
//
// Three hooks rather than one, because the three reads answer three independent
// questions and fail independently: a dead stats read must not take the toggle
// with it, and a domain test in flight must not remount the status card. The
// page shell owns all three and passes what each card needs.
//
// -----------------------------------------------------------------------------
// MUTATORS RETURN THEIR RESULT; THE CALLER TOASTS FROM IT
// -----------------------------------------------------------------------------
// `toggle`, `saveConfig` and `refreshEdges` each return the call's own outcome —
// including the backend's `detail` — rather than only parking a message in
// `error` state. DESIGN.md's Confirmation Toasts rule is explicit about why: a
// caller that reads `error` after an `await` toasts whatever the PREVIOUS attempt
// failed with. The one exception is `refreshEdges`, where "it failed" and "it
// measured and dropped everything" are both legitimate outcomes the panel has to
// draw, so the hook keeps the error and the card reads it live.
//
// -----------------------------------------------------------------------------
// `refresh(silent?)` KEEPS ITS PARAMETER
// -----------------------------------------------------------------------------
// Same reason as `use-custom-dns`: typing it `() => Promise<void>` makes
// `onClick={refresh}` compile, which hands React's MouseEvent to `silent` — a
// truthy object — so a user-initiated refresh runs with its own spinner
// suppressed and the button looks inert. Declaring the parameter makes
// `onClick={() => refresh()}` the only spelling that builds.
// =============================================================================

const STATUS_ENDPOINT = "/cgi-bin/quecmanager/network/smartdns.sh";
const STATS_ENDPOINT = "/cgi-bin/quecmanager/network/smartdns_stats.sh";
const TEST_ENDPOINT = "/cgi-bin/quecmanager/network/dns_test.sh";

/** Bounded like the CGI's own helper timeout, so a wedged WAN cannot spin forever. */
const TEST_TIMEOUT_MS = 60_000;

/** What a config save came back as. `detail` is rendered VERBATIM in the editor. */
export interface SmartDnsSaveOutcome {
  ok: boolean;
  error?: string;
  detail?: string;
}

export interface UseSmartDnsReturn {
  /** Latest GET payload — `null` before the first read. */
  status: SmartDnsStatusResponse | null;
  /** True while the initial read is in flight. */
  isLoading: boolean;
  /** True while `enable`/`disable` is in flight. */
  isToggling: boolean;
  /** True while `refresh_edges` is in flight (a bounded sweep of every provider). */
  isRefreshingEdges: boolean;
  /** True while `save` is in flight. */
  isSavingConfig: boolean;
  /** Top-level read or transport error. */
  error: string | null;
  /** What the last `refresh_edges` returned, or `null` before one has run. */
  recommendation: SmartDnsRefreshEdgesResponse | null;
  /** The last `refresh_edges` failure. Distinct from a successful "all dropped". */
  refreshError: string | null;
  toggle: (next: boolean) => Promise<SmartDnsToggleResponse | null>;
  saveConfig: (text: string) => Promise<SmartDnsSaveOutcome>;
  refreshEdges: () => Promise<SmartDnsRefreshEdgesResponse | null>;
  /** Re-read the status. `silent` skips the loading state; never pass an event. */
  refresh: (silent?: boolean) => Promise<void>;
}

export function useSmartDns(): UseSmartDnsReturn {
  const [status, setStatus] = useState<SmartDnsStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isToggling, setIsToggling] = useState(false);
  const [isRefreshingEdges, setIsRefreshingEdges] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recommendation, setRecommendation] =
    useState<SmartDnsRefreshEdgesResponse | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------
  const refresh = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);

    try {
      const resp = await authFetch(STATUS_ENDPOINT);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      const data = (await resp.json()) as SmartDnsStatusResponse;
      if (!mountedRef.current) return;
      setStatus(data);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(
        err instanceof Error ? err.message : "Failed to fetch SmartDNS status",
      );
    } finally {
      if (mountedRef.current && !silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ---------------------------------------------------------------------------
  // Write: the on/off switch
  // ---------------------------------------------------------------------------
  const toggle = useCallback(
    async (next: boolean): Promise<SmartDnsToggleResponse | null> => {
      setIsToggling(true);
      setError(null);

      try {
        const resp = await authFetch(STATUS_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: next ? "enable" : "disable" }),
        });
        const result = (await resp.json()) as
          | SmartDnsToggleResponse
          | SmartDnsCgiError;

        if (!mountedRef.current) return null;

        if (!resp.ok || "error" in result) {
          setError(
            ("error" in result && result.error) ||
              `HTTP ${resp.status}: ${resp.statusText}`,
          );
          return null;
        }

        // The reply carries only the two flags. PID, RSS and uptime come from a
        // re-read — silently, so the card is not torn down and rebuilt around
        // the switch the user just flipped.
        setStatus((prev) =>
          prev ? { ...prev, enabled: result.enabled, running: result.running } : prev,
        );
        void refresh(true);
        return result;
      } catch (err) {
        if (!mountedRef.current) return null;
        setError(err instanceof Error ? err.message : "Failed to switch SmartDNS");
        return null;
      } finally {
        if (mountedRef.current) setIsToggling(false);
      }
    },
    [refresh],
  );

  // ---------------------------------------------------------------------------
  // Write: the config editor
  // ---------------------------------------------------------------------------
  const saveConfig = useCallback(
    async (text: string): Promise<SmartDnsSaveOutcome> => {
      setIsSavingConfig(true);

      try {
        const resp = await authFetch(STATUS_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "save", config: text }),
        });
        const result = (await resp.json()) as SmartDnsSaveResponse | SmartDnsCgiError;

        if (!mountedRef.current) return { ok: false };

        if ("saved" in result && result.saved === false) {
          const failure = result as SmartDnsSaveFailure;
          return { ok: false, error: failure.error, detail: failure.detail };
        }
        if ("error" in result) {
          // A transport-level `cgi_error` (auth, method, unexpected) rather than
          // the save contract's own refusal.
          return { ok: false, error: result.error, detail: result.detail };
        }
        if (!resp.ok) {
          return { ok: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
        }

        // The reply says saved/restarted/listening but carries no text; the
        // editor's baseline moves to what it just sent, and the re-read picks up
        // the new mtime and size.
        void refresh(true);
        return { ok: true };
      } catch (err) {
        if (!mountedRef.current) return { ok: false };
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Failed to save the config",
        };
      } finally {
        if (mountedRef.current) setIsSavingConfig(false);
      }
    },
    [refresh],
  );

  // ---------------------------------------------------------------------------
  // Write: refresh_edges — measure every provider, rewrite the group
  // ---------------------------------------------------------------------------
  const refreshEdges = useCallback(async (): Promise<SmartDnsRefreshEdgesResponse | null> => {
    setIsRefreshingEdges(true);
    setRefreshError(null);

    try {
      const resp = await authFetch(STATUS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh_edges" }),
      });
      const payload = (await resp.json()) as
        | SmartDnsRefreshEdgesPayload
        | SmartDnsCgiError;

      if (!mountedRef.current) return null;

      if (!resp.ok || "error" in payload) {
        setRefreshError(
          ("error" in payload && payload.error) ||
            `HTTP ${resp.status}: ${resp.statusText}`,
        );
        return null;
      }

      // Tolerant of the two wire shapes `normaliseRefreshEdges` documents; a
      // reply that is neither is reported rather than half-rendered.
      const result = normaliseRefreshEdges(payload);
      if (result === null) {
        setRefreshError("The refresh reply did not contain a recommendation");
        return null;
      }

      setRecommendation(result);
      // The block on the device may have just been rewritten.
      void refresh(true);
      return result;
    } catch (err) {
      if (!mountedRef.current) return null;
      setRefreshError(
        err instanceof Error ? err.message : "Failed to refresh edge selection",
      );
      return null;
    } finally {
      if (mountedRef.current) setIsRefreshingEdges(false);
    }
  }, [refresh]);

  return {
    status,
    isLoading,
    isToggling,
    isRefreshingEdges,
    isSavingConfig,
    error,
    recommendation,
    refreshError,
    toggle,
    saveConfig,
    refreshEdges,
    refresh,
  };
}

// =============================================================================
// useSmartDnsStats — the performance panel's read
// =============================================================================
// Deliberately NOT polled. Every figure behind it moves on the scale of a
// dnsmasq cache line or a Connection Quality sample, not on the poller's
// cadence, and a 2 s poll of four derived figures would spend more CPU than the
// resolver it is reporting on. The panel's own Refresh asks for a new reading.
// =============================================================================

export interface UseSmartDnsStatsReturn {
  stats: SmartDnsStatsResponse | null;
  isLoading: boolean;
  error: string | null;
  refresh: (silent?: boolean) => Promise<void>;
}

export function useSmartDnsStats(): UseSmartDnsStatsReturn {
  const [stats, setStats] = useState<SmartDnsStatsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);

    try {
      const resp = await authFetch(STATS_ENDPOINT);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      const data = (await resp.json()) as SmartDnsStatsResponse;
      if (!mountedRef.current) return;
      setStats(data);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(
        err instanceof Error ? err.message : "Failed to fetch SmartDNS statistics",
      );
    } finally {
      if (mountedRef.current && !silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { stats, isLoading, error, refresh };
}

// =============================================================================
// useSmartDnsTest — the domain tester
// =============================================================================
// A domain nobody answers is a RESULT (Contract 2: exit 0, every `ok:false`,
// `fastest:null`), so it must not arrive here as `error`. Only a rejected or
// failed sweep sets `error`, and it keeps the CGI's `error` code beside the
// `detail` so the card can translate a known code and still print an unknown one
// verbatim.
// =============================================================================

export interface SmartDnsTestError {
  /** The CGI's code: `invalid_domain`, `timeout`, `probe_failed`, `malformed_result`, `helper_missing`, or a transport message. */
  code: string;
  /** The CGI's own sentence, rendered verbatim when the code is not one we translate. */
  detail?: string;
}

export interface UseSmartDnsTestReturn {
  /** The last completed measurement, or `null` before one has run. */
  result: SmartDnsTestResponse | null;
  /** The domain that produced `result`, so the table can name it even after the input changes. */
  lastDomain: string | null;
  error: SmartDnsTestError | null;
  isTesting: boolean;
  run: (domain: string) => Promise<void>;
}

export function useSmartDnsTest(): UseSmartDnsTestReturn {
  const [result, setResult] = useState<SmartDnsTestResponse | null>(null);
  const [lastDomain, setLastDomain] = useState<string | null>(null);
  const [error, setError] = useState<SmartDnsTestError | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async (domain: string) => {
    const trimmed = domain.trim();
    if (trimmed.length === 0) return;

    setIsTesting(true);
    setError(null);

    // Bounded client-side too. The CGI bounds the helper, but a request that
    // never answers at all would otherwise leave the button spinning for as long
    // as the tab is open.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

    try {
      const resp = await authFetch(
        `${TEST_ENDPOINT}?domain=${encodeURIComponent(trimmed)}`,
        { signal: controller.signal },
      );
      const payload = (await resp.json()) as SmartDnsTestPayload;

      if (!mountedRef.current) return;

      if (isSmartDnsTestResponse(payload)) {
        setResult(payload);
        setLastDomain(payload.domain ?? trimmed);
        return;
      }

      setResult(null);
      setLastDomain(trimmed);
      setError({ code: payload.error ?? "unknown", detail: payload.detail });
    } catch (err) {
      if (!mountedRef.current) return;
      setLastDomain(trimmed);
      setError({
        code: controller.signal.aborted ? "timeout" : "transport",
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      clearTimeout(timer);
      if (mountedRef.current) setIsTesting(false);
    }
  }, []);

  return { result, lastDomain, error, isTesting, run };
}
