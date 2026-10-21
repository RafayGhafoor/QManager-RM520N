"use client";

import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import { cn } from "@/lib/utils";

import { GROUP_CARD, GROUP_HEAD } from "./shapes";

// =============================================================================
// GroupCard — one metric group, with the staleness chip
// =============================================================================
// The chip is the page's one freshness channel, and it is driven by
// `useModemStatus().isStale` — the poller's own verdict that the snapshot it is
// serving is older than a poll cycle. No timer is started here: a local
// `setInterval` would be a second clock disagreeing with the first, which is how
// the retired "live band" on /monitoring/latency ended up contradicting the
// cards underneath it (`docs/reference/latency-monitor.md:74`).
//
// It renders the WARNING HALF ONLY. A fresh group shows nothing, because a
// "Fresh" chip on every card is wallpaper that says nothing until it means
// something — the same call `/cellular/settings`' APN band made.
// =============================================================================

export interface GroupCardProps {
  title: string;
  description?: string;
  /** True when the poller's snapshot is older than a poll cycle. */
  stale: boolean;
  className?: string;
  children: React.ReactNode;
}

export function GroupCard({
  title,
  description,
  stale,
  className,
  children,
}: GroupCardProps) {
  const { t } = useTranslation("cellular");

  return (
    <section className={cn(GROUP_CARD, className)}>
      <header className={GROUP_HEAD.ROOT}>
        <div className={GROUP_HEAD.TITLES}>
          <h2 className={GROUP_HEAD.TITLE}>{title}</h2>
          {description ? <p className={GROUP_HEAD.DESC}>{description}</p> : null}
        </div>
        {stale ? (
          <Badge variant="warning" className={GROUP_HEAD.CHIP}>
            <MaterialSymbol name="warning" size={12} />
            {t("detailed_metrics.stale")}
          </Badge>
        ) : null}
      </header>
      {children}
    </section>
  );
}

export default GroupCard;
