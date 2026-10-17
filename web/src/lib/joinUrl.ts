import type { AppConfig } from '../types';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * URL encoded in the lobby QR code. If this page was opened via a LAN address,
 * phones can use that same address. If it was opened via localhost, swap in
 * the machine's LAN IP reported by the server.
 */
export function resolveJoinUrl(config: AppConfig | null): { url: string; reachable: boolean } {
  const override = new URLSearchParams(window.location.search).get('joinUrl');
  if (override) return { url: override, reachable: true };
  if (config?.publicJoinUrl) return { url: config.publicJoinUrl, reachable: true };

  const { protocol, hostname, port } = window.location;
  if (!LOCAL_HOSTS.has(hostname)) return { url: `${window.location.origin}/join`, reachable: true };
  if (config?.lanIp) return { url: `${protocol}//${config.lanIp}${port ? `:${port}` : ''}/join`, reachable: true };
  return { url: `${window.location.origin}/join`, reachable: false };
}
