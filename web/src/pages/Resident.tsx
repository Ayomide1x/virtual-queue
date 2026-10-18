import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertsOptIn } from '../components/AlertsOptIn';
import { ConnectionBanner } from '../components/ConnectionStatus';
import { Header } from '../components/Header';
import { OfficeGate } from '../components/OfficeGate';
import { ServiceBadge } from '../components/ServiceBadge';
import { ApiError, officeApi } from '../lib/api';
import { Link } from 'react-router-dom';
import { formatClock, formatRange } from '../lib/format';
import { useChannel } from '../lib/socket';
import { audioUnlocked, playChime, unlockAudio, vibrate } from '../lib/sound';
import { useOfficeManifest } from '../lib/pwa';
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

/**
 * Pick up a ticket passed in the URL (?ticket=…), e.g. when the installed home
 * screen app opens for the first time — iOS gives it separate storage. A ticket
 * already on this device wins: the app's start URL keeps its first ticket forever.
 */
function adoptTicketFromUrl(officeId: string) {
  const id = new URLSearchParams(window.location.search).get('ticket');
  const storage = ticketStorage(officeId);
  if (id && UUID.test(id) && !storage.get()) storage.set(id);
}

export default function Resident() {
  const officeId = useOfficeId();
  useState(() => adoptTicketFromUrl(officeId));
  return (
    <OfficeGate officeId={officeId}>
      {(data) => <ResidentScreen key={officeId} officeId={officeId} initialOffice={data.office} />}
    </OfficeGate>
  );
}

