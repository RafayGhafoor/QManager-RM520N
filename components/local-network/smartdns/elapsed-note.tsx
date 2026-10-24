"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";

/**
 * Elapsed-time note for the two operations that legitimately take a minute.
 *
 * WHY THIS EXISTS
 *   `Refresh now` (edge selection) runs a full provider sweep on the device —
 *   measured 42-57 s — and the domain tester is 30-40 s. Both are single requests,
 *   so there is no progress to subscribe to, and a spinner alone is indistinguishable
 *   from a hang. The owner said so directly: "edge selection took some time, we
 *   should show ETA or something".
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not fake a progress bar. The honest information is (a) how long this one
 *   has been running and (b) roughly how long these normally take, both measured.
 *   A percentage would have to be invented.
 *
 * The estimate text comes from the locale so the numbers stay stated next to the
 * measurement that produced them.
 */
export function ElapsedNote({
  running,
  estimateKey,
  className,
}: {
  running: boolean;
  estimateKey: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [seconds, setSeconds] = React.useState(0);

  React.useEffect(() => {
    if (!running) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    setSeconds(0);
    const id = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [running]);

  if (!running) return null;

  return (
    <span
      className={className}
      // Announced politely: the elapsed counter updates every second, and assertive
      // announcements would make a screen reader unusable for a minute.
      aria-live="polite"
      role="status"
    >
      {t(estimateKey, { seconds })}
    </span>
  );
}
