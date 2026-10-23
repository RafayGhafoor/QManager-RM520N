"use client";

import * as React from "react";
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { RotateCcwIcon, TriangleAlertIcon } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CardFoot } from "@/components/ui/card-foot";
import { SaveButton, useSaveFlash } from "@/components/ui/save-button";
import { SegmentedField, type SegmentedOption } from "@/components/ui/segmented-field";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SaveOutcome } from "@/hooks/use-ip-passthrough";
import type { PassthroughState } from "@/types/ip-passthrough";

import {
  CARD_DESC,
  CARD_PAD,
  CARD_SHELL,
  CARD_TITLE,
  FOOT,
  MODE_NOTE,
  SETTING,
  SKELETON,
} from "./shapes";

const K = "ipPassthrough";
type Choice = "off" | "on";

function SettingRow({
  label,
  dirty,
  children,
}: {
  label: string;
  dirty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={SETTING.ROW}>
      <div className={SETTING.KEY}>
        <span className={SETTING.KEY_LINE}>
          {label}
          <span
            aria-hidden
            className={cn(SETTING.DOT, dirty ? SETTING.DOT_ON : SETTING.DOT_OFF)}
          />
        </span>
      </div>
      <div className={SETTING.CONTROL}>{children}</div>
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className={SETTING.BODY} aria-hidden>
      <div className={SETTING.GROUP}>
        <Skeleton className={SKELETON.EYEBROW} />
        <div className={SETTING.ROW}>
          <Skeleton className={SKELETON.ROW_KEY} />
          <Skeleton className={cn(SKELETON.PILL, "ml-auto w-36")} />
        </div>
        <Skeleton className={cn(SKELETON.NOTE_LINE, "w-full")} />
        <Skeleton className={cn(SKELETON.NOTE_LINE, "w-3/4")} />
      </div>
    </div>
  );
}

export interface IPPassthroughCardProps {
  /** What was asked for; `null` until the first successful read. */
  enabled: boolean | null;
  /** What QCMAP reports; decides whether turning off needs a reboot. */
  state: PassthroughState | null;
  /** Live LAN clients; passthrough binds exactly one. */
  clients: number;
  isLoading: boolean;
  isSaving: boolean;
  failed: boolean;
  saveSettings: (enabled: boolean) => Promise<SaveOutcome>;
  refresh: () => void;
}

