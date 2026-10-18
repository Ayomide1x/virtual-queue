import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useOffice, type OfficeLoad } from '../lib/useOffice';
import type { OfficeResponse } from '../types';
import { useI18n } from '../i18n';
import { Header } from './Header';

export function OfficeNotFound({ message, dark = false }: { message?: string; dark?: boolean }) {
  const { t, lang } = useI18n();
  return (
    <div className={`min-h-screen ${dark ? 'bg-navy-950 text-white' : ''}`}>
      {!dark && <Header title={t.notFound.pageTitle} languages />}
      <main id="main" tabIndex={-1} className="mx-auto max-w-xl px-6 py-16 text-center outline-none">
        <div className={`mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full ${dark ? 'bg-white/10' : 'bg-warning-light'}`}>
          <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
            <path d="M12 8v5M12 16.5h.01M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
        </div>
        <h1 className={`text-3xl font-extrabold ${dark ? '' : 'text-navy-900'}`}>{t.notFound.title}</h1>
        <p className={`mt-3 text-lg ${dark ? 'text-white/85' : 'text-muted'}`}>{(lang === 'en' && message) || t.notFound.body}</p>
        <p className={`mt-2 ${dark ? 'text-white/85' : 'text-muted'}`}>{t.notFound.hint}</p>
        <Link to="/" className="btn-primary mt-8">
          {t.notFound.home}
        </Link>
      </main>
    </div>
  );
}

function Loading({ dark }: { dark?: boolean }) {
  const { t } = useI18n();
  return (
    <div className={`flex min-h-screen items-center justify-center ${dark ? 'bg-navy-950 text-white' : ''}`} role="status">
      <div className="text-center">
        <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-primary-light border-t-primary" aria-hidden="true" />
        <p className="text-lg font-semibold">{t.common.loadingOffice}</p>
      </div>
    </div>
  );
}

/** Loads the office for this route; shows a clear message if it doesn't exist. */
export function OfficeGate({ officeId, dark, children }: { officeId: string; dark?: boolean; children: (data: OfficeResponse) => ReactNode }) {
  const load: OfficeLoad = useOffice(officeId);
  if (load.state === 'loading') return <Loading dark={dark} />;
  if (load.state === 'not_found') return <OfficeNotFound message={load.message} dark={dark} />;
  return <>{children(load.data)}</>;
}
