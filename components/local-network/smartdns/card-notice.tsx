"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { NOTICE } from "./shapes";

// =============================================================================
// CardNotice — the in-card resting / empty state
// =============================================================================
// One block for "there is nothing to draw here yet", used by four cards on this
// page: a new provider table with no measurement, the tester before it has run,
// a stats read that returned nothing, and a config file that could not be read.
//
// It is deliberately NOT `components/ui/empty.tsx`. That primitive ships
// `p-6 ... md:p-12` — a VIEWPORT breakpoint — inside a family whose responsive
// contract is container queries, and no call-site class can remove it (`p-*` and
// `md:p-*` are different variants, so `cn()` keeps both). The traffic-engine
// family reached the same conclusion for the same reason and restated the shape;
// this is the second instance, not a new exception.
//
// A skeleton is a promise that data is on its way. This block is the opposite —
// it is drawn when the answer is "nothing yet" or "the read failed" — so it never
// shimmers, and the disc is neutral so it cannot read as a warning.
// =============================================================================

export interface CardNoticeProps {
  glyph: LucideIcon;
  title: string;
  body: string;
  /** One action, drawn from the card's own edge rather than floating mid-block. */
  action?: React.ReactNode;
  /** `"role=alert"` for a failed read; `"status"` for an expected empty state. */
  tone?: "neutral" | "alert";
}

export function CardNotice({
  glyph: Glyph,
  title,
  body,
  action,
  tone = "neutral",
}: CardNoticeProps) {
  return (
    <div
      className={NOTICE.ROOT}
      role={tone === "alert" ? "alert" : "status"}
    >
      <span
        className={cn(
          NOTICE.DISC,
          tone === "alert" && "bg-destructive-container text-on-destructive-container",
        )}
      >
        <Glyph className={NOTICE.GLYPH} aria-hidden="true" />
      </span>
      <span className={NOTICE.TITLE}>{title}</span>
      <span className={NOTICE.BODY}>{body}</span>
      {action ? <span className={NOTICE.ACTION}>{action}</span> : null}
    </div>
  );
}

export default CardNotice;
