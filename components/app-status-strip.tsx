"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";

import { MaterialSymbol } from "@/components/ui/material-symbol";
import type { MaterialSymbolName } from "@/components/ui/material-symbol";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { QUALITY_GLYPH } from "@/components/cellular/signal-quality-display";
import { cn } from "@/lib/utils";
import { useLiveTraffic } from "@/hooks/use-live-traffic";
import { useModemStatus } from "@/hooks/use-modem-status";
import {
  formatBytes,
  getSignalQuality,
  RSRP_THRESHOLDS,
  type LteStatus,
  type ModemStatus,
  type NrStatus,
} from "@/types/modem-status";

// =============================================================================
// The app-wide status strip — three live facts in the top bar
// =============================================================================
// Until now the top bar held navigation only: which route am I on. Every live
// fact about the box — is it attached, how strong is the cell, what is moving —
// lived on /dashboard, so a user checking SMS or a settings form had to leave
// the page to answer "is anything wrong?" and come back.
//
// THREE LANES, and the number is the design. Each lane is one question with one
// answer that changes without a page reload:
//
//   connection — am I attached, to whom, on which RAT   → /dashboard
//   signal     — how strong is the serving cell         → /cellular
//   traffic    — what is moving across the LAN right now → /dashboard
//
// They are LINKS, not buttons. Each lane is a shortcut to the surface that owns
// its number, so the strip never becomes a second dashboard that has to be
// maintained alongside the first one. Nothing here is interactive beyond that:
// no toggles, no dialogs, no mutation of any kind, because a control that lives
// in the app chrome is one keystroke away from being pressed by accident on
// every route in the product.
//
// COST, because this mounts on every route. Two polls, both deliberately slower
// than the dashboard's:
//
//   status  — every 10 s through the cached CGI (the dashboard runs 2 s). The
//             answer to "which cell am I on" changes on handover, not per poll.
//   traffic — 1 Hz against the STATIC /live-traffic.json (9.0 ms of CPU and 1.4
//             forks per read, measured in docs/reference/live-traffic.md),
//             skipped entirely while the tab is hidden.
//
// Both are gated on tab visibility for the same reason: a cached status poll is
// ~69 ms of the device's single core, and spending it on a backgrounded tab is
// spending the box's CPU to tell nobody anything.
//
// The strip is ABSENT rather than wrong when it does not know. Before the first
// poll lands, while the poller is stale, and while the modem is unreachable,
// each lane renders its own unknown mark and no figure — the device is a CPE in
// someone's home, and a chrome element that confidently says "Jazz · 5G-NSA"
// two seconds after the poller died is worse than one that says nothing.
// =============================================================================

/** Status cadence for the strip. See the cost note above for why it is not 2 s. */
const STATUS_POLL_MS = 10_000;

// ─── Lane geometry ────────────────────────────────────────────────────────
// One string per role, not per lane: the three lanes must be interchangeable
// or the bar reads as three unrelated controls. 36px tall inside a 64px bar
// leaves the row centred without any wrapper arithmetic.
const LANE =
  "group/lane relative inline-flex h-9 items-center gap-2 rounded-pill px-2.5 " +
  "transition-colors duration-(--duration-quick) ease-quick " +
  "hover:bg-surface-container-high focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-background";

const LANE_VALUE =
  "hidden max-w-[24ch] truncate text-xs font-semibold tabular-nums " +
  "text-on-surface-variant desktop:inline";

// ─── Tab visibility ───────────────────────────────────────────────────────
// A one-line hook rather than a shared one: nothing else in the product needs
// it yet, and a hook that exists for one caller is a file that has to be found
// before it can be read. Promote it to hooks/ the day a second caller appears.
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return visible;
}

// ─── Lane 1: connection ───────────────────────────────────────────────────
// Six states, six glyphs, and no two share one — the glyph is what survives
// greyscale, deuteranopia and a washed-out screen, so it carries the state and
// the ink only reinforces it.
//
// "Unreachable" is NOT "offline". When the last poll did not return we have not
// observed a disconnection, we have lost the ability to observe anything, and
// the lane says exactly that.
type LinkState = "up" | "limited" | "searching" | "down" | "off" | "unknown" | "warm";

interface Lane {
  state: LinkState;
  glyph: MaterialSymbolName;
  ink: string;
  value: string;
  tooltip: string;
}

const LINK_INK: Record<LinkState, string> = {
  up: "text-success",
  limited: "text-warning",
  searching: "text-warning",
  down: "text-destructive",
  off: "text-on-surface-variant",
  unknown: "text-on-surface-variant",
  warm: "text-on-surface-variant",
};

