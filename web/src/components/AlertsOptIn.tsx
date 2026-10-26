import { useEffect, useId, useState, type FormEvent } from 'react';
import { Rich, errorText, useI18n } from '../i18n';
import { officeApi, type AlertContact } from '../lib/api';
import { isIOS, pushSupport, subscribeToPush, useAlertsMeta } from '../lib/pwa';

type Target = { kind: 'ticket' | 'appointment'; id: string };

/**
 * Optional alerts: a "Notify me" button for push, with email as a fallback.
 * On iPhone, push only works from the home screen app, so we show how to add it.
 */
export function AlertsOptIn({ officeId, target }: { officeId: string; target: Target }) {
  const api = officeApi(officeId);
  const meta = useAlertsMeta();
  const [contact, setContact] = useState<AlertContact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'push' | 'email' | null>(null);
  const [showEmail, setShowEmail] = useState(false);
  const support = pushSupport();
  const isTicket = target.kind === 'ticket';
  const { t } = useI18n();

  const calls = isTicket
    ? { get: () => api.getTicketAlerts(target.id), set: api.setTicketAlerts.bind(null, target.id), remove: api.removeTicketAlerts.bind(null, target.id) }
    : { get: () => api.getAppointmentAlerts(target.id), set: api.setAppointmentAlerts.bind(null, target.id), remove: api.removeAppointmentAlerts.bind(null, target.id) };

  useEffect(() => {
    calls.get().then(setContact).catch(() => setContact({ push: false, email: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officeId, target.id]);

  if (!meta || !contact) return null;
  const pushOffered = meta.push.enabled && !!meta.push.publicKey;
  if (!pushOffered && !meta.email.enabled) return null;

  const enablePush = async () => {
    setBusy('push');
    setError(null);
    try {
      const result = await subscribeToPush(meta.push.publicKey!);
      if ('error' in result) {
        setError(result.error === 'denied' ? t.alerts.denied : t.alerts.failed);
        setShowEmail(true);
        return;
      }
      setContact(await calls.set({ push: result.subscription }));
    } catch (err) {
      setError(errorText(t, err, t.alerts.failedShort));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (channel: 'push' | 'email') => {
    setError(null);
    try {
      setContact(await calls.remove(channel));
    } catch (err) {
      setError(errorText(t, err, t.alerts.updateFailed));
    }
  };

  const anyOn = contact.push || !!contact.email;
  const emailFirst = !pushOffered || support === 'insecure' || support === 'unsupported';

  return (
    <section className="card space-y-4 p-5" aria-labelledby={`alerts-${target.id}`}>
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${anyOn ? 'bg-success-light text-success-darker' : 'bg-primary-lighter text-primary'}`}>
          <BellIcon />
        </span>
        <div>
          <h2 id={`alerts-${target.id}`} className="text-lg font-bold text-navy-900">
            {anyOn ? t.alerts.onTitle : isTicket ? t.alerts.ticketTitle : t.alerts.apptTitle}
          </h2>
          <p className="text-muted">{isTicket ? t.alerts.ticketBody : t.alerts.apptBody}</p>
        </div>
      </div>

      {/* --- push --- */}
      {pushOffered &&
        (contact.push ? (
          <StatusRow label={t.alerts.pushOn} onRemove={() => remove('push')} removeLabel={t.alerts.pushOff} />
        ) : support === 'ok' ? (
          <button type="button" className="btn-primary min-h-[56px] w-full text-lg" onClick={enablePush} disabled={busy === 'push'}>
            <BellIcon /> {busy === 'push' ? t.alerts.turningOn : t.alerts.notifyMe}
          </button>
        ) : support === 'ios-install' ? (
          <IosInstallGuide />
        ) : (
          <p className="rounded-md bg-muted-lightest p-3 text-sm text-muted">
            {support === 'insecure' ? t.alerts.insecure : t.alerts.unsupported}
          </p>
        ))}

      {/* --- email --- */}
      {meta.email.enabled &&
        (contact.email ? (
          <StatusRow label={t.alerts.willEmail(contact.email)} onRemove={() => remove('email')} removeLabel={t.alerts.stopEmails} />
        ) : emailFirst || showEmail ? (
          <EmailForm
            busy={busy === 'email'}
            logOnly={meta.email.mode === 'log'}
            onSubmit={async (email) => {
              setBusy('email');
              setError(null);
              try {
                setContact(await calls.set({ email }));
              } catch (err) {
                setError(errorText(t, err, t.alerts.emailSaveFailed));
              } finally {
                setBusy(null);
              }
            }}
          />
        ) : (
          <button type="button" className="font-semibold text-primary underline underline-offset-4" onClick={() => setShowEmail(true)}>
            {contact.push ? t.alerts.alsoEmail : t.alerts.emailInstead}
          </button>
        ))}

      {error && (
        <p role="alert" className="rounded-md border-l-8 border-danger-dark bg-danger-light p-3 font-semibold text-danger-dark">
          {error}
        </p>
      )}
    </section>
  );
}

function StatusRow({ label, onRemove, removeLabel }: { label: string; onRemove: () => void; removeLabel: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-success-light px-3 py-2" role="status">
      <span className="flex items-center gap-2 font-semibold text-success-darker">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m5 12 5 5L20 7" />
        </svg>
        {label}
      </span>
      <button type="button" className="text-sm font-semibold text-ink underline underline-offset-4" onClick={onRemove}>
        {removeLabel}
      </button>
    </div>
  );
}

function EmailForm({ onSubmit, busy, logOnly }: { onSubmit: (email: string) => void; busy: boolean; logOnly: boolean }) {
  const [email, setEmail] = useState('');
  const { t } = useI18n();
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) onSubmit(email.trim());
  };
  return (
    <form onSubmit={submit} className="space-y-2" noValidate>
      <label htmlFor="alert-email" className="block font-bold">
        {t.alerts.emailLabel}
      </label>
      <div className="flex gap-2">
        <input
          id="alert-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-describedby={`${id}-privacy`}
          className="min-h-[48px] min-w-0 flex-1 rounded-md border-2 border-muted-light bg-white px-3 text-lg focus:border-primary"
        />
        <button type="submit" className="btn-outline shrink-0" disabled={busy || !email.trim()}>
          {busy ? t.alerts.saving : t.alerts.emailMe}
        </button>
      </div>
      <p id={`${id}-privacy`} className="text-sm text-muted">
        {t.alerts.emailPrivacy}
        {logOnly && t.alerts.previewMode}
      </p>
    </form>
  );
}

/** Visual guide: iOS only allows web push for apps added to the home screen (iOS 16.4+). */
export function IosInstallGuide() {
  const ipad = isIOS() && !/iPhone|iPod/.test(navigator.userAgent);
  const { t } = useI18n();
  return (
    <div className="rounded-lg border-2 border-primary-light bg-primary-lighter p-4">
      <p className="font-bold text-navy-900">{t.ios.intro(ipad ? t.ios.ipad : t.ios.iphone)}</p>
      <ol className="mt-3 space-y-3">
        <Step n={1} icon={<ShareIcon />}>
          <Rich text={t.ios.share(ipad)} />
        </Step>
        <Step n={2} icon={<AddIcon />}>
          <Rich text={t.ios.add} />
        </Step>
        <Step n={3} icon={<img src="/icons/apple-touch-icon.png" alt="" className="h-9 w-9 rounded-lg" />}>
          <Rich text={t.ios.open} />
        </Step>
      </ol>
      <p className="mt-3 text-sm text-muted">{t.ios.footer}</p>
    </div>
  );
}

function Step({ n, icon, children }: { n: number; icon: React.ReactNode; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <li className="flex items-center gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-primary shadow-sm" aria-hidden="true">
        {icon}
      </span>
      <span>
        <span className="sr-only">{t.ios.step(n)}</span>
        {children}
      </span>
    </li>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/** iOS-style share glyph: a box with an arrow pointing up. */
function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="#007aff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M8 11H6.5A1.5 1.5 0 0 0 5 12.5v7A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16" />
    </svg>
  );
}

/** iOS "Add to Home Screen" glyph: a plus in a rounded square. */
function AddIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="#1b1b1b" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}
