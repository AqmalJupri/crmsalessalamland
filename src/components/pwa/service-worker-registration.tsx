"use client";

import { useEffect } from "react";

const localServiceWorkerHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isServiceWorkerOriginEligible(
  hostname: string,
  isSecureContext: boolean,
): boolean {
  return isSecureContext || localServiceWorkerHosts.has(hostname);
}

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (
      !("serviceWorker" in navigator) ||
      !isServiceWorkerOriginEligible(window.location.hostname, window.isSecureContext)
    ) {
      return;
    }

    let active = true;

    async function registerRootWorker(): Promise<void> {
      try {
        const existing = await navigator.serviceWorker.getRegistration("/");
        if (!active || existing) return;
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      } catch {
        // Registration is an enhancement; the online application remains authoritative.
      }
    }

    void registerRootWorker();
    return () => {
      active = false;
    };
  }, []);

  return null;
}
