"use client";

import { useTranslation } from "react-i18next";
import { CableIcon, CircleSlashIcon, TriangleAlertIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CallTerminal } from "@/hooks/use-call-terminal";
import { cn } from "@/lib/utils";

import {
  CARD_HEAD,
  CARD_PAD,
  CARD_SHELL,
  CARD_TITLE,
  CHIP_GLYPH,
  FOOTNOTE,
  NOTICE,
  READOUT,
  SECTION_LABEL,
} from "./shapes";

// =============================================================================
// SessionCard — what the device is actually doing underneath the call
// =============================================================================
// The two cards above are controls; this one is the instrument panel, and it
// exists because the failure this feature has already produced once is invisible
// from the controls: the call is answered, the page says "active", and no audio
// flows because the device's PCM tap never opened (the vendor audio daemon was
// holding a dead client). Frames are the tell.
//
// -----------------------------------------------------------------------------
// THE TAP IS THE THING TO WATCH
// -----------------------------------------------------------------------------
// The tap is opened by the bridge when the modem reports "answered" and closed
// when the call ends. Three readings matter:
//
//   age       how long it has been open during this call. Restarting resets it,
//             so a tap that keeps collapsing shows as an age that never grows.
//   restarts  how many times it was reopened. A non-zero count is not a failure
//             on its own — the vendor stream does die on its own — but a climbing
//             one during a single call means the audio is gapping.
//   note      the bridge's own explanation when it has given up reopening. This
//             is the only place the "restart alsa.service" remedy is surfaced,
//             because the bridge's log lives in /data/log on the device.
//
// Downlink frames are counted by the bridge, not by the browser: a browser that
// receives nothing while the bridge counts thousands has a WebRTC problem, and
// the reverse (bridge counts nothing) is a device problem. One panel tells the
// two apart, which is why both directions are readouts here.
// =============================================================================

const K = "calls";

interface SessionCardProps {
  terminal: CallTerminal;
}

const seconds = (bytes: number): string => (bytes / 16000).toFixed(1);

const SessionCard = ({ terminal }: SessionCardProps) => {
  const { t } = useTranslation("common");
  const state = terminal.state;

  if (!state) {
    return (
      <Card className={cn(CARD_SHELL, CARD_PAD)}>
        <CardHeader className={CARD_HEAD.ROOT}>
          <div className={CARD_HEAD.TITLES}>
            <CardTitle className={CARD_TITLE}>{t(`${K}.session.title`)}</CardTitle>
            <p className={CARD_HEAD.DESC}>{t(`${K}.session.description`)}</p>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <div className={NOTICE.ROOT}>
            <div className={NOTICE.DISC}>
              <CableIcon className={NOTICE.GLYPH} aria-hidden="true" />
            </div>
            <p className={NOTICE.TITLE}>{t(`${K}.session.no_read_title`)}</p>
            <p className={NOTICE.BODY}>{t(`${K}.session.no_read_body`)}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const rows = [
    {
      key: t(`${K}.session.call`),
      value: t(`${K}.call_state.${terminal.state?.call_label ?? "idle"}`),
      mono: false,
    },
    {
      key: t(`${K}.session.number`),
      value: state.number === "" ? "—" : state.number,
      mono: true,
    },
    {
      key: t(`${K}.session.tap`),
      value: state.tap
        ? `${t(`${K}.session.tap_open`)} · ${Math.round(state.tap_age_s)}s`
        : t(`${K}.session.tap_closed`),
      mono: false,
    },
    {
      key: t(`${K}.session.restarts`),
      value: String(state.tap_restarts),
      mono: false,
    },
    {
      key: t(`${K}.session.downlink`),
      value: `${state.dl_frames} · ${seconds(state.dl_bytes)}s`,
      mono: false,
    },
    {
      key: t(`${K}.session.uplink`),
      value: `${state.ul_frames} · ${seconds(state.ul_bytes)}s`,
      mono: false,
    },
  ];

  return (
    <Card className={cn(CARD_SHELL, CARD_PAD)}>
      <CardHeader className={CARD_HEAD.ROOT}>
        <div className={CARD_HEAD.TITLES}>
          <CardTitle className={CARD_TITLE}>{t(`${K}.session.title`)}</CardTitle>
          <p className={CARD_HEAD.DESC}>{t(`${K}.session.description`)}</p>
        </div>
        <div className={CARD_HEAD.ACTIONS}>
          <Badge variant={state.tap ? "success" : "muted"}>
            {state.tap ? (
              <CableIcon className={CHIP_GLYPH} aria-hidden="true" />
            ) : (
              <CircleSlashIcon className={CHIP_GLYPH} aria-hidden="true" />
            )}
            {state.tap ? t(`${K}.session.tap_open`) : t(`${K}.session.tap_closed`)}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 px-0">
        {state.tap_note ? (
          <div className="flex items-start gap-2.5 rounded-field bg-warning-container px-4 py-3 text-on-warning-container">
            <TriangleAlertIcon className="mt-0.5 size-4 flex-none" aria-hidden="true" />
            <p className="text-[0.8125rem] leading-relaxed text-pretty">{state.tap_note}</p>
          </div>
        ) : null}

        <div className={READOUT.GRID}>
          {rows.map((row) => (
            <div key={row.key} className={READOUT.ROOT}>
              <span className={READOUT.KEY}>{row.key}</span>
              <span className={row.mono ? READOUT.VALUE_MONO : READOUT.VALUE}>
                {row.value}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1">
          <span className={SECTION_LABEL}>{t(`${K}.session.last_at`)}</span>
          <span className={READOUT.VALUE_MONO}>{state.last_at || "—"}</span>
        </div>

        <p className={FOOTNOTE}>{t(`${K}.session.footnote`)}</p>
      </CardContent>
    </Card>
  );
};

export default SessionCard;
