"use client";

import { useTranslation } from "react-i18next";
import { motion } from "motion/react";

import { useCallTerminal } from "@/hooks/use-call-terminal";
import { staggerContainer, staggerItem } from "@/lib/motion";
import { cn } from "@/lib/utils";

import AudioCard from "./audio-card";
import ContactsCard from "./contacts-card";
import DialerCard from "./dialer-card";
import HistoryCard from "./history-card";
import RecordingsCard from "./recordings-card";
import SessionCard from "./session-card";
import { PAGE_HEAD, PAGE_ROOT } from "./shapes";

// =============================================================================
// Calls — the /cellular/calls page shell (ZLT X16)
// =============================================================================
// A browser terminal for the modem's own voice calls: speak into the call from
// this page's microphone, and hear the far end through this page's speakers.
// Nothing is transcoded or recorded in between.
//
// -----------------------------------------------------------------------------
// THE CARD ORDER IS THE ORDER A CALL HAPPENS IN
// -----------------------------------------------------------------------------
//   1. Audio link     connect first — before dialling, so the device's tap opens
//                     into a live stream the moment the far end answers
//   2. Dialer         then the call itself, its keypad, and its end
//   3. Session        and what the device is doing underneath, for when it is not
//
// Order by sequence rather than by importance: a reader who is here to make a
// call reads top to bottom and does the right thing; a reader who is here
// because audio failed skips to the third card, which is exactly why it is last
// and why its title says what it is.
//
// -----------------------------------------------------------------------------
// NO PAGE-LEVEL BANNER
// -----------------------------------------------------------------------------
// The `/local-network/` families carry one banner for "nothing was ever read",
// because all their cards read the same backend. Here the cards fail
// independently: the link can be refused (no microphone, no HTTPS) while the
// dialer still works over the modem, and the session panel can be empty while
// both other cards are live. So each card owns its own state and the page level
// stays silent — a banner would have to pick one of the three and lie about the
// others.
// =============================================================================

const CallsComponent = () => {
  const { t } = useTranslation("common");
  const terminal = useCallTerminal();

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
            <h1 className={PAGE_HEAD.TITLE}>{t("calls.page.title")}</h1>
            <p className={PAGE_HEAD.DESC}>{t("calls.page.description")}</p>
          </div>
        </div>
      </motion.div>

      <motion.div variants={staggerItem}>
        <AudioCard terminal={terminal} />
      </motion.div>

      <motion.div variants={staggerItem}>
        <DialerCard terminal={terminal} />
      </motion.div>

      <motion.div variants={staggerItem}>
        <HistoryCard terminal={terminal} />
      </motion.div>

      <motion.div variants={staggerItem}>
        <RecordingsCard terminal={terminal} />
      </motion.div>

      <motion.div variants={staggerItem}>
        <ContactsCard terminal={terminal} />
      </motion.div>

      <motion.div variants={staggerItem}>
        <SessionCard terminal={terminal} />
      </motion.div>
    </motion.div>
  );
};

export default CallsComponent;
