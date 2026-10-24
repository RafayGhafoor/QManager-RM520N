"use client";

import React, { useCallback, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MetricBar } from "@/components/ui/metric-bar";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TickingValue } from "@/components/ui/ticking-value";
import { TickGroup } from "@/components/ui/tick-group";

import type { DeviceStatus, LteStatus, NrStatus } from "@/types/modem-status";
import {
  formatBytes,
  calculateLteDistance,
  calculateNrDistance,
  formatDistance,
  formatTemperature,
} from "@/types/modem-status";
import { useUnitPreferences } from "@/hooks/use-system-settings";
import { useDataUsed } from "@/hooks/use-data-used";
import { useLiveTraffic } from "@/hooks/use-live-traffic";
import { useModemSubsys } from "@/hooks/use-modem-subsys";
// The 44px coarse-pointer target for a Switch, from the shapes module the
// DESIGN.md entry names as its home. Imported rather than retyped: an overlay
// string that only one surface remembers is a string two surfaces disagree on.
import { SWITCH_TARGET } from "@/components/cellular/tower-locking/shapes";
import { DUR, staggerRows, staggerRowItem } from "@/lib/motion";
import {
  ABSENT,
  CARD_DESC,
  CARD_SHELL,
  CARD_TITLE,
  FOCUS_RING,
  METER_H,
  VALUE_CLASS,
} from "./shapes";
import { PillRow } from "./pill-row";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import { cn } from "@/lib/utils";

interface DeviceMetricsComponentProps {
  deviceData: DeviceStatus | null;
  lteData: LteStatus | null;
  nrData: NrStatus | null;
  isLoading: boolean;
  /**
   * Whether the last poll actually reached the modem.
   *
   * Spelled exactly as device-status.tsx and network-status.tsx spell it, and
   * for the same reason: the status hook deliberately keeps the previous
   * snapshot on a failed fetch, so a card reading only `deviceData` sees a
   * full, plausible payload during an outage and cannot tell it is looking at
   * a photograph.
   */
  modemReachable: boolean;
}

// --- Warning thresholds ---
const TEMP_WARN = 60; // °C
const TEMP_DANGER = 75; // °C
const CPU_WARN = 70; // percentage
const CPU_DANGER = 90; // percentage

/**
 * Where the Live Traffic switch remembers itself. Per browser, not per device:
 * this is a reading preference, so it belongs in the same place as the avatar
 * and the SMS read marks rather than on the modem's flash.
 */
const LIVE_TRAFFIC_STORAGE_KEY = "qm_live_traffic";

/**
 * The switch is read through `useSyncExternalStore` rather than hydrated in an
 * effect, and the reason is the static export: this page is prerendered at
 * build time, where `localStorage` does not exist and the row must default to
 * ON. An effect that then sets state is the react-compiler rule's textbook
 * "cascading render", and a lazy `useState` initializer would make the first
 * client render disagree with the prerendered HTML. `useSyncExternalStore`
 * states the difference explicitly — the server snapshot is `true`, the client
 * snapshot is the stored value — so React swaps them without a mismatch.
 *
 * The custom event is what makes a same-tab change visible: only cross-tab
 * changes arrive as a `storage` event on their own.
 */
const LIVE_TRAFFIC_CHANGE_EVENT = "qm:live-traffic-change";

function subscribeLiveTraffic(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(LIVE_TRAFFIC_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(LIVE_TRAFFIC_CHANGE_EVENT, onChange);
  };
}

function readLiveTrafficPreference(): boolean {
  try {
    return window.localStorage.getItem(LIVE_TRAFFIC_STORAGE_KEY) !== "0";
  } catch {
    // Private mode / storage disabled: the shipped default wins.
    return true;
  }
}

