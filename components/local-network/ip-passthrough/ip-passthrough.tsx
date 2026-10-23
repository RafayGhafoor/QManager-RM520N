"use client";

import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { RefreshCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useIpPassthrough } from "@/hooks/use-ip-passthrough";
import { staggerContainer, staggerItem } from "@/lib/motion";
import { cn } from "@/lib/utils";

import IPPassthroughCard from "./ip-passthrough-card";
import StatusStrip from "./status-strip";
import { HEADER_PILL, PAGE_HEAD, PAGE_ROOT, PILL_GLYPH } from "./shapes";

const K = "ipPassthrough";

const IPPassthroughComponent = () => {
  const { t } = useTranslation("common");
  const {
    enabled,
    state,
    targetMac,
    clients,
    isLoading,
    isSaving,
    error,
    saveSettings,
    refresh,
  } = useIpPassthrough();

  const failed = enabled === null && !isLoading && error !== null;

  return (
    <motion.div
      className={PAGE_ROOT}
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
              variant="ghost"
              onClick={() => refresh()}
              disabled={isSaving || isLoading}
              size="action"
              className={HEADER_PILL}
            >
              <RefreshCcwIcon
                className={cn(PILL_GLYPH, isLoading && "motion-safe:animate-spin")}
                aria-hidden
              />
              {t(`${K}.header.refresh`)}
            </Button>
          </div>
        </div>
      </motion.div>

      <motion.div variants={staggerItem}>
        <StatusStrip
          enabled={enabled}
          state={state}
          targetMac={targetMac}
          failed={failed}
          onRetry={() => refresh()}
        />
      </motion.div>

      <motion.div variants={staggerItem}>
        <IPPassthroughCard
          enabled={enabled}
          state={state}
          clients={clients}
          isLoading={isLoading}
          isSaving={isSaving}
          failed={failed}
          saveSettings={saveSettings}
          refresh={() => refresh(true)}
        />
      </motion.div>
    </motion.div>
  );
};

export default IPPassthroughComponent;
