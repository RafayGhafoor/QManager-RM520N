"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { CircleAlertIcon, CircleCheckIcon, RefreshCcwIcon, RouterIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

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
  /** Configured flag read from the device's own backend. */
  enabled: boolean | null;
  failed: boolean;
  onRetry: () => void;
}

export function StatusStrip({ enabled, failed, onRetry }: StatusStripProps) {
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

  const Glyph = enabled ? CircleCheckIcon : RouterIcon;
  // Reuse the former `eth` locale slot as the O5A's generic enabled state; the
  // product endpoint reports no transport, so do not name Ethernet or USB here.
  const titleKey = enabled ? "eth" : "disabled";

  return (
    <Card className={HERO_SHELL} role="region" aria-label={t(`${K}.status.label`)}>
      <CardContent className={cn(HERO_PAD, STATUS.BODY)}>
        <div className={STATUS.PHASE}>
          <span
            aria-hidden
            className={cn(
              STATUS.DISC,
              DISC_TRANSITION,
              enabled ? DISC_TONE.info : DISC_TONE.neutral,
            )}
          >
            <Glyph className={STATUS.GLYPH} />
          </span>
          <div className={STATUS.TEXT}>
            <span className={EYEBROW}>{t(`${K}.status.label`)}</span>
            <p className={STATUS.TITLE}>{t(`${K}.status.mode_title.${titleKey}`)}</p>
            <p className={STATUS.BLURB}>{t(`${K}.status.blurb.${titleKey}`)}</p>
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
