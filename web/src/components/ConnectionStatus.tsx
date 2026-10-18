import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { useConnected } from '../lib/socket';

/** Banner shown only when the live connection drops (after a short grace period). */
export function ConnectionBanner({ dark = false }: { dark?: boolean }) {
  const connected = useConnected();
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (connected) return setShow(false);
    const t = setTimeout(() => setShow(true), 1200);
    return () => clearTimeout(t);
  }, [connected]);
  if (!show) return null;
  return (
    <div
      role="status"
      className={`flex items-center justify-center gap-2 px-4 py-2 text-center text-sm font-semibold ${
        dark ? 'bg-warning text-ink' : 'bg-warning-light text-ink border-b border-warning'
      }`}
    >
      <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-warning-dark" aria-hidden="true" />
      {t.common.reconnecting}
    </div>
  );
}

export function LiveDot({ light = false }: { light?: boolean }) {
  const connected = useConnected();
  const { t } = useI18n();
  return (
    <span className={`inline-flex items-center gap-2 text-sm font-semibold ${light ? 'text-white' : 'text-muted'}`}>
      <span
        className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-success' : 'animate-pulse bg-warning'}`}
        aria-hidden="true"
      />
      {connected ? t.common.live : t.common.reconnectingShort}
    </span>
  );
}