export function IPPassthroughCard({
  enabled,
  state,
  clients,
  isLoading,
  isSaving,
  failed,
  saveSettings,
  refresh,
}: IPPassthroughCardProps) {
  const { t } = useTranslation("common");
  const { saved, markSaved } = useSaveFlash();
  const formId = useId();
  const [draft, setDraft] = useState<boolean | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const next = draft ?? enabled;
  const dirty = enabled !== null && next !== enabled;
  // Turning off only costs a reboot when passthrough is actually running.
  const offNeedsReboot = !next && state === "active";
  const blockedReason =
    enabled === null
      ? t(`${K}.errors.card_unread`)
      : !dirty
        ? t(`${K}.errors.no_changes`)
        : null;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (enabled === null || !dirty) return;
    setShowConfirm(true);
  };

  const handleDiscard = () => setDraft(null);

  const handleConfirmedApply = async () => {
    setShowConfirm(false);
    if (next === null) return;

    const outcome = await saveSettings(next);

    if (outcome === "failed") {
      toast.error(t(`${K}.toast_apply_error`));
      return;
    }

    markSaved();
    setDraft(null);

    if (outcome === "rebooting") {
      // The deferred-reboot contract: all three lines, in this order.
      sessionStorage.setItem("qm_rebooting", "1");
      document.cookie = "qm_logged_in=; Path=/; Max-Age=0";
      window.location.href = "/reboot/";
      return;
    }

    toast.success(
      t(
        outcome === "active"
          ? `${K}.toast_active`
          : outcome === "pending"
            ? `${K}.toast_pending`
            : `${K}.toast_off`,
      ),
    );
    refresh();
  };

  const options: readonly SegmentedOption<Choice>[] = [
    { value: "off", label: t(`${K}.options.off`) },
    { value: "on", label: t(`${K}.options.on`) },
  ];
  const selection: Choice = next ? "on" : "off";
  const held = isSaving || enabled === null;

  const noteKey = !dirty
    ? "rest"
    : next
      ? "to_on"
      : offNeedsReboot
        ? "to_off_reboot"
        : "to_off";

  return (
    <>
      <Card className={CARD_SHELL}>
        <CardHeader className={CARD_PAD}>
          <CardTitle className={CARD_TITLE}>{t(`${K}.card.title`)}</CardTitle>
          <CardDescription className={CARD_DESC}>
            {t(`${K}.card.description`)}
          </CardDescription>
        </CardHeader>

        <CardContent className={CARD_PAD}>
          {enabled === null ? (
            isLoading || !failed ? (
              <SettingsSkeleton />
            ) : (
              <p className={SETTING.UNREAD}>{t(`${K}.errors.card_unread`)}</p>
            )
          ) : (
            <form id={formId} className={SETTING.BODY} onSubmit={handleSubmit}>
              <div className={SETTING.GROUP}>
                <p className={SETTING.LABEL}>{t(`${K}.groups.passthrough`)}</p>
                <SettingRow label={t(`${K}.rows.mode.label`)} dirty={dirty}>
                  <SegmentedField
                    value={selection}
                    onValueChange={(value) => setDraft(value === "on")}
                    options={options}
                    ariaLabel={t(`${K}.rows.mode.label`)}
                    disabled={held}
                    breakpoint="never"
                    glyph={() => null}
                  />
                </SettingRow>

                <div
                  role="status"
                  className={cn(
                    MODE_NOTE.ROOT,
                    dirty && offNeedsReboot ? MODE_NOTE.DIRTY : MODE_NOTE.REST,
                  )}
                >
                  {dirty && offNeedsReboot ? (
                    <RotateCcwIcon className={MODE_NOTE.GLYPH} aria-hidden />
                  ) : (
                    <TriangleAlertIcon
                      className={cn(MODE_NOTE.GLYPH, MODE_NOTE.GLYPH_REST)}
                      aria-hidden
                    />
                  )}
                  <span>{t(`${K}.mode_note.${noteKey}`)}</span>
                </div>

                {clients > 1 ? (
                  <p className={SETTING.UNREAD}>{t(`${K}.errors.many_clients`)}</p>
                ) : null}
              </div>
            </form>
          )}
        </CardContent>

        <CardFoot
          className={CARD_PAD}
          status={
            dirty ? (
              <span className={FOOT.LINE}>
                <span className={FOOT.DOT} aria-hidden />
                {t(`${K}.card.unsaved_one`, { count: 1 })}
              </span>
            ) : undefined
          }
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={handleDiscard}
                disabled={isSaving || !dirty}
                size="action"
              >
                {t(`${K}.card.discard`)}
              </Button>
              <SaveButton
                type="submit"
                form={formId}
                variant={dirty && offNeedsReboot ? "destructive" : "default"}
                isSaving={isSaving}
                saved={saved}
                label={t(`${K}.card.apply`)}
                blockedReason={blockedReason}
                size="action"
              />
            </>
          }
        />
      </Card>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(`${K}.dialog.${next ? "on" : offNeedsReboot ? "off_reboot" : "off"}.title`)}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm">
                <p>
                  {t(`${K}.dialog.${next ? "on" : offNeedsReboot ? "off_reboot" : "off"}.body`)}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(`${K}.dialog.cancel`)}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmedApply}>
              {t(`${K}.dialog.${next ? "on" : offNeedsReboot ? "off_reboot" : "off"}.confirm`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default IPPassthroughCard;