function ResidentScreen({ officeId, initialOffice }: { officeId: string; initialOffice: OfficeInfo }) {
  const storage = ticketStorage(officeId);
  const api = officeApi(officeId);
  const { data: lobby } = useChannel<LobbyState>({ officeId, role: 'lobby' }, 'lobby:state');
  const office = lobby?.office ?? initialOffice;
  useTitle(`Join the line — ${office.name}`);
  const [ticketId, setTicketId] = useState<string | null>(storage.get);
  // "Add to Home Screen" opens this office, with this ticket.
  useOfficeManifest(officeId, ticketId ? `/o/${officeId}/join?ticket=${ticketId}` : undefined);
  // Keep the ticket in the address bar too: iOS saves this URL on "Add to Home Screen".
  useEffect(() => {
    const url = new URL(window.location.href);
    if (ticketId) url.searchParams.set('ticket', ticketId);
    else url.searchParams.delete('ticket');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, [ticketId]);
  const [joinedView, setJoinedView] = useState<TicketView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: live } = useChannel<{ officeId: string; id: string; view: TicketView | null; serverNow?: number }>(
    ticketId ? { officeId, role: 'ticket', ticketId } : null,
    'ticket:update',
    (d) => d.id === ticketId,
  );
  const view = live ? live.view : joinedView;

  const forget = (message: string | null) => {
    storage.clear();
    setTicketId(null);
    setJoinedView(null);
    setNotice(message);
  };

  // Ticket expired, was reset, or the resident left from another tab.
  useEffect(() => {
    if (!ticketId || !live) return;
    if (live.view === null) forget('Your previous ticket is no longer active. You can join the line again below.');
    else if (live.view.ticket.status === 'left') forget('You have left the line.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, ticketId]);

  // Unlock audio on the first tap anywhere, so the "your turn" chime can play later.
  useEffect(() => {
    const unlock = () => void unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  const onJoined = (v: TicketView) => {
    storage.set(v.ticket.id);
    setNotice(null);
    setJoinedView(v);
    setTicketId(v.ticket.id);
  };

  const status = ticketId && view ? view.ticket.status : null;

  return (
    <div className={`flex min-h-screen flex-col ${status === 'called' ? 'bg-success-darker' : ''}`}>
      <Header title="Virtual Queue" office={office.name} />
      <ConnectionBanner />
      <main className="mx-auto w-full max-w-md flex-1 px-4 pb-10 pt-6">
        {!ticketId && (office.status.open ? <JoinForm api={api} lobby={lobby} office={office} onJoined={onJoined} notice={notice} /> : <Closed office={office} notice={notice} />)}
        {ticketId && !view && <LoadingTicket />}
        {view && status === 'waiting' && <Waiting api={api} view={view} onLeft={() => forget('You have left the line.')} />}
        {view && status === 'called' && <Called api={api} view={view} onLeft={() => forget('You have left the line.')} />}
        {view && (status === 'served' || status === 'no_show') && <Finished view={view} onDone={() => forget(null)} />}
      </main>
    </div>
  );
}

function LoadingTicket() {
  return (
    <div className="card p-8 text-center" role="status">
      <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-primary-light border-t-primary" aria-hidden="true" />
      <p className="text-lg font-semibold">Finding your ticket…</p>
    </div>
  );
}

// ---------------------------------------------------------------------- join

type Api = ReturnType<typeof officeApi>;

function Closed({ office, notice }: { office: OfficeInfo; notice: string | null }) {
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
        <h1 className="text-3xl font-extrabold text-navy-900">The line is closed</h1>
        <p className="mt-3 text-lg text-muted">{office.status.message ?? 'Joining is closed right now.'}</p>
        <p className="mt-3 text-muted">This page will open automatically when the line reopens.</p>
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
  const nameRef = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    void unlockAudio();
    if (!name.trim()) {
      setError('Please enter your first name.');
      nameRef.current?.focus();
      return;
    }
    if (!service) {
      setError('Please choose a service.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      onJoined(await api.join(name.trim(), service));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-3xl font-extrabold text-navy-900">Join the line</h1>
        <p className="mt-2 text-lg text-muted">Save your place from your phone. We’ll alert you here when it’s your turn.</p>
      </div>

      {notice && (
        <div role="status" className="rounded-md border-l-8 border-primary bg-primary-lighter p-4 text-ink">
          {notice}
        </div>
      )}

      <div>
        <label htmlFor="name" className="mb-2 block text-lg font-bold">
          First name
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
          aria-describedby="name-hint"
        />
        <p id="name-hint" className="mt-1 text-sm text-muted">
          Only your first name — staff use it to greet you.
        </p>
      </div>

      <fieldset>
        <legend className="mb-2 text-lg font-bold">What do you need help with?</legend>
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
                  onChange={() => setService(id)}
                  className="sr-only"
                />
                <ServiceBadge code={code} size="lg" tone={selected ? 'solid' : 'light'} />
                <span className="flex-1">
                  <span className="block text-lg font-bold">{name}</span>
                  <span className="block text-sm text-muted">
                    {s
                      ? s.paused
                        ? 'Temporarily paused — you can still join'
                        : `${s.waitingCount} waiting · ${s.waitingCount === 0 ? 'No wait' : `${formatRange(s.estimate)} wait`}`
                      : ' '}
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
        <p role="alert" className="rounded-md border-l-8 border-danger-dark bg-danger-light p-4 font-semibold text-danger-dark">
          {error}
        </p>
      )}

      <button type="submit" className="btn-primary w-full min-h-[60px] text-xl" disabled={submitting}>
        {submitting ? 'Getting your ticket…' : 'Get my ticket'}
      </button>
      {office.appointments.enabled && <AppointmentLinks officeId={api.officeId} />}
    </form>
  );
}

/** "Book an appointment" link, plus a shortcut to an appointment booked on this device. */
function AppointmentLinks({ officeId }: { officeId: string }) {
  const saved = (() => {
    try {
      return localStorage.getItem(`vq.appointment.${officeId}`);
    } catch {
      return null;
    }
  })();
  return (
    <div className="rounded-md border border-muted-lighter bg-white p-4 text-center">
      <p className="text-muted">Prefer a set time?</p>
      <div className="mt-2 flex flex-wrap justify-center gap-x-6 gap-y-2">
        <Link to={`/o/${officeId}/book`} className="font-bold text-primary underline underline-offset-4">
          Book an appointment
        </Link>
        {saved && (
          <Link to={`/o/${officeId}/appointment/${saved}`} className="font-bold text-primary underline underline-offset-4">
            View my appointment
          </Link>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- waiting

function TicketNumber({ view, tone = 'light' }: { view: TicketView; tone?: 'light' | 'dark' }) {
  return (
    <div className="text-center">
      <div className={`label ${tone === 'dark' ? 'text-success-light' : ''}`}>Your ticket</div>
      <div className={`tabular mt-1 text-7xl font-extrabold tracking-tight ${tone === 'dark' ? 'text-white' : 'text-navy-900'}`}>
        {view.ticket.number}
      </div>
      <div className={`mt-1 text-lg ${tone === 'dark' ? 'text-white' : 'text-muted'}`}>{view.serviceName}</div>
      {(view.ticket.priority || view.ticket.kind === 'appointment') && (
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {view.ticket.priority && (
            <span className={`rounded-full px-3 py-1 text-sm font-bold ${tone === 'dark' ? 'bg-white/15 text-white' : 'bg-navy-900 text-white'}`}>Priority service</span>
          )}
          {view.ticket.kind === 'appointment' && view.ticket.appointmentAt && (
            <span className={`rounded-full px-3 py-1 text-sm font-bold ${tone === 'dark' ? 'bg-white/15 text-white' : 'bg-primary-light text-navy-900'}`}>
              Appointment · {formatClock(view.ticket.appointmentAt)}
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

  return (
    <div className="animate-fade-in space-y-5">
      <p className="text-xl">
        Hi <strong>{view.ticket.name}</strong>, you’re in line.
      </p>

      <section className="card overflow-hidden" aria-labelledby="ticket-heading">
        <h2 id="ticket-heading" className="sr-only">
          Your place in line
        </h2>
        <div className="border-b border-muted-lighter bg-primary-lighter px-6 py-6">
          <TicketNumber view={view} />
        </div>
        <dl className="grid grid-cols-2 divide-x divide-muted-lighter" aria-live="polite" aria-atomic="true">
          <div className="p-5 text-center">
            <dt className="label">Position</dt>
            <dd className="tabular mt-1 text-4xl font-extrabold text-navy-900">{position ?? '—'}</dd>
            <dd className="text-sm text-muted">{ahead === 0 ? 'You’re next!' : `${ahead} ${ahead === 1 ? 'person' : 'people'} ahead`}</dd>
          </div>
          <div className="p-5 text-center">
            <dt className="label">Estimated wait</dt>
            <dd className="mt-1 text-2xl font-extrabold leading-10 text-navy-900">
              {ahead === 0 ? 'Any moment' : formatRange(estimate).replace('About ', '~')}
            </dd>
            <dd className="text-sm text-muted">{ahead === 0 ? 'updates live' : 'likely range · updates live'}</dd>
          </div>
        </dl>
      </section>

      <AlertsOptIn officeId={api.officeId} target={{ kind: 'ticket', id: view.ticket.id }} />

      {view.servicePaused && (
        <div role="status" className="rounded-md border-l-8 border-warning bg-warning-light p-4">
          <p className="font-bold">This line is briefly paused.</p>
          <p>You’ll keep your place. Staff will resume calling shortly.</p>
        </div>
      )}

      <div className="rounded-md bg-white p-4 text-muted">
        <p>
          <strong className="text-ink">Keep this page open</strong> (or turn on alerts above). Your phone will chime when it’s your turn. You can safely refresh — your
          ticket is saved on this device.
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
            <SpeakerIcon /> Turn on sound alerts
          </button>
        )}
      </div>

      <LeaveButton api={api} ticketId={view.ticket.id} onLeft={onLeft} />
    </div>
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

  const leave = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.leave(ticketId);
      onLeft();
    } catch (err) {
      // Already gone (served / left elsewhere): treat as left.
      if (err instanceof ApiError && (err.code === 'not_active' || err.code === 'not_found')) onLeft();
      else setError(err instanceof ApiError ? err.message : 'Could not leave the line. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <button type="button" className={tone === 'dark' ? 'btn w-full border-2 border-white/70 text-white hover:bg-white/10' : 'btn-danger-outline w-full'} onClick={() => setConfirming(true)}>
        Leave the line
      </button>
    );
  }
  return (
    <div className="card animate-fade-in p-4 text-ink" role="alertdialog" aria-labelledby="leave-q">
      <p id="leave-q" className="text-lg font-bold">
        Leave the line?
      </p>
      <p className="text-muted">You’ll lose your place and need a new ticket to rejoin.</p>
      {error && (
        <p role="alert" className="mt-2 font-semibold text-danger-dark">
          {error}
        </p>
      )}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <button type="button" className="btn-secondary" onClick={() => setConfirming(false)} disabled={busy} autoFocus>
          Keep my place
        </button>
        <button type="button" className="btn bg-danger-dark text-white hover:bg-danger" onClick={leave} disabled={busy}>
          {busy ? 'Leaving…' : 'Yes, leave'}
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
      document.title = on ? '🔔 It’s your turn!' : original;
      on = !on;
    }, 1000);
    return () => {
      clearInterval(id);
      document.title = original;
    };
  }, []);

  return (
    <div className="animate-fade-in space-y-6 text-white" role="alert" aria-live="assertive">
      <div className="mx-auto mt-2 flex h-24 w-24 animate-pulse-ring items-center justify-center rounded-full bg-success text-white">
        <svg viewBox="0 0 24 24" className="h-12 w-12" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      </div>
      <div className="text-center">
        <h1 ref={headingRef} tabIndex={-1} className="text-4xl font-extrabold outline-none">
          It’s your turn
        </h1>
        <p className="mt-3 text-2xl">Please go to</p>
        <p className="mt-1 break-words text-6xl font-extrabold">{view.counterName}</p>
        {view.ticket.recallCount > 0 && <p className="mt-3 text-lg font-semibold text-success-light">Staff are calling you again — please come now.</p>}
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
          <SpeakerIcon /> Play alert sound
        </button>
      )}
      <LeaveButton api={api} ticketId={view.ticket.id} onLeft={onLeft} tone="dark" />
    </div>
  );
}

// ------------------------------------------------------------------ finished

function Finished({ view, onDone }: { view: TicketView; onDone: () => void }) {
  const served = view.ticket.status === 'served';
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
      <h1 className="text-3xl font-extrabold text-navy-900">{served ? 'You’re all set' : 'We missed you'}</h1>
      <p className="text-lg text-muted">
        {served
          ? `Thank you for visiting, ${view.ticket.name}. Ticket ${view.ticket.number} is complete.`
          : `We called ticket ${view.ticket.number} but didn’t see you at the counter. You can join the line again, or ask at the front desk.`}
      </p>
      <button type="button" className="btn-primary w-full" onClick={onDone}>
        {served ? 'Done' : 'Join the line again'}
      </button>
    </div>
  );
}
