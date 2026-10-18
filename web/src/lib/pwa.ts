import { useEffect, useState } from 'react';

export interface AlertsMeta {
  push: { enabled: boolean; publicKey: string | null };
  email: { enabled: boolean; mode: 'resend' | 'log' | null };
}

let metaCache: Promise<AlertsMeta> | null = null;

/** Which alert channels this server offers. */
export function useAlertsMeta(): AlertsMeta | null {
  const [meta, setMeta] = useState<AlertsMeta | null>(null);
  useEffect(() => {
    metaCache ??= fetch('/api/meta')
      .then((r) => r.json())
      .then((m) => m.alerts as AlertsMeta)
      .catch((err) => {
        metaCache = null;
        throw err;
      });
    metaCache.then(setMeta).catch(() => {});
  }, []);
  return meta;
}

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

/** Running as an installed (home screen) app. */
export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export type PushSupport =
  | 'ok'
  | 'insecure' // web push needs https (or localhost)
  | 'ios-install' // iPhone/iPad: only works from the home screen app
  | 'unsupported';

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure';
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIOS() && !isStandalone()) return 'ios-install';
  return capable ? 'ok' : 'unsupported';
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

function base64UrlToBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Ask for permission (must run from a tap) and subscribe this device.
 * Returns the subscription to send to the server, or a reason it failed.
 */
export async function subscribeToPush(publicKey: string): Promise<{ subscription: PushSubscriptionJSON } | { error: 'denied' | 'failed' }> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { error: 'denied' };
  const reg = await registerServiceWorker();
  if (!reg) return { error: 'failed' };
  try {
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) as BufferSource }));
    return { subscription: sub.toJSON() };
  } catch {
    return { error: 'failed' };
  }
}

/**
 * Point the page at this office's web app manifest. `start` is where the
 * installed app opens; it includes the ticket because iOS gives home screen
 * apps their own storage.
 */
export function useOfficeManifest(officeId: string, start?: string) {
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
    }
    link.href = `/api/o/${officeId}/manifest.webmanifest${start ? `?start=${encodeURIComponent(start)}` : ''}`;
  }, [officeId, start]);

  useEffect(() => {
    void registerServiceWorker();
  }, []);
}
