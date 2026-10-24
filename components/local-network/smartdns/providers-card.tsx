"use client";

import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  CircleSlashIcon,
  Loader2Icon,
  MinusIcon,
  RadarIcon,
  RefreshCcwIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type {
  SmartDnsProbeProvider,
  SmartDnsRecommendation,
  SmartDnsRefreshEdgesResponse,
  SmartDnsStatusResponse,
  SmartDnsTestResponse,
} from "@/types/smartdns";

import CardNotice from "./card-notice";
import { ElapsedNote } from "./elapsed-note";
import { formatMoment, formatNumber, shortUpstream } from "./format";
import {
  CARD_HEAD,
  CARD_PAD,
  CARD_SHELL,
  CARD_TITLE,
  CHIP_GLYPH,
  ERROR_BOX,
  ERROR_TEXT,
  FOOTNOTE,
  GROUP_MARK,
  SECTION_LABEL,
  TABLE,
  TABLE_COLS,
  VERDICT_BADGE,
  VERDICT_GLYPH,
  type VerdictSlot,
} from "./shapes";

// =============================================================================
// ProvidersCard — the edge-selection panel, where the algorithm is made visible
// =============================================================================
// Contract 4's second card. Its job is that a reader can see WHY the group has
// the members it has: which providers measured well, which were dropped and by
// how much, and which are carrying the live block right now.
//
// -----------------------------------------------------------------------------
// WHERE EACH COLUMN ACTUALLY COMES FROM — read this before changing a column
// -----------------------------------------------------------------------------
// Contract 3 exposes the edge state but not the Contract-1 provider report: GET
// `smartdns.sh` returns `edge {mode, members, last_refresh}`, and POST
// `refresh_edges` returns the recommendation (`good`, `dropped[].reason`,
// `action`, `reason`) plus `applied`. The per-provider MEASUREMENT — quality in
// milliseconds, answer class, per-domain answers — reaches the UI only through
// `dns_test.sh` (Contract 2), which is one domain at a time.
//
// So the rows here are the UNION of three sources, and the merge is deliberate
// rather than convenient:
//
//   status.edge.members        which upstreams carry the live block
//   recommendation             which the algorithm kept and which it dropped
//   recommendation.providers   the Contract-1 rows, when the reply carries them:
//                              measured quality, verdict, per-domain answers
//   the last domain test       the same measurements for one domain, when the
//                              tester has been run and the reply carries none
//
// Nothing here invents a field. What the merge buys is the honest reading: a
// provider can be IN the live group and UNMEASURED since the page loaded, and
// that state gets its own chip rather than being drawn as `failed` — a working
// upstream labelled broken is worse than one labelled unknown.
//
// -----------------------------------------------------------------------------
// VERDICT IS DERIVED, AND THE DERIVATION IS THE HONEST PART
// -----------------------------------------------------------------------------
//   measured by the last test   ok ? (class "far" ? slow : good) : failed
//   only in the recommendation  in `good` ? good : (dropped ? slow : unmeasured)
//   neither                     unmeasured
//
// `slow` for a dropped provider is not a guess: Contract 1 drops a provider for
// measuring above `threshold_ms`, and its `reason` says the number. The reason is
// rendered verbatim in the recommendation block, which is where a reader can see
// that "slow" means "median 338 ms > 150 ms" on this device.
// =============================================================================

const K = "smartdns";

interface ProviderRow {
  upstream: string;
  short: string;
  /** Measured quality, from the last domain test. `null` when unmeasured. */
  qualityMs: number | null;
  verdict: VerdictSlot;
  inGroup: boolean;
  /** The answers this provider handed out, grouped by the domain asked. */
  answers: { domain: string; ips: string[] }[];
}

const ACTION_BADGE = {
  rewrite: "info",
  keep: "success",
  insufficient: "warning",
} as const;

export interface ProvidersCardProps {
  status: SmartDnsStatusResponse | null;
  recommendation: SmartDnsRefreshEdgesResponse | null;
  /** The last `refresh_edges` failure — distinct from a successful all-dropped sweep. */
  refreshError: string | null;
  isRefreshing: boolean;
  /** True while the first status read is in flight. */
  isLoading: boolean;
  /** The most recent domain test, so quality and answers have a source. */
  lastTest: SmartDnsTestResponse | null;
  onRefresh: () => void;
}

