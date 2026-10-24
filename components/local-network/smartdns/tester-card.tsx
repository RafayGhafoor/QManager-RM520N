"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  CircleAlertIcon,
  Loader2Icon,
  SearchIcon,
  TimerIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { SmartDnsTestResponse } from "@/types/smartdns";
import type { SmartDnsTestError } from "@/hooks/use-smartdns";

import CardNotice from "./card-notice";
import { formatNumber, sortByFastest } from "./format";
import {
  CARD_HEAD,
  CARD_PAD,
  CARD_SHELL,
  CARD_TITLE,
  CHIP_GLYPH,
  CLASS_BADGE,
  CLASS_GLYPH,
  DOMAIN_FIELD,
  ERROR_BOX,
  ERROR_TEXT,
  FIELD_ROW,
  FOOTNOTE,
  TABLE,
  TABLE_COLS,
} from "./shapes";

// =============================================================================
// TesterCard — the domain tester, and the centrepiece of the page
// =============================================================================
// Contract 4's fourth card and Contract 2's only consumer. Type a domain, press
// Test, and every provider in the pool answers it: which IP each one handed out,
// how far away that IP is, and therefore which provider is handing out the slow
// edge that the whole edge-selection algorithm exists to route around.
//
// -----------------------------------------------------------------------------
// THE ANSWER SET IS SORTED FASTEST-FIRST, AND "NO ANSWER" SORTS LAST
// -----------------------------------------------------------------------------
// Contract 2 states `fastest` / `slowest` / `spread` but not the order of
// `results`. The table's hierarchy is the answer to the question, so the sort
// happens here (`sortByFastest`) and rows with no answer go to the bottom: they
// are a result, but they do not have a latency, and placing one mid-table would
// imply one. Their RTT cell reads an em dash, never "0".
//
// -----------------------------------------------------------------------------
// A DOMAIN NOBODY ANSWERS IS NOT AN ERROR
// -----------------------------------------------------------------------------
// Contract 2 is explicit: no answer → exit 0, every `ok:false`, `fastest:null`.
// That renders as a table of failures plus one plain sentence, because the
// measurement succeeded and its result is "nobody answered". Only a rejected or
// broken sweep takes the error box — `invalid_domain`, `timeout`, `probe_failed`,
// `malformed_result`, `helper_missing` — and an unrecognised code prints the
// CGI's own `detail` verbatim rather than swallowing it behind "something went
// wrong".
//
// -----------------------------------------------------------------------------
// THREE STATES, AND THE EMPTY ONE IS DESIGNED
// -----------------------------------------------------------------------------
//   empty     a resting block that says what the control does, above the field
//   loading   three skeleton rows at the real table row height
//   error     a solid tonal container, `role="alert"`, with the CGI's words
// There is no fourth state where the table silently keeps the previous domain's
// results after a failed test — `result` is cleared when a run fails, so a stale
// answer set can never sit under a new domain's name.
// =============================================================================

const K = "smartdns";

/**
 * CGI error codes worth translating. Every other code renders the backend's
 * `detail` verbatim: a mistranslated diagnosis is worse than an untranslated one,
 * and these five are the whole of `dns_test.sh`'s vocabulary.
 */
const ERROR_KEYS: Record<string, string> = {
  invalid_domain: "invalid_domain",
  timeout: "timeout",
  probe_failed: "probe_failed",
  helper_missing: "helper_missing",
  malformed_result: "malformed_result",
  transport: "transport",
};

export interface TesterCardProps {
  result: SmartDnsTestResponse | null;
  error: SmartDnsTestError | null;
  isTesting: boolean;
  onRun: (domain: string) => Promise<void>;
}

