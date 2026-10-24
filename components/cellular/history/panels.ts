// =============================================================================
// panels.ts — which panels a reader shows, as a per-viewer preference
// =============================================================================
// Whether a panel is on is a DISPLAY preference, not device state: no write
// endpoint, no round-trip, and one browser's choice never reformats the page
// for anyone else. So it lives in `localStorage`, exactly as greenpacket's
// History page keeps its own panel picker.
//
// THE MERGE IS THE LOAD-BEARING PART. A stored object is merged ONTO the
// defaults rather than trusted wholesale: a panel added in a later build must
// appear at its own default, not vanish because an older payload never
// mentioned it. That is why `mergePanels` walks the current id list instead of
// `Object.assign`-ing whatever was found.
//
// The availability hero is NOT in this list. It is the page's answer, not a
// panel — hiding it would leave a page about 5G availability with no statement
// about 5G availability on it.
// =============================================================================

export const PANEL_IDS = [
  "pattern",
  "timeline",
  "rf",
  "bands",
  "events",
  "outages",
  "phy",
  "identity",
  "system",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export type PanelVisibility = Record<PanelId, boolean>;

/**
 * The first impression. The five that answer the field complaint ("5G
 * disappears at night") are on — including the band/CA strip, which is the one
 * panel that names the band that went missing; the deeper depth — per-outage
 * table, PHY figures, the identity grid and device load — is opt-in, because a
 * page that opens with nine panels opens with none of them read.
 */
export const PANEL_DEFAULT: PanelVisibility = {
  pattern: true,
  timeline: true,
  rf: true,
  bands: true,
  events: true,
  outages: false,
  phy: false,
  identity: false,
  system: false,
};

/**
 * Versioned and app-scoped, like the other `qmanager.*` browser preferences.
 *
 * NOT bumped when a panel is added, and that is deliberate: `mergePanels` walks
 * the CURRENT id list, so a panel an older payload never mentioned arrives at
 * its own default. Only a change to the SHAPE of a stored value (or to what an
 * id means) would need a new key.
 */
const STORAGE_KEY = "qmanager.cell_history.panels.v1";

/**
 * Stored choices merged onto the defaults. `unknown` input, because a stored
 * payload is not typed: a value that is not a boolean is simply not evidence.
 */
export function mergePanels(saved: unknown): PanelVisibility {
  const merged: PanelVisibility = { ...PANEL_DEFAULT };
  if (saved === null || typeof saved !== "object") return merged;
  const record = saved as Record<string, unknown>;
  for (const id of PANEL_IDS) {
    const value = record[id];
    if (typeof value === "boolean") merged[id] = value;
  }
  return merged;
}

/** The reader's stored choice, or the defaults on a first visit. */
export function loadPanels(): PanelVisibility {
  if (typeof window === "undefined") return { ...PANEL_DEFAULT };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...PANEL_DEFAULT };
    return mergePanels(JSON.parse(raw) as unknown);
  } catch {
    // Private mode, quota, or a hand-edited value: the defaults still answer.
    return { ...PANEL_DEFAULT };
  }
}

/** Best-effort persist. A read-only browser simply does not remember. */
export function savePanels(visibility: PanelVisibility): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(visibility));
  } catch {
    // Quota exceeded or storage disabled — the choice still holds for this tab.
  }
}

export function shownPanelCount(visibility: PanelVisibility): number {
  return PANEL_IDS.filter((id) => visibility[id]).length;
}
