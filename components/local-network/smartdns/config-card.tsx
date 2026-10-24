"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileWarningIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CardFoot } from "@/components/ui/card-foot";
import { SaveButton, useSaveFlash } from "@/components/ui/save-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { SmartDnsStatusResponse } from "@/types/smartdns";
import type { SmartDnsSaveOutcome } from "@/hooks/use-smartdns";

import CardNotice from "./card-notice";
import {
  CARD_HEAD,
  CARD_PAD,
  CARD_SHELL,
  CARD_TITLE,
  CONFIG_EDITOR,
  ERROR_BOX,
  ERROR_TEXT,
} from "./shapes";

// =============================================================================
// ConfigEditorCard — the smartdns.conf editor
// =============================================================================
// Contract 4's fifth card. It edits the file the daemon reads, so every decision
// here is about not shipping a broken resolver by accident.
//
// -----------------------------------------------------------------------------
// THE SAVE IS THE GATE, NOT A TEST — AND ITS ERROR IS RENDERED VERBATIM
// -----------------------------------------------------------------------------
// `smartdns test -c` validates NOTHING on 0.13.1 (measured: it exits 0 for
// `totally-bogus-directive foo`). The real gate is `qmanager_dns_apply save`,
// which runs the candidate on a throwaway port, asserts it listens and answers,
// and only then swaps it in — and when it refuses, its `detail` is the only
// place in the product where a user can read WHY. So the failure is printed in
// the error container exactly as it arrived, untranslated: a paraphrase of a
// validator's diagnosis is a second implementation of the validator.
//
// -----------------------------------------------------------------------------
// SAVE IS BLOCKED, NEVER MERELY DISABLED, AND IT IS BLOCKED FOR THREE REASONS
// -----------------------------------------------------------------------------
// `SaveButton`'s `blockedReason` is a STRING — the stated reason it cannot be
// taken — and its presence is what blocks the control. That exists because a
// `disabled` button cannot be focused and carries no pointer events, so its
// reason is unreachable by exactly the users who need it. The three reasons:
//
//   the config could not be read   `status.config` absent — see BELOW
//   nothing has changed            the editor still holds what the device has
//   the editor is empty            see BELOW
//
// -----------------------------------------------------------------------------
// AN UNREADABLE CONFIG CLOSES THE EDITOR, IT DOES NOT PRESENT AN EMPTY ONE
// -----------------------------------------------------------------------------
// Contract 3's field list does not include the config text (this page needs it,
// and `types/smartdns.ts` records that gap). If it is absent — a backend that
// follows the contract literally, or a read that failed — the editor renders its
// "could not read the config" state with Save blocked. It must never render an
// empty textarea with a live Save, because that button would write nothing over
// a working resolver config.
//
// An empty editor is blocked for the same reason: a whitespace-only save is not
// an edit, it is a deletion with a confirmation prompt missing.
// =============================================================================

const K = "smartdns";

const FORM_ID = "smartdns-config-form";

export interface ConfigEditorCardProps {
  status: SmartDnsStatusResponse | null;
  isLoading: boolean;
  isSaving: boolean;
  onSave: (text: string) => Promise<SmartDnsSaveOutcome>;
}

export function ConfigEditorCard({
  status,
  isLoading,
  isSaving,
  onSave,
}: ConfigEditorCardProps) {
  const { t } = useTranslation("common");
  const { saved, markSaved } = useSaveFlash();

  const deviceConfig = typeof status?.config === "string" ? status.config : null;

  const [text, setText] = React.useState("");
  const [baseline, setBaseline] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const seededRef = React.useRef(false);

  // Seed ONCE, from the first read that carries the file. Re-seeding on every
  // poll would overwrite whatever the user has typed the moment a background
  // read landed.
  React.useEffect(() => {
    if (seededRef.current || deviceConfig === null) return;
    seededRef.current = true;
    setText(deviceConfig);
    setBaseline(deviceConfig);
  }, [deviceConfig]);

  const dirty = baseline !== null && text !== baseline;
  const isEmpty = text.trim().length === 0;

  const blockedReason = deviceConfig === null
    ? t(`${K}.config.blocked_unreadable`)
    : isEmpty
      ? t(`${K}.config.blocked_empty`)
      : !dirty
        ? t(`${K}.config.blocked_unchanged`)
        : null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (blockedReason !== null) return;

    const outcome = await onSave(text);
    if (outcome.ok) {
      // The reply carries no text; what was just accepted IS the new baseline.
      setBaseline(text);
      setSaveError(null);
      markSaved();
      toast.success(t(`${K}.config.toast_saved`));
      return;
    }

    // The validator's own words, verbatim, in both places they belong: the
    // persistent line keeps the context next to the file it is about, the toast
    // announces the event.
    const message = outcome.detail ?? outcome.error ?? t(`${K}.config.toast_error`);
    setSaveError(message);
    toast.error(message);
  };

  return (
    <Card className={CARD_SHELL}>
      <CardHeader className={cn(CARD_PAD, CARD_HEAD.ROOT)}>
        <div className={CARD_HEAD.TITLES}>
          <CardTitle className={CARD_TITLE}>{t(`${K}.config.title`)}</CardTitle>
          <span className={CARD_HEAD.DESC}>{t(`${K}.config.description`)}</span>
        </div>
      </CardHeader>

      <CardContent className={cn(CARD_PAD, "flex flex-col gap-4")}>
        {isLoading && status === null ? (
          <Skeleton className="h-[22rem] w-full rounded-field" aria-hidden="true" />
        ) : deviceConfig === null ? (
          <CardNotice
            glyph={FileWarningIcon}
            title={t(`${K}.config.unreadable_title`)}
            body={t(`${K}.config.unreadable_body`)}
            tone="alert"
          />
        ) : (
          <form id={FORM_ID} onSubmit={handleSubmit}>
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={isSaving}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="none"
              wrap="off"
              aria-label={t(`${K}.config.editor_label`)}
              className={CONFIG_EDITOR}
            />
          </form>
        )}

        {saveError !== null ? (
          <div className={ERROR_BOX} role="alert">
            <span className={ERROR_TEXT}>{saveError}</span>
          </div>
        ) : null}
      </CardContent>

      <CardFoot
        className={CARD_PAD}
        liveStatus={false}
        status={
          <>
            {/* The path is an opaque string compared character by character, so
                it takes the machine voice; it is also the answer to "which file
                did I just edit". */}
            <span
              className="min-w-0 truncate font-mono text-[0.75rem]"
              title={status?.config_path}
            >
              {status?.config_path ?? "—"}
            </span>
            {dirty ? (
              <span className="text-primary text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">
                {t(`${K}.config.unsaved`)}
              </span>
            ) : null}
          </>
        }
        actions={
          <>
            <Button
              type="button"
              variant="tonal-neutral"
              size="action"
              disabled={!dirty || isSaving}
              onClick={() => {
                setText(baseline ?? "");
                setSaveError(null);
              }}
            >
              {t(`${K}.config.discard`)}
            </Button>
            <SaveButton
              type="submit"
              form={FORM_ID}
              size="action"
              isSaving={isSaving}
              saved={saved}
              label={t(`${K}.config.save`)}
              blockedReason={blockedReason}
            />
          </>
        }
      />
    </Card>
  );
}

export default ConfigEditorCard;
