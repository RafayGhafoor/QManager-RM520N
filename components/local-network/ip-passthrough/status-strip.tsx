"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  HourglassIcon,
  RefreshCcwIcon,
  RouterIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { PassthroughState } from "@/types/ip-passthrough";

import {
  CONDITION,
  DISC_TONE,
  DISC_TRANSITION,
  EYEBROW,
  HERO_PAD,
  HERO_SHELL,
  PILL_GLYPH,
  SKELETON,
  STATUS,
} from "./shapes";

const K = "ipPassthrough";

export interface StatusStripProps {
  /** What was asked for. */
  enabled: boolean | null;
  /** What QCMAP reports right now. */
  state: PassthroughState | null;
  /** The device that is, or would be, bound. */
  targetMac: string;
  failed: boolean;
  onRetry: () => void;
}

export function StatusStrip({
  enabled,
  state,
  targetMac,
  failed,
  onRetry,
}: StatusStripProps) {
  const { t } = useTranslation("common");

  if (enabled === null) {
    return failed ? (
      <Card className={HERO_SHELL} role="region" aria-label={t(`${K}.status.label`)}>
        <CardContent className={HERO_PAD}>
          <div role="status" className={CONDITION.ROOT}>
            <span aria-hidden className={CONDITION.DISC}>
              <CircleAlertIcon className={CONDITION.GLYPH} />
            </span>
            <div className={CONDITION.TEXT}>
              <p className={CONDITION.TITLE}>{t(`${K}.errors.read_title`)}</p>
              <p className={CONDITION.BODY}>{t(`${K}.errors.read_body`)}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={onRetry}
              className={CONDITION.ACTION}
            >
              <RefreshCcwIcon className={PILL_GLYPH} aria-hidden />
              {t(`${K}.errors.retry`)}
            </Button>
          </div>
        </CardContent>
      </Card>
    ) : (
      <StatusStripSkeleton />
    );
  }

  // Four honest states: what was asked for crossed with what QCMAP says.
  const live = state === "active";
  const phase = enabled
    ? live
      ? "active"
      : "pending"
    : live
      ? "off_pending"
      : "off";
  const Glyph =
    phase === "active"
      ? CircleCheckIcon
      : phase === "off"
        ? RouterIcon
        : HourglassIcon;

  return (
    <Card className={HERO_SHELL} role="region" aria-label={t(`${K}.status.label`)}>
      <CardContent className={cn(HERO_PAD, STATUS.BODY)}>
        <div className={STATUS.PHASE}>
          <span
            aria-hidden
            className={cn(
              STATUS.DISC,
              DISC_TRANSITION,
              phase === "active" ? DISC_TONE.info : DISC_TONE.neutral,
            )}
          >
            <Glyph className={STATUS.GLYPH} />
          </span>
          <div className={STATUS.TEXT}>
            <span className={EYEBROW}>{t(`${K}.status.label`)}</span>
            <p className={STATUS.TITLE}>{t(`${K}.status.title.${phase}`)}</p>
            <p className={STATUS.BLURB}>
              {t(`${K}.status.blurb.${phase}`, { mac: targetMac })}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function StatusStripSkeleton() {
  return (
    <Card className={HERO_SHELL} aria-hidden>
      <CardContent className={cn(HERO_PAD, STATUS.BODY)}>
        <div className={STATUS.PHASE}>
          <Skeleton className={STATUS.DISC} />
          <div className={cn(STATUS.TEXT, "flex-1")}>
            <Skeleton className={SKELETON.EYEBROW} />
            <Skeleton className={SKELETON.TITLE} />
            <Skeleton className={SKELETON.BLURB} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default StatusStrip;
