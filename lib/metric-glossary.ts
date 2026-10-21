// =============================================================================
// metric-glossary.ts — the one home for what a PHY reading means
// =============================================================================
// Every metric cell on `/cellular/detailed-metrics` renders a `HintIcon` fed
// from this file, and the cell takes its `metric` as a `MetricId` — so a cell
// cannot exist without an entry, and an entry cannot exist without a cell's
// wiring. The two failures this prevents are the ones a runtime lookup invites:
//
//   * a cell whose tip is empty because nobody wrote the sentence, and
//   * a sentence nobody reads because the cell was renamed.
//
// `satisfies Record<MetricId, MetricGlossaryEntry>` is the build-time half of
// that: a MISSING id and an ORPHAN entry are both a `tsc` error, so `bun run
// build` fails rather than a page shipping with a bare `ⓘ`.
//
// WHAT IS AND IS NOT IN AN ENTRY
//   `range`       The reporting span, symbols and unit abbreviations ONLY —
//                 "-156…-31 dBm", "0…15". It is identical in every language, so
//                 it is not translated. `null` means no span is documented for
//                 this metric on this firmware; the tip then omits the line
//                 rather than inventing one. Do not fill these in from memory:
//                 PMI's measured answer already left the 4-bit range, which is
//                 exactly why it has no span here.
//   `better`      Which direction is good, so the tip can say it in words.
//                 `neither` is the common case and not a cop-out: a PCI, a TM
//                 mode and a transmit power have no good end.
//   `explanation` An i18n KEY under the `cellular` namespace, not a sentence.
//                 Strings belong in `public/locales/*/cellular.json`; this file
//                 holds structure.
//
// The two fields this modem cannot report have entries too, because they are
// DISPLAYED — as an explicit "not reported by this modem" row. Their note says
// why the command is not merely failing but never issued.
// =============================================================================

/** Which direction of change is good news. */
export type MetricDirection = "high" | "low" | "neither";

export interface MetricGlossaryEntry {
  /** Reporting span in symbols and unit abbreviations, or `null` if undocumented. */
  range: string | null;
  better: MetricDirection;
  /** i18n key in the `cellular` namespace. */
  explanation: string;
}

/**
 * Every metric this page displays, LTE and NR kept separate on purpose: the
 * same measurement is graded against different reporting ranges per radio, and
 * NR's SINR is called SNR by 3GPP.
 */
export const METRIC_IDS = [
  // Registration
  "registered",
  "carrier",
  "rrc.rat",
  "rrc.state",
  // LTE
  "lte.rsrp",
  "lte.rsrq",
  "lte.rssi",
  "lte.sinr",
  "lte.cqi",
  "lte.ri",
  "lte.pmi",
  "lte.mimo_layers",
  "lte.tm_mode",
  "lte.ul_mcs",
  "lte.tx_power",
  // NR
  "nr.rsrp",
  "nr.rsrq",
  "nr.sinr",
  "nr.cqi",
  "nr.ri",
  "nr.pmi",
  "nr.mimo_layers",
  "nr.dl_mcs",
  "nr.ul_mcs",
  "nr.tx_power",
  "nr.pathloss",
  // Carrier aggregation
  "ca.lte_carriers",
  "ca.nr_carriers",
  "ca.total_bandwidth",
  "ca.component",
  // SSB beams
  "beams.beam",
  "beams.rsrp",
  "beams.rsrq",
  "beams.pci",
  // Archived panels
  "panel.rsrp",
  "panel.sinr",
  "panel.rsrq",
  "panel.rssi",
  "panel.temp",
  "panel.cqi",
  "panel.rank",
  "panel.mcs",
  "panel.tx_power",
  "panel.total_cells",
] as const;

export type MetricId = (typeof METRIC_IDS)[number];

// --- Shared entries -------------------------------------------------------
// Two ids may carry one entry when the quantity is genuinely the same one:
// RSRP means RSRP whether the serving radio is LTE or NR, and a panel's RSRP is
// that same reading with a timestamp. Where the numbers differ per radio (the
// reported span) the entry is split instead.

const RSRP: MetricGlossaryEntry = {
  range: "-156…-31 dBm",
  better: "high",
  explanation: "detailed_metrics.glossary.rsrp",
};

const RSRQ: MetricGlossaryEntry = {
  range: "-43…+20 dB",
  better: "high",
  explanation: "detailed_metrics.glossary.rsrq",
};

const SINR: MetricGlossaryEntry = {
  range: "-23…+40 dB",
  better: "high",
  explanation: "detailed_metrics.glossary.sinr",
};

const RSSI: MetricGlossaryEntry = {
  range: "-120…-25 dBm",
  better: "high",
  explanation: "detailed_metrics.glossary.rssi",
};

const CQI: MetricGlossaryEntry = {
  range: "0…15",
  better: "high",
  explanation: "detailed_metrics.glossary.cqi",
};

