import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertsOptIn } from '../components/AlertsOptIn';
import { ConnectionBanner } from '../components/ConnectionStatus';
import { Header } from '../components/Header';
import { OfficeGate } from '../components/OfficeGate';
import { ServiceBadge } from '../components/ServiceBadge';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { errorText, formatRange, formatTime, hoursText, useI18n } from '../i18n';
import { ApiError, officeApi } from '../lib/api';
import { useChannel } from '../lib/socket';
import { audioUnlocked, playChime, unlockAudio, vibrate } from '../lib/sound';
import { isIOS, isStandalone, useOfficeManifest } from '../lib/pwa';
import { useOfficeId } from '../lib/useOffice';
import { useTitle } from '../lib/useTitle';
import type { LobbyState, OfficeInfo, TicketView } from '../types';

/** The resident's ticket for each office is kept on this device. */
function ticketStorage(officeId: string) {
  const key = `vq.ticket.${officeId}`;
  return {
    get: () => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (id: string) => {
      try {
        localStorage.setItem(key, id);
      } catch {
        /* private mode: ticket just won't survive a refresh */
      }
    },
    clear: () => {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A ticket's own address. Bookmarkable, and what the Home Screen app opens on. */
export const ticketPath = (officeId: string, ticketId: string) => `/o/${officeId}/t/${ticketId}`;

/**
 * The tickets this page could show, best first.
 *
 * - In Safari (or any browser tab), the ticket in the address comes first: the
 *   resident opened that link, so that's the ticket they mean.
 * - In a Home Screen app, the one in storage comes first. The icon's start_url
 *   is frozen at the ticket it was installed with, and iOS never updates it, so
 *   when the resident joins again from inside the app, only the app's storage
 *   knows about the newer ticket.
 *
 * The other one is the fallback, used if the first has already ended.
 */
function ticketCandidates(officeId: string, fromUrl: string | null, standalone: boolean): string[] {
  const stored = ticketStorage(officeId).get();
  const order = standalone ? [stored, fromUrl] : [fromUrl, stored];
  return order.filter((id, i): id is string => !!id && UUID.test(id) && order.indexOf(id) === i);
}

export default function Resident() {
  const officeId = useOfficeId();
  const params = useParams();
  // Decided once, on load: later route changes (a ticket ending → the join page) must not bounce back.
  const [start] = useState(() => {
    // Installed Home Screen app (iOS: navigator.standalone) vs. a browser tab.
    const standalone = isStandalone();
    const fromUrl = params.ticketId ?? new URLSearchParams(window.location.search).get('ticket');
    const candidates = ticketCandidates(officeId, fromUrl, standalone);
    const target = candidates[0] ? ticketPath(officeId, candidates[0]) : `/o/${officeId}/join`;
    const here = window.location.pathname === target && !window.location.search.includes('ticket=');
    // In a browser, a full page load, not an in-app route change: Safari reads
    // the page's manifest (start_url = this address) only when a page loads.
    // An installed app's start_url is already fixed, so there it's in-app.
    return { standalone, candidates, target, reload: !here && !standalone, move: !here && standalone };
  });
  useEffect(() => {
    if (start.reload) window.location.replace(start.target);
  }, [start]);
  if (start.reload) return null;
  return (
    <OfficeGate officeId={officeId}>
      {(data) => (
        <ResidentScreen key={officeId} officeId={officeId} initialOffice={data.office} candidates={start.candidates} standalone={start.standalone} moveTo={start.move ? start.target : null} />
      )}
    </OfficeGate>
  );
}

function ResidentScreen({
  officeId,
  initialOffice,
  candidates: initialCandidates,
  standalone,
  moveTo,
}: {
  officeId: string;
  initialOffice: OfficeInfo;
  candidates: string[];
  standalone: boolean;
  moveTo: string | null;
}) {
  const storage = ticketStorage(officeId);
  const api = officeApi(officeId);
  const { data: lobby } = useChannel<LobbyState>({ officeId, role: 'lobby' }, 'lobby:state');
  const office = lobby?.office ?? initialOffice;
  const { t, lang } = useI18n();
  useTitle(t.join.pageTitle(office.name));
  const navigate = useNavigate();
  const [candidates, setCandidates] = useState(initialCandidates);
  const ticketId = candidates[0] ?? null;
  // "Add to Home Screen" opens this office, with this ticket. (In production the
  // server already put this link in the page; this keeps dev and later changes in step.)
  useOfficeManifest(officeId, ticketId ? ticketPath(officeId, ticketId) : `/o/${officeId}/join`);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (moveTo) navigate(moveTo, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: live } = useChannel<{ officeId: string; id: string; view: TicketView | null; serverNow?: number }>(
    ticketId ? { officeId, role: 'ticket', ticketId } : null,
    'ticket:update',
    (d) => d.id === ticketId,
  );
  const current = live && live.id === ticketId ? live : null; // not a previous ticket's last update
  const view = current ? current.view : null;

  const forget = (message: string | null) => {
    if (storage.get() === ticketId) storage.clear();
    setCandidates([]);
    setNotice(message);
    navigate(`/o/${officeId}/join`, { replace: true });
  };

  // The first time we hear about a ticket: if it had already ended and there's
  // another one to try, try that. Once it's been seen in line, endings are shown.
  const seenActive = useRef<string | null>(null);
  useEffect(() => {
    if (!ticketId || !current) return;
    const status = current.view?.ticket.status;
    const isActive = status === 'waiting' || status === 'called';
    if (isActive) {
      seenActive.current = ticketId;
      if (storage.get() !== ticketId) storage.set(ticketId); // this device now follows this ticket
      return;
    }
    if (seenActive.current !== ticketId && candidates.length > 1) {
      if (storage.get() === ticketId) storage.clear();
      const next = candidates[1];
      // Browser: a full load, so the page (and its manifest) carries the ticket shown.
      if (!standalone) return window.location.replace(ticketPath(officeId, next));
      setCandidates(candidates.slice(1));
      navigate(ticketPath(officeId, next), { replace: true });
      return;
    }
    // Ticket expired, was reset, or the resident left from another tab.
    if (current.view === null) forget(t.join.noLongerActive);
    else if (status === 'left') forget(t.join.left);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, ticketId]);

  // Alerts and the lobby announcement use the ticket's language: keep it in step with the page.
  const syncedLang = useRef<string | null>(null);
  const ticketLang = view?.ticket.lang;
  const active = view?.ticket.status === 'waiting' || view?.ticket.status === 'called';
  useEffect(() => {
    if (!ticketId || !active || !ticketLang || ticketLang === lang || syncedLang.current === `${ticketId}:${lang}`) return;
    syncedLang.current = `${ticketId}:${lang}`;
    api.setTicketLanguage(ticketId, lang).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId, active, ticketLang, lang]);

  // Unlock audio on the first tap anywhere, so the "your turn" chime can play later.
  useEffect(() => {
    const unlock = () => void unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  const onJoined = (v: TicketView) => {
    storage.set(v.ticket.id);
    // Load the ticket's own address as a fresh page, so the page Safari adds to
    // the Home Screen (and its manifest) already carries the ticket.
    window.location.replace(ticketPath(officeId, v.ticket.id));
  };

  const status = ticketId && view ? view.ticket.status : null;

  return (
    <div className={`flex min-h-screen flex-col ${status === 'called' ? 'on-dark bg-success-darker' : ''}`}>
      <Header title={t.common.appName} office={office.name} languages />
      <ConnectionBanner />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-md flex-1 px-4 pb-10 pt-6 outline-none">
        {!ticketId && (office.status.open ? <JoinForm api={api} lobby={lobby} office={office} onJoined={onJoined} notice={notice} /> : <Closed office={office} notice={notice} />)}
        {ticketId && !view && <LoadingTicket />}
        {view && status === 'waiting' && <Waiting api={api} view={view} onLeft={() => forget(t.join.left)} />}
        {view && status === 'called' && <Called api={api} view={view} onLeft={() => forget(t.join.left)} />}
        {view && (status === 'served' || status === 'no_show') && <Finished view={view} onDone={() => forget(null)} />}
      </main>
    </div>
  );
}

function LoadingTicket() {
  const { t } = useI18n();
  return (
    <div className="card p-8 text-center" role="status">
      <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-primary-light border-t-primary" aria-hidden="true" />
      <p className="text-lg font-semibold">{t.join.findingTicket}</p>
    </div>
  );
}

// ---------------------------------------------------------------------- join

type Api = ReturnType<typeof officeApi>;

function Closed({ office, notice }: { office: OfficeInfo; notice: string | null }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <div className="animate-fade-in space-y-6">
      {notice && (
        <div role="status" className="rounded-md border-l-8 border-primary bg-primary-lighter p-4">
          {notice}
        </div>
      )}
      <div className="card p-6 text-center" role="status">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted-lightest text-navy-900">
          <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </div>
        <h1 className="text-3xl font-extrabold text-navy-900">{t.join.closedTitle}</h1>
        <p className="mt-3 text-lg text-muted">{hoursText(office.status, i18n)}</p>
        <p className="mt-3 text-muted">{t.join.closedAutoOpen}</p>
      </div>
    </div>
  );
}

function JoinForm({
  api,
  lobby,
  office,
  onJoined,
  notice,
}: {
  api: Api;
  lobby: LobbyState | null;
  office: OfficeInfo;
  onJoined: (v: TicketView) => void;
  notice: string | null;
}) {
  const [name, setName] = useState('');
  const [service, setService] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [invalid, setInvalid] = useState<'name' | 'service' | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const servicesRef = useRef<HTMLFieldSetElement>(null);
  const { t, lang } = useI18n();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    void unlockAudio();
    if (!name.trim()) {
      setError(t.join.errorName);
      setInvalid('name');
      nameRef.current?.focus();
      return;
    }
    if (!service) {
      setError(t.join.errorService);
      setInvalid('service');
      servicesRef.current?.querySelector('input')?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    setInvalid(null);
    try {
      onJoined(await api.join(name.trim(), service, lang));
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-3xl font-extrabold text-navy-900">{t.join.title}</h1>
        <p className="mt-2 text-lg text-muted">{t.join.intro}</p>
      </div>

      {notice && (
        <div role="status" className="rounded-md border-l-8 border-primary bg-primary-lighter p-4 text-ink">
          {notice}
        </div>
      )}

      {/* Added to the Home Screen before joining, then joined in Safari: that ticket is in Safari's storage, not here. */}
      {isIOS() && isStandalone() && (
        <div className="rounded-md border-l-8 border-muted-light bg-white p-4 text-ink">
          <p className="font-bold">{t.join.appNoTicketTitle}</p>
          <p className="mt-1 text-muted">{t.join.appNoTicketBody}</p>
        </div>
      )}

      <div>
        <label htmlFor="name" className="mb-2 block text-lg font-bold">
          {t.join.nameLabel}
        </label>
        <input
          ref={nameRef}
          id="name"
          name="name"
          autoComplete="given-name"
          autoCapitalize="words"
          enterKeyHint="next"
          maxLength={30}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="block min-h-[56px] w-full rounded-md border-2 border-muted-light bg-white px-4 text-xl focus:border-primary"
          aria-describedby={invalid === 'name' ? 'name-hint join-error' : 'name-hint'}
          aria-invalid={invalid === 'name' || undefined}
        />
        <p id="name-hint" className="mt-1 text-sm text-muted">
          {t.join.nameHint}
        </p>
      </div>

      <fieldset ref={servicesRef} aria-describedby={invalid === 'service' ? 'join-error' : undefined}>
        <legend className="mb-2 text-lg font-bold">{t.join.serviceLegend}</legend>
        <div className="space-y-3">
          {office.services.map(({ id, name, code }) => {
            const s = lobby?.services.find((x) => x.id === id);
            const selected = service === id;
            return (
              <label
                key={id}
                className={`flex min-h-[72px] cursor-pointer items-center gap-4 rounded-lg border-2 bg-white p-4 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-4 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                  selected ? 'border-primary bg-primary-lighter ring-1 ring-primary' : 'border-muted-lighter hover:border-muted-light'
                }`}
              >
                <input
                  type="radio"
                  name="service"
                  value={id}
                  checked={selected}
                  onChange={() => {
                    setService(id);
                    if (invalid === 'service') {
                      setInvalid(null);
                      setError(null);
                    }
                  }}
                  className="sr-only"
                />
                <ServiceBadge code={code} size="lg" tone={selected ? 'solid' : 'light'} />
                <span className="flex-1">
                  <span className="block text-lg font-bold">{name}</span>
                  <span className="block text-sm text-muted">
                    {s ? (s.paused ? t.join.paused : t.join.waitingNow(s.waitingCount, formatRange(t, s.estimate))) : '\u00a0'}
                  </span>
                </span>
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${selected ? 'border-primary bg-primary' : 'border-muted-light'}`}
                  aria-hidden="true"
                >
                  {selected && <span className="h-2.5 w-2.5 rounded-full bg-white" />}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {error && (
        <p id="join-error" role="alert" className="rounded-md border-l-8 border-danger-dark bg-danger-light p-4 font-semibold text-danger-dark">
          {error}
        </p>
      )}

      <button type="submit" className="btn-primary w-full min-h-[60px] text-xl" disabled={submitting}>
        {submitting ? t.join.submitting : t.join.submit}
      </button>
      {office.appointments.enabled && <AppointmentLinks officeId={api.officeId} />}
    </form>
  );
}

/** "Book an appointment" link, plus a shortcut to an appointment booked on this device. */
function AppointmentLinks({ officeId }: { officeId: string }) {
  const { t } = useI18n();
  const saved = (() => {
    try {
      return localStorage.getItem(`vq.appointment.${officeId}`);
    } catch {
      return null;
    }
  })();
  return (
    <div className="rounded-md border border-muted-lighter bg-white p-4 text-center">
      <p className="text-muted">{t.join.preferTime}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-x-6 gap-y-2">
        <Link to={`/o/${officeId}/book`} className="font-bold text-primary underline underline-offset-4">
          {t.join.book}
        </Link>
        {saved && (
          <Link to={`/o/${officeId}/appointment/${saved}`} className="font-bold text-primary underline underline-offset-4">
            {t.join.viewAppointment}
          </Link>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- waiting

function TicketNumber({ view, tone = 'light' }: { view: TicketView; tone?: 'light' | 'dark' }) {
  const { t, locale } = useI18n();
  return (
    <div className="text-center">
      <div className={`label ${tone === 'dark' ? 'text-white' : ''}`}>{t.ticket.yourTicket}</div>
      <div className={`tabular mt-1 text-7xl font-extrabold tracking-tight ${tone === 'dark' ? 'text-white' : 'text-navy-900'}`}>
        {view.ticket.number}
      </div>
      <div className={`mt-1 text-lg ${tone === 'dark' ? 'text-white' : 'text-muted'}`}>{view.serviceName}</div>
      {(view.ticket.priority || view.ticket.kind === 'appointment') && (
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {view.ticket.priority && (
            <span className={`rounded-full px-3 py-1 text-sm font-bold ${tone === 'dark' ? 'bg-white/15 text-white' : 'bg-navy-900 text-white'}`}>{t.common.priorityService}</span>
          )}
          {view.ticket.kind === 'appointment' && view.ticket.appointmentAt && (
            <span className={`rounded-full px-3 py-1 text-sm font-bold ${tone === 'dark' ? 'bg-white/15 text-white' : 'bg-primary-light text-navy-900'}`}>
              {t.common.appointmentAt(formatTime(view.ticket.appointmentAt, locale))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Waiting({ api, view, onLeft }: { api: Api; view: TicketView; onLeft: () => void }) {
  const { ahead, position, estimate } = view;
  const [soundOn, setSoundOn] = useState(audioUnlocked());
  const { t } = useI18n();

  // Tell screen reader users when they move up (the numbers on screen change silently).
  const [announcement, setAnnouncement] = useState('');
  const lastAhead = useRef(ahead);
  useEffect(() => {
    if (ahead !== null && position !== null && lastAhead.current !== null && ahead !== lastAhead.current) {
      setAnnouncement(t.ticket.positionAnnouncement(position, ahead));
    }
    lastAhead.current = ahead;
  }, [ahead, position, t]);

  return (
    <div className="animate-fade-in space-y-5">
      <h1 className="text-xl font-normal">{t.ticket.hi(view.ticket.name)}</h1>
      <p role="status" aria-atomic="true" className="sr-only">
        {announcement}
      </p>

      <section className="card overflow-hidden" aria-labelledby="ticket-heading">
        <h2 id="ticket-heading" className="sr-only">
          {t.ticket.placeHeading}
        </h2>
        <div className="border-b border-muted-lighter bg-primary-lighter px-6 py-6">
          <TicketNumber view={view} />
        </div>
        <dl className="grid grid-cols-2 divide-x divide-muted-lighter">
          <div className="p-5 text-center">
            <dt className="label">{t.ticket.position}</dt>
            <dd className="tabular mt-1 text-4xl font-extrabold text-navy-900">{position ?? '—'}</dd>
            <dd className="text-sm text-muted">{ahead === 0 ? t.ticket.youreNext : t.ticket.ahead(ahead ?? 0)}</dd>
          </div>
          <div className="p-5 text-center">
            <dt className="label">{t.ticket.estimatedWait}</dt>
            <dd className="mt-1 text-2xl font-extrabold leading-10 text-navy-900">{ahead === 0 ? t.ticket.anyMoment : t.time.approx(formatRange(t, estimate))}</dd>
            <dd className="text-sm text-muted">{ahead === 0 ? t.ticket.updatesLive : t.ticket.likelyRange}</dd>
          </div>
        </dl>
      </section>

      <AlertsOptIn officeId={api.officeId} target={{ kind: 'ticket', id: view.ticket.id }} />

      {view.servicePaused && (
        <div role="status" className="rounded-md border-l-8 border-warning bg-warning-light p-4">
          <p className="font-bold">{t.ticket.pausedTitle}</p>
          <p>{t.ticket.pausedBody}</p>
        </div>
      )}

      <div className="rounded-md bg-white p-4 text-muted">
        <p>
          <strong className="text-ink">{t.ticket.keepOpenStrong}</strong>
          {t.ticket.keepOpenRest}
        </p>
        {!soundOn && (
          <button
            type="button"
            className="btn-outline mt-3 w-full"
            onClick={async () => {
              const ok = await unlockAudio();
              setSoundOn(ok);
              if (ok) playChime(0.2);
            }}
          >
            <SpeakerIcon /> {t.ticket.soundOn}
          </button>
        )}
      </div>

      <CopyTicketLink officeId={api.officeId} ticketId={view.ticket.id} />

      <LeaveButton api={api} ticketId={view.ticket.id} onLeft={onLeft} />
    </div>
  );
}

/** The ticket's own address, to keep or open on another device. */
function CopyTicketLink({ officeId, ticketId }: { officeId: string; ticketId: string }) {
  const { t } = useI18n();
  const link = `${window.location.origin}${ticketPath(officeId, ticketId)}`;
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setResult('copied');
    } catch {
      setResult('failed');
    }
  };
  return (
    <div className="rounded-md bg-white p-4 text-muted">
      <button type="button" className="btn-outline w-full" onClick={copy}>
        <LinkIcon /> {t.ticket.copyLink}
      </button>
      <p role="status" className={result ? 'mt-2 text-ink' : 'sr-only'}>
        {result === 'copied' ? t.ticket.linkCopied : result === 'failed' ? t.ticket.copyFailed : ''}
      </p>
      {result === 'failed' && <p className="mt-1 select-all break-all font-mono text-sm text-ink">{link}</p>}
      <p className="mt-2 text-sm">{t.ticket.linkHint}</p>
    </div>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

function LeaveButton({ api, ticketId, onLeft, tone = 'light' }: { api: Api; ticketId: string; onLeft: () => void; tone?: 'light' | 'dark' }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();
  const leaveButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    // After "Keep my place", put focus back on the button that opened the question.
    if (!confirming && returnFocus.current) leaveButton.current?.focus();
    returnFocus.current = false;
  }, [confirming]);
  const keep = () => {
    returnFocus.current = true;
    setConfirming(false);
  };

  const leave = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.leave(ticketId);
      onLeft();
    } catch (err) {
      // Already gone (served / left elsewhere): treat as left.
      if (err instanceof ApiError && (err.code === 'not_active' || err.code === 'not_found')) onLeft();
      else setError(errorText(t, err, t.ticket.leaveError));
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <button
        ref={leaveButton}
        type="button"
        className={tone === 'dark' ? 'btn w-full border-2 border-white/70 text-white hover:bg-white/10' : 'btn-danger-outline w-full'}
        onClick={() => setConfirming(true)}
      >
        {t.ticket.leave}
      </button>
    );
  }
  return (
    <div
      className="card animate-fade-in p-4 text-ink"
      role="alertdialog"
      aria-labelledby="leave-q"
      aria-describedby="leave-body"
      onKeyDown={(e) => e.key === 'Escape' && !busy && keep()}
    >
      <p id="leave-q" className="text-lg font-bold">
        {t.ticket.leaveQuestion}
      </p>
      <p id="leave-body" className="text-muted">
        {t.ticket.leaveBody}
      </p>
      {error && (
        <p role="alert" className="mt-2 font-semibold text-danger-dark">
          {error}
        </p>
      )}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <button type="button" className="btn-secondary" onClick={keep} disabled={busy} autoFocus>
          {t.ticket.keepPlace}
        </button>
        <button type="button" className="btn bg-danger-dark text-white hover:bg-danger" onClick={leave} disabled={busy}>
          {busy ? t.ticket.leaving : t.ticket.confirmLeave}
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- called

function Called({ api, view, onLeft }: { api: Api; view: TicketView; onLeft: () => void }) {
  const alerted = useRef<string | null>(null);
  const [soundOn, setSoundOn] = useState(audioUnlocked());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { t } = useI18n();

  // Chime on the initial call and on each recall.
  useEffect(() => {
    const key = `${view.ticket.id}:${view.ticket.recallCount}`;
    if (alerted.current === key) return;
    alerted.current = key;
    playChime();
    vibrate();
    headingRef.current?.focus();
  }, [view.ticket.id, view.ticket.recallCount]);

  useEffect(() => {
    const original = document.title;
    let on = true;
    const id = setInterval(() => {
      document.title = on ? t.called.tabTitle : original;
      on = !on;
    }, 1000);
    return () => {
      clearInterval(id);
      document.title = original;
    };
  }, [t]);

  return (
    <div className="animate-fade-in space-y-6 text-white">
      {/* Short, so screen readers say it at once; the full page follows. */}
      <p role="alert" className="sr-only">
        {t.called.announce(view.counterName ?? '')}
        {view.ticket.recallCount > 0 ? ` ${t.called.recalled}` : ''}
      </p>
      <div className="mx-auto mt-2 flex h-24 w-24 animate-pulse-ring items-center justify-center rounded-full bg-success text-white">
        <svg viewBox="0 0 24 24" className="h-12 w-12" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      </div>
      <div className="text-center">
        <h1 ref={headingRef} tabIndex={-1} className="text-4xl font-extrabold outline-none">
          {t.called.title}
        </h1>
        <p className="mt-3 text-2xl">{t.called.goTo}</p>
        <p className="mt-1 break-words text-6xl font-extrabold">{view.counterName}</p>
        {view.ticket.recallCount > 0 && <p className="mt-3 text-lg font-semibold text-success-light">{t.called.recalled}</p>}
      </div>
      <div className="rounded-lg bg-white/10 p-5">
        <TicketNumber view={view} tone="dark" />
      </div>
      {!soundOn && (
        <button
          type="button"
          className="btn w-full bg-white text-success-darker"
          onClick={async () => {
            const ok = await unlockAudio();
            setSoundOn(ok);
            if (ok) playChime();
          }}
        >
          <SpeakerIcon /> {t.called.playSound}
        </button>
      )}
      <LeaveButton api={api} ticketId={view.ticket.id} onLeft={onLeft} tone="dark" />
    </div>
  );
}

// ------------------------------------------------------------------ finished

function Finished({ view, onDone }: { view: TicketView; onDone: () => void }) {
  const served = view.ticket.status === 'served';
  const { t } = useI18n();
  return (
    <div className="card animate-fade-in space-y-4 p-6 text-center">
      <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${served ? 'bg-success-light text-success-darker' : 'bg-warning-light text-warning-dark'}`}>
        {served ? (
          <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m5 12 5 5L20 7" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true">
            <path d="M12 7v6M12 17h.01" />
          </svg>
        )}
      </div>
      <h1 className="text-3xl font-extrabold text-navy-900">{served ? t.finished.servedTitle : t.finished.missedTitle}</h1>
      <p className="text-lg text-muted">{served ? t.finished.servedBody(view.ticket.name, view.ticket.number) : t.finished.missedBody(view.ticket.number)}</p>
      <button type="button" className="btn-primary w-full" onClick={onDone}>
        {served ? t.finished.done : t.finished.joinAgain}
      </button>
    </div>
  );
}
