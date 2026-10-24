"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { authFetch } from "@/lib/auth-fetch";
import {
  isCellHistoryFailure,
  type CellHistoryRange,
  type CellHistoryResponse,
  type CellHistorySuccess,
} from "@/types/cell-history";

// =============================================================================
// useCellHistory — one ranged GET, one sequence
// =============================================================================
// Reads `fetch_signal_history.sh?view=cells&range=` and holds the newest
// answer. The three rules are `hooks/use-detailed-metrics.ts`'s, and they are
// rules because each one has already shipped broken somewhere:
//
//  1. RANGED READS ONLY. There is no `range=now` on this page and no live band
//     (`docs/reference/latency-monitor.md:74` — a live strip above a range view
//     disagrees with the cards under it the moment the range's last bucket is
//     more than a minute old). Every read is therefore a file read on the CGI
//     side, which is also why nothing here renews a live lease: this page never
//     asks the CGI to hold anything open.
//  2. ONLY THE NEWEST REQUEST MAY LAND. A 30d read is many times the work of a
//     1h read, so a range switch can land them out of order and paint the old
//     range's numbers under the new range's pill. Every fetch takes a sequence
//     number and drops itself if a newer one started — it must not even clear
//     the newer request's loading flag.
//  3. NOTHING IS WRITTEN AFTER UNMOUNT, and a hidden tab reads nothing. The
//     archive gains one row a minute, so 30 s is already eager; there is no
//     reason for a backgrounded tab to spend the device's only core on a page
//     nobody is looking at. Becoming visible reads once at once — the answer
//     aged while the tab was hidden — and then resumes the cadence.
//
// `dataRange` exists because `range` changes before the answer does. Anything
// that reads the payload's SHAPE ("does this response have a timeline") keys on
// `dataRange`, never on `range`: the moment between selecting a range and its
// first answer would otherwise render as "the archive recorded nothing".
// =============================================================================

const ENDPOINT = "/cgi-bin/quecmanager/at_cmd/fetch_signal_history.sh";

/** The archive gains one row a minute; 30 s is already eager. */
const RANGE_POLL_MS = 30_000;

export interface UseCellHistoryReturn {
  data: CellHistorySuccess | null;
  /** The range `data` was read for; it lags `range` until the new read lands. */
  dataRange: CellHistoryRange | null;
  isLoading: boolean;
  /** The thrown/failed read's own message — diagnostic, never rendered raw. */
  error: string | null;
  refresh: () => void;
}

export function useCellHistory(range: CellHistoryRange): UseCellHistoryReturn {
  const [data, setData] = useState<CellHistorySuccess | null>(null);
  const [dataRange, setDataRange] = useState<CellHistoryRange | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const rangeRef = useRef(range);

  const fetchRange = useCallback(async (next: CellHistoryRange) => {
    const seq = ++seqRef.current;
    try {
      const res = await authFetch(`${ENDPOINT}?view=cells&range=${next}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as CellHistoryResponse;
      // A superseded request must not touch the state of the one in flight.
      if (!mountedRef.current || seq !== seqRef.current) return;
      if (isCellHistoryFailure(json)) throw new Error(json.message ?? json.error);

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
    // A hidden tab leaves the read to the visibility handler, so selecting a
    // range in a background tab starts nothing.
    if (document.visibilityState !== "visible") return;
    void fetchRange(range);
  }, [range, fetchRange]);

  useEffect(() => {
    let id: number | null = null;
    const stop = () => {
      if (id !== null) window.clearInterval(id);
      id = null;
    };
    const start = () => {
      if (id === null) {
        id = window.setInterval(
          () => void fetchRange(rangeRef.current),
          RANGE_POLL_MS,
        );
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void fetchRange(rangeRef.current);
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
  }, [fetchRange]);

  const refresh = useCallback(() => {
    void fetchRange(rangeRef.current);
  }, [fetchRange]);

  return { data, dataRange, isLoading, error, refresh };
}