const RI: MetricGlossaryEntry = {
  range: "1…4",
  better: "high",
  explanation: "detailed_metrics.glossary.ri",
};

/** No documented span: the measured NR answer was 20, past the 4-bit range. */
const PMI: MetricGlossaryEntry = {
  range: null,
  better: "neither",
  explanation: "detailed_metrics.glossary.pmi",
};

const MIMO_LAYERS: MetricGlossaryEntry = {
  range: "1…4",
  better: "high",
  explanation: "detailed_metrics.glossary.mimo_layers",
};

const UL_MCS: MetricGlossaryEntry = {
  range: "0…28",
  better: "high",
  explanation: "detailed_metrics.glossary.ul_mcs",
};

const TX_POWER: MetricGlossaryEntry = {
  range: "dBm",
  better: "neither",
  explanation: "detailed_metrics.glossary.tx_power",
};

const MCS_PANEL: MetricGlossaryEntry = {
  range: "0…28",
  better: "high",
  explanation: "detailed_metrics.glossary.mcs",
};

const RANK: MetricGlossaryEntry = {
  range: "1…4",
  better: "high",
  explanation: "detailed_metrics.glossary.rank",
};

const PCI: MetricGlossaryEntry = {
  range: "0…1007",
  better: "neither",
  explanation: "detailed_metrics.glossary.pci",
};

export const METRIC_GLOSSARY = {
  registered: {
    range: null,
    better: "neither",
    explanation: "detailed_metrics.glossary.registered",
  },
  carrier: {
    range: null,
    better: "neither",
    explanation: "detailed_metrics.glossary.carrier",
  },
  "rrc.rat": {
    range: null,
    better: "neither",
    explanation: "detailed_metrics.glossary.rat",
  },
  "rrc.state": {
    range: null,
    better: "neither",
    explanation: "detailed_metrics.glossary.rrc_state",
  },

  "lte.rsrp": RSRP,
  "lte.rsrq": RSRQ,
  "lte.rssi": RSSI,
  "lte.sinr": SINR,
  "lte.cqi": CQI,
  "lte.ri": RI,
  "lte.pmi": PMI,
  "lte.mimo_layers": MIMO_LAYERS,
  "lte.tm_mode": {
    range: null,
    better: "neither",
    explanation: "detailed_metrics.glossary.tm_mode",
  },
  "lte.ul_mcs": UL_MCS,
  "lte.tx_power": {
    range: null,
    better: "neither",
    explanation: "detailed_metrics.glossary.lte_tx_power_absent",
  },

  "nr.rsrp": RSRP,
  "nr.rsrq": RSRQ,
  "nr.sinr": SINR,
  "nr.cqi": CQI,
  "nr.ri": RI,
  "nr.pmi": PMI,
  "nr.mimo_layers": MIMO_LAYERS,
  "nr.dl_mcs": {
    range: "0…27",
    better: "high",
    explanation: "detailed_metrics.glossary.dl_mcs",
  },
  "nr.ul_mcs": UL_MCS,
  "nr.tx_power": TX_POWER,
  "nr.pathloss": {
    range: null,
    better: "neither",
    explanation: "detailed_metrics.glossary.nr_pathloss_absent",
  },

  "ca.lte_carriers": {
    range: null,
    better: "high",
    explanation: "detailed_metrics.glossary.ca_lte_carriers",
  },
  "ca.nr_carriers": {
    range: null,
    better: "high",
    explanation: "detailed_metrics.glossary.ca_nr_carriers",
  },
  "ca.total_bandwidth": {
    range: "MHz",
    better: "high",
    explanation: "detailed_metrics.glossary.ca_total_bandwidth",
  },
  "ca.component": {
    range: null,
    better: "neither",
    explanation: "detailed_metrics.glossary.ca_component",
  },

  "beams.beam": {
    range: null,
    better: "neither",
    explanation: "detailed_metrics.glossary.beam",
  },
  "beams.rsrp": RSRP,
  "beams.rsrq": RSRQ,
  "beams.pci": PCI,

  "panel.rsrp": RSRP,
  "panel.sinr": SINR,
  "panel.rsrq": RSRQ,
  "panel.rssi": RSSI,
  "panel.temp": {
    range: "°C",
    better: "low",
    explanation: "detailed_metrics.glossary.temperature",
  },
  "panel.cqi": CQI,
  "panel.rank": RANK,
  "panel.mcs": MCS_PANEL,
  "panel.tx_power": TX_POWER,
  "panel.total_cells": {
    range: null,
    better: "neither",
    explanation: "detailed_metrics.glossary.total_cells",
  },
} as const satisfies Record<MetricId, MetricGlossaryEntry>;

/**
 * Look an entry up. Typed to the id union, so the return is an entry rather
 * than `MetricGlossaryEntry | undefined` — there is no branch in which a caller
 * has to decide what an absent explanation looks like.
 */
export function glossaryFor(id: MetricId): MetricGlossaryEntry {
  return METRIC_GLOSSARY[id];
}
