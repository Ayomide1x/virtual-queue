import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertsOptIn } from '../components/AlertsOptIn';
import { CopyField } from '../components/CopyField';
import { Header } from '../components/Header';
import { OfficeGate } from '../components/OfficeGate';
import { errorText, formatDateKey, formatHHMM, formatTime, useI18n } from '../i18n';
import { ApiError, officeApi } from '../lib/api';
import { syncClock, useNow } from '../lib/clock';
import { useOfficeManifest } from '../lib/pwa';
import { useOfficeId } from '../lib/useOffice';
import { useTitle } from '../lib/useTitle';
import type { AppointmentStatus, AppointmentView, OfficeInfo } from '../types';

export default function AppointmentPage() {
  const officeId = useOfficeId();
  const { apptId = '' } = useParams();
  return (
    <OfficeGate officeId={officeId}>{(data) => <AppointmentScreen key={apptId} officeId={officeId} apptId={apptId} office={data.office} />}</OfficeGate>
  );
}

function AppointmentScreen({ officeId, apptId, office }: { officeId: string; apptId: string; office: OfficeInfo }) {
  const { t, lang, locale } = useI18n();
  useTitle(t.appointment.pageTitle(office.name));
  useOfficeManifest(officeId, `/o/${officeId}/appointment/${apptId}`);
  const api = officeApi(officeId);
  const now = useNow(1000);
  const [view, setView] = useState<AppointmentView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const keepAppointment = () => {
    setConfirmCancel(false);
    requestAnimationFrame(() => cancelButton.current?.focus());
  };

  const load = useCallback(() => {
    api
      .appointment(apptId)
      .then((v) => {
        syncClock(v.serverNow);
        setView(v);
      })
      .catch((err) => err instanceof ApiError && err.status === 404 && setNotFound(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apptId, officeId]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  // Reminders go out in the appointment's language: keep it in step with the page.
  const apptLang = view?.appointment.lang;
  const syncedLang = useRef<string | null>(null);
  useEffect(() => {
    if (!apptLang || apptLang === lang || syncedLang.current === lang) return;
    syncedLang.current = lang;
    api.setAppointmentLanguage(apptId, lang).then(setView).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apptLang, lang, apptId]);

  const goToTicket = (ticketId: string) => {
    try {
      localStorage.setItem(`vq.ticket.${officeId}`, ticketId);
    } catch {
      /* ignore */
    }
    window.location.assign(`/o/${officeId}/t/${ticketId}`); // a full load: see Resident's onJoined
  };

  const checkIn = async () => {
    setBusy(true);
    setError(null);
    try {
      goToTicket((await api.checkIn(apptId)).ticketId);
    } catch (err) {
      setError(errorText(t, err, t.appointment.checkInFailed));
      load();
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      setView(await api.cancelAppointment(apptId));
      setConfirmCancel(false);
    } catch (err) {
      setError(errorText(t, err, t.appointment.cancelFailed));
    } finally {
      setBusy(false);
    }
  };

  if (notFound) {
    return (
      <div className="min-h-screen">
        <Header title={t.appointment.headerShort} office={office.name} languages />
        <main id="main" tabIndex={-1} className="mx-auto max-w-md px-4 py-10 text-center outline-none">
          <h1 className="text-2xl font-extrabold text-navy-900">{t.appointment.notFoundTitle}</h1>
          <p className="mt-2 text-muted">{t.appointment.notFoundBody}</p>
          <Link to={`/o/${officeId}/book`} className="btn-primary mt-6">
            {t.join.book}
          </Link>
        </main>
      </div>
    );
  }

  const a = view?.appointment;
  // Booked + window closed while this page was open: show as missed without waiting for a reload.
  const status = a && a.status === 'booked' && view && now > view.checkIn.closesAt ? 'missed' : a?.status;
  const windowOpen = !!view && status === 'booked' && now >= view.checkIn.opensAt && now <= view.checkIn.closesAt;
  const minsToOpen = view ? Math.ceil((view.checkIn.opensAt - now) / 60_000) : 0;
  // Times are in the office's time zone, in the page's language.
  const tz = office.timezone;
  const timeLabel = a ? formatHHMM(a.time, locale) : '';
  const opensLabel = view ? formatTime(view.checkIn.opensAt, locale, tz) : '';
  const closesLabel = view ? formatTime(view.checkIn.closesAt, locale, tz) : '';

  return (
    <div className="min-h-screen">
      <Header title={t.appointment.header} office={office.name} languages />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-md space-y-5 px-4 pb-12 pt-6 outline-none">
        {!view || !a ? (
          <p className="text-center text-muted" role="status">
            {t.appointment.loading}
          </p>
        ) : (
          <>
            <StatusBanner status={status!} closesLabel={closesLabel} />

            <section className="card overflow-hidden" aria-label={t.appointment.details}>
              <div className="border-b border-muted-lighter bg-primary-lighter px-6 py-5 text-center">
                <div className="label">{formatDateKey(a.date, locale)}</div>
                <div className="mt-1 text-5xl font-extrabold text-navy-900">{timeLabel}</div>
                <div className="mt-1 text-lg text-muted">{a.serviceName}</div>
              </div>
              <dl className="grid grid-cols-2 divide-x divide-muted-lighter text-center">
                <div className="p-4">
                  <dt className="label">{t.appointment.name}</dt>
                  <dd className="mt-1 text-lg font-bold">{a.name}</dd>
                </div>
                <div className="p-4">
                  <dt className="label">{t.appointment.reference}</dt>
                  <dd className="mt-1 font-mono text-lg font-bold tracking-wider">{a.ref}</dd>
                </div>
              </dl>
            </section>

            {status === 'booked' && (
              <div className="card space-y-3 p-5">
                <p>
                  <strong>{t.appointment.checkInStrong}</strong>
                  {t.appointment.checkInRest(opensLabel, closesLabel, timeLabel)}
                </p>
                <button type="button" className="btn-success min-h-[60px] w-full text-xl" disabled={!windowOpen || busy} onClick={checkIn}>
                  {busy
                    ? t.appointment.checkingIn
                    : windowOpen
                      ? t.appointment.imHere
                      : minsToOpen > 0 && minsToOpen <= 120
                        ? t.appointment.opensIn(minsToOpen)
                        : t.appointment.opensAt(opensLabel)}
                </button>
              </div>
            )}

            {status === 'checked_in' && a.ticketId && (
              <button type="button" className="btn-primary min-h-[56px] w-full text-lg" onClick={() => goToTicket(a.ticketId!)}>
                {t.appointment.seePlace}
              </button>
            )}

            {error && (
              <p role="alert" className="rounded-md border-l-8 border-danger-dark bg-danger-light p-4 font-semibold text-danger-dark">
                {error}
              </p>
            )}

            {status === 'booked' && <AlertsOptIn officeId={officeId} target={{ kind: 'appointment', id: apptId }} />}

            {status === 'booked' && (
              <div className="card space-y-3 p-5">
                <CopyField label={t.appointment.linkLabel} value={window.location.href} hint={t.appointment.linkHint} />
              </div>
            )}

            {status === 'booked' &&
              (confirmCancel ? (
                <div
                  className="card space-y-3 p-5"
                  role="alertdialog"
                  aria-labelledby="cancel-q"
                  onKeyDown={(e) => e.key === 'Escape' && !busy && keepAppointment()}
                >
                  <p id="cancel-q" className="text-lg font-bold">
                    {t.appointment.cancelQuestion}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <button type="button" className="btn-secondary" onClick={keepAppointment} disabled={busy} autoFocus>
                      {t.appointment.keepIt}
                    </button>
                    <button type="button" className="btn bg-danger-dark text-white hover:bg-danger" onClick={cancel} disabled={busy}>
                      {t.appointment.confirmCancel}
                    </button>
                  </div>
                </div>
              ) : (
                <button ref={cancelButton} type="button" className="btn-danger-outline w-full" onClick={() => setConfirmCancel(true)}>
                  {t.appointment.cancel}
                </button>
              ))}

            {(status === 'missed' || status === 'cancelled') && (
              <div className="flex flex-col gap-3">
                <Link to={`/o/${officeId}/book`} className="btn-primary">
                  {t.appointment.bookAnother}
                </Link>
                <Link to={`/o/${officeId}/join`} className="btn-outline">
                  {t.appointment.walkIn}
                </Link>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function StatusBanner({ status, closesLabel }: { status: string; closesLabel: string }) {
  const { t } = useI18n();
  const styles: Record<AppointmentStatus, string> = {
    booked: 'border-success-dark bg-success-light',
    checked_in: 'border-primary bg-primary-lighter',
    missed: 'border-warning bg-warning-light',
    cancelled: 'border-muted-light bg-muted-lightest',
  };
  const key = (status in styles ? status : 'booked') as AppointmentStatus;
  const [title, body] = t.appointment.status[key];
  const cls = styles[key];
  return (
    <div role="status" className={`rounded-md border-l-8 p-4 ${cls}`}>
      <h1 className="text-lg font-bold text-ink">{title}</h1>
      <p className="text-ink">{body.replace('{closes}', closesLabel)}</p>
    </div>
  );
}