export function TesterCard({
  result,
  error,
  isTesting,
  onRun,
}: TesterCardProps) {
  const { t, i18n } = useTranslation("common");
  const [domain, setDomain] = React.useState("");

  const trimmed = domain.trim();
  const canRun = trimmed.length > 0 && !isTesting;
  const invalidDomain = error?.code === "invalid_domain";

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canRun) return;
    void onRun(trimmed);
  };

  const rows = result ? sortByFastest(result.results) : [];

  const errorMessage = (() => {
    if (!error) return null;
    const key = ERROR_KEYS[error.code];
    if (key) return t(`${K}.test.error.${key}`);
    return error.detail ?? t(`${K}.test.error.generic`);
  })();

  return (
    <Card className={CARD_SHELL}>
      <CardHeader className={cn(CARD_PAD, CARD_HEAD.ROOT)}>
        <div className={CARD_HEAD.TITLES}>
          <CardTitle className={CARD_TITLE}>{t(`${K}.test.title`)}</CardTitle>
          <span className={CARD_HEAD.DESC}>{t(`${K}.test.description`)}</span>
        </div>
      </CardHeader>

      <CardContent className={cn(CARD_PAD, "flex flex-col gap-4")}>
        <form onSubmit={handleSubmit} className={FIELD_ROW}>
          <Input
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className={cn(DOMAIN_FIELD, "flex-1")}
            value={domain}
            aria-invalid={invalidDomain || undefined}
            aria-label={t(`${K}.test.domain_label`)}
            placeholder={t(`${K}.test.placeholder`)}
            onChange={(event) => setDomain(event.target.value)}
            disabled={isTesting}
          />
          <Button type="submit" size="action" disabled={!canRun}>
            {isTesting ? (
              <Loader2Icon className="size-4 motion-safe:animate-spin" />
            ) : (
              <SearchIcon className="size-4" />
            )}
            {t(isTesting ? `${K}.test.running` : `${K}.test.run`)}
          </Button>
        </form>

        {errorMessage ? (
          <div className={ERROR_BOX} role="alert">
            <span className={cn(ERROR_TEXT, "font-semibold")}>{errorMessage}</span>
            {error?.detail && ERROR_KEYS[error.code] ? (
              // The translated sentence leads; the CGI's own words follow, so a
              // diagnosis is never lost to a translation that is merely close.
              // Weight separates them — never an alpha on the container's own
              // ink, which would soften a colour already measured against it.
              <span className={ERROR_TEXT}>{error.detail}</span>
            ) : null}
          </div>
        ) : null}

        {isTesting ? (
          <TesterSkeleton />
        ) : result === null ? (
          <CardNotice
            glyph={TimerIcon}
            title={t(`${K}.test.empty_title`)}
            body={t(`${K}.test.empty_body`)}
          />
        ) : (
          <>
            {result.fastest_ms !== null ? (
              /* The one figure the whole page exists to produce, on its own
                 container step — the only inner container this card uses. */
              <div className="flex flex-col gap-1 rounded-tile bg-surface-container px-4 py-3">
                <p className="text-[0.9375rem] font-semibold tabular-nums">
                  {t(`${K}.test.summary`, {
                    fastest: formatNumber(result.fastest_ms, i18n.language) ?? "—",
                    slowest: formatNumber(result.slowest_ms, i18n.language) ?? "—",
                    spread: formatNumber(result.spread_ms, i18n.language) ?? "—",
                  })}
                </p>
                {result.fastest ? (
                  <span className="text-on-surface-variant flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]">
                    <span>{t(`${K}.test.fastest_answer`)}</span>
                    <span className="font-mono text-[0.75rem]">
                      {result.fastest}
                    </span>
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-[0.9375rem] font-semibold">
                <CircleAlertIcon
                  className="text-on-surface-variant size-4"
                  aria-hidden="true"
                />
                {t(`${K}.test.all_failed`, { domain: result.domain })}
              </div>
            )}

            <Table className={TABLE.ROOT}>
              <TableHeader>
                <TableRow className="border-0 hover:bg-transparent">
                  <TableHead className={cn(TABLE.HEAD_CELL, TABLE_COLS.PROVIDERS)}>
                    {t(`${K}.test.columns.provider`)}
                  </TableHead>
                  <TableHead className={cn(TABLE.HEAD_CELL, TABLE_COLS.ANSWERS)}>
                    {t(`${K}.test.columns.answers`)}
                  </TableHead>
                  <TableHead className={cn(TABLE.HEAD_CELL, TABLE_COLS.RTT)}>
                    {t(`${K}.test.columns.rtt`)}
                  </TableHead>
                  <TableHead className={cn(TABLE.HEAD_CELL, TABLE_COLS.CLASS)}>
                    {t(`${K}.test.columns.class`)}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const ClassGlyph = CLASS_GLYPH[row.class];
                  return (
                    <TableRow key={row.upstream} className={TABLE.ROW}>
                      <TableCell className={cn(TABLE.CELL, TABLE_COLS.PROVIDERS)}>
                        <div className={TABLE.NAME}>
                          <span className={TABLE.LABEL}>{row.short}</span>
                          <span className={TABLE.SUB} title={row.upstream}>
                            {row.upstream}
                          </span>
                        </div>
                      </TableCell>

                      <TableCell className={cn(TABLE.CELL, TABLE_COLS.ANSWERS)}>
                        {row.ips.length > 0 ? (
                          <span className={TABLE.ANSWER}>
                            {row.ips.map((ip) => (
                              <span key={ip}>{ip}</span>
                            ))}
                          </span>
                        ) : (
                          <span className={TABLE.EMPTY}>
                            {t(`${K}.test.no_answer`)}
                          </span>
                        )}
                      </TableCell>

                      <TableCell className={cn(TABLE.CELL, TABLE_COLS.RTT)}>
                        {row.rtt_ms === null ? (
                          <span className={TABLE.EMPTY}>—</span>
                        ) : (
                          <span className={TABLE.NUM}>
                            {formatNumber(row.rtt_ms, i18n.language)}
                            <span className={TABLE.UNIT}>ms</span>
                          </span>
                        )}
                      </TableCell>

                      <TableCell className={cn(TABLE.CELL, TABLE_COLS.CLASS)}>
                        <Badge variant={CLASS_BADGE[row.class]}>
                          <ClassGlyph className={CHIP_GLYPH} aria-hidden="true" />
                          {t(`${K}.test.class.${row.class}`)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            <span className={FOOTNOTE}>
              {t(`${K}.test.near_note`, { ms: result.threshold_ms })}
            </span>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Three rows at the loaded table's own row height — a mirror, not a guess. */
export function TesterSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <Skeleton className="h-[1.375rem] w-64 rounded-field" />
      {Array.from({ length: 3 }).map((_, index) => (
        <Skeleton key={index} className="h-12 w-full rounded-tile" />
      ))}
    </div>
  );
}

export default TesterCard;
