"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { authFetch } from "@/lib/auth-fetch";
import type {
  IpPassthroughSettingsResponse,
  IpPassthroughApplyRequest,
  IpPassthroughSaveResponse,
} from "@/types/ip-passthrough";

const CGI_ENDPOINT = "/cgi-bin/quecmanager/network/ip_passthrough.sh";

export interface UseIpPassthroughReturn {
  enabled: boolean | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  saveSettings: (enabled: boolean) => Promise<boolean>;
  refresh: () => void;
}

export function useIpPassthrough(): UseIpPassthroughReturn {
  const [enabled, setEnabled] = useState<boolean | null>(null);
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

  const fetchSettings = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);

    try {
      const resp = await authFetch(CGI_ENDPOINT);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }

      const data: IpPassthroughSettingsResponse = await resp.json();
      if (!mountedRef.current) return;

      if (!data.success || typeof data.enabled !== "boolean") {
        setError(data.detail || data.error || "Failed to fetch IP Passthrough settings");
        return;
      }

      setEnabled(data.enabled);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(
        err instanceof Error
          ? err.message
          : "Failed to fetch IP Passthrough settings"
      );
    } finally {
      if (mountedRef.current && !silent) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = useCallback(
    async (nextEnabled: boolean): Promise<boolean> => {
      setError(null);
      setIsSaving(true);

      try {
        const request: IpPassthroughApplyRequest = {
          action: "apply",
          enabled: nextEnabled,
        };

        const resp = await authFetch(CGI_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        }

        const result: IpPassthroughSaveResponse = await resp.json();
        if (!mountedRef.current) return false;

        if (!result.success) {
          setError(result.detail || result.error || "Failed to apply settings");
          return false;
        }

        return true;
      } catch (err) {
        if (!mountedRef.current) return false;
        setError(
          err instanceof Error ? err.message : "Failed to apply settings"
        );
        return false;
      } finally {
        if (mountedRef.current) {
          setIsSaving(false);
        }
      }
    },
    []
  );

  return {
    enabled,
    isLoading,
    isSaving,
    error,
    saveSettings,
    refresh: fetchSettings,
  };
}