const LINK_GLYPH: Record<LinkState, MaterialSymbolName> = {
  up: "cell_tower",
  limited: "priority_high",
  searching: "radar",
  down: "signal_disconnected",
  off: "airplanemode_active",
  unknown: "help",
  warm: "help",
};

function readLink(
  status: ModemStatus | null,
  isStale: boolean,
  t: (key: string, opts?: Record<string, unknown>) => string,
): Lane {
  if (!status) {
    return {
      state: "warm",
      glyph: LINK_GLYPH.warm,
      ink: LINK_INK.warm,
      value: t("statusStrip.waiting"),
      tooltip: t("statusStrip.waiting_tooltip"),
    };
  }

  // Airplane mode is a deliberate state and outranks everything else: with the
  // radio off, "no service" is the expected consequence, not a fault.
  const isAirplaneMode = status.network?.cfun === 0 || status.network?.cfun === 4;
  if (isAirplaneMode) {
    return {
      state: "off",
      glyph: LINK_GLYPH.off,
      ink: LINK_INK.off,
      value: t("statusStrip.off"),
      tooltip: t("statusStrip.off_tooltip"),
    };
  }

  if (!status.modem_reachable) {
    return {
      state: "unknown",
      glyph: LINK_GLYPH.unknown,
      ink: LINK_INK.unknown,
      value: t("statusStrip.unknown"),
      tooltip: t("statusStrip.unreachable_tooltip"),
    };
  }

  const service = status.network?.service_status ?? "unknown";
  const carrier = status.network?.carrier?.trim() || t("statusStrip.no_carrier");
  const rat = status.network?.type ?? "";

  if (service === "no_service" || service === "sim_error") {
    return {
      state: "down",
      glyph: LINK_GLYPH.down,
      ink: LINK_INK.down,
      value: t("statusStrip.offline"),
      tooltip: t("statusStrip.down_tooltip", { carrier }),
    };
  }

  if (service === "searching" || service === "unknown") {
    return {
      state: "searching",
      glyph: LINK_GLYPH.searching,
      ink: LINK_INK.searching,
      value: t("statusStrip.searching"),
      tooltip: t("statusStrip.searching_tooltip"),
    };
  }

  // "Limited" is attached-but-degraded. It gets its own glyph rather than the
  // healthy tower in warning ink, because tint alone is not a channel: at a
  // glance, and always for a colour-blind reader, this would otherwise read as
  // a perfectly good connection.
  if (service === "limited") {
    return {
      state: "limited",
      glyph: LINK_GLYPH.limited,
      ink: LINK_INK.limited,
      value: t("statusStrip.limited"),
      tooltip: t("statusStrip.limited_tooltip", { carrier, rat }),
    };
  }

  return {
    state: "up",
    glyph: LINK_GLYPH.up,
    ink: LINK_INK.up,
    value: [carrier, rat].filter(Boolean).join(" · "),
    // A stale snapshot is never presented as live: the tooltip is the one place
    // this lane can explain itself, and it names the delay rather than hiding it.
    tooltip: isStale
      ? t("statusStrip.up_stale_tooltip", { carrier, rat })
      : t("statusStrip.up_tooltip", { carrier, rat }),
  };
}

// ─── Lane 2: signal ───────────────────────────────────────────────────────
// The metric is the SERVING leg's RSRP: NR when a 5G leg is up, LTE otherwise,
// which is the same precedence the dashboard's hero card uses. RSRP and not
// SINR because RSRP is the number an installer moves the unit for.
//
// The glyph is the wedge ladder (`signal_cellular_0..4_bar`), not a single
// tower glyph: bar count is the channel that survives a colour-blind reader and
// a black-and-white screenshot, and the numeral beside it stays in the neutral
// reading ink precisely so the bar is the only quality channel. A tinted figure
// would need a bar or an sr-only word beside it anyway — this lane gives it the
// bar and keeps the figure plain.
function servingLeg(
  lte: LteStatus | null | undefined,
  nr: NrStatus | null | undefined,
): { leg: "5g" | "4g"; rsrp: number | null; rsrq: number | null; sinr: number | null } {
  const nrUp = nr?.state === "connected" && nr?.rsrp !== null && nr?.rsrp !== undefined;
  const leg = nrUp ? "5g" : "4g";
  const src = nrUp ? nr : lte;
  return {
    leg,
    rsrp: src?.rsrp ?? null,
    rsrq: src?.rsrq ?? null,
    sinr: src?.sinr ?? null,
  };
}

