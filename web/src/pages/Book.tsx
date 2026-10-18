import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Header } from '../components/Header';
import { OfficeGate } from '../components/OfficeGate';
import { ServiceBadge } from '../components/ServiceBadge';
import { ApiError, officeApi } from '../lib/api';
import { formatHHMM } from '../lib/format';
import { useOfficeId } from '../lib/useOffice';
import { useTitle } from '../lib/useTitle';
import type { DayAvailability, OfficeInfo } from '../types';

export default function Book() {
  const officeId = useOfficeId();
  return <OfficeGate officeId={officeId}>{(data) => <BookScreen key={officeId} officeId={officeId} office={data.office} />}</OfficeGate>;
}

function BookScreen({ officeId, office }: { officeId: string; office: OfficeInfo }) {
  useTitle(`Book an appointment — ${office.name}`);
  const api = officeApi(officeId);
  const navigate = useNavigate();
  const [service, setService] = useState<string | null>(null);
  const [days, setDays] = useState<DayAvailability[] | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSlots = (svc: string) => {
    setDays(null);
    api
      .slots(svc)
      .then((r) => {
        setDays(r.days);
        setDate((d) => (d && r.days.some((x) => x.date === d) ? d : (r.days.find((x) => x.slots.some((s) => s.remaining > 0))?.date ?? r.days[0]?.date ?? null)));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load appointment times.'));
  };

  useEffect(() => {
    if (service) loadSlots(service);
    setTime(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!service || !date || !time) return setError('Please choose a service, day and time.');
    if (!name.trim()) return setError('Please enter your first name.');
    setBusy(true);
    setError(null);
    try {
      const view = await api.book({ name: name.trim(), service, date, time });
      try {
        localStorage.setItem(`vq.appointment.${officeId}`, view.appointment.id);
      } catch {
        /* ignore */
      }
      navigate(`/o/${officeId}/appointment/${view.appointment.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not book. Please try again.');
      if (err instanceof ApiError && err.code === 'slot_full') {
        setTime(null);
        loadSlots(service);
      }
    } finally {
      setBusy(false);
    }
  };

  const day = days?.find((d) => d.date === date);

  return (
    <div className="min-h-screen">
      <Header title="Book an appointment" office={office.name} />
      <main className="mx-auto w-full max-w-md px-4 pb-12 pt-6">
        {!office.appointments.enabled ? (
          <div className="card p-6 text-center">
            <h1 className="text-2xl font-extrabold text-navy-900">Appointments aren’t available</h1>
            <p className="mt-2 text-muted">This office isn’t taking appointments right now.</p>
            <Link to={`/o/${officeId}/join`} className="btn-primary mt-6">
              Join the line instead
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="animate-fade-in space-y-6" noValidate>
            <div>
              <h1 className="text-3xl font-extrabold text-navy-900">Book an appointment</h1>
              <p className="mt-2 text-lg text-muted">
                Pick a time, then check in from your phone when you arrive. People with appointments go ahead of walk-ins who joined after their time.
              </p>
            </div>

            <fieldset>
              <legend className="mb-2 text-lg font-bold">1. What do you need help with?</legend>
              <div className="space-y-3">
                {office.services.map((s) => (
                  <label
                    key={s.id}
                    className={`flex min-h-[64px] cursor-pointer items-center gap-4 rounded-lg border-2 bg-white p-4 has-[:focus-visible]:outline has-[:focus-visible]:outline-4 has-[:focus-visible]:outline-focus ${
                      service === s.id ? 'border-primary bg-primary-lighter' : 'border-muted-lighter hover:border-muted-light'
                    }`}
                  >
                    <input type="radio" name="service" value={s.id} checked={service === s.id} onChange={() => setService(s.id)} className="sr-only" />
                    <ServiceBadge code={s.code} tone={service === s.id ? 'solid' : 'light'} />
                    <span className="flex-1 text-lg font-bold">{s.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {service && (
              <fieldset>
                <legend className="mb-2 text-lg font-bold">2. Choose a day</legend>
                {!days ? (
                  <p className="text-muted" role="status">
                    Loading times…
                  </p>
                ) : (
                  <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2" role="radiogroup" aria-label="Day">
                    {days.map((d, i) => {
                      const open = d.slots.reduce((a, s) => a + (s.remaining > 0 ? 1 : 0), 0);
                      const selected = d.date === date;
                      return (
                        <button
                          key={d.date}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => (setDate(d.date), setTime(null))}
                          className={`flex min-h-[64px] min-w-[88px] shrink-0 flex-col items-center justify-center rounded-lg border-2 px-3 py-2 ${
                            selected ? 'border-primary bg-primary text-white' : 'border-muted-lighter bg-white hover:border-muted-light'
                          }`}
                        >
                          <span className="text-sm font-semibold">{i === 0 ? 'Today' : d.label.split(',')[0].slice(0, 3)}</span>
                          <span className="font-bold">{d.label.split(', ')[1] ?? d.label}</span>
                          <span className={`text-xs ${selected ? 'text-white/85' : 'text-muted'}`}>{open ? `${open} times` : 'Full / closed'}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            )}

            {day && (
              <fieldset>
                <legend className="mb-2 text-lg font-bold">3. Choose a time · {day.label}</legend>
                {day.slots.length === 0 ? (
                  <p className="rounded-md bg-white p-4 text-muted">No appointments on this day.</p>
                ) : (
                  <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Time">
                    {day.slots.map((s) => {
                      const full = s.remaining === 0;
                      const selected = s.time === time;
                      return (
                        <button
                          key={s.time}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          disabled={full}
                          onClick={() => setTime(s.time)}
                          className={`flex min-h-[56px] flex-col items-center justify-center rounded-md border-2 px-1 ${
                            selected ? 'border-primary bg-primary text-white' : full ? 'border-muted-lighter bg-muted-lightest text-muted line-through' : 'border-muted-lighter bg-white hover:border-primary'
                          }`}
                          aria-label={`${formatHHMM(s.time)}${full ? ', fully booked' : `, ${s.remaining} left`}`}
                        >
                          <span className="font-bold">{formatHHMM(s.time)}</span>
                          {!full && s.remaining <= 2 && <span className={`text-xs ${selected ? 'text-white/85' : 'text-muted'}`}>{s.remaining} left</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            )}

            {time && (
              <div>
                <label htmlFor="book-name" className="mb-2 block text-lg font-bold">
                  4. Your first name
                </label>
                <input
                  id="book-name"
                  autoComplete="given-name"
                  maxLength={30}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="block min-h-[56px] w-full rounded-md border-2 border-muted-light bg-white px-4 text-xl focus:border-primary"
                />
              </div>
            )}

            {error && (
              <p role="alert" className="rounded-md border-l-8 border-danger-dark bg-danger-light p-4 font-semibold text-danger-dark">
                {error}
              </p>
            )}

            <button type="submit" className="btn-primary min-h-[60px] w-full text-xl" disabled={busy || !time}>
              {busy ? 'Booking…' : time && day ? `Book ${formatHHMM(time)}` : 'Book appointment'}
            </button>
            <p className="text-center">
              <Link to={`/o/${officeId}/join`} className="font-semibold text-primary underline underline-offset-4">
                Join the line now instead
              </Link>
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
