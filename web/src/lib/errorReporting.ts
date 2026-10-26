// Send browser crashes to the server (POST /api/client-errors), where they're
// logged and, if error tracking is on, forwarded. Ticket ids are blanked out
// here (and again on the server); we never send form contents or storage.

const MAX_REPORTS = 5; // per page load, so a render loop can't flood the server
let sent = 0;
const seen = new Set<string>();

export function reportError(kind: 'error' | 'unhandledrejection' | 'react', err: unknown) {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Unknown error');
  const key = `${e.message}|${e.stack?.split('\n')[1] ?? ''}`;
  if (sent >= MAX_REPORTS || seen.has(key)) return;
  seen.add(key);
  sent++;
  const body = JSON.stringify({
    kind,
    message: e.message.slice(0, 1000),
    stack: e.stack?.slice(0, 4000),
    // No query string or hash (they can hold staff keys), and no ids: a ticket's address holds its secret id.
    url: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id'),
  });
  try {
    void fetch('/api/client-errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch {
    /* reporting must never cause another error */
  }
}

export function installErrorReporting() {
  window.addEventListener('error', (ev) => reportError('error', ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportError('unhandledrejection', ev.reason));
}
