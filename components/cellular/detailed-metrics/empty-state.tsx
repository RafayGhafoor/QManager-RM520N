"use client";

import { MaterialSymbol } from "@/components/ui/material-symbol";
import type { MaterialSymbolName } from "@/components/ui/material-symbol-names";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

// =============================================================================
// MetricEmptyState — the shared "there is nothing to draw" panel
// =============================================================================
// The house `Empty` primitive, sized for a metric group rather than a page. It
// exists so the beams table and the archive card cannot drift into two
// different kinds of hole, and so neither of them grows a bespoke spinner: the
// only loading affordance on this page is a `Skeleton`, because a spinner
// promises an event that arrives and this page's states are all "not yet said"
// or "cannot be said".
// =============================================================================

export interface MetricEmptyStateProps {
  icon: MaterialSymbolName;
  title: string;
  body: string;
  className?: string;
}

export function MetricEmptyState({
  icon,
  title,
  body,
  className,
}: MetricEmptyStateProps) {
  return (
    <Empty
      className={cn(
        "min-h-[11rem] rounded-tile border-0 bg-surface-container p-6 md:p-6",
        className,
      )}
    >
      <EmptyHeader>
        {/* `size={24}` matches `EmptyMedia variant="icon"`'s own default: the
            variant's `[&_svg]` rules cannot reach a MaterialSymbol's inline
            font size (see empty.tsx). */}
        <EmptyMedia variant="icon" className="rounded-tile">
          <MaterialSymbol name={icon} size={24} />
        </EmptyMedia>
        <EmptyTitle className="text-sm font-semibold">{title}</EmptyTitle>
        <EmptyDescription className="text-xs/relaxed text-on-surface-variant">
          {body}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export default MetricEmptyState;
