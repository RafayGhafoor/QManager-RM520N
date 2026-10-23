// =============================================================================
// ip-passthrough.ts — GreenPacket O5A IP Passthrough contract
// =============================================================================
// The O5A product backend exposes one supported setting: enable/disable. The
// RM520N-specific QMAP controls (target MAC, NAT, USB protocol, DNS) are not
// available through this device's backend and are intentionally not modeled.

export interface IpPassthroughSettingsResponse {
  success: boolean;
  enabled: boolean;
  error?: string;
  detail?: string;
}

export interface IpPassthroughApplyRequest {
  action: "apply";
  enabled: boolean;
}

export interface IpPassthroughSaveResponse {
  success: boolean;
  error?: string;
  detail?: string;
}
