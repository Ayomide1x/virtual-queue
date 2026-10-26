import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ConnectionBanner, LiveDot } from '../components/ConnectionStatus';
import { Header } from '../components/Header';
import { OfficeGate } from '../components/OfficeGate';
import { ServiceBadge } from '../components/ServiceBadge';
import { StaffGate } from '../components/StaffGate';
import { ApiError, officeApi } from '../lib/api';
import { useNow } from '../lib/clock';
import { formatClock, formatElapsed, formatMinutes, formatRangeShort } from '../lib/format';
import { rememberOffice } from '../lib/myOffices';
import { useChannel } from '../lib/socket';
import { useOfficeId } from '../lib/useOffice';
import { useTitle } from '../lib/useTitle';
import { PRIORITY_LABELS, PRIORITY_REASONS, type CounterState, type PriorityReason, type ServiceState, type StaffState, type WaitingEntry } from '../types';

type Api = ReturnType<typeof officeApi>;

function counterStorage(officeId: string) {
  const key = `vq.staffCounter.${officeId}`;
  return {
    get: (): number | null => {
      try {
        const n = Number(localStorage.getItem(key));
        return Number.isInteger(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    },
    set: (n: number | null) => {
      try {
        if (n) localStorage.setItem(key, String(n));
        else localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

export default function Staff() {
  const officeId = useOfficeId();
  return (
    <OfficeGate officeId={officeId}>
      {(data) => (
        <StaffGate officeId={officeId} officeName={data.office.name} title="Staff Console">
          {(staffKey, onForbidden) => <StaffScreen key={officeId} officeId={officeId} staffKey={staffKey} onForbidden={onForbidden} initialName={data.office.name} />}
        </StaffGate>
      )}
    </OfficeGate>
  );
}

function StaffScreen({ officeId, staffKey, onForbidden, initialName }: { officeId: string; staffKey: string; onForbidden: () => void; initialName: string }) {
  const storage = counterStorage(officeId);
  const api = officeApi(officeId);
  const [counter, setCounterState] = useState<number | null>(storage.get);
  const { data: state, error } = useChannel<StaffState>({ officeId, role: 'staff', staffKey }, 'staff:state');
  const officeName = state?.office.name ?? initialName;
  useTitle(`Staff Console — ${officeName}`);

  useEffect(() => {
    if (error === 'forbidden') onForbidden();
  }, [error, onForbidden]);
  useEffect(() => {
    rememberOffice(officeId, officeName);
  }, [officeId, officeName]);

  const setCounter = (n: number | null) => {
    storage.set(n);
    setCounterState(n);
  };

  const mine = state?.counters.find((c) => c.counter === counter);
  const validCounter = state ? (mine ? counter : null) : counter;

  return (
    <div className="min-h-screen">
      <Header title="Staff Console" office={officeName}>
        <nav className="flex items-center gap-2 sm:gap-4" aria-label="Staff">
          <LiveDot light />
          <Link to={`/o/${officeId}/display`} target="_blank" className="hidden rounded px-2 py-1 text-sm font-semibold text-white/90 underline-offset-4 hover:underline md:inline">
            Lobby display ↗
          </Link>
          <Link to={`/o/${officeId}/appointments`} className="rounded px-2 py-1 text-sm font-semibold text-white/90 underline-offset-4 hover:underline">
            Appointments
          </Link>
          <Link to={`/o/${officeId}/analytics`} className="rounded px-2 py-1 text-sm font-semibold text-white/90 underline-offset-4 hover:underline">
            Analytics
          </Link>
          <Link to={`/o/${officeId}/settings`} className="rounded px-2 py-1 text-sm font-semibold text-white/90 underline-offset-4 hover:underline">
            Settings
          </Link>
          {validCounter && mine && (
            <button type="button" onClick={() => setCounter(null)} className="btn min-h-[40px] border border-white/40 px-3 py-1.5 text-sm text-white hover:bg-white/10">
              {mine.name} · Change
            </button>
          )}
        </nav>
      </Header>
      <ConnectionBanner />
      {state && !state.office.status.open && (
        <div role="status" className="border-b border-warning bg-warning-light px-4 py-2 text-center font-semibold">
          {state.office.status.message ?? 'Joining is closed.'} You can still serve people already in line.
        </div>
      )}
      {!state ? (
        <div className="p-10 text-center text-lg text-muted" role="status">
          Loading queue…
        </div>
      ) : !validCounter ? (
        <CounterPicker state={state} onPick={setCounter} />
      ) : (
        <Console api={api} officeId={officeId} counter={validCounter} state={state} />
      )}
    </div>
  );
}

function CounterPicker({ state, onPick }: { state: StaffState; onPick: (n: number) => void }) {
  return (
    <main id="main" tabIndex={-1} className="outline-none mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-extrabold text-navy-900">Which counter are you at?</h1>
      <p className="mt-2 text-lg text-muted">You can change this at any time.</p>
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {state.counters.map((c) => (
          <button
            key={c.counter}
            type="button"
            onClick={() => onPick(c.counter)}
            className="card flex min-h-[110px] flex-col items-center justify-center gap-1 p-4 text-center hover:border-primary hover:bg-primary-lighter"
          >
            <span className="break-words text-2xl font-extrabold text-navy-900">{c.name}</span>
            <span className="text-sm text-muted">{c.ticket ? `Serving ${c.ticket.number}` : 'Available'}</span>
          </button>
        ))}
      </div>
    </main>
  );
}

type Feedback = { kind: 'success' | 'error' | 'info'; text: string; at: number };

function Console({ api, officeId, counter, state }: { api: Api; officeId: string; counter: number; state: StaffState }) {
  const now = useNow(1000);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [callFrom, setCallFrom] = useState<string>('any');
  const mine = state.counters.find((c) => c.counter === counter);
  const current = mine?.ticket ?? null;

  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), feedback.kind === 'error' ? 7000 : 4000);
    return () => clearTimeout(t);
  }, [feedback]);

  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>, success: (r: any) => string) => {
      if (busy) return;
      setBusy(label);
      try {
        const r = await fn();
        setFeedback({ kind: 'success', text: success(r), at: Date.now() });
      } catch (err) {
        const text = err instanceof ApiError ? err.message : 'Something went wrong.';
        setFeedback({ kind: err instanceof ApiError && err.code === 'empty' ? 'info' : 'error', text, at: Date.now() });
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const callNext = (service?: string) =>
    act('call', () => api.callNext(counter, service), (t) => `Called ${t.number} (${t.name}) to ${t.counterName}.`);
  const served = () => current && act('served', () => api.served(counter, current.number), (t) => `${t.number} marked served.`);
  const noShow = () => current && act('noshow', () => api.noShow(counter, current.number), (t) => `${t.number} marked as no-show.`);
  const recall = () => current && act('recall', () => api.recall(counter), (t) => `Recalled ${t.number}.`);

  // Keyboard shortcuts for fast counter work. They can be turned off, since
  // single-letter keys clash with screen reader commands (WCAG 2.1.4).
  const [shortcuts, setShortcutsState] = useState(() => {
    try {
      return localStorage.getItem('vq.staffShortcuts') !== 'off';
    } catch {
      return true;
    }
  });
  const setShortcuts = (on: boolean) => {
    setShortcutsState(on);
    try {
      localStorage.setItem('vq.staffShortcuts', on ? 'on' : 'off');
    } catch {
      /* not remembered */
    }
  };
  const handlers = useRef({ callNext, served, noShow, recall, callFrom, current, shortcuts });
  handlers.current = { callNext, served, noShow, recall, callFrom, current, shortcuts };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !handlers.current.shortcuts) return;
      const el = e.target as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable) return;
      const h = handlers.current;
      const key = e.key.toLowerCase();
      if (key === 'n' && !h.current) void h.callNext(h.callFrom === 'any' ? undefined : h.callFrom);
      else if (key === 's') void h.served();
      else if (key === 'x') void h.noShow();
      else if (key === 'r') void h.recall();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const callableServices = state.services.filter((s) => !s.paused && s.waitingCount > 0);
  const selectedService = callFrom === 'any' ? null : (state.services.find((s) => s.id === callFrom) ?? null);
  const canCall = !current && (selectedService ? !selectedService.paused && selectedService.waitingCount > 0 : callableServices.length > 0);
  const callHint = current
    ? 'Finish the current resident first.'
    : selectedService?.paused
      ? `${selectedService.name} is paused.`
      : selectedService && selectedService.waitingCount === 0
        ? `No one is waiting for ${selectedService.name}.`
        : !selectedService && callableServices.length === 0
          ? state.totals.waiting > 0
            ? 'All lines with people waiting are paused.'
            : 'No one is waiting.'
          : null;

  return (
    <main id="main" tabIndex={-1} className="outline-none mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-12">
      {/* Counter panel */}
      <section className="space-y-4 lg:col-span-4" aria-labelledby="counter-heading">
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-muted-lighter bg-navy-900 px-5 py-3 text-white">
            <h1 id="counter-heading" className="truncate text-lg font-bold">
              {mine?.name}
            </h1>
            <span className="text-sm text-primary-light">{current ? 'Serving' : 'Available'}</span>
          </div>

          <div className="p-5" aria-live="polite">
            {current ? (
              <div className="text-center">
                <div className="label">Now serving</div>
                <div className="tabular text-6xl font-extrabold text-navy-900">{current.number}</div>
                <div className="mt-1 text-2xl font-bold">{current.name}</div>
                <div className="mt-1 text-muted">{state.services.find((s) => s.id === current.service)?.name ?? 'Service'}</div>
                <div className="tabular mt-3 inline-block rounded-full bg-muted-lightest px-3 py-1 text-sm font-semibold text-muted">
                  At counter {formatElapsed(now - current.calledAt)}
                  {current.recallCount > 0 && ` · recalled ${current.recallCount}×`}
                </div>
              </div>
            ) : (
              <div className="py-4 text-center">
                <div className="text-xl font-bold text-navy-900">Ready for the next resident</div>
                {mine?.last && (
                  <p className={`mt-2 text-sm ${mine.last.outcome === 'left' ? 'font-semibold text-danger-dark' : 'text-muted'}`}>
                    {mine.last.outcome === 'left'
                      ? `${mine.last.number} left the line before reaching the counter.`
                      : `Last: ${mine.last.number} — ${mine.last.outcome === 'served' ? 'served' : 'no-show'}`}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3 border-t border-muted-lighter bg-muted-lightest/60 p-5">
            <div className="flex gap-2">
              <label htmlFor="call-from" className="sr-only">
                Call next from
              </label>
              <select
                id="call-from"
                value={callFrom}
                onChange={(e) => setCallFrom(e.target.value)}
                className="min-h-[48px] flex-1 rounded-md border-2 border-muted-light bg-white px-3 font-semibold"
              >
                <option value="any">Any line (longest wait)</option>
                {state.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.waitingCount})
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn-primary w-full min-h-[60px] text-xl"
              disabled={!canCall || !!busy}
              onClick={() => callNext(callFrom === 'any' ? undefined : callFrom)}
              aria-keyshortcuts={shortcuts ? 'N' : undefined}
            >
              {busy === 'call' ? 'Calling…' : 'Call Next'}
              {shortcuts && <Kbd>N</Kbd>}
            </button>
            {callHint && <p className="text-center text-sm text-muted">{callHint}</p>}
            <button type="button" className="btn-success w-full" disabled={!current || !!busy} onClick={served} aria-keyshortcuts={shortcuts ? 'S' : undefined}>
              Mark Served {shortcuts && <Kbd>S</Kbd>}
            </button>
            <div className="grid grid-cols-2 gap-3">
              <button type="button" className="btn-danger-outline px-3" disabled={!current || !!busy} onClick={noShow} aria-keyshortcuts={shortcuts ? 'X' : undefined}>
                No-Show {shortcuts && <Kbd>X</Kbd>}
              </button>
              <button type="button" className="btn-outline px-3" disabled={!current || !!busy} onClick={recall} aria-keyshortcuts={shortcuts ? 'R' : undefined}>
                Recall {shortcuts && <Kbd>R</Kbd>}
              </button>
            </div>
            {/* One live region that is always present, so every message gets announced. */}
            <div role="status" aria-live="polite">
              {feedback && (
                <div
                  key={feedback.at}
                  className={`animate-fade-in rounded-md border-l-8 p-4 font-semibold ${
                    feedback.kind === 'success'
                      ? 'border-success-dark bg-success-light text-success-darker'
                      : feedback.kind === 'info'
                        ? 'border-primary bg-primary-lighter text-navy-900'
                        : 'border-danger-dark bg-danger-light text-danger-dark'
                  }`}
                >
                  {feedback.text}
                </div>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={shortcuts} onChange={(e) => setShortcuts(e.target.checked)} className="h-5 w-5 accent-primary" />
              Keyboard shortcuts (N, S, X, R)
            </label>
          </div>
        </div>

        <AllCounters counters={state.counters} mine={counter} now={now} />
      </section>

      {/* Queues & stats */}
      <section className="space-y-6 lg:col-span-8" aria-label="Queues">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="People waiting" value={String(state.totals.waiting)} />
          <Stat label="Served today" value={String(state.totals.servedToday)} />
          <Stat label="Average wait" value={formatMinutes(state.totals.avgWaitSec)} />
          <Stat label="No-shows today" value={String(state.totals.noShowToday)} />
        </dl>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {state.services.map((s) => (
            <ServiceQueue key={s.id} api={api} service={s} now={now} canCall={!current && !busy} onCall={() => callNext(s.id)} onError={(text) => setFeedback({ kind: 'error', text, at: Date.now() })} />
          ))}
        </div>

        <SampleDataControls api={api} officeId={officeId} onDone={(text) => setFeedback({ kind: 'success', text, at: Date.now() })} />
      </section>
    </main>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="ml-1 hidden rounded border border-current px-1.5 py-0.5 font-sans text-xs font-semibold opacity-70 lg:inline" aria-hidden="true">
      {children}
    </kbd>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card px-4 py-3">
      <dt className="label text-xs">{label}</dt>
      <dd className="tabular mt-1 text-3xl font-extrabold text-navy-900">{value}</dd>
    </div>
  );
}

function ServiceQueue({ api, service, now, canCall, onCall, onError }: { api: Api; service: ServiceState; now: number; canCall: boolean; onCall: () => void; onError: (msg: string) => void }) {
  const [toggling, setToggling] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const toggle = async () => {
    setToggling(true);
    try {
      await (service.paused ? api.resume(service.id) : api.pause(service.id));
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not update the line.');
    } finally {
      setToggling(false);
    }
  };

  return (
    <article className={`card flex flex-col ${service.paused ? 'border-warning ring-1 ring-warning' : ''}`} aria-labelledby={`svc-${service.id}`}>
      <header className="border-b border-muted-lighter p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 id={`svc-${service.id}`} className="flex items-center gap-2 text-lg font-bold leading-tight text-navy-900">
            <ServiceBadge code={service.code} size="sm" />
            {service.name}
          </h2>
          <span className="tabular rounded-full bg-primary-lighter px-2.5 py-0.5 text-sm font-bold text-primary-dark">{service.waitingCount}</span>
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 text-center text-xs">
          <div>
            <dt className="text-muted">Avg service</dt>
            <dd className="tabular text-base font-bold">{formatMinutes(service.avgServiceSec)}</dd>
          </div>
          <div>
            <dt className="text-muted">Avg wait</dt>
            <dd className="tabular text-base font-bold">{formatMinutes(service.avgWaitSec)}</dd>
          </div>
          <div>
            <dt className="text-muted">Served</dt>
            <dd className="tabular text-base font-bold">{service.servedToday}</dd>
          </div>
          <div>
            <dt className="text-muted" title="Counters that called from this line in the last 30 minutes">
              Counters
            </dt>
            <dd className="tabular text-base font-bold">{service.activeCounters ? Number(service.activeCounters.toFixed(1)) : '—'}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted">Wait if joining now</dt>
            <dd className="tabular text-base font-bold">{service.waitingCount ? formatRangeShort(service.estimate) : 'No wait'}</dd>
          </div>
        </dl>
        {service.paused && (
          <p className="mt-3 rounded bg-warning-light px-2 py-1 text-center text-sm font-bold text-ink" role="status">
            Line paused — not calling
          </p>
        )}
      </header>

      <ol className="max-h-[360px] flex-1 divide-y divide-muted-lighter overflow-y-auto" aria-label={`${service.name} queue`}>
        {service.waiting.length === 0 && <li className="p-6 text-center text-muted">No one waiting</li>}
        {service.waiting.map((w, i) => (
          <WaitingRow
            key={w.number}
            api={api}
            entry={w}
            position={i + 1}
            now={now}
            open={menuFor === w.number}
            onToggle={() => setMenuFor((m) => (m === w.number ? null : w.number))}
            onDone={() => setMenuFor(null)}
            onError={onError}
          />
        ))}
      </ol>

      <footer className="grid grid-cols-2 gap-2 border-t border-muted-lighter p-3">
        <button type="button" className="btn-outline min-h-[44px] px-2 py-2 text-sm" disabled={!canCall || service.paused || service.waitingCount === 0} onClick={onCall}>
          Call from line
        </button>
        <button type="button" className={`btn min-h-[44px] px-2 py-2 text-sm border-2 ${service.paused ? 'border-success-dark bg-success-dark text-white hover:bg-success-darker' : 'border-muted-light bg-white text-ink hover:bg-muted-lightest'}`} onClick={toggle} disabled={toggling} aria-pressed={service.paused}>
          {service.paused ? 'Resume line' : 'Pause line'}
        </button>
      </footer>
    </article>
  );
}

function WaitingRow({
  api,
  entry: w,
  position,
  now,
  open,
  onToggle,
  onDone,
  onError,
}: {
  api: Api;
  entry: WaitingEntry;
  position: number;
  now: number;
  open: boolean;
  onToggle: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = `priority-${w.number}`;
  // Keyboard: opening moves focus into the options; Escape closes and returns focus.
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [open]);
  const close = () => {
    onToggle();
    toggleRef.current?.focus();
  };
  const set = async (reason: PriorityReason | null) => {
    setBusy(true);
    try {
      await api.setPriority(w.number, reason);
      onDone();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not update priority.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={w.priority ? 'bg-primary-lighter/60' : ''}>
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className="tabular w-5 shrink-0 text-right text-sm text-muted">{position}</span>
        <span className="tabular w-14 shrink-0 font-bold text-navy-900">{w.number}</span>
        <span className="min-w-0 flex-1 truncate" title={w.name}>{w.name}</span>
        <span className={`tabular shrink-0 text-sm ${now - w.joinedAt > 20 * 60_000 ? 'font-bold text-danger-dark' : 'text-muted'}`} title="Time waiting">
          {formatElapsed(now - w.joinedAt)}
        </span>
        <button
          ref={toggleRef}
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={`Priority options for ${w.number}`}
          title="Priority"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded border ${w.priority ? 'border-navy-900 bg-navy-900 text-white' : 'border-muted-lighter text-muted hover:border-primary hover:text-primary'}`}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill={w.priority ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinejoin="round" aria-hidden="true">
            <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
          </svg>
        </button>
      </div>
      {(w.priority || w.kind === 'appointment') && (
        <div className="-mt-1.5 flex flex-wrap gap-1 pb-2 pl-[5.25rem] pr-4">
          {w.priority && <span className="whitespace-nowrap rounded bg-navy-900 px-1.5 py-0.5 text-[11px] font-bold text-white">Priority · {PRIORITY_LABELS[w.priority]}</span>}
          {w.kind === 'appointment' && w.appointmentAt && (
            <span className="whitespace-nowrap rounded bg-primary-light px-1.5 py-0.5 text-[11px] font-bold text-navy-900">Appt {formatClock(w.appointmentAt)}</span>
          )}
        </div>
      )}
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="group"
          aria-label={`Priority for ${w.number}`}
          className="animate-fade-in border-t border-muted-lighter bg-muted-lightest px-4 py-3"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          <p className="mb-2 text-sm font-semibold">{w.priority ? `Priority: ${PRIORITY_LABELS[w.priority]}. Change or remove:` : `Give ${w.number} priority because:`}</p>
          <div className="flex flex-wrap gap-2">
            {PRIORITY_REASONS.filter((r) => r !== w.priority).map((r) => (
              <button key={r} type="button" className="btn-outline min-h-[36px] px-3 py-1 text-sm" disabled={busy} onClick={() => set(r)}>
                {PRIORITY_LABELS[r]}
              </button>
            ))}
            {w.priority && (
              <button type="button" className="btn-danger-outline min-h-[36px] px-3 py-1 text-sm" disabled={busy} onClick={() => set(null)}>
                Remove priority
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function AllCounters({ counters, mine, now }: { counters: CounterState[]; mine: number; now: number }) {
  return (
    <div className="card p-4">
      <h2 className="label mb-3">All counters</h2>
      <ul className="grid grid-cols-2 gap-2">
        {counters.map((c) => (
          <li key={c.counter} className={`rounded-md border px-3 py-2 ${c.counter === mine ? 'border-primary bg-primary-lighter' : 'border-muted-lighter'}`}>
            <div className="truncate text-xs font-semibold text-muted">{c.name}</div>
            {c.ticket ? (
              <div className="flex items-baseline justify-between">
                <span className="tabular font-bold text-navy-900">{c.ticket.number}</span>
                <span className="tabular text-xs text-muted">{formatElapsed(now - c.ticket.calledAt)}</span>
              </div>
            ) : (
              <div className="text-sm text-muted">Available</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SampleDataControls({ api, officeId, onDone }: { api: Api; officeId: string; onDone: (msg: string) => void }) {
  const [confirm, setConfirm] = useState<'seed' | 'reset' | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      if (confirm === 'seed') await api.seed();
      else await api.reset();
      onDone(confirm === 'seed' ? 'Sample residents loaded.' : 'All queues cleared.');
    } catch (err) {
      onDone(err instanceof ApiError ? err.message : 'That didn’t work. Please try again.');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  return (
    <details className="rounded-lg border border-dashed border-muted-light bg-white/60 p-4 text-sm">
      <summary className="cursor-pointer font-semibold text-muted">Sample data</summary>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {confirm ? (
          <>
            <span className="font-semibold">{confirm === 'seed' ? 'Replace all queues with sample residents?' : 'Clear every queue and today’s stats?'}</span>
            <button type="button" className="btn-primary min-h-[40px] py-2" onClick={run} disabled={busy}>
              {busy ? 'Working…' : 'Yes, continue'}
            </button>
            <button type="button" className="btn-secondary min-h-[40px] py-2" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn-secondary min-h-[40px] py-2" onClick={() => setConfirm('seed')}>
              Load sample residents
            </button>
            <button type="button" className="btn-secondary min-h-[40px] py-2" onClick={() => setConfirm('reset')}>
              Clear all queues
            </button>
            <Link to={`/o/${officeId}/display`} target="_blank" className="font-semibold text-primary underline">
              Open lobby display ↗
            </Link>
            <span className="text-muted">Shortcuts: N call · S served · X no-show · R recall</span>
          </>
        )}
      </div>
    </details>
  );
}