function buildRows(
  status: SmartDnsStatusResponse | null,
  recommendation: SmartDnsRecommendation | null,
  lastTest: SmartDnsTestResponse | null,
  probeProviders: SmartDnsProbeProvider[] | undefined,
): ProviderRow[] {
  const members = status?.edge?.members ?? [];
  const tested = new Map(
    (lastTest?.results ?? []).map((row) => [row.upstream, row]),
  );
  const probed = new Map(
    (probeProviders ?? []).map((provider) => [provider.upstream, provider]),
  );

  const upstreams: string[] = [];
  const seen = new Set<string>();
  const push = (upstream: string) => {
    if (seen.has(upstream)) return;
    seen.add(upstream);
    upstreams.push(upstream);
  };
  members.forEach(push);
  recommendation?.good.forEach(push);
  recommendation?.dropped.forEach((dropped) => push(dropped.upstream));
  probeProviders?.forEach((provider) => push(provider.upstream));
  (lastTest?.results ?? []).forEach((row) => push(row.upstream));

  return upstreams.map((upstream) => {
    const probe = probed.get(upstream);
    const row = tested.get(upstream);
    const dropped = recommendation?.dropped.some(
      (entry) => entry.upstream === upstream,
    );

    let verdict: VerdictSlot;
    if (probe) {
      // Contract 1's own verdict — already `good` / `slow` / `failed`.
      verdict = probe.verdict;
    } else if (row) {
      verdict = !row.ok ? "failed" : row.class === "far" ? "slow" : "good";
    } else if (recommendation) {
      verdict = recommendation.good.includes(upstream)
        ? "good"
        : dropped
          ? "slow"
          : "unmeasured";
    } else {
      verdict = "unmeasured";
    }

    const answers = probe
      ? probe.domains
          .filter((answer) => answer.ok && answer.ips.length > 0)
          .map((answer) => ({ domain: answer.domain, ips: answer.ips }))
      : row && lastTest
        ? [{ domain: lastTest.domain, ips: row.ips }]
        : [];

    return {
      upstream,
      short: probe?.short || row?.short || shortUpstream(upstream),
      qualityMs: probe?.quality_ms ?? row?.rtt_ms ?? null,
      verdict,
      inGroup: probe ? probe.in_live_group : members.includes(upstream),
      answers,
    };
  });
}

