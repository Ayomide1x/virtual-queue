import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ConnectionBanner, LiveDot } from '../components/ConnectionStatus';
import { Header } from '../components/Header';
import { OfficeGate } from '../components/OfficeGate';
import { StaffGate } from '../components/StaffGate';
import { ApiError, officeApi } from '../lib/api';
import { formatHHMM } from '../lib/format';
import { useChannel } from '../lib/socket';
import { useOfficeId } from '../lib/useOffice';
import { useTitle } from '../lib/useTitle';
import type { AppointmentStatus, DayView, DayViewEntry, StaffState } from '../types';

const STATUS: Record<AppointmentStatus, { label: string; cls: string }> = {
  booked: { label: 'Booked', cls: 'bg-primary-lighter text-primary-dark' },
  checked_in: { label: 'Checked in', cls: 'bg-success-light text-success-darker' },
  missed: { label: 'Missed', cls: 'bg-warning-light text-ink' },
  cancelled: { label: 'Cancelled', cls: 'bg-muted-lightest text-muted line-through' },
};

const TICKET_STATUS: Record<string, string> = {
  waiting: 'waiting',
  called: 'at a counter now',
  served: 'served',
  no_show: 'no-show',
  left: 'left the line',
};

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export default function StaffAppointments() {
  const officeId = useOfficeId();
  return (
    <OfficeGate officeId={officeId}>
      {(data) => (
        <StaffGate officeId={officeId} officeName={data.office.name} title="Appointments">
          {(staffKey, onForbidden) => <DayScreen key={officeId} officeId={officeId} staffKey={staffKey} onForbidden={onForbidden} officeName={data.office.name} />}
        </StaffGate>
      )}
    </OfficeGate>
  );
}