function readSignal(status: ModemStatus | null, t: (key: string, opts?: Record<string, unknown>) => string): Lane {
  const leg = servingLeg(status?.lte, status?.nr);
  const quality = getSignalQuality(leg.rsrp, RSRP_THRESHOLDS);

  const label = leg.leg === "5g" ? t("statusStrip.leg_5g") : t("statusStrip.leg_4g");

  if (leg.rsrp === null) {
    return {
      state: "unknown",
      glyph: QUALITY_GLYPH.none,
      ink: LINK_INK.unknown,
      value: t("statusStrip.no_reading"),
      tooltip: t("statusStrip.no_reading_tooltip"),
    };
  }

  const dB = (v: number | null) => (v === null ? "—" : `${v}`);

  return {
    state: "up",
    glyph: QUALITY_GLYPH[quality],
    ink: "text-on-surface-variant",
    value: `${leg.rsrp} dBm`,
    tooltip: t("statusStrip.signal_tooltip", {
      leg: label,
      rsrp: dB(leg.rsrp),
      rsrq: dB(leg.rsrq),
      sinr: dB(leg.sinr),
    }),
  };
}

// ─── Lane 3: live traffic ─────────────────────────────────────────────────
// Same reader as the dashboard's Live Traffic row (the static document the Rust
// sampler writes), same byte-not-bit rendering convention, same three shapes: a
// rate, no rate YET (`warming`, which must never print 0 B/s), and no reading at
// all. The last two are different lane values on purpose — an idle link and a
// blind sampler are not the same fact.
function formatRate(bitsPerSec: number): string {
  return `${formatBytes(Math.round(bitsPerSec / 8))}/s`;
}

function readTraffic(
  sample: ReturnType<typeof useLiveTraffic>["sample"],
  isStale: boolean,
  t: (key: string, opts?: Record<string, unknown>) => string,
): Lane {
  const base = {
    glyph: "swap_horiz" as MaterialSymbolName,
    ink: "text-on-surface-variant",
  };

  if (isStale || sample === null) {
    return {
      ...base,
      state: "unknown",
      value: t("statusStrip.no_reading"),
      tooltip: t("statusStrip.traffic_blind_tooltip"),
    };
  }

  if (sample.warming) {
    return {
      ...base,
      state: "warm",
      value: t("statusStrip.measuring"),
      tooltip: t("statusStrip.traffic_warming_tooltip"),
    };
  }

  return {
    ...base,
    state: "up",
    value: `↓ ${formatRate(sample.rx_bps)} · ↑ ${formatRate(sample.tx_bps)}`,
    tooltip: t("statusStrip.traffic_tooltip", {
      down: formatRate(sample.rx_bps),
      up: formatRate(sample.tx_bps),
    }),
  };
}

// ─── One lane ─────────────────────────────────────────────────────────────
function StatusLane({
  lane,
  href,
  ariaLabel,
  glyphSize = 18,
}: {
  lane: Lane;
  href: string;
  ariaLabel: string;
  glyphSize?: number;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link href={href} className={LANE} aria-label={ariaLabel}>
          <MaterialSymbol
            name={lane.glyph}
            size={glyphSize}
            filled
            className={cn("shrink-0", lane.ink)}
          />
          <span className={LANE_VALUE}>{lane.value}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{lane.tooltip}</TooltipContent>
    </Tooltip>
  );
}

// ─── The strip ────────────────────────────────────────────────────────────
export function AppStatusStrip() {
  const { t } = useTranslation("common");
  const visible = useDocumentVisible();

  // `enabled: visible` rather than unmounting the strip: the last reading stays
  // on screen through a tab switch, and the hooks re-arm from the cached value
  // when the tab comes back — no skeleton flash, no empty header.
  const { data, isStale } = useModemStatus({
    pollInterval: STATUS_POLL_MS,
    enabled: visible,
  });
  const traffic = useLiveTraffic(visible);

  const link = readLink(data, isStale, t);
  const signal = readSignal(data, t);
  const flow = readTraffic(traffic.sample, traffic.isStale, t);

  return (
    <div
      role="group"
      aria-label={t("statusStrip.aria")}
      className="ml-auto flex items-center gap-0.5 pr-2 lg:pr-4"
    >
      <StatusLane
        lane={link}
        href="/dashboard"
        ariaLabel={t("statusStrip.network_aria", { value: link.value })}
      />
      <StatusLane
        lane={signal}
        href="/cellular"
        ariaLabel={t("statusStrip.signal_aria", { value: signal.value })}
      />
      <StatusLane
        lane={flow}
        href="/dashboard"
        ariaLabel={t("statusStrip.traffic_aria", { value: flow.value })}
      />
    </div>
  );
}

export default AppStatusStrip;