export function ProvidersCard({
  status,
  recommendation,
  refreshError,
  isRefreshing,
  isLoading,
  lastTest,
  onRefresh,
}: ProvidersCardProps) {
  const { t, i18n } = useTranslation("common");

  // Precedence: a fresh refresh reply beats the STORED measurement, which beats
  // nothing. The stored rows are what keep the table populated on first load —
  // the algorithm already measured them, they just were not being returned.
  const rows = buildRows(
    status,
    recommendation,
    lastTest,
    recommendation?.providers ?? status?.edge?.measured ?? undefined,
  );
  const mode = status?.edge?.mode ?? null;

  return (
    <Card className={CARD_SHELL}>
      <CardHeader className={cn(CARD_PAD, CARD_HEAD.ROOT)}>
        <div className={CARD_HEAD.TITLES}>
          <CardTitle className={CARD_TITLE}>{t(`${K}.providers.title`)}</CardTitle>
          <span className={CARD_HEAD.DESC}>
            {t(`${K}.providers.description`)}
          </span>
        </div>
        <div className={CARD_HEAD.ACTIONS}>
          <Button
            type="button"
            variant="tonal-neutral"
            size="action"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            {isRefreshing ? (
              <Loader2Icon className="size-4 motion-safe:animate-spin" />
            ) : (
              <RefreshCcwIcon className="size-4" />
            )}
            {t(
              isRefreshing
                ? `${K}.providers.refreshing`
                : `${K}.providers.refresh`,
            )}
          </Button>

            {/* A sweep is 40-60 s on this device and there is no server-side
                progress to subscribe to, so show elapsed time + the measured
                range instead of an unexplained spinner. */}
            <ElapsedNote
              running={isRefreshing}
              estimateKey={`${K}.providers.refreshing_hint`}
              className="text-on-surface-variant text-[0.75rem] tabular-nums"
            />
        </div>
      </CardHeader>

      <CardContent className={cn(CARD_PAD, "flex flex-col gap-4")}>
        {/* The live block's own facts, drawn only once a read has landed.
            `mode` is printed verbatim: Contract 3 names the field but not its
            vocabulary, and inventing an enum here would be the UI deciding what
            the backend means. */}
        {status !== null ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
            <span className="flex items-baseline gap-1.5">
              <span className={SECTION_LABEL}>{t(`${K}.providers.mode`)}</span>
              <span className="font-mono text-[0.8125rem]">{mode ?? "—"}</span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className={SECTION_LABEL}>
                {t(`${K}.providers.last_refresh`)}
              </span>
              <span className="text-[0.8125rem] tabular-nums">
                {status.edge?.last_refresh
                  ? (formatMoment(status.edge.last_refresh, i18n.language) ??
                    t(`${K}.providers.never`))
                  : t(`${K}.providers.never`)}
              </span>
            </span>
          </div>
        ) : null}

        {refreshError !== null ? (
          <div className={ERROR_BOX} role="alert">
            <span className={ERROR_TEXT}>{refreshError}</span>
          </div>
        ) : null}

        {isLoading && status === null ? (
          <ProvidersCardSkeleton />
        ) : rows.length === 0 ? (
          <CardNotice
            glyph={RadarIcon}
            title={t(`${K}.providers.empty_title`)}
            body={t(`${K}.providers.empty_body`)}
          />
        ) : (
          <Table className={TABLE.ROOT}>
            <TableHeader>
              <TableRow className="border-0 hover:bg-transparent">
                <TableHead className={cn(TABLE.HEAD_CELL, TABLE_COLS.PROVIDERS)}>
                  {t(`${K}.providers.columns.provider`)}
                </TableHead>
                <TableHead className={cn(TABLE.HEAD_CELL, TABLE_COLS.QUALITY)}>
                  {t(`${K}.providers.columns.quality`)}
                </TableHead>
                <TableHead className={cn(TABLE.HEAD_CELL, TABLE_COLS.VERDICT)}>
                  {t(`${K}.providers.columns.verdict`)}
                </TableHead>
                <TableHead className={cn(TABLE.HEAD_CELL, TABLE_COLS.GROUP)}>
                  {t(`${K}.providers.columns.group`)}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <ProviderTableRow key={row.upstream} row={row} />
              ))}
            </TableBody>
          </Table>
        )}

        {lastTest && lastTest.threshold_ms ? (
          <span className={FOOTNOTE}>
            {t(`${K}.providers.threshold`, { ms: lastTest.threshold_ms })}
          </span>
        ) : null}

        {recommendation ? <RecommendationBlock recommendation={recommendation} /> : null}
      </CardContent>
    </Card>
  );
}

