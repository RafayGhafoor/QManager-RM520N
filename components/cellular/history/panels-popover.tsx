"use client";

import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

import {
  PANEL_IDS,
  shownPanelCount,
  type PanelId,
  type PanelVisibility,
} from "./panels";

// =============================================================================
// PanelsPopover — the page's panel picker
// =============================================================================
// A popover, not a second page-level control row: the range pill is the page's
// one visible control, and eight checkboxes do not fit beside it at any width.
// The trigger states the count (`shown/total`) so the page never hides a panel
// without saying that it has.
//
// The rows are a plain list of checkbox + label + hint, each row a real
// `label` so the whole row is the hit target. The hint is not decoration: "PHY
// depth" alone does not tell a reader what appears, and this page can be eight
// panels long.
// =============================================================================

export interface PanelsPopoverProps {
  visibility: PanelVisibility;
  onToggle: (id: PanelId) => void;
}

export function PanelsPopover({ visibility, onToggle }: PanelsPopoverProps) {
  const { t } = useTranslation("cellular");
  const baseId = useId();
  const shown = shownPanelCount(visibility);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="tonal-neutral" size="sm">
          <MaterialSymbol name="visibility" size={16} />
          {t("history.panels.button")}
          <span className="tabular-nums text-on-surface-variant">
            {t("history.panels.count", { shown, total: PANEL_IDS.length })}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <PopoverTitle className="px-1 pb-2 text-xs font-semibold text-on-surface-variant">
          {t("history.panels.title")}
        </PopoverTitle>
        <ul className="flex flex-col gap-0.5">
          {PANEL_IDS.map((id) => {
            const rowId = `${baseId}-${id}`;
            return (
              <li key={id}>
                <label
                  htmlFor={rowId}
                  className="flex cursor-pointer items-start gap-2.5 rounded-tile px-1 py-1.5 hover:bg-surface-container"
                >
                  <Checkbox
                    id={rowId}
                    glyph="check"
                    className="mt-0.5"
                    checked={visibility[id]}
                    onCheckedChange={() => onToggle(id)}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {t(`history.panels.items.${id}.label`)}
                    </span>
                    <span className="text-xs leading-relaxed text-on-surface-variant">
                      {t(`history.panels.items.${id}.hint`)}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export default PanelsPopover;
