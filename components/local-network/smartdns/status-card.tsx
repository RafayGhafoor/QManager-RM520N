"use client";

import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  CheckCircle2Icon,
  CircleSlashIcon,
  CheckIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  SegmentedField,
  SEGMENTED,
  type SegmentedOption,
} from "@/components/ui/segmented-field";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type {
  SmartDnsStatusResponse,
  SmartDnsToggleResponse,
} from "@/types/smartdns";

import { CHIP_GLYPH, CARD_HEAD, CARD_PAD, CARD_SHELL, CARD_TITLE, LOG_BODY, LOG_VIEWPORT, READOUT, SECTION_LABEL, SETTING_ROW } from "./shapes";
import { formatDuration, formatMoment, formatNumber } from "./format";

// =============================================================================
// StatusCard — is the resolver on, and what is it doing
// =============================================================================
// Contract 4's first card: the on/off switch, the running state, pid / RSS /
// uptime, the config path and its mtime, and — required, not optional — a plain
// sentence saying what OFF means.
//
// -----------------------------------------------------------------------------
// THE SWITCH IS A `SegmentedField`, AND THE OFF SENTENCE NEVER MOVES
// -----------------------------------------------------------------------------
// DESIGN.md > Segmented pills: an on/off decision on a new or reworked surface is
// the shared pill with a check glyph on the active segment, never a bare `Switch`
// — the glyph is what makes the selection survive grayscale, which a bare thumb
// does not.
//
// The consequence line is the SAME sentence in both positions. It says what
// turning this off does (dnsmasq falls back to the carrier resolvers, so DNS
// keeps working and lookups are slower), and that is the fact a user needs BEFORE
// they flip it. Swapping the sentence when the switch moves would hide it in the
// one position where the reader has already seen the outcome and no longer needs
// to be warned.
//
// -----------------------------------------------------------------------------
// `enabled` AND `running` ARE TWO FACTS AND BOTH ARE DRAWN
// -----------------------------------------------------------------------------
// `enabled` is what was asked for; `running` is what the daemon is doing. They
// disagree when a start failed or the unit was stopped underneath QManager, and
// collapsing them into one chip is how a stopped resolver renders as healthy.
// The third state — enabled but not running — takes `warning` and its own glyph,
// because it is the one state where the switch says "on" and the page must say
// otherwise.
// =============================================================================

const K = "smartdns";

/** The lucide check that SegmentedField reserves on every segment. */
const renderCheckGlyph = (className: string) => (
  <CheckIcon size={SEGMENTED.GLYPH} className={className} aria-hidden="true" />
);

type OnOff = "on" | "off";
type StatusState = "running" | "enabled_stopped" | "stopped";

const STATE_BADGE = {
  running: "success",
  enabled_stopped: "warning",
  stopped: "muted",
} as const;

const STATE_GLYPH = {
  running: CheckCircle2Icon,
  enabled_stopped: TriangleAlertIcon,
  stopped: CircleSlashIcon,
} as const;

export interface StatusCardProps {
  status: SmartDnsStatusResponse | null;
  isLoading: boolean;
  /** True while the enable/disable write is in flight. */
  isToggling: boolean;
  onToggle: (next: boolean) => Promise<SmartDnsToggleResponse | null>;
}

