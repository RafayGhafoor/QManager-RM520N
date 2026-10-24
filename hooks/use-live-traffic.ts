"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  isLiveTrafficFailure,
  type LiveTrafficSample,
  type LiveTrafficSnapshot,
} from "@/types/modem-status";

// =============================================================================
// useLiveTraffic — the dashboard Live Traffic row's reader
// =============================================================================
// One GET per second of the **static** `/live-traffic.json` written by
// `qmanager_traffic` (native/qmanager_traffic). Not a CGI, and deliberately so:
// measured on this device 2026-10-24, a static read costs 9.0 ms of CPU and 1.4
// forks against 69.3 ms and 7.4 for a CGI — see
// `docs/reference/live-traffic.md`. At 1 Hz that is the difference between
// ~0.9 % and ~7 % of this box's single core.
//
// The shape of this hook is `hooks/use-detailed-metrics.ts`'s, because its three
// rules were learned on a live surface that already shipped:
//
//  1. A HIDDEN TAB READS NOTHING. A backgrounded dashboard polling once a second
//     would spend the device's only core on nobody's behalf.
//  2. ONLY THE NEWEST REQUEST MAY LAND (sequence guard), so a slow response
//     cannot overwrite a fresh one.
//  3. NOTHING IS WRITTEN AFTER UNMOUNT.
//
// Two things are specific to this document:
//
//  * IT CAN GO STALE WITHOUT FAILING. The file is static, so a dead sampler
//    still answers 200 with the last sample it wrote. `ts` is compared tick to
//    tick: a sample whose timestamp does not advance is not live, and after
//    STALE_AFTER_MISSES of those the row is told to show absence instead of a
//    frozen rate. Same for a fetch that fails outright.
//  * `warming` IS NOT ZERO. The first sample after a restart has no delta to
//    divide by; the UI must say "measuring…" rather than 0 bps.
// =============================================================================

const ENDPOINT = "/live-traffic.json";

/** One read per second, and only while the tab is visible. */
const LIVE_POLL_MS = 1_000;

/**
 * How many consecutive identical-or-failed reads before the reading is called
 * stale. Two, not one: a slow write/read race would otherwise blink the row to
 * absent once a minute, and one second of patience costs nothing.
 */
const STALE_AFTER_MISSES = 2;

export interface UseLiveTrafficReturn {
  /** The newest sample, or null before the first good read / while stale. */
  sample: LiveTrafficSample | null;
  /** True until the first read lands (skeleton-ish state for the row). */
  isLoading: boolean;
  /** The sampler answered, but with `ok: false` (no counter to read). */
  error: string | null;
  /** True when the document exists but is no longer advancing, or reads fail. */
  isStale: boolean;
  /** Force a read now (used when the row is switched back on). */
  refresh: () => void;
}

export function useLiveTraffic(enabled: boolean): UseLiveTrafficReturn {
  const [sample, setSample] = useState<LiveTrafficSample | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);

  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  // Refs, not state: they are read on every tick and must not re-arm the effect
  // that owns the interval.
  const lastTsRef = useRef<number | null>(null);
  const missesRef = useRef(0);

  const read = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      // The document is replaced every second, so any cache is a wrong answer.
      // `no-store` also keeps the service worker/browser from replaying it.
      const res = await fetch(ENDPOINT, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as LiveTrafficSnapshot;
      if (!mountedRef.current || seq !== seqRef.current) return;

      if (isLiveTrafficFailure(json)) {
        missesRef.current = 0;
        lastTsRef.current = null;
        setSample(null);
        setError(json.detail || json.error);
        setIsStale(false);
        return;
      }

      const advanced = lastTsRef.current === null || json.ts !== lastTsRef.current;
      lastTsRef.current = json.ts;
      missesRef.current = advanced ? 0 : missesRef.current + 1;

      if (missesRef.current >= STALE_AFTER_MISSES) {
        // A 200 that does not move is a dead sampler, not a quiet link.
        setSample(null);
        setError(null);
        setIsStale(true);
        return;
      }

      setSample(json);
      setError(null);
      setIsStale(false);
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      missesRef.current += 1;
      if (missesRef.current >= STALE_AFTER_MISSES) {
        setSample(null);
        setError(err instanceof Error ? err.message : "Live traffic unavailable");
        setIsStale(true);
      }
    } finally {
      if (mountedRef.current && seq === seqRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Switched off: no interval, no requests, and no half-stale value left
      // behind for the moment it is switched back on.
      seqRef.current++;
      setSample(null);
      setError(null);
      setIsStale(false);
      setIsLoading(true);
      lastTsRef.current = null;
      missesRef.current = 0;
      return;
    }

    let id: number | null = null;
    const stop = () => {
      if (id !== null) window.clearInterval(id);
      id = null;
    };
    const start = () => {
      if (id === null) id = window.setInterval(() => void read(), LIVE_POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Read once on the way back in: the document aged while the tab was
        // hidden, and the sampler kept writing. `ts` will have advanced, so
        // this read also clears a stale verdict.
        void read();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      void read();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [enabled, read]);

  const refresh = useCallback(() => {
    if (enabled) void read();
  }, [enabled, read]);

  return { sample, isLoading, error, isStale, refresh };
}
