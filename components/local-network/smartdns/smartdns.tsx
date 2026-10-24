"use client";

import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { RefreshCcwIcon } from "lucide-react";

import { Banner, bannerActionVariants } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import {
  useSmartDns,
  useSmartDnsStats,
  useSmartDnsTest,
} from "@/hooks/use-smartdns";
import { staggerContainer, staggerItem } from "@/lib/motion";
import { cn } from "@/lib/utils";

import ConfigEditorCard from "./config-card";
import PerformanceCard from "./performance-card";
import ProvidersCard from "./providers-card";
import StatusCard from "./status-card";
import TesterCard from "./tester-card";
import { PAGE_HEAD, PAGE_ROOT } from "./shapes";

// =============================================================================
// SmartDNS — the /local-network/smartdns page shell
// =============================================================================
// The shell owns the three hooks, the page header with its Refresh pill, the
// one page-level banner, and the `staggerContainer` cascade over the five cards.
//
// -----------------------------------------------------------------------------
// THE CARD ORDER IS A CADENCE, NOT CONTRACT 4's NUMBERING
// -----------------------------------------------------------------------------
// Contract 4 lists the four (really five) cards in a numbered order. The DOM
// order here is the order a reader ASKS:
//
//   1. Status + toggle    is it on, and what is it doing
//   2. Edge selection     what it is choosing between, and why
//   3. Domain tester      prove it: which provider is handing out the slow edge
//   4. Performance        what that has bought, and from which source
//   5. Config editor      the advanced file, last because almost nobody edits it
//
// Measured order rather than numbered: the tester is the page's centrepiece (it
// is the only control that answers "is this working for ME, right now") and it
// sits directly under the table it explains. A single-column stack is deliberate
// and follows the Radio Information precedent — these five cards have genuinely
// different shapes (a two-fact status read, two tables, a four-tile strip and a
// 22rem editor), so pairing any two of them would be a height lock over cards
// with nothing in common. Symmetry is not a property of this page.
//
// -----------------------------------------------------------------------------
// ONE PAGE-LEVEL BANNER, AND ONLY FOR A DEAD READ
// -----------------------------------------------------------------------------
// Every card owns its own empty, loading and error states, so the only condition
// that belongs at page level is "nothing was ever read" — where all five cards
// would otherwise show their empty states at once and the reader would be told
// five times that the modem did not answer. The banner says it once and carries
// the retry, which re-reads the status AND the stats read, since both can fail
// for the same reason.
// =============================================================================

const K = "smartdns";

const SmartDnsComponent = () => {
  const { t } = useTranslation("common");
  const smartdns = useSmartDns();
  const stats = useSmartDnsStats();
  const test = useSmartDnsTest();

  // ANY failed read is announced, including one that failed on top of data we
  // already hold. The cards keep drawing the last reading (it is still the last
  // thing the modem confirmed), so without the banner a Refresh that failed would
  // look exactly like a Refresh that found nothing to change.
  const readFailed = smartdns.error !== null;

  const refreshAll = () => {
    void smartdns.refresh();
    void stats.refresh();
  };

  return (
    <motion.div
      className={cn("@container/main", PAGE_ROOT)}
      aria-live="polite"
      aria-atomic="false"
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
    >
      <motion.div variants={staggerItem}>
        <div className={PAGE_HEAD.ROOT}>
          <div className={PAGE_HEAD.TITLES}>
            <h1 className={PAGE_HEAD.TITLE}>{t(`${K}.page.title`)}</h1>
            <p className={PAGE_HEAD.DESC}>{t(`${K}.page.description`)}</p>
          </div>
          <div className={PAGE_HEAD.ACTIONS}>
            <Button
              type="button"
              variant="tonal-neutral"
              size="action"
              onClick={refreshAll}
              disabled={smartdns.isLoading}
            >
              <RefreshCcwIcon className="size-4" />
              {t(`${K}.header.refresh`)}
            </Button>
          </div>
        </div>
      </motion.div>

      {readFailed ? (
        <motion.div variants={staggerItem}>
          <Banner
            role="stale"
            title={t(`${K}.read_failed_title`)}
            description={t(`${K}.read_failed_body`)}
            action={
              <button
                type="button"
                onClick={refreshAll}
                className={bannerActionVariants({ tone: "destructive" })}
              >
                <RefreshCcwIcon />
                {t("actions.retry")}
              </button>
            }
          />
        </motion.div>
      ) : null}

      <motion.div variants={staggerItem}>
        <StatusCard
          status={smartdns.status}
          isLoading={smartdns.isLoading}
          isToggling={smartdns.isToggling}
          onToggle={smartdns.toggle}
        />
      </motion.div>

      <motion.div variants={staggerItem}>
        <ProvidersCard
          status={smartdns.status}
          recommendation={smartdns.recommendation}
          refreshError={smartdns.refreshError}
          isRefreshing={smartdns.isRefreshingEdges}
          isLoading={smartdns.isLoading}
          lastTest={test.result}
          onRefresh={() => {
            void smartdns.refreshEdges();
          }}
        />
      </motion.div>

      <motion.div variants={staggerItem}>
        <TesterCard
          result={test.result}
          error={test.error}
          isTesting={test.isTesting}
          onRun={test.run}
        />
      </motion.div>

      <motion.div variants={staggerItem}>
        <PerformanceCard
          stats={stats.stats}
          isLoading={stats.isLoading}
          onRefresh={stats.refresh}
        />
      </motion.div>

      <motion.div variants={staggerItem}>
        <ConfigEditorCard
          status={smartdns.status}
          isLoading={smartdns.isLoading}
          isSaving={smartdns.isSavingConfig}
          onSave={smartdns.saveConfig}
        />
      </motion.div>
    </motion.div>
  );
};

export default SmartDnsComponent;