function writeLiveTrafficPreference(next: boolean) {
  try {
    window.localStorage.setItem(LIVE_TRAFFIC_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Remembering the preference is not worth failing the toggle over.
  }
  window.dispatchEvent(new Event(LIVE_TRAFFIC_CHANGE_EVENT));
}

/** One meter group: a label/value row over an 8px track. */
function MeterRow({
  label,
  children,
  bar,
}: {
  label: string;
  /** The value cell — already wrapped in its own `TickingValue`. */
  children: React.ReactNode;
  /**
   * The track. ALWAYS a `MetricBar`, never `null` — a bar with no reading
   * takes `value={null}` and draws the empty track (DESIGN.md > Quality bars).
   *
   * This prop used to accept `null` and fall back to an invisible spacer that
   * held the height and drew nothing. That is a THIRD spelling of absence: an
   * empty track says "no reading", a blank gap says "no meter". Introducing
   * the canonical one for the unreachable branch and leaving the old one
   * beside it would have put both in the same slot on the same card.
   */
  bar: React.ReactNode;
}) {
  return (
    <motion.div variants={staggerRowItem} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-on-surface-variant">
          {label}
        </span>
        <div className="flex items-center gap-1.5">{children}</div>
      </div>
      {bar}
    </motion.div>
  );
}

/**
 * The card speaks BYTES, so the rate is bytes per second.
 *
 * Data Used directly below is a byte total (`formatBytes`: "37.4 GB"), and this
 * row is the rate of that same counter — so "1.1 MB/s" beside "37.4 GB" is one
 * measurement in one unit family. It is also the convention the sibling product
 * shipped with (`greenpacket-o5a`, `v2/src/pages/Dashboard.svelte:80`:
 * `formatBytes(n) + '/s'` over gp-metricsd's bytes/s), which is what an owner
 * comparing the two UIs will read first.
 *
 * The document keeps BITS per second, because that is the canonical rate unit
 * and what a link budget is quoted in (and the sampler's own contract); the
 * conversion happens here, once, in the renderer. `formatBitsPerSec` exists in
 * types/modem-status.ts for anything that wants the other convention.
 */
function formatRate(bitsPerSec: number): string {
  return `${formatBytes(Math.round(bitsPerSec / 8))}/s`;
}

/**
 * One direction of the live rate pair: the direction glyph in its own ink, the
 * figure beside it in the row's value ink.
 *
 * Deliberately NOT wrapped in `TickingValue`, which every other figure on this
 * card uses. That component dips the figure on each value CHANGE (recipe 06),
 * and a rate that changes every second would dip once a second — the motion
 * would be reporting the refresh, which is not news. `tabular-nums` still keeps
 * the width steady, which is what the dip was partly buying.
 */
function RateCell({ direction, value }: { direction: "down" | "up"; value: string }) {
  return (
    <span className={cn(VALUE_CLASS, "flex items-center gap-1 tabular-nums")}>
      <MaterialSymbol
        name={direction === "down" ? "arrow_circle_down" : "arrow_circle_up"}
        size={20}
        filled
        className={cn(
          "shrink-0",
          direction === "down"
            ? "text-downlink-on-surface"
            : "text-uplink-on-surface",
        )}
      />
      {value}
    </span>
  );
}

/**
 * Skeleton (Skeleton-Mirror Rule): four meter groups and four pills, i.e. the
 * exact eight-row geometry of the loaded body at the exact same heights.
 *
 * It used to draw TEN generic rows for a body of seven, so the card lost height
 * the instant data landed and dragged its grid siblings with it. The fourth
 * pill is Live Traffic, which is present by default; a reader who has switched
 * it off gets one pill of slack, which is the cheaper error of the two — the
 * reverse would make this card grow when data arrives.
 */
function MetricsSkeleton() {
  return (
    <div className="flex flex-col gap-3.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div className="flex h-5 items-center justify-between gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-20" />
          </div>
          <Skeleton className={cn(METER_H, "w-full rounded-pill")} />
        </div>
      ))}
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full rounded-pill" />
      ))}
    </div>
  );
}