function ProviderTableRow({ row }: { row: ProviderRow }) {
  const { t, i18n } = useTranslation("common");
  const VerdictGlyph = VERDICT_GLYPH[row.verdict];

  return (
    <TableRow className={TABLE.ROW}>
      <TableCell className={cn(TABLE.CELL, TABLE_COLS.PROVIDERS)}>
        <div className={TABLE.NAME}>
          <span className={TABLE.LABEL}>{row.short}</span>
          <span className={TABLE.SUB} title={row.upstream}>
            {row.upstream}
          </span>
          {row.answers.length > 0 ? (
            <span className={TABLE.ANSWER}>
              {row.answers.map((answer) => (
                <span
                  key={answer.domain}
                  className="flex flex-wrap items-baseline gap-x-2"
                >
                  <span>{answer.domain}</span>
                  {answer.ips.map((ip) => (
                    <span key={ip}>{ip}</span>
                  ))}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      </TableCell>

      <TableCell className={cn(TABLE.CELL, TABLE_COLS.QUALITY)}>
        {row.qualityMs === null ? (
          <span className={TABLE.EMPTY}>—</span>
        ) : (
          <span className={TABLE.NUM}>
            {formatNumber(row.qualityMs, i18n.language)}
            <span className={TABLE.UNIT}>ms</span>
          </span>
        )}
      </TableCell>

      <TableCell className={cn(TABLE.CELL, TABLE_COLS.VERDICT)}>
        <Badge variant={VERDICT_BADGE[row.verdict]}>
          <VerdictGlyph className={CHIP_GLYPH} aria-hidden="true" />
          {t(`${K}.providers.verdict.${row.verdict}`)}
        </Badge>
      </TableCell>

      <TableCell className={cn(TABLE.CELL, TABLE_COLS.GROUP)}>
        {/* A glyph AND a word: membership is a fact about the live block, not a
            health verdict, so it is not allowed to be a chip (The Two-Form
            Rule) and it is not allowed to be colour alone either. */}
        <span className={cn(GROUP_MARK.ROOT, row.inGroup ? GROUP_MARK.IN : GROUP_MARK.OUT)}>
          {row.inGroup ? (
            <CheckIcon className={GROUP_MARK.GLYPH} aria-hidden="true" />
          ) : (
            <MinusIcon className={GROUP_MARK.GLYPH} aria-hidden="true" />
          )}
          {t(
            row.inGroup
              ? `${K}.providers.group.in`
              : `${K}.providers.group.out`,
          )}
        </span>
      </TableCell>
    </TableRow>
  );
}

/**
 * What the algorithm decided, in its own words.
 *
 * `reason` and every `dropped[].reason` are rendered VERBATIM, in the UI face
 * rather than mono: they are sentences written for a person ("median 338 ms >
 * 150 ms"), not machine identifiers, and translating them would be a second
 * implementation of the algorithm's vocabulary.
 */
function RecommendationBlock({
  recommendation,
}: {
  recommendation: SmartDnsRefreshEdgesResponse;
}) {
  const { t } = useTranslation("common");
  const ActionIcon =
    recommendation.action === "rewrite"
      ? RefreshCcwIcon
      : recommendation.action === "keep"
        ? CheckIcon
        : CircleSlashIcon;

  return (
    <div className="flex flex-col gap-3 rounded-tile bg-surface-container p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(SECTION_LABEL, "mr-auto")}>
          {t(`${K}.providers.recommendation.title`)}
        </span>
        <Badge variant={ACTION_BADGE[recommendation.action]}>
          <ActionIcon className={CHIP_GLYPH} aria-hidden="true" />
          {t(`${K}.providers.recommendation.action_${recommendation.action}`)}
        </Badge>
        <Badge variant={recommendation.applied ? "success" : "muted"}>
          {/* Applied and not-applied are two states of ONE slot, so they cannot
              share a glyph — the chip fills differ by a hair under simulation. */}
          {recommendation.applied ? (
            <CheckIcon className={CHIP_GLYPH} aria-hidden="true" />
          ) : (
            <MinusIcon className={CHIP_GLYPH} aria-hidden="true" />
          )}
          {t(
            recommendation.applied
              ? `${K}.providers.recommendation.applied`
              : `${K}.providers.recommendation.not_applied`,
          )}
        </Badge>
      </div>

      <p className="text-[0.8125rem] leading-relaxed text-pretty">
        {recommendation.reason}
      </p>

      {recommendation.dropped.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className={SECTION_LABEL}>
            {t(`${K}.providers.recommendation.dropped`)}
          </span>
          {recommendation.dropped.map((entry) => (
            <div
              key={entry.upstream}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"
            >
              <span className="font-mono text-[0.75rem]">{entry.upstream}</span>
              <span className="text-on-surface-variant text-[0.75rem] tabular-nums">
                {entry.reason}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <span className="text-on-surface-variant text-[0.8125rem]">
          {t(`${K}.providers.recommendation.none_dropped`)}
        </span>
      )}
    </div>
  );
}

/**
 * The loading state: a header line and three rows at the loaded table's own row
 * height, so the handoff does not jump.
 */
export function ProvidersCardSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <Skeleton className="h-[1.375rem] w-full max-w-[30rem] rounded-field" />
      {Array.from({ length: 3 }).map((_, index) => (
        <Skeleton key={index} className="h-12 w-full rounded-tile" />
      ))}
    </div>
  );
}

export default ProvidersCard;
