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
type Choice = "disabled" | "enabled";

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
  enabled: boolean | null;
  isLoading: boolean;
  isSaving: boolean;
  failed: boolean;
  saveSettings: (enabled: boolean) => Promise<boolean>;
}

export function IPPassthroughCard({
  enabled,
  isLoading,
  isSaving,
  failed,
  saveSettings,
}: IPPassthroughCardProps) {
  const { t } = useTranslation("common");
  const { saved, markSaved } = useSaveFlash();
  const formId = useId();
  const [draft, setDraft] = useState<boolean | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const nextEnabled = draft ?? enabled;
  const dirty = enabled !== null && nextEnabled !== enabled;
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
    if (nextEnabled === null) return;

    const ok = await saveSettings(nextEnabled);
    if (!ok) {
      toast.error(t(`${K}.toast_apply_error`));
      return;
    }

    markSaved();
    // The deferred-reboot contract: all three lines, in this order.
    sessionStorage.setItem("qm_rebooting", "1");
    document.cookie = "qm_logged_in=; Path=/; Max-Age=0";
    window.location.href = "/reboot/";
  };

  const options: readonly SegmentedOption<Choice>[] = [
    { value: "disabled", label: t(`${K}.options.mode_disabled`) },
    { value: "enabled", label: t(`${K}.options.mode_eth`) },
  ];
  const selection: Choice = nextEnabled ? "enabled" : "disabled";
  const held = isSaving || enabled === null;

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
                    onValueChange={(value) => setDraft(value === "enabled")}
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
                    dirty ? MODE_NOTE.DIRTY : MODE_NOTE.REST,
                  )}
                >
                  {dirty ? (
                    <RotateCcwIcon className={MODE_NOTE.GLYPH} aria-hidden />
                  ) : (
                    <TriangleAlertIcon
                      className={cn(MODE_NOTE.GLYPH, MODE_NOTE.GLYPH_REST)}
                      aria-hidden
                    />
                  )}
                  <span>
                    {!dirty
                      ? t(`${K}.mode_note.rest`)
                      : nextEnabled
                        ? t(`${K}.mode_note.to_passthrough`)
                        : t(`${K}.mode_note.to_router`)}
                  </span>
                </div>
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
                variant={dirty && nextEnabled ? "destructive" : "default"}
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
            <AlertDialogTitle>{t(`${K}.dialog.title`)}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm">
                <p>{t(`${K}.dialog.body`)}</p>
                {nextEnabled ? (
                  <p className="text-on-surface font-medium">
                    {t(`${K}.dialog.body_gateway`)}
                  </p>
                ) : null}
                <p>{t(`${K}.dialog.body_persist`)}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(`${K}.dialog.cancel`)}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmedApply}>
              {t(`${K}.dialog.confirm`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default IPPassthroughCard;
