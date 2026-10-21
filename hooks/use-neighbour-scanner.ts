"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { authFetch } from "@/lib/auth-fetch";
import { liveCellsToRows } from "@/lib/neighbour-live";
import type {
  LiveServingReadings,
  NeighbourCellResult,
  NeighbourLastResponse,
  NeighbourNowResponse,
  NeighbourRange,
  NeighbourRangeFailure,
  NeighbourScanStatusResponse,
  ScanStatus,
  ServingReadings,
} from "@/types/cell-scanner";

// =============================================================================
// The neighbour read's transport
// =============================================================================
// Deliberately a SEPARATE hook from `useCellScanner`, not a shared generic. The
// two drive different endpoints with different lifetimes, and the parts that
// looked shareable are exactly the parts that should differ (see the interval
// note below). What genuinely was shared — the table, the hero, the lock dialog,
// the state panels — is shared as components. Merging the transports too would
// buy one fewer file and cost the ability to tune either.
//
// This hook USED to be the weaker twin of `useCellScanner`, and the gap was not
// stylistic: it had no `pollStatusRef`, so every `setInterval` callback captured
// the first render's `pollStatus` and its closure went stale; and its poll catch
// block was empty, so a modem that stopped answering left the surface spinning
// silently for as long as the tab stayed open. Both are fixed here.
//
// TWO RANGES, ONE HOOK (2026-10-22). The endpoint gained `?range=`, so this hook
// gained a range. It is an EXTENSION, not a second hook: the one-shot read's
// lifecycle (start -> poll -> complete/error) is untouched, and the live view is
// a third section beside it. A second hook would have meant a second copy of
// that lifecycle for no gain.
// =============================================================================

/**
 * 1s, and NOT the parent's 2s.
 *
 * This is the one place the two transports should genuinely disagree. A neighbour
 * read is three short AT commands and a `sleep 1` — it finishes in about two
 * seconds, so a 2s cadence would routinely spend a whole extra poll after the
 * result was already on disk and make a fast operation feel slow. The parent
 * sweeps for up to 180s, where a 1s cadence would be 180 pointless requests
 * against a modem that is deliberately busy.
 */
const SCAN_POLL_INTERVAL = 1000;

/**
 * Consecutive failed polls before the run is called lost.
 *
 * Five at a 1s cadence is ~5s of silence. The parent allows ~10s because a sweep
 * has a legitimate reason to be unreachable — it is holding the AT mutex — while
 * a neighbour read does not, so this surface can be less patient without risking
 * a false negative.
 */
const MAX_POLL_FAILURES = 5;

/**
 * The live tick. 1 Hz is the rate the feature was measured at (~4 % of one core,
 * 0/30 failures over a soak) and the rate the poller itself publishes at, so a
 * faster read would render the same sample twice.
 */
const LIVE_POLL_INTERVAL = 1000;

/**
 * How long one visit to the live view may cost before it stops on its own.
 *
 * Aiming is a minutes-long activity, not an all-day one. A tab left open on the
 * live view would otherwise keep a 1 Hz QMI read running for as long as it is
 * left there — the exact "always-on sampler" the spec rules out. The budget
 * counts time SPENT POLLING, not wall time: a hidden tab polls nothing, and
 * coming back to it should not immediately spend the whole allowance.
 */
const LIVE_BUDGET_MS = 5 * 60 * 1000;

/**
 * Consecutive failed live reads before the view admits it is not updating.
 *
 * Three at 1 Hz is ~3s of silence. The sample on screen is up to 6s old by the
 * CGI's own window, so a single dropped fetch is normal and must not flicker a
 * warning; a second of it, however, means the numbers on screen are older than
 * the table says.
 */
const LIVE_MAX_FAILURES = 3;

/** Why live polling is not renewing the lease right now. Null while it is. */
export type LiveStop = "paused" | "expired" | null;

/** The `range=last` context: the serving cell, the carrier, and the age. */
export interface NeighbourLastView {
  /** Epoch seconds the last completed scan wrote, or `null` when there is none. */
  generatedAt: number | null;
  /** How old that scan is, in seconds, or `null` when it is unknown. */
  ageS: number | null;
  registered: boolean;
  carrier: string | null;
  serving: ServingReadings | null;
}

