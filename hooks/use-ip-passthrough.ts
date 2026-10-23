"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { authFetch } from "@/lib/auth-fetch";
import type {
  IpPassthroughSettingsResponse,
  IpPassthroughApplyRequest,
  IpPassthroughSaveResponse,
  PassthroughState,
} from "@/types/ip-passthrough";

const CGI_ENDPOINT = "/cgi-bin/quecmanager/network/ip_passthrough.sh";

/** How an apply ended, so the card can pick the right message and hand-off. */
export type SaveOutcome =
  | "active" // enabled and QCMAP confirmed it
  | "pending" // enabled and saved, still waiting for a device or for QCMAP
  | "off" // disabled; nothing was active, so nothing needs to reboot
  | "rebooting" // disabled while active: the modem is rebooting to clear it
  | "failed";

export interface UseIpPassthroughReturn {
  /** What was asked for (null before the first read). */
  enabled: boolean | null;
  /** What QCMAP reports (null before the first read). */
  state: PassthroughState | null;
  targetMac: string;
  clients: number;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  saveSettings: (enabled: boolean) => Promise<SaveOutcome>;
  /** `silent` skips the loading skeleton; a click event must never be passed in. */
  refresh: (silent?: boolean) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useIpPassthrough(): UseIpPassthroughReturn {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [state, setState] = useState<PassthroughState | null>(null);
  const [targetMac, setTargetMac] = useState("");
  const [clients, setClients] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyRead = useCallback((d: IpPassthroughSettingsResponse) => {
    setEnabled(d.enabled);
    setState(d.state);
    setTargetMac(d.target_mac ?? "");
    setClients(d.clients ?? 0);
  }, []);

  /** One read. Returns the parsed body, or null on any failure (never throws). */
  const readOnce = useCallback(async (): Promise<IpPassthroughSettingsResponse | null> => {
    try {
      const resp = await authFetch(CGI_ENDPOINT);
      if (!resp.ok) return null;
      const d: IpPassthroughSettingsResponse = await resp.json();
      if (!d.success || typeof d.enabled !== "boolean") return null;
      return d;
    } catch {
      return null;
    }
  }, []);

  const fetchSettings = useCallback(
    async (silent = false) => {
      if (!silent) setIsLoading(true);
      setError(null);
      const d = await readOnce();
      if (!mountedRef.current) return;
      if (d) applyRead(d);
      else setError("Failed to fetch IP Passthrough settings");
      if (!silent) setIsLoading(false);
    },
    [readOnce, applyRead],
  );

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = useCallback(
    async (next: boolean): Promise<SaveOutcome> => {
      setError(null);
      setIsSaving(true);
      const wasActive = state === "active";

      // Applying re-binds the LAN, which can cut the browser's own connection before
      // the reply arrives. So a network error is not a failure: read the state back.
      const settle = async (): Promise<SaveOutcome> => {
        for (let i = 0; i < 10; i++) {
          await sleep(3000);
          const d = await readOnce();
          if (!mountedRef.current) return "failed";
          if (d) {
            applyRead(d);
            if (next && d.enabled) return d.state === "active" ? "active" : "pending";
            if (!next && !d.enabled) return d.state === "active" ? "rebooting" : "off";
          }
        }
        return "failed";
      };

      try {
        const request: IpPassthroughApplyRequest = { action: "apply", enabled: next };
        let result: IpPassthroughSaveResponse | null = null;
        try {
          const resp = await authFetch(CGI_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
          result = await resp.json();
        } catch (err) {
          // Disabling an active passthrough reboots the modem, so the socket dying is expected.
          if (!next && wasActive) return "rebooting";
          if (!mountedRef.current) return "failed";
          const outcome = await settle();
          if (outcome === "failed") {
            setError(err instanceof Error ? err.message : "Failed to apply settings");
          }
          return outcome;
        }

        if (!mountedRef.current) return "failed";
        if (!result || !result.success) {
          setError(result?.detail || result?.error || "Failed to apply settings");
          return "failed";
        }

        if (!next) {
          if (wasActive) return "rebooting";
          setEnabled(false);
          return "off";
        }

        setEnabled(true);
        if (result.state) setState(result.state);
        setTargetMac(result.target_mac ?? "");
        setClients(result.clients ?? 0);
        return result.state === "active" ? "active" : "pending";
      } finally {
        if (mountedRef.current) setIsSaving(false);
      }
    },
    [state, readOnce, applyRead],
  );

  return {
    enabled,
    state,
    targetMac,
    clients,
    isLoading,
    isSaving,
    error,
    saveSettings,
    refresh: fetchSettings,
  };
}