function DayScreen({ officeId, staffKey, onForbidden, officeName }: { officeId: string; staffKey: string; onForbidden: () => void; officeName: string }) {
  useTitle(`Appointments — ${officeName}`);
  const api = useMemo(() => officeApi(officeId), [officeId]);
  const [date, setDate] = useState<string | null>(null);
  const [day, setDay] = useState<DayView | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Any change in the office (bookings, check-ins, calls) arrives on the staff channel.
  const { data: live, error } = useChannel<StaffState>({ officeId, role: 'staff', staffKey }, 'staff:state');

  useEffect(() => {
    if (error === 'forbidden') onForbidden();
  }, [error, onForbidden]);

  const load = useCallback(
    (d: string | null) =>
      api
        .dayView(d ?? undefined)
        .then((v) => {
          setDay(v);
          setDate(v.date);
        })
        .catch((err) => setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not load appointments.' })),
    [api],
  );

  useEffect(() => {
    void load(date);
    const id = setInterval(() => void load(date), 30_000);
    return () => clearInterval(id);
  }, [date, load, live?.serverNow]);

  const act = async (entry: DayViewEntry, action: 'checkin' | 'cancel') => {
    setBusyId(entry.id);
    setMessage(null);
    try {
      if (action === 'checkin') {
        await api.checkIn(entry.id);
        setMessage({ kind: 'success', text: `${entry.name} (${entry.ref}) is checked in and in line.` });
      } else {
        await api.cancelAppointment(entry.id);
        setMessage({ kind: 'success', text: `Cancelled ${entry.name}’s ${formatHHMM(entry.time)} appointment.` });
      }
      await load(date);
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'That didn’t work.' });
      await load(date);
    } finally {
      setBusyId(null);
    }
  };

  const groups = useMemo(() => {
    const m = new Map<string, DayViewEntry[]>();
    for (const e of day?.entries ?? []) m.set(e.time, [...(m.get(e.time) ?? []), e]);
    return [...m.entries()];
  }, [day]);

  const counts = useMemo(() => {
    const c: Record<AppointmentStatus, number> = { booked: 0, checked_in: 0, missed: 0, cancelled: 0 };
    for (const e of day?.entries ?? []) c[e.status]++;
    return c;
  }, [day]);

  return (
    <div className="min-h-screen">
      <Header title="Appointments" office={live?.office.name ?? officeName}>
        <nav className="flex items-center gap-4" aria-label="Staff">
          <LiveDot light />
          <Link to={`/o/${officeId}/staff`} className="rounded px-2 py-1 text-sm font-semibold text-white/90 underline-offset-4 hover:underline">
            ← Staff console
          </Link>
        </nav>
      </Header>
      <ConnectionBanner />
      <main id="main" tabIndex={-1} className="outline-none mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold text-navy-900">Appointments</h1>
            <p className="mt-1 text-lg text-muted">{day ? `${day.label}${day.date === day.today ? ' · Today' : ''}` : 'Loading…'}</p>
          </div>
          {date && day && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-secondary min-h-[44px] px-3" onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day">
                ←
              </button>
              <input
                type="date"
                aria-label="Date"
                value={date}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                className="min-h-[44px] rounded-md border-2 border-muted-light bg-white px-3"
              />
              <button type="button" className="btn-secondary min-h-[44px] px-3" onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day">
                →
              </button>
              {date !== day.today && (
                <button type="button" className="btn-outline min-h-[44px] px-3" onClick={() => setDate(day.today)}>
                  Today
                </button>
              )}
            </div>
          )}
        </div>

        {day && !day.settings.enabled && (
          <p className="rounded-md border-l-8 border-warning bg-warning-light p-4">
            Online booking is switched off. Existing appointments are still shown. Turn booking on in{' '}
            <Link to={`/o/${officeId}/settings`} className="font-semibold underline">
              Settings
            </Link>
            .
          </p>
        )}

        {day && (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(Object.keys(STATUS) as AppointmentStatus[]).map((s) => (
              <div key={s} className="card px-4 py-3">
                <dt className="label text-xs">{STATUS[s].label}</dt>
                <dd className="tabular text-3xl font-extrabold text-navy-900">{counts[s]}</dd>
              </div>
            ))}
          </dl>
        )}

        <div aria-live="polite">
          {message && (
            <p
              role={message.kind === 'error' ? 'alert' : 'status'}
              className={`rounded-md border-l-8 p-4 font-semibold ${message.kind === 'error' ? 'border-danger-dark bg-danger-light text-danger-dark' : 'border-success-dark bg-success-light text-success-darker'}`}
            >
              {message.text}
            </p>
          )}
        </div>

        {day && groups.length === 0 && <p className="card p-8 text-center text-lg text-muted">No appointments on this day.</p>}

        {groups.length > 0 && (
          <ol className="card divide-y divide-muted-lighter">
            {groups.map(([time, entries]) => (
              <li key={time} className="grid grid-cols-[88px_1fr] gap-4 px-4 py-3 sm:grid-cols-[110px_1fr]">
                <div className="pt-2 text-lg font-extrabold text-navy-900">{formatHHMM(time)}</div>
                <ul className="space-y-2">
                  {entries.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-muted-lighter px-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block font-bold">
                          {e.name} <span className="font-mono text-sm font-semibold text-muted">· {e.ref}</span>
                        </span>
                        <span className="block text-sm text-muted">
                          {e.serviceName}
                          {e.ticket && ` · Ticket ${e.ticket.number}, ${TICKET_STATUS[e.ticket.status] ?? e.ticket.status}`}
                        </span>
                      </span>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${STATUS[e.status].cls}`}>{STATUS[e.status].label}</span>
                      {e.canCheckIn && (
                        <button type="button" className="btn-success min-h-[40px] px-3 py-1.5 text-sm" disabled={busyId === e.id} onClick={() => act(e, 'checkin')}>
                          Check in
                        </button>
                      )}
                      {e.status === 'booked' && (
                        <button type="button" className="btn-secondary min-h-[40px] px-3 py-1.5 text-sm" disabled={busyId === e.id} onClick={() => act(e, 'cancel')}>
                          Cancel
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
        {day && (
          <p className="text-sm text-muted">
            Check-in is open from {day.settings.checkInEarlyMin} minutes before to {day.settings.checkInLateMin} minutes after each appointment. After that it is marked missed.
          </p>
        )}
      </main>
    </div>
  );
}
