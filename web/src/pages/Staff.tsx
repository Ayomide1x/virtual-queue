import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ConnectionBanner, LiveDot } from '../components/ConnectionStatus';
import { Header } from '../components/Header';
import { ServiceIcon } from '../components/ServiceIcon';
import { ApiError, api } from '../lib/api';
import { useNow } from '../lib/clock';
import { formatElapsed, formatMinutes } from '../lib/format';
import { useChannel } from '../lib/socket';
import { useConfig } from '../lib/useConfig';
import type { CounterState, ServiceId, ServiceState, StaffState } from '../types';

const COUNTER_KEY = 'vq.staffCounter';

function readCounter(): number | null {
  try {
    const n = Number(localStorage.getItem(COUNTER_KEY));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export default function Staff() {
  const config = useConfig();
  const [counter, setCounterState] = useState<number | null>(readCounter);
  const state = useChannel<StaffState>({ role: 'staff' }, 'staff:state');

  const setCounter = (n: number | null) => {
    try {
      if (n) localStorage.setItem(COUNTER_KEY, String(n));
      else localStorage.removeItem(COUNTER_KEY);
    } catch {
      /* ignore */
    }
    setCounterState(n);
  };

  const totalCounters = config?.counters ?? state?.counters.length ?? 6;
  const validCounter = counter && counter <= totalCounters ? counter : null;

  return (
    <div className="min-h-screen">
      <Header title="Staff Console">
        <div className="flex items-center gap-4">
          <LiveDot light />
          {validCounter && (
            <button type="button" onClick={() => setCounter(null)} className="btn min-h-[40px] border border-white/40 px-3 py-1.5 text-sm text-white hover:bg-white/10">
              Counter {validCounter} · Change
            </button>
          )}
        </div>
      </Header>
      <ConnectionBanner />
      {!validCounter ? (
        <CounterPicker total={totalCounters} state={state} onPick={setCounter} />
      ) : !state ? (
        <div className="p-10 text-center text-lg text-muted" role="status">
          Loading queue…
        </div>
      ) : (
        <Console counter={validCounter} state={state} />
      )}
    </div>
  );
}

function CounterPicker({ total, state, onPick }: { total: number; state: StaffState | null; onPick: (n: number) => void }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-extrabold text-navy-900">Which counter are you at?</h1>
      <p className="mt-2 text-lg text-muted">You can change this at any time.</p>
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
          const c = state?.counters.find((x) => x.counter === n);
          return (
            <button key={n} type="button" onClick={() => onPick(n)} className="card flex min-h-[110px] flex-col items-center justify-center gap-1 p-4 text-center hover:border-primary hover:bg-primary-lighter">
              <span className="label">Counter</span>
              <span className="text-4xl font-extrabold text-navy-900">{n}</span>
              <span className="text-sm text-muted">{c?.ticket ? `Serving ${c.ticket.number}` : 'Available'}</span>
            </button>
          );
        })}
      </div>
    </main>
  );
}

type Feedback = { kind: 'success' | 'error' | 'info'; text: string; at: number };