export function StatusCard({
  status,
  isLoading,
  isToggling,
  onToggle,
}: StatusCardProps) {
  const { t, i18n } = useTranslation("common");

  const state: StatusState = status?.running
    ? "running"
    : status?.enabled
      ? "enabled_stopped"
      : "stopped";
  const StateGlyph = STATE_GLYPH[state];

  const onOffOptions: SegmentedOption<OnOff>[] = [
    { value: "on", label: t("state.on") },
    { value: "off", label: t("state.off") },
  ];

  // One toast per finished action, fired here because this component owns the
  // action (DESIGN.md > Confirmation Toasts).
  const commit = async (next: OnOff) => {
    const wantOn = next === "on";
    const result = await onToggle(wantOn);
    if (result) {
      toast.success(
        t(wantOn ? `${K}.status.toggle.toast_enabled` : `${K}.status.toggle.toast_disabled`),
      );
    } else {
      toast.error(t(`${K}.status.toggle.toast_error`));
    }
  };

  const dash = "—";
  const units = {
    day: t(`${K}.duration.day`),
    hour: t(`${K}.duration.hour`),
    minute: t(`${K}.duration.minute`),
    second: t(`${K}.duration.second`),
  };

  const memory =
    status?.rss_kb === null || status?.rss_kb === undefined
      ? null
      : `${formatNumber(status.rss_kb / 1024, i18n.language, 1)} MB`;

  // "loaded / cap" is the interesting reading, because a loaded count that EQUALS
  // the cap means the cache is saturated and evicting (the reason the cap was
  // raised to 8192 here). Either half can be missing, so the joiner is built
  // around what exists rather than around both.
  const cacheLoaded = formatNumber(status?.cache_loaded ?? null, i18n.language);
  const cacheSize = formatNumber(status?.cache_size ?? null, i18n.language);
  const cacheValue =
    cacheLoaded !== null && cacheSize !== null
      ? `${cacheLoaded} / ${cacheSize}`
      : (cacheLoaded ?? cacheSize ?? dash);

  const readouts: {
    key: string;
    label: string;
    value: string;
    mono?: boolean;
  }[] = [
    {
      key: "pid",
      label: t(`${K}.status.readout.pid`),
      value: formatNumber(status?.pid ?? null, i18n.language) ?? dash,
    },
    {
      key: "memory",
      label: t(`${K}.status.readout.memory`),
      value: memory ?? dash,
    },
    {
      key: "uptime",
      label: t(`${K}.status.readout.uptime`),
      value:
        status?.uptime_sec === null || status?.uptime_sec === undefined
          ? dash
          : formatDuration(status.uptime_sec, units),
    },
    {
      key: "config_path",
      label: t(`${K}.status.readout.config_path`),
      value: status?.config_path || dash,
      mono: true,
    },
    {
      key: "config_mtime",
      label: t(`${K}.status.readout.config_modified`),
      value: formatMoment(status?.config_mtime ?? null, i18n.language) ?? dash,
    },
    { key: "cache", label: t(`${K}.status.readout.cache`), value: cacheValue },
    {
      key: "upstreams",
      label: t(`${K}.status.readout.upstreams`),
      value: formatNumber(status?.provider_count ?? null, i18n.language) ?? dash,
    },
    {
      key: "blocked",
      label: t(`${K}.status.readout.blocked_rules`),
      value: formatNumber(status?.blocked_count ?? null, i18n.language) ?? dash,
    },
    {
      key: "errors",
      label: t(`${K}.status.readout.log_errors`),
      value: formatNumber(status?.error_count ?? null, i18n.language) ?? dash,
    },
  ];

  const logs = status?.logs_tail ?? [];

  return (
    <Card className={CARD_SHELL}>
      <CardHeader className={cn(CARD_PAD, CARD_HEAD.ROOT)}>
        <div className={CARD_HEAD.TITLES}>
          <CardTitle className={CARD_TITLE}>{t(`${K}.status.title`)}</CardTitle>
          <span className={CARD_HEAD.DESC}>{t(`${K}.status.description`)}</span>
        </div>
        {status ? (
          <div className={CARD_HEAD.ACTIONS}>
            <Badge variant={STATE_BADGE[state]}>
              <StateGlyph className={CHIP_GLYPH} aria-hidden="true" />
              {t(`${K}.status.state.${state}`)}
            </Badge>
          </div>
        ) : null}
      </CardHeader>

      <CardContent className={cn(CARD_PAD, "flex flex-col gap-4")}>
        {isLoading && status === null ? (
          <StatusCardSkeleton />
        ) : (
          <>
            <div className={SETTING_ROW.ROOT}>
              <div className={SETTING_ROW.TEXT}>
                <span className={SETTING_ROW.LABEL}>
                  {t(`${K}.status.toggle.label`)}
                </span>
                <span className={SETTING_ROW.HINT}>
                  {t(`${K}.status.toggle.hint`)}
                </span>
              </div>
              <div className={SETTING_ROW.CONTROL}>
                <SegmentedField
                  value={status?.enabled ? "on" : "off"}
                  onValueChange={(next) => {
                    void commit(next);
                  }}
                  options={onOffOptions}
                  ariaLabel={t(`${K}.status.toggle.label`)}
                  disabled={isToggling}
                  breakpoint="never"
                  glyph={renderCheckGlyph}
                />
              </div>
            </div>

            <div className={READOUT.GRID}>
              {readouts.map((row) => (
                <div key={row.key} className={READOUT.ROOT}>
                  <span className={READOUT.KEY}>{row.label}</span>
                  <span
                    className={row.mono ? READOUT.VALUE_MONO : READOUT.VALUE}
                    title={row.mono ? row.value : undefined}
                  >
                    {row.value}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2">
              <span className={SECTION_LABEL}>{t(`${K}.status.log.title`)}</span>
              {logs.length > 0 ? (
                <div className={LOG_VIEWPORT}>
                  <pre className={LOG_BODY}>
                    {logs.map((line, index) => (
                      <span key={`${index}-${line}`}>{line}</span>
                    ))}
                  </pre>
                </div>
              ) : (
                <span className="text-on-surface-variant text-[0.8125rem]">
                  {t(`${K}.status.log.empty`)}
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The card's loading state: the toggle row and nine readout pills, at the real
 * heights imported from the loaded view's own constants.
 */
export function StatusCardSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <Skeleton className="h-[5.5rem] w-full rounded-tile" />
      <div className={READOUT.GRID}>
        {Array.from({ length: 9 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full rounded-pill" />
        ))}
      </div>
    </div>
  );
}

export default StatusCard;
