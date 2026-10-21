"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { authFetch } from "@/lib/auth-fetch";
import {
  isDetailedMetricsFailure,
  type DetailedMetricRange,
  type DetailedMetricsResponse,
  type DetailedMetricsSuccess,
} from "@/types/detailed-metrics";

// =============================================================================
// useDetailedMetrics — one GET, one range, one sequence
// =============================================================================
// Reads `fetch_signal_history.sh?range=` and holds the newest answer. Three
// rules, all of them from a surface that shipped this shape already
// (`hooks/use-sites.ts`, and `docs/reference/latency-monitor.md:99`):
//
//  1. A HIDDEN TAB READS NOTHING on `now`, and stops reading when it goes
//     hidden. Each `range=now` read is one poll of the modem, so the browser
//     being in the foreground is what keeps the cost on; a backgrounded tab
//     that kept asking would spend the device's only core on nobody's behalf.
//     A ranged read (1h–90d) is a file read on the CGI side and keeps its slow
//     cadence either way.
//  2. ONLY THE NEWEST REQUEST MAY LAND. A 90d read is many times the work of a
//     1h read, so a range switch can land them out of order and paint the old
//     range's numbers under the new range's pill. Every fetch takes a sequence
//     number and drops itself if a newer one started.
//  3. NOTHING IS WRITTEN AFTER UNMOUNT.
//
// `dataRange` exists because `range` changes before the answer does. Anything
// that reads the payload's SHAPE — "does this response have a series" — must
// key on `dataRange`, never on `range`: a `now` response carries an empty
// series, so the moment between selecting a range and its first read would
// otherwise render as "this panel archived nothing".
// =============================================================================

const ENDPOINT = "/cgi-bin/quecmanager/at_cmd/fetch_signal_history.sh";

/** The live cadence. One read per second, and only while the tab is visible. */
const LIVE_POLL_MS = 1_000;

/** Ranged reads: the archive gains one row a minute, so 30 s is already eager. */
const RANGE_POLL_MS = 30_000;

export interface UseDetailedMetricsReturn {
  data: DetailedMetricsSuccess | null;
  /** The range `data` was read for; it lags `range` until the new read lands. */
  dataRange: DetailedMetricRange | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useDetailedMetrics(
  range: DetailedMetricRange,
): UseDetailedMetricsReturn {
  const [data, setData] = useState<DetailedMetricsSuccess | null>(null);
  const [dataRange, setDataRange] = useState<DetailedMetricRange | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const rangeRef = useRef(range);

  const fetchRange = useCallback(async (next: DetailedMetricRange) => {
    const seq = ++seqRef.current;
    try {
      const res = await authFetch(`${ENDPOINT}?range=${next}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as DetailedMetricsResponse;
      // A superseded request must not clear the error or the loading flag for
      // the request that is actually in flight.
      if (!mountedRef.current || seq !== seqRef.current) return;
      if (isDetailedMetricsFailure(json)) throw new Error(json.message ?? json.error);

      setData(json);
      setDataRange(next);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to read the archive");
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
    rangeRef.current = range;
    // A hidden tab selecting `now` leaves the read to the visibility handler,
    // so no lease-interval starts and nothing is read for a page nobody sees.
    if (range === "now" && document.visibilityState !== "visible") return;
    void fetchRange(range);
  }, [range, fetchRange]);

  useEffect(() => {
    if (range !== "now") {
      const id = window.setInterval(
        () => void fetchRange(rangeRef.current),
        RANGE_POLL_MS,
      );
      return () => window.clearInterval(id);
    }

    let id: number | null = null;
    const stop = () => {
      if (id !== null) window.clearInterval(id);
      id = null;
    };
    const start = () => {
      if (id === null) {
        id = window.setInterval(() => void fetchRange("now"), LIVE_POLL_MS);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Read once on the way back in, then resume the cadence: the snapshot
        // aged while the tab was hidden and nothing else will refresh it.
        void fetchRange("now");
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [range, fetchRange]);

  const refresh = useCallback(() => {
    void fetchRange(rangeRef.current);
  }, [fetchRange]);

  return { data, dataRange, isLoading, error, refresh };
}