/** One live sample: the camped cell, the neighbours, and how old it is. */
export interface NeighbourLiveView {
  /** Epoch seconds the poller published this sample, or `null` when stale. */
  liveAt: number | null;
  /** How old the sample is, in seconds, or `null` when there is none. */
  ageS: number | null;
  /** QMI reports signal for a cell the modem may not be attached to. */
  registered: boolean;
  carrier: string | null;
  serving: LiveServingReadings | null;
  /** The sample's cells, mapped onto the table's row shape. */
  cells: NeighbourCellResult[];
}

interface UseNeighbourScannerReturn {
  status: ScanStatus;
  results: NeighbourCellResult[];
  error: string | null;
  startScan: () => Promise<void>;

  /** The last completed read's context. Always `null` outside `range=last`. */
  last: NeighbourLastView | null;
  /** The current live sample. `null` until the first answer lands, and outside `range=now`. */
  live: NeighbourLiveView | null;
  /** Non-null once the live view has stopped renewing its lease. */
  liveStop: LiveStop;
  /** True once consecutive live reads have failed; the sample on screen is frozen. */
  liveFailed: boolean;
  /** Stop renewing the lease, keeping the sample on screen. */
  pauseLive: () => void;
  /** Resume, starting a FRESH five-minute budget. */
  resumeLive: () => void;
}