const DeviceMetricsComponent = ({
  deviceData,
  lteData,
  nrData,
  isLoading,
  modemReachable,
}: DeviceMetricsComponentProps) => {
  const { t } = useTranslation("dashboard");
  const { t: tc } = useTranslation("common");
  const unitPrefs = useUnitPreferences();
  const temp = deviceData?.temperature ?? null;
  const cpu = deviceData?.cpu_usage ?? null;
  const memUsed = deviceData?.memory_used_mb ?? 0;
  const memTotal = deviceData?.memory_total_mb ?? 0;
  const swapUsed = deviceData?.swap_used_mb ?? null;
  const swapTotal = deviceData?.swap_total_mb ?? null;

  // Same spelling as device-status.tsx and network-status.tsx, so the cards on
  // this surface cannot disagree about what "unreachable" means.
  const unreachable = !modemReachable;

  // The chip may not fire off a photograph: a temperature we cannot re-read is
  // not evidence the modem is still hot, and a warning nobody can refresh is
  // worse than no warning at all.
  const isTempHigh = !unreachable && temp !== null && temp >= TEMP_WARN;
  // CPU is /proc/stat on the box serving this page, so its chip is not gated.
  const isCpuHigh = cpu !== null && cpu >= CPU_WARN;
  const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;

  // Persistent data-usage counter — polled independently at 2 s cadence
  const { data: dataUsed, isResetting, resetCounter } = useDataUsed();

  // ── Live Traffic ────────────────────────────────────────────────────────
  // On by default, off remembered (see the store helpers above for why this is
  // `useSyncExternalStore` and not an effect).
  //
  // WHY THIS IS SWITCHABLE AT ALL: the row costs the device one HTTP read per
  // second while it is on (measured 9.0 ms of CPU, `docs/reference/live-traffic.md`).
  // Switched off, the browser issues no request at all — the numbers a user
  // cannot see should not be paid for.
  const liveTrafficOn = React.useSyncExternalStore(
    subscribeLiveTraffic,
    readLiveTrafficPreference,
    () => true,
  );
  const liveTraffic = useLiveTraffic(liveTrafficOn);
  const liveSample = liveTraffic.sample;
  // Three shapes, and they are not interchangeable: a rate, no rate YET, and no
  // reading at all. `warming` is the middle one and must never render as 0 bps.
  const liveHasRates = liveSample !== null && !liveSample.warming;
  const liveIsBlind =
    !liveHasRates && (liveTraffic.isStale || liveTraffic.error !== null);

  // /usrdata partition usage — sourced from the poller cache via modem-subsys
  const { data: subsysData } = useModemSubsys();
  const storageTotalKb = subsysData?.storage?.total_kb ?? 0;
  const storageUsedKb = subsysData?.storage?.used_kb ?? 0;
  const storagePct =
    storageTotalKb > 0 ? (storageUsedKb / storageTotalKb) * 100 : 0;

  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  const handleResetConfirm = useCallback(async () => {
    const ok = await resetCounter();
    if (ok) {
      toast.success(t("metrics.reset_success"));
    } else {
      toast.error(t("metrics.reset_error"));
    }
    setResetDialogOpen(false);
  }, [resetCounter, t]);

  // Skeleton handoff (Motion Guide recipe 11): the overlay lives for one
  // `quick` and then unmounts. Nothing downstream depends on it, so a missed
  // timer degrades to an ordinary instant swap rather than a stuck skeleton.
  const [handoff, setHandoff] = useState(false);
  const wasLoading = React.useRef(isLoading);
  React.useEffect(() => {
    const landed = wasLoading.current && !isLoading;
    wasLoading.current = isLoading;
    if (!landed) return;

    setHandoff(true);
    const id = window.setTimeout(() => setHandoff(false), DUR.quick * 1000);
    return () => window.clearTimeout(id);
  }, [isLoading]);

  // WHERE THE UNREACHABLE GATE STOPS, and it stops in the middle of this card
  // because `modem_reachable` means exactly one thing: the last AT command
  // timed out. It is not a verdict on the machine serving the page.
  //
  // GATED — read over AT, and free to have changed since. Temperature is
  // AT+QTEMP; both distances derive from the serving cell's timing advance.
  // When the poll fails the poller parses nothing and the PREVIOUS value
  // survives, so what is on screen is a photograph. Step 03 made this same
  // call for the two uptimes.
  //
  // NOT GATED — CPU (/proc/stat), memory (/proc/meminfo) and storage (a
  // different hook against a different endpoint) are measured locally and are
  // still fresh; the poller reads the first two unconditionally, before it
  // ever talks to the modem. Blanking them would be inventing an outage this
  // box is not having. The data counter below is cumulative and monotone: a
  // byte total cannot become WRONG while we are not looking, only incomplete.
  //
  // ABSENT rather than the formatters' own "-": both return a hyphen-minus for
  // a null reading, which beside a column of figures reads as a minus sign
  // with its digits missing. The formatters are shared with other routes, so
  // the sentinel is chosen here rather than changed there.
  const tempValue =
    unreachable || temp === null
      ? ABSENT
      : formatTemperature(temp, unitPrefs?.tempUnit);
  const cpuValue = cpu !== null ? `${cpu}%` : ABSENT;
  const memValue = memTotal > 0 ? `${memUsed} MB / ${memTotal} MB` : ABSENT;
  // Three distinct readings, not two: no swap device at all (0/0), a device the
  // cache has not reported yet (absent), and a real figure. Collapsing the first
  // two would print "0 MB / 0 MB" on a box that has 89 MB of zram.
  const hasSwap = (swapTotal ?? 0) > 0 && swapUsed !== null;
  const swapPct =
    hasSwap && swapTotal! > 0 ? Math.round((swapUsed! * 100) / swapTotal!) : null;
  const swapValue =
    swapTotal === null && swapUsed === null
      ? ABSENT
      : swapTotal === 0
        ? t("metrics.no_swap")
        : `${swapUsed ?? 0} MB / ${swapTotal} MB`;
  const storageValue =
    storageTotalKb > 0
      ? `${formatBytes(storageUsedKb * 1024)} / ${formatBytes(storageTotalKb * 1024)}`
      : ABSENT;

  const lteKm = calculateLteDistance(lteData?.ta ?? null);
  const nrKm = calculateNrDistance(nrData?.ta ?? null);
  const lteDistance =
    unreachable || lteKm === null
      ? ABSENT
      : formatDistance(lteKm, unitPrefs?.distanceUnit);
  const nrDistance =
    unreachable || nrKm === null
      ? ABSENT
      : formatDistance(nrKm, unitPrefs?.distanceUnit);

  const body = isLoading ? (
    <MetricsSkeleton />
  ) : (
    // One tick cascade for the whole body, and the card's reading order is
    // already the cascade order: the four meters top-to-bottom, then the Live
    // Traffic pill whose down/up pair sits side by side and so reads
    // left-to-right, then the Data Used pill, then the two distance rows. `TickGroup` sorts the live DOM nodes rather
    // than a declared index, so it needs no axis flag to switch between the
    // two — and rows that hold their value this poll never enter the ranking,
    // which is why one group over eight figures cannot run long.
    //
    // Wrapping the `motion.div` from outside is deliberate but also safe from
    // inside: `TickGroup` publishes its own React context and never touches
    // `MotionContext`, and motion/react resolves a child's parent through
    // `useContext(MotionContext)`, so an intervening plain provider is
    // transparent to `staggerRows` -> `staggerRowItem` propagation.
    <TickGroup>
      <motion.div
        className="flex flex-col gap-3.5"
        // Variants only, no initial/animate: this cascade INHERITS the
        // page-wide clock in home-component.tsx. Declaring its own would
        // detach it and start a second clock, which is the defect the
        // single-cascade step retired.
        variants={staggerRows}
      >
        {/* ── Modem Temperature ─────────────────────────────────────────── */}
        <MeterRow
          label={t("metrics.modem_temperature")}
          bar={
            <MetricBar
              value={unreachable ? null : temp}
              max={100}
              warnAt={TEMP_WARN}
              dangerAt={TEMP_DANGER}
              // A cool modem is good news, not merely not-yet-bad — so the
              // meter reads green below the warn line and still escalates to
              // amber and red above it.
              baseTone="success"
              track="surface-container-high"
              index={0}
            />
          }
        >
          {isTempHigh && (
            // The glyph inherits the chip's `on-warning-container` ink. It used
            // to carry `text-warning`, which repainted it in the SOLID role
            // colour on a container fill — the Container-Pair Rule's most common
            // failure. No `transition-colors` here either: `badge.tsx` writes its
            // own two-clock longhand and the utility would clobber it.
            <Badge variant="warning">
              <MaterialSymbol name="warning" size={12} filled />
              {t("metrics.high_temp_warning")}
            </Badge>
          )}
          <span className={VALUE_CLASS}>
            <TickingValue value={temp}>{tempValue}</TickingValue>
          </span>
        </MeterRow>

        {/* ── CPU Usage ─────────────────────────────────────────────────── */}
        <MeterRow
          label={t("metrics.cpu_usage")}
          bar={
            <MetricBar
              value={cpu}
              max={100}
              warnAt={CPU_WARN}
              dangerAt={CPU_DANGER}
              track="surface-container-high"
              index={1}
            />
          }
        >
          {isCpuHigh && (
            <Badge variant="warning">
              <MaterialSymbol name="warning" size={12} filled />
              {t("metrics.high_cpu_warning")}
            </Badge>
          )}
          <span className={VALUE_CLASS}>
            <TickingValue value={cpu}>{cpuValue}</TickingValue>
          </span>
        </MeterRow>

        {/* ── Memory Usage ──────────────────────────────────────────────── */}
        <MeterRow
          label={t("metrics.memory_usage")}
          bar={
            <MetricBar
              value={memTotal > 0 ? memPct : null}
              max={100}
              warnAt={70}
              dangerAt={90}
              track="surface-container-high"
              index={2}
            />
          }
        >
          <span className={VALUE_CLASS}>
            <TickingValue value={memUsed}>{memValue}</TickingValue>
          </span>
        </MeterRow>

        {/* ── Swap (zram) ─────────────────────────────────────────────────
            Directly under Memory because it is the same quantity with a
            different ceiling: on this SoC the swap device is compressed RAM
            (zram0), so a full swap means RAM pressure, not a slow disk. It is
            its own row rather than a suffix on Memory because the two move
            independently — memory can sit at 60 % while swap is full of pages
            that were cold an hour ago. */}
        {swapTotal !== 0 ? (
          <MeterRow
            label={t("metrics.swap_usage")}
            bar={
              <MetricBar
                value={swapPct}
                max={100}
                warnAt={50}
                dangerAt={85}
                track="surface-container-high"
                index={3}
              />
            }
          >
            <span className={VALUE_CLASS}>
              <TickingValue value={swapUsed}>{swapValue}</TickingValue>
            </span>
          </MeterRow>
        ) : null}

        {/* ── Storage (/usrdata partition) ──────────────────────────────── */}
        <MeterRow
          label={t("metrics.storage_label")}
          bar={
            <MetricBar
              value={storageTotalKb > 0 ? storagePct : null}
              max={100}
              warnAt={80}
              dangerAt={95}
              track="surface-container-high"
              index={4}
            />
          }
        >
          <span className={VALUE_CLASS}>
            <TickingValue value={storageUsedKb}>{storageValue}</TickingValue>
          </span>
        </MeterRow>

        {/* ── Live Traffic (WAN rate, one sample a second) ────────────────
            Above the cumulative counter on purpose: this answers "how fast am
            I going", the row below answers "how much have I used", and the
            question a user opens a dashboard with is the first one. Same row
            anatomy, same two direction inks and glyphs as Data Used, so the
            pair reads as the instantaneous and the total of one measurement. */}
        {liveTrafficOn && (
          <PillRow
            label={
              <>
                <span className="truncate">{t("metrics.live_traffic_label")}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn("inline-flex shrink-0", FOCUS_RING)}
                      aria-label={t("metrics.more_info_aria")}
                    >
                      <MaterialSymbol name="info" size={16} filled />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t("metrics.live_traffic_tooltip")}</p>
                  </TooltipContent>
                </Tooltip>
              </>
            }
          >
            {liveHasRates ? (
              <>
                <RateCell
                  direction="down"
                  value={formatRate(liveSample.rx_bps)}
                />
                <RateCell
                  direction="up"
                  value={formatRate(liveSample.tx_bps)}
                />
              </>
            ) : liveIsBlind ? (
              // One absent pair, not a zero: the sampler answered, but not
              // with a reading we can stand behind.
              <>
                <RateCell direction="down" value={ABSENT} />
                <RateCell direction="up" value={ABSENT} />
              </>
            ) : (
              <span className="text-sm font-semibold text-on-surface-variant tabular-nums">
                {t("metrics.live_traffic_warming")}
              </span>
            )}
          </PillRow>
        )}

        {/* ── Data Used (cumulative counter from AT+QGDCNT/QGDNRCNT) ────── */}
        <PillRow
          label={
            <>
              <span className="truncate">{t("metrics.data_used_label")}</span>
              <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                    aria-label={t("metrics.reset_counter_aria")}
                    disabled={isResetting}
                  >
                    <MaterialSymbol name="restart_alt" size={14} />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("metrics.reset_confirm_title")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("metrics.reset_confirm_desc")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{tc("actions.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={handleResetConfirm}>
                      {t("metrics.reset_confirm_button")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          }
        >
          {/* Down/up are the one place a solid role colour is right on a
              container: they are accent GLYPHS, not text, and the figure beside
              each keeps the container's ink. Both take the `-on-surface`
              variant, which is the tinted-ink token sized for a plain card.

              Download used to be `text-primary` here — the 5G NR identity hue
              on a figure that counts every byte the modem has received on any
              radio. It is Downlink Rose now, and this tile is the one place in
              the product that was already half-right: upload has been Uplink
              Cyan here all along while the speedtest dialog and the AMBR chips
              painted it Carrier Violet. All three agree now. */}
          <span className={cn(VALUE_CLASS, "flex items-center gap-1")}>
            <MaterialSymbol
              name="arrow_circle_down"
              size={20}
              filled
              className="shrink-0 text-downlink-on-surface"
            />
            <TickingValue value={dataUsed?.accumulated_rx_bytes ?? 0}>
              {formatBytes(dataUsed?.accumulated_rx_bytes ?? 0)}
            </TickingValue>
          </span>
          <span className={cn(VALUE_CLASS, "flex items-center gap-1")}>
            <MaterialSymbol
              name="arrow_circle_up"
              size={20}
              filled
              className="shrink-0 text-uplink-on-surface"
            />
            <TickingValue value={dataUsed?.accumulated_tx_bytes ?? 0}>
              {formatBytes(dataUsed?.accumulated_tx_bytes ?? 0)}
            </TickingValue>
          </span>
        </PillRow>

        {/* ── LTE Cell Distance ─────────────────────────────────────────── */}
        <PillRow
          label={
            <>
              <span className="truncate">{t("metrics.lte_cell_distance")}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn("inline-flex shrink-0", FOCUS_RING)}
                    aria-label={t("metrics.more_info_aria")}
                  >
                    <MaterialSymbol name="info" size={16} filled />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {!unreachable && lteData?.ta ? (
                    <p>{t("metrics.lte_distance_tooltip", { ta: lteData.ta })}</p>
                  ) : (
                    <p>{t("metrics.ta_unavailable")}</p>
                  )}
                </TooltipContent>
              </Tooltip>
            </>
          }
        >
          <span className={VALUE_CLASS}>
            <TickingValue value={lteDistance}>{lteDistance}</TickingValue>
          </span>
        </PillRow>

        {/* ── NR Cell Distance ──────────────────────────────────────────── */}
        <PillRow
          label={
            <>
              <span className="truncate">{t("metrics.nr_cell_distance")}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn("inline-flex shrink-0", FOCUS_RING)}
                    aria-label={t("metrics.more_info_aria")}
                  >
                    <MaterialSymbol name="info" size={16} filled />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {!unreachable && nrData?.ta ? (
                    <p>{t("metrics.nr_distance_tooltip", { ta: nrData.ta })}</p>
                  ) : (
                    <p>{t("metrics.ta_unavailable")}</p>
                  )}
                </TooltipContent>
              </Tooltip>
            </>
          }
        >
          <span className={VALUE_CLASS}>
            <TickingValue value={nrDistance}>{nrDistance}</TickingValue>
          </span>
        </PillRow>
      </motion.div>
    </TickGroup>
  );

  return (
    <Card className={CARD_SHELL}>
      {/* CardHeader with its own padding cancelled, because CARD_SHELL already
          carries px-6. Structurally identical to the loaded/skeleton titles in
          recent-activities.tsx and signal-status-card.tsx — this card has no
          CardAction today, but keeping the header slot means the grid column
          for one is already reserved, and a reviewer diffing the dashboard
          cards does not find this one built differently for no reason. */}
      <CardHeader className="px-0">
        <CardTitle className={cn(CARD_TITLE, "tabular-nums")}>
          {t("metrics.title")}
        </CardTitle>
        {/* An explicit ink class because the primitive hardcodes a retired
            one. Not skeletoned: both lines are constants and neither was ever
            unknown, so a placeholder here would withhold the one thing that
            could orient a reader while the rows fill in. */}
        <CardDescription className={CARD_DESC}>
          {t("metrics.description")}
        </CardDescription>
        {/* The card's first CardAction, in the slot the header has always
            reserved. The switch lives HERE and not in the row it hides: a
            control that only exists inside a hidden row cannot bring it back. */}
        <CardAction>
          <label className="flex cursor-pointer items-center gap-2">
            <span className="text-xs font-semibold text-on-surface-variant">
              {t("metrics.live_traffic_toggle")}
            </span>
            <Switch
              id="qm-live-traffic"
              className={cn(SWITCH_TARGET, FOCUS_RING)}
              checked={liveTrafficOn}
              onCheckedChange={writeLiveTrafficPreference}
              aria-label={t("metrics.live_traffic_toggle")}
            />
          </label>
        </CardAction>
      </CardHeader>

      {/* Recipe 11's overlay construction: the skeleton fades out ON TOP of the
          real content rather than beside it, so the real body owns the card's
          height from its first frame and the crossfade contributes zero layout
          shift. Pure opacity, no movement. */}
      <div className="relative">
        <div className={cn(handoff && "ca-content-in")}>{body}</div>
        {handoff && (
          <div
            aria-hidden
            className="ca-skeleton-out pointer-events-none absolute inset-0 [&>*]:h-full"
          >
            <MetricsSkeleton />
          </div>
        )}
      </div>
    </Card>
  );
};

export default DeviceMetricsComponent;
