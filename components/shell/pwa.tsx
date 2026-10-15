"use client";

import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

/** Registers the static-asset service worker (production only). */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, []);
  return null;
}

/** Clears service-worker caches (called on sign-out). */
export async function clearAppCaches() {
  try {
    navigator.serviceWorker?.controller?.postMessage("clear-caches");
    if ("caches" in window) for (const k of await caches.keys()) await caches.delete(k);
  } catch {
    /* best effort */
  }
}

/** Visible banner while the device is offline. Nothing is queued for later. */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  if (!offline) return null;
  return (
    <div role="status" className="flex items-center gap-2 bg-pending-soft px-4 py-2 text-sm text-pending">
      <WifiOff className="size-4" aria-hidden /> You’re offline. Changes can’t be saved until you reconnect — nothing is queued.
    </div>
  );
}