export function useNeighbourScanner(
  range: NeighbourRange,
): UseNeighbourScannerReturn {
  const { t } = useTranslation("cellular");

  const [status, setStatus] = useState<ScanStatus>("idle");
  const [results, setResults] = useState<NeighbourCellResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<NeighbourLastView | null>(null);
  const [live, setLive] = useState<NeighbourLiveView | null>(null);
  const [liveStop, setLiveStop] = useState<LiveStop>(null);
  const [liveFailed, setLiveFailed] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failureCountRef = useRef(0);
  // Always holds the latest `pollStatus`, so an interval callback armed on one
  // render never calls the closure from an earlier one.
  const pollStatusRef = useRef<() => Promise<void>>(null!);
  /** Remaining live budget. Persists across effect re-runs; reset on entering `now`. */
  const liveBudgetRef = useRef(LIVE_BUDGET_MS);
  const liveFailuresRef = useRef(0);
  /** Only the newest live answer may land, so a slow one cannot overwrite a newer one. */
  const liveSeqRef = useRef(0);
  /**
   * The latest `t`, held so the callbacks can READ it without DEPENDING on it.
   *
   * i18next runs with the default `bindI18n: 'languageChanged'`, so switching
   * language hands back a fresh `t` identity. With `t` in `pollStatus`'s dep
   * array that rebuilt `pollStatus`, which rebuilt the mount effect, whose
   * cleanup calls `stopPolling()` — a language change mid-read killed the
   * interval and nothing re-armed it. The ref keeps every message current
   * (translations are read at the moment an error is raised, never cached)
   * while leaving `pollStatus` identity-stable, which is the only property the
   * interval and the mount effect care about.
   */
  const tRef = useRef(t);
  tRef.current = t;

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const finishScan = useCallback(() => {
    stopPolling();
    failureCountRef.current = 0;
  }, [stopPolling]);

  /** Arm the interval through the ref, never through a captured callback. */
  const ensurePolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(
      () => pollStatusRef.current(),
      SCAN_POLL_INTERVAL,
    );
  }, []);

  // ---------------------------------------------------------------------------
  // range=last — the completed read's context
  // ---------------------------------------------------------------------------
  // Only the CONTEXT is read here, not the rows: the rows on screen are the ones
  // the status poll produced, and a second copy of them from a second request
  // could disagree with the count the hero is showing. The serving cell, the
  // carrier and the age exist nowhere else — a neighbour report carries no
  // serving-cell marker — so they are worth the one request.
  const fetchLast = useCallback(async () => {
    try {
      const res = await authFetch(
        `/cgi-bin/quecmanager/at_cmd/neighbour_scan_status.sh?range=last&_t=${Date.now()}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: NeighbourLastResponse | NeighbourRangeFailure =
        await res.json();
      // A failure keeps the previous view: the rows and counts are still true,
      // and the columns that need this context render their own em dash.
      if (!data.success) return;
      setLast({
        generatedAt: data.generated_at,
        ageS: data.age_s,
        registered: data.registered,
        carrier: data.carrier,
        serving: data.serving,
      });
    } catch {
      // Deliberately silent. This read is context for three columns; failing it
      // must not raise an error panel over a completed scan.
    }
  }, []);

  // ---------------------------------------------------------------------------
  // range=now — the live sample, on a lease
  // ---------------------------------------------------------------------------
  // Each read renews the poller's lease, so the cadence IS the lease: stop
  // fetching and the device stops sampling within 10 s. Nothing here turns live
  // mode on; asking is what turns it on.
  const fetchLive = useCallback(async () => {
    const seq = ++liveSeqRef.current;
    try {
      const res = await authFetch(
        `/cgi-bin/quecmanager/at_cmd/neighbour_scan_status.sh?range=now&_t=${Date.now()}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: NeighbourNowResponse | NeighbourRangeFailure =
        await res.json();
      if (seq !== liveSeqRef.current) return;
      if (!data.success) throw new Error(data.error);

      liveFailuresRef.current = 0;
      setLiveFailed(false);
      setLive({
        liveAt: data.live_at,
        ageS: data.age_s,
        registered: data.registered,
        carrier: data.carrier,
        serving: data.serving,
        cells: liveCellsToRows(data.cells),
      });
    } catch {
      if (seq !== liveSeqRef.current) return;
      liveFailuresRef.current += 1;
      // The previous sample stays on screen and stays labelled with its own
      // age; the surface says out loud that it is no longer updating rather
      // than presenting a frozen reading as current.
      if (liveFailuresRef.current >= LIVE_MAX_FAILURES) setLiveFailed(true);
    }
  }, []);

  // A fresh allowance, and no stop, whenever the range changes. A sample from a
  // previous visit is dropped rather than handed to a surface that would label
  // it with today's clock.
  useEffect(() => {
    liveBudgetRef.current = LIVE_BUDGET_MS;
    liveFailuresRef.current = 0;
    setLiveStop(null);
    setLiveFailed(false);
    if (range !== "now") setLive(null);
  }, [range]);

  // The live loop. Two gates, and both are the lease's: the range must be `now`,
  // and the view must not be stopped. Hidden tabs are handled INSIDE the loop so
  // that becoming visible again resumes at the same cadence.
  useEffect(() => {
    if (range !== "now" || liveStop !== null) return;

    let interval: ReturnType<typeof setInterval> | null = null;
    let expiry: ReturnType<typeof setTimeout> | null = null;
    let armedAt = 0;

    const disarm = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
      if (expiry !== null) {
        clearTimeout(expiry);
        expiry = null;
      }
      if (armedAt !== 0) {
        liveBudgetRef.current = Math.max(
          0,
          liveBudgetRef.current - (Date.now() - armedAt),
        );
        armedAt = 0;
      }
    };

    const arm = () => {
      if (interval !== null) return;
      if (liveBudgetRef.current <= 0) {
        setLiveStop("expired");
        return;
      }
      armedAt = Date.now();
      expiry = setTimeout(() => {
        disarm();
        setLiveStop("expired");
      }, liveBudgetRef.current);
      interval = setInterval(() => void fetchLive(), LIVE_POLL_INTERVAL);
      // One read at once, so entering the range shows the current sample rather
      // than an em dash for a full second.
      void fetchLive();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") arm();
      else disarm();
    };

    // A hidden tab renews nothing. `use-sites.ts` gates its first read the same
    // way, for the same reason: a lease renewed from a background tab would keep
    // a 1 Hz sampler running for a screen nobody is looking at.
    if (document.visibilityState === "visible") arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      disarm();
    };
  }, [range, liveStop, fetchLive]);

  const pauseLive = useCallback(() => setLiveStop("paused"), []);
  // A resume starts a fresh budget, whether it follows an explicit pause or the
  // five-minute stop: both are deliberate acts, and a resumed session that
  // expired again a second later would be a control that does nothing.
  const resumeLive = useCallback(() => {
    liveBudgetRef.current = LIVE_BUDGET_MS;
    setLiveFailed(false);
    setLiveStop(null);
  }, []);

  const pollStatus = useCallback(async () => {
    try {
      const res = await authFetch(
        `/cgi-bin/quecmanager/at_cmd/neighbour_scan_status.sh?_t=${Date.now()}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data: NeighbourScanStatusResponse = await res.json();
      failureCountRef.current = 0;

      switch (data.status) {
        case "running":
          setStatus("running");
          // Mount-time detection: a read started on another route may still be
          // in flight, and without this it would never be polled.
          ensurePolling();
          break;

        case "complete": {
          const cells = data.results ?? [];
          setStatus("complete");
          setResults(cells);
          setError(null);
          finishScan();
          // The completed read is now the `last` range's subject, so its
          // serving cell and age are re-read with it.
          void fetchLast();
          if (cells.length > 0) {
            toast.success(
              tRef.current("cell_scanner.neighbour.toast.complete_title"),
              {
                description: tRef.current(
                  "cell_scanner.neighbour.toast.complete_desc",
                  { count: cells.length },
                ),
              },
            );
          }
          break;
        }

        case "error":
          setStatus("error");
          setError(
            data.message ?? tRef.current("cell_scanner.neighbour.error.failed"),
          );
          finishScan();
          break;

        default:
          // "idle", and which of the two idles matters.
          //
          // No interval armed: the mount poll on a page where nothing has run.
          // Genuinely idle, and silence is the right answer.
          //
          // An interval armed: a read WAS in flight and the worker died without
          // writing either a result or an error. Resetting to `idle` here — the
          // old behaviour — is indistinguishable from never having pressed the
          // button, so the surface owes the user an account instead.
          if (pollRef.current) {
            setStatus("error");
            setError(tRef.current("cell_scanner.neighbour.error.scan_vanished"));
            finishScan();
          }
          break;
      }
    } catch {
      // One dropped poll is not a failed read — the worker runs on the modem,
      // not in this tab. Sustained silence is, and it gets reported rather than
      // swallowed.
      failureCountRef.current += 1;
      if (failureCountRef.current < MAX_POLL_FAILURES) return;
      if (!pollRef.current) return;

      setStatus("error");
      setError(tRef.current("cell_scanner.neighbour.error.poll_lost"));
      finishScan();
      toast.error(
        tRef.current("cell_scanner.neighbour.toast.poll_failed_title"),
        {
          description: tRef.current(
            "cell_scanner.neighbour.toast.poll_failed_desc",
          ),
        },
      );
    }
  }, [ensurePolling, fetchLast, finishScan]);

  pollStatusRef.current = pollStatus;

  const startScan = useCallback(async () => {
    setStatus("running");
    setError(null);
    failureCountRef.current = 0;

    try {
      const res = await authFetch(
        "/cgi-bin/quecmanager/at_cmd/neighbour_scan_start.sh",
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();

      if (!data.success) {
        if (data.error === "already_running") {
          // Someone else's read is in flight. Attach to it rather than
          // reporting a failure the user cannot act on.
          setStatus("running");
          ensurePolling();
          return;
        }

        // The other scan type holds the modem — a full band sweep, in this
        // direction, which is the expensive one to wait on. It must NOT fall
        // through to `already_running` above: attaching would poll a neighbour
        // status file that does not exist, read `idle` a second later, and reset
        // the surface as though the button had never been pressed. The CGI's
        // `detail` is English-only and is dropped in favour of copy that names
        // the wait.
        if (data.error === "other_scan_running") {
          setStatus("error");
          setError(tRef.current("cell_scanner.neighbour.error.other_scan_running"));
          return;
        }

        setStatus("error");
        setError(
          data.detail ||
            data.error ||
            tRef.current("cell_scanner.neighbour.error.start_failed"),
        );
        return;
      }

      stopPolling();
      pollRef.current = setInterval(
        () => pollStatusRef.current(),
        SCAN_POLL_INTERVAL,
      );
    } catch {
      setStatus("error");
      setError(tRef.current("cell_scanner.neighbour.error.start_unreachable"));
    }
  }, [ensurePolling, stopPolling]);

  // Pick up a result or an in-flight read left by a previous visit.
  useEffect(() => {
    pollStatus();
    return () => stopPolling();
  }, [pollStatus, stopPolling]);

  // The last read's context, once per visit to that range. In `now` the live
  // sample is the subject, and nothing here is read.
  useEffect(() => {
    if (range !== "last") return;
    void fetchLast();
  }, [range, fetchLast]);

  // NO `beforeunload` GUARD, and that is deliberate. The parent installs one
  // because losing a 3-minute sweep is expensive and the modem stays busy after
  // the tab closes. A neighbour read costs two seconds and can simply be run
  // again; prompting "are you sure you want to leave?" over it would be the
  // interface inventing a stake it does not have.
  //
  // The LIVE range needs no guard for a different reason: a closed tab stops
  // renewing the lease, and the device's 1 Hz sampler stops by itself within
  // 10 s. There is nothing to lose and nothing left running.

  return {
    status,
    results,
    error,
    startScan,
    last,
    live,
    liveStop,
    liveFailed,
    pauseLive,
    resumeLive,
  };
}
