"use client";

import { MaterialSymbol } from "@/components/ui/material-symbol";
import type { MaterialSymbolName } from "@/components/ui/material-symbol-names";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

// =============================================================================
// PanelEmpty — "there is nothing to draw here", in the house shape
// =============================================================================
// The same panel `detailed-metrics/empty-state.tsx` renders, restated for this
// family rather than imported from it: geometry and shells are restated across
// sibling feature modules, never reached across (DESIGN.md > A per-family
// `shapes.ts`). It carries NO title, because every hole on this page is
// described by one `history.*` sentence — the card's own heading is already
// above it, and a second title would say the same thing twice.
//
// The only loading affordance on this page is a `Skeleton`: a spinner promises
// an event that arrives, and every state here is either "not said yet" or
// "cannot be said".
// =============================================================================

export interface PanelEmptyProps {
  icon: MaterialSymbolName;
  body: string;
  className?: string;
}

export function PanelEmpty({ icon, body, className }: PanelEmptyProps) {
  return (
    <Empty
      className={cn(
        "min-h-[8rem] rounded-tile border-0 bg-surface-container p-6 md:p-6",
        className,
      )}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon" className="rounded-tile">
          <MaterialSymbol name={icon} size={24} />
        </EmptyMedia>
        <EmptyDescription className="text-xs/relaxed text-on-surface-variant">
          {body}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export default PanelEmpty;
