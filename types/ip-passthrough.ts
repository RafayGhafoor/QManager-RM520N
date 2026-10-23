// =============================================================================
// ip-passthrough.ts — GreenPacket O5A IP Passthrough contract
// =============================================================================
// Backend: scripts/www/cgi-bin/quecmanager/network/ip_passthrough.sh, which drives
// Quectel's ql_qmap. The target device (the router on the LAN port) is detected by
// the backend, so there is no MAC, NAT, USB or DNS setting here.

/** Read from QCMAP itself; "unknown" means it could not be read, never "inactive". */
export type PassthroughState = "active" | "inactive" | "unknown";

export interface IpPassthroughSettingsResponse {
  success: boolean;
  /** What the owner asked for (persisted by QManager). */
  enabled: boolean;
  /** What QCMAP reports right now. */
  state: PassthroughState;
  /** The device that is, or would be, bound. Empty when none is connected. */
  target_mac: string;
  /** Number of live LAN clients; passthrough binds exactly one. */
  clients: number;
  error?: string;
  detail?: string;
}

export interface IpPassthroughApplyRequest {
  action: "apply";
  enabled: boolean;
}

/** Enabling returns the full state; disabling an active passthrough returns only `success`
 *  because the modem is about to reboot. */
export interface IpPassthroughSaveResponse {
  success: boolean;
  enabled?: boolean;
  state?: PassthroughState;
  target_mac?: string;
  clients?: number;
  error?: string;
  detail?: string;
}
