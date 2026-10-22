// =============================================================================
// sms.ts — SMS Center Types
// =============================================================================
// TypeScript interfaces for the SMS Center CGI endpoint.
//
// Backend endpoint: GET/POST /cgi-bin/quecmanager/cellular/sms.sh
//
// Note: The SmsMessage shape matches the JSON output of `sms_tool -j recv`.
// Verify field names against actual device output and adjust if needed.
// =============================================================================

/** A single (possibly merged multi-part) SMS message */
export interface SmsMessage {
  /** Storage indexes for all parts of this message (used for deletion) */
  indexes: number[];
  /** Sender phone number or alphanumeric ID */
  sender: string;
  /** Message content (concatenated if multi-part) */
  content: string;
  /** Timestamp string (format: "MM/DD/YY HH:MM:SS") */
  timestamp: string;
  /**
   * Which store this message lives in:
   *   "ME"  — modem memory (the modem reader's primary source)
   *   "SM"  — SIM card
   *   "STORE" — the DEVICE's own SMS store (the vendor stack's
   *           `sms_config` table, which the vendor UI is served from).
   * Required so deletion targets the correct store: ME/SM take physical slot
   * indexes through `sms_tool`, STORE takes `SmsId` values through sqlite.
   */
  storage: SmsStorageKind;
  /**
   * True when the DEVICE reports the message as already read.
   *
   * Only the STORE source can answer this — the modem reader has no read flag.
   * Absent means "the device did not say", which the read-state hook treats as
   * unread rather than guessing. The device flag is the initial state only:
   * marking a message read here is still browser-local and additive on top.
   */
  read?: boolean;
}

/** Which memory backs a message. See `SmsMessage.storage`. */
export type SmsStorageKind = "ME" | "SM" | "STORE";

/** Storage status info */
export interface SmsStorage {
  /** Number of messages currently stored */
  used: number;
  /** Maximum storage capacity */
  total: number;
  /**
   * Per-memory breakdown for the ME (modem) store. Optional: an
   * un-upgraded device runs the old CGI, which does not emit this
   * breakdown, so the UI must degrade to the combined meter when absent.
   */
  me?: { used: number; total: number };
  /**
   * Per-memory breakdown for the SM (SIM card) store. Optional: an
   * un-upgraded device runs the old CGI, which does not emit this
   * breakdown, so the UI must degrade to the combined meter when absent.
   */
  sm?: { used: number; total: number };
  /**
   * Set only when the DEVICE's own SMS store answered the read. Its presence is
   * how the tiles know they must not draw a modem/SIM split: the store is one
   * database with no per-memory capacity, so `me`/`sm` are absent and `used` is
   * a message count, not slot usage.
   */
  store?: { used: number };
}

/** Response from GET /cgi-bin/quecmanager/cellular/sms.sh */
export interface SmsInboxResponse {
  success: boolean;
  /** Which source answered. Absent on a CGI that predates the store path. */
  source?: "store" | "modem";
  messages: SmsMessage[];
  storage: SmsStorage;
  error?: string;
  detail?: string;
}

/** Generic POST response */
export interface SmsActionResponse {
  success: boolean;
  error?: string;
  detail?: string;
}