function Console({ counter, state }: { counter: number; state: StaffState }) {
  const now = useNow(1000);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [callFrom, setCallFrom] = useState<ServiceId | 'any'>('any');
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

  const callNext = (service?: ServiceId) =>
    act('call', () => api.callNext(counter, service), (t) => `Called ${t.number} (${t.name}) to Counter ${counter}.`);
  const served = () => current && act('served', () => api.served(counter, current.number), (t) => `${t.number} marked served.`);
  const noShow = () => current && act('noshow', () => api.noShow(counter, current.number), (t) => `${t.number} marked as no-show.`);
  const recall = () => current && act('recall', () => api.recall(counter), (t) => `Recalled ${t.number}.`);

  // Keyboard shortcuts for fast counter work.
  const handlers = useRef({ callNext, served, noShow, recall, callFrom, current });
  handlers.current = { callNext, served, noShow, recall, callFrom, current };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
  const selectedService = callFrom === 'any' ? null : state.services.find((s) => s.id === callFrom);
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
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-12">
      {/* Counter panel */}
      <section className="space-y-4 lg:col-span-4" aria-labelledby="counter-heading">
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-muted-lighter bg-navy-900 px-5 py-3 text-white">
            <h1 id="counter-heading" className="text-lg font-bold">
              Counter {counter}
            </h1>
            <span className="text-sm text-primary-light">{current ? 'Serving' : 'Available'}</span>
          </div>

          <div className="p-5" aria-live="polite">
            {current ? (
              <div className="text-center">
                <div className="label">Now serving</div>
                <div className="tabular text-6xl font-extrabold text-navy-900">{current.number}</div>
                <div className="mt-1 text-2xl font-bold">{current.name}</div>
                <div className="mt-1 flex items-center justify-center gap-2 text-muted">
                  <ServiceIcon service={current.service} className="h-5 w-5" />
                  {state.services.find((s) => s.id === current.service)?.name}
                </div>
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
                onChange={(e) => setCallFrom(e.target.value as ServiceId | 'any')}
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
              aria-keyshortcuts="N"
            >
              {busy === 'call' ? 'Calling…' : 'Call Next'}
              <Kbd>N</Kbd>
            </button>
            {callHint && <p className="text-center text-sm text-muted">{callHint}</p>}
            <button type="button" className="btn-success w-full" disabled={!current || !!busy} onClick={served} aria-keyshortcuts="S">
              Mark Served <Kbd>S</Kbd>
            </button>
            <div className="grid grid-cols-2 gap-3">
              <button type="button" className="btn-danger-outline px-3" disabled={!current || !!busy} onClick={noShow} aria-keyshortcuts="X">
                No-Show <Kbd>X</Kbd>
              </button>
              <button type="button" className="btn-outline px-3" disabled={!current || !!busy} onClick={recall} aria-keyshortcuts="R">
                Recall <Kbd>R</Kbd>
              </button>
            </div>
            <div aria-live="polite">
              {feedback && (
                <div
                  key={feedback.at}
                  role={feedback.kind === 'error' ? 'alert' : 'status'}
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

        <div className="grid gap-4 md:grid-cols-3">
          {state.services.map((s) => (
            <ServiceQueue key={s.id} service={s} now={now} canCall={!current && !busy} onCall={() => callNext(s.id)} onError={(text) => setFeedback({ kind: 'error', text, at: Date.now() })} />
          ))}
        </div>

        <DemoControls onDone={(text) => setFeedback({ kind: 'success', text, at: Date.now() })} />
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

function ServiceQueue({ service, now, canCall, onCall, onError }: { service: ServiceState; now: number; canCall: boolean; onCall: () => void; onError: (msg: string) => void }) {
  const [toggling, setToggling] = useState(false);
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
            <ServiceIcon service={service.id} className="h-6 w-6 shrink-0 text-primary" />
            {service.name}
          </h2>
          <span className="tabular rounded-full bg-primary-lighter px-2.5 py-0.5 text-sm font-bold text-primary-dark">{service.waitingCount}</span>
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
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
          <li key={w.number} className="flex items-center gap-3 px-4 py-2.5">
            <span className="tabular w-5 text-right text-sm text-muted">{i + 1}</span>
            <span className="tabular w-16 font-bold text-navy-900">{w.number}</span>
            <span className="flex-1 truncate">{w.name}</span>
            <span className={`tabular text-sm ${now - w.joinedAt > 20 * 60_000 ? 'font-bold text-danger-dark' : 'text-muted'}`} title="Time waiting">
              {formatElapsed(now - w.joinedAt)}
            </span>
          </li>
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

function AllCounters({ counters, mine, now }: { counters: CounterState[]; mine: number; now: number }) {
  return (
    <div className="card p-4">
      <h2 className="label mb-3">All counters</h2>
      <ul className="grid grid-cols-2 gap-2">
        {counters.map((c) => (
          <li key={c.counter} className={`rounded-md border px-3 py-2 ${c.counter === mine ? 'border-primary bg-primary-lighter' : 'border-muted-lighter'}`}>
            <div className="text-xs font-semibold text-muted">Counter {c.counter}</div>
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

function DemoControls({ onDone }: { onDone: (msg: string) => void }) {
  const [confirm, setConfirm] = useState<'seed' | 'reset' | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      if (confirm === 'seed') await api.seed();
      else await api.reset();
      onDone(confirm === 'seed' ? 'Sample residents loaded.' : 'All queues cleared.');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  return (
    <details className="rounded-lg border border-dashed border-muted-light bg-white/60 p-4 text-sm">
      <summary className="cursor-pointer font-semibold text-muted">Demo tools</summary>
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
            <Link to="/display" target="_blank" className="font-semibold text-primary underline">
              Open lobby display ↗
            </Link>
            <span className="text-muted">Shortcuts: N call · S served · X no-show · R recall</span>
          </>
        )}
      </div>
    </details>
  );
}
