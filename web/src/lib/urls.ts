const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Base URL that phones can reach. PUBLIC_URL (from the server) wins. Otherwise,
 * if this page was opened via a network address, that address works for phones
 * too; if it was opened via localhost, swap in the machine's LAN IP.
 */
export function publicBase(meta: { publicUrl: string | null; lanIp: string | null } | null): { base: string; reachable: boolean } {
  if (meta?.publicUrl) return { base: meta.publicUrl, reachable: true };
  const { protocol, hostname, port, origin } = window.location;
  if (!LOCAL_HOSTS.has(hostname)) return { base: origin, reachable: true };
  if (meta?.lanIp) return { base: `${protocol}//${meta.lanIp}${port ? `:${port}` : ''}`, reachable: true };
  return { base: origin, reachable: false };
}

export function officeLinks(base: string, officeId: string, staffKey?: string | null) {
  const root = `${base}/o/${officeId}`;
  return {
    join: `${root}/join`,
    display: `${root}/display`,
    staff: staffKey ? `${root}/staff#key=${encodeURIComponent(staffKey)}` : `${root}/staff`,
    settings: `${root}/settings`,
  };
}
