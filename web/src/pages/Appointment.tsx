import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertsOptIn } from '../components/AlertsOptIn';
import { CopyField } from '../components/CopyField';
import { Header } from '../components/Header';
import { OfficeGate } from '../components/OfficeGate';
import { ApiError, officeApi } from '../lib/api';
import { syncClock, useNow } from '../lib/clock';
import { useOfficeManifest } from '../lib/pwa';
import { useOfficeId } from '../lib/useOffice';
import { useTitle } from '../lib/useTitle';
import type { AppointmentView, OfficeInfo } from '../types';

export default function AppointmentPage() {
  const officeId = useOfficeId();
  const { apptId = '' } = useParams();
  return (
    <OfficeGate officeId={officeId}>{(data) => <AppointmentScreen key={apptId} officeId={officeId} apptId={apptId} office={data.office} />}</OfficeGate>
  );
}

function AppointmentScreen({ officeId, apptId, office }: { officeId: string; apptId: string; office: OfficeInfo }) {
  useTitle(`Your appointment — ${office.name}`);
  useOfficeManifest(officeId, `/o/${officeId}/appointment/${apptId}`);
  const api = officeApi(officeId);
  const navigate = useNavigate();
  const now = useNow(1000);
  const [view, setView] = useState<AppointmentView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

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

  const goToTicket = (ticketId: string) => {
    try {
      localStorage.setItem(`vq.ticket.${officeId}`, ticketId);
    } catch {
      /* ignore */
    }
    navigate(`/o/${officeId}/join`);
  };

  const checkIn = async () => {
    setBusy(true);
    setError(null);
    try {
      goToTicket((await api.checkIn(apptId)).ticketId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check in. Please try again.');
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
      setError(err instanceof ApiError ? err.message : 'Could not cancel. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (notFound) {
    return (
      <div className="min-h-screen">
        <Header title="Appointment" office={office.name} />
        <main className="mx-auto max-w-md px-4 py-10 text-center">
          <h1 className="text-2xl font-extrabold text-navy-900">Appointment not found</h1>
          <p className="mt-2 text-muted">This link may be incomplete, or the appointment is more than two days old.</p>
          <Link to={`/o/${officeId}/book`} className="btn-primary mt-6">
            Book an appointment
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

  return (
    <div className="min-h-screen">
      <Header title="Your appointment" office={office.name} />
      <main className="mx-auto w-full max-w-md space-y-5 px-4 pb-12 pt-6">
        {!view || !a ? (
          <p className="text-center text-muted" role="status">
            Loading your appointment…
          </p>
        ) : (
          <>
            <StatusBanner status={status!} view={view} />

            <section className="card overflow-hidden" aria-label="Appointment details">
              <div className="border-b border-muted-lighter bg-primary-lighter px-6 py-5 text-center">
                <div className="label">{view.dateLabel}</div>
                <div className="mt-1 text-5xl font-extrabold text-navy-900">{view.timeLabel}</div>
                <div className="mt-1 text-lg text-muted">{a.serviceName}</div>
              </div>
              <dl className="grid grid-cols-2 divide-x divide-muted-lighter text-center">
                <div className="p-4">
                  <dt className="label">Name</dt>
                  <dd className="mt-1 text-lg font-bold">{a.name}</dd>
                </div>
                <div className="p-4">
                  <dt className="label">Reference</dt>
                  <dd className="mt-1 font-mono text-lg font-bold tracking-wider">{a.ref}</dd>
                </div>
              </dl>
            </section>

            {status === 'booked' && (
              <div className="card space-y-3 p-5">
                <p>
                  <strong>Check in when you arrive</strong>, between {view.checkIn.opensLabel} and {view.checkIn.closesLabel}. You’ll then go ahead of walk-ins who
                  joined after {view.timeLabel}.
                </p>
                <button type="button" className="btn-success min-h-[60px] w-full text-xl" disabled={!windowOpen || busy} onClick={checkIn}>
                  {busy ? 'Checking in…' : windowOpen ? 'I’m here — check in' : minsToOpen > 0 && minsToOpen <= 120 ? `Check-in opens in ${minsToOpen} min` : `Check-in opens at ${view.checkIn.opensLabel}`}
                </button>
              </div>
            )}

            {status === 'checked_in' && a.ticketId && (
              <button type="button" className="btn-primary min-h-[56px] w-full text-lg" onClick={() => goToTicket(a.ticketId!)}>
                See my place in line
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
                <CopyField label="Your confirmation link" value={window.location.href} hint="Save or bookmark it. You’ll use it to check in, or to cancel." />
              </div>
            )}

            {status === 'booked' &&
              (confirmCancel ? (
                <div className="card space-y-3 p-5" role="alertdialog" aria-labelledby="cancel-q">
                  <p id="cancel-q" className="text-lg font-bold">
                    Cancel this appointment?
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <button type="button" className="btn-secondary" onClick={() => setConfirmCancel(false)} disabled={busy} autoFocus>
                      Keep it
                    </button>
                    <button type="button" className="btn bg-danger-dark text-white hover:bg-danger" onClick={cancel} disabled={busy}>
                      Yes, cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn-danger-outline w-full" onClick={() => setConfirmCancel(true)}>
                  Cancel appointment
                </button>
              ))}

            {(status === 'missed' || status === 'cancelled') && (
              <div className="flex flex-col gap-3">
                <Link to={`/o/${officeId}/book`} className="btn-primary">
                  Book another time
                </Link>
                <Link to={`/o/${officeId}/join`} className="btn-outline">
                  Join the line as a walk-in
                </Link>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function StatusBanner({ status, view }: { status: string; view: AppointmentView }) {
  const styles: Record<string, [string, string, string]> = {
    booked: ['border-success-dark bg-success-light', 'You’re booked', 'We look forward to seeing you.'],
    checked_in: ['border-primary bg-primary-lighter', 'You’re checked in', 'You’re in line. Keep your phone handy for your turn.'],
    missed: ['border-warning bg-warning-light', 'This appointment was missed', `Check-in closed at ${view.checkIn.closesLabel}.`],
    cancelled: ['border-muted-light bg-muted-lightest', 'This appointment was cancelled', 'The time has been released for others.'],
  };
  const [cls, title, body] = styles[status] ?? styles.booked;
  return (
    <div role="status" className={`rounded-md border-l-8 p-4 ${cls}`}>
      <p className="text-lg font-bold text-ink">{title}</p>
      <p className="text-ink">{body}</p>
    </div>
  );
}
