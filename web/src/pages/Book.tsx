import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Header } from '../components/Header';
import { OfficeGate } from '../components/OfficeGate';
import { ServiceBadge } from '../components/ServiceBadge';
import { errorText, formatDateKey, formatHHMM, useI18n } from '../i18n';
import { ApiError, officeApi } from '../lib/api';
import { useOfficeId } from '../lib/useOffice';
import { useTitle } from '../lib/useTitle';
import type { DayAvailability, OfficeInfo } from '../types';

export default function Book() {
  const officeId = useOfficeId();
  return <OfficeGate officeId={officeId}>{(data) => <BookScreen key={officeId} officeId={officeId} office={data.office} />}</OfficeGate>;
}

/**
 * A card-style choice that is a real radio button underneath, so arrow keys,
 * screen readers and the focus ring all work as they do for any radio group.
 */
function Choice({
  name,
  value,
  checked,
  disabled,
  onChange,
  className,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  className: string;
  children: ReactNode;
}) {
  return (
    <label
      className={`cursor-pointer has-[:focus-visible]:outline has-[:focus-visible]:outline-4 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
        disabled ? 'cursor-not-allowed' : ''
      } ${className}`}
    >
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onChange} className="sr-only" />
      {children}
    </label>
  );
}

function BookScreen({ officeId, office }: { officeId: string; office: OfficeInfo }) {
  const { t, lang, locale } = useI18n();
  useTitle(t.book.pageTitle(office.name));
  const api = officeApi(officeId);
  const navigate = useNavigate();
  const [service, setService] = useState<string | null>(null);
  const [days, setDays] = useState<DayAvailability[] | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const loadSlots = (svc: string) => {
    setDays(null);
    api
      .slots(svc)
      .then((r) => {
        setDays(r.days);
        setDate((d) => (d && r.days.some((x) => x.date === d) ? d : (r.days.find((x) => x.slots.some((s) => s.remaining > 0))?.date ?? r.days[0]?.date ?? null)));
      })
      .catch((err) => setError(errorText(t, err, t.book.loadFailed)));
  };

  useEffect(() => {
    if (service) loadSlots(service);
    setTime(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!service || !date || !time) return setError(t.book.chooseAll);
    if (!name.trim()) {
      setError(t.join.errorName);
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const view = await api.book({ name: name.trim(), service, date, time, lang });
      try {
        localStorage.setItem(`vq.appointment.${officeId}`, view.appointment.id);
      } catch {
        /* ignore */
      }
      navigate(`/o/${officeId}/appointment/${view.appointment.id}`);
    } catch (err) {
      setError(errorText(t, err, t.book.failed));
      if (err instanceof ApiError && err.code === 'slot_full') {
        setTime(null);
        loadSlots(service);
      }
    } finally {
      setBusy(false);
    }
  };

  const day = days?.find((d) => d.date === date);
  const dayLabel = (dateKey: string) => formatDateKey(dateKey, locale);

  return (
    <div className="min-h-screen">
      <Header title={t.book.title} office={office.name} languages />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-md px-4 pb-12 pt-6 outline-none">
        {!office.appointments.enabled ? (
          <div className="card p-6 text-center">
            <h1 className="text-2xl font-extrabold text-navy-900">{t.book.offTitle}</h1>
            <p className="mt-2 text-muted">{t.book.offBody}</p>
            <Link to={`/o/${officeId}/join`} className="btn-primary mt-6">
              {t.book.joinInstead}
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="animate-fade-in space-y-6" noValidate>
            <div>
              <h1 className="text-3xl font-extrabold text-navy-900">{t.book.title}</h1>
              <p className="mt-2 text-lg text-muted">{t.book.intro}</p>
            </div>

            <fieldset>
              <legend className="mb-2 text-lg font-bold">{t.book.step1}</legend>
              <div className="space-y-3">
                {office.services.map((s) => (
                  <Choice
                    key={s.id}
                    name="service"
                    value={s.id}
                    checked={service === s.id}
                    onChange={() => setService(s.id)}
                    className={`flex min-h-[64px] items-center gap-4 rounded-lg border-2 bg-white p-4 ${
                      service === s.id ? 'border-primary bg-primary-lighter' : 'border-muted-lighter hover:border-muted-light'
                    }`}
                  >
                    <ServiceBadge code={s.code} tone={service === s.id ? 'solid' : 'light'} />
                    <span className="flex-1 text-lg font-bold">{s.name}</span>
                  </Choice>
                ))}
              </div>
            </fieldset>

            {service && (
              <fieldset>
                <legend className="mb-2 text-lg font-bold">{t.book.step2}</legend>
                {!days ? (
                  <p className="text-muted" role="status">
                    {t.book.loadingTimes}
                  </p>
                ) : (
                  <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 pt-1">
                    {days.map((d, i) => {
                      const open = d.slots.reduce((a, s) => a + (s.remaining > 0 ? 1 : 0), 0);
                      const selected = d.date === date;
                      return (
                        <Choice
                          key={d.date}
                          name="day"
                          value={d.date}
                          checked={selected}
                          onChange={() => (setDate(d.date), setTime(null))}
                          className={`flex min-h-[64px] min-w-[88px] shrink-0 flex-col items-center justify-center rounded-lg border-2 px-3 py-2 ${
                            selected ? 'border-primary bg-primary text-white' : 'border-muted-lighter bg-white hover:border-muted-light'
                          }`}
                        >
                          {/* Screen readers get the full date; the card shows a short form. */}
                          <span className="sr-only">
                            {i === 0 ? `${t.book.today}, ` : ''}
                            {dayLabel(d.date)}, {t.book.timesOpen(open)}
                          </span>
                          <span aria-hidden="true" className="text-sm font-semibold capitalize">
                            {i === 0 ? t.book.today : formatDateKey(d.date, locale, { weekday: 'short' })}
                          </span>
                          <span aria-hidden="true" className="font-bold">
                            {formatDateKey(d.date, locale, { month: 'short', day: 'numeric' })}
                          </span>
                          <span aria-hidden="true" className={`text-xs ${selected ? 'text-white' : 'text-muted'}`}>
                            {t.book.timesOpen(open)}
                          </span>
                        </Choice>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            )}

            {day && (
              <fieldset>
                <legend className="mb-2 text-lg font-bold">{t.book.step3(dayLabel(day.date))}</legend>
                {day.slots.length === 0 ? (
                  <p className="rounded-md bg-white p-4 text-muted">{t.book.noneThisDay}</p>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {day.slots.map((s) => {
                      const full = s.remaining === 0;
                      const selected = s.time === time;
                      const label = formatHHMM(s.time, locale);
                      return (
                        <Choice
                          key={s.time}
                          name="time"
                          value={s.time}
                          checked={selected}
                          disabled={full}
                          onChange={() => setTime(s.time)}
                          className={`flex min-h-[56px] flex-col items-center justify-center rounded-md border-2 px-1 ${
                            selected ? 'border-primary bg-primary text-white' : full ? 'border-muted-lighter bg-muted-lightest text-muted line-through' : 'border-muted-lighter bg-white hover:border-primary'
                          }`}
                        >
                          <span className="font-bold">{label}</span>
                          {full ? (
                            <span className="sr-only">, {t.book.full}</span>
                          ) : s.remaining <= 2 ? (
                            <span className={`text-xs ${selected ? 'text-white' : 'text-muted'}`}>
                              <span className="sr-only">, </span>
                              {t.book.left(s.remaining)}
                            </span>
                          ) : null}
                        </Choice>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            )}

            {time && (
              <div>
                <label htmlFor="book-name" className="mb-2 block text-lg font-bold">
                  {t.book.step4}
                </label>
                <input
                  ref={nameRef}
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
              {busy ? t.book.booking : time && day ? t.book.bookAt(formatHHMM(time, locale)) : t.book.bookButton}
            </button>
            <p className="text-center">
              <Link to={`/o/${officeId}/join`} className="font-semibold text-primary underline underline-offset-4">
                {t.book.joinNowInstead}
              </Link>
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
