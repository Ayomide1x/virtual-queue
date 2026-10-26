import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CopyField } from '../components/CopyField';
import { Header } from '../components/Header';
import { ApiError, createOffice } from '../lib/api';
import { forgetOffice, listMyOffices, rememberOffice, type SavedOffice } from '../lib/myOffices';
import { setStaffKey } from '../lib/staffKey';
import { officeLinks, publicBase } from '../lib/urls';
import { useTitle } from '../lib/useTitle';
import type { CreatedOffice } from '../types';

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

export default function Home() {
  useTitle('Virtual Queue — Create an office');
  const [created, setCreated] = useState<CreatedOffice | null>(null);
  const [mine, setMine] = useState<SavedOffice[]>(listMyOffices);

  return (
    <div className="min-h-screen">
      <Header title="Virtual Queue" />
      <main id="main" tabIndex={-1} className="outline-none mx-auto max-w-3xl px-4 py-10 sm:px-6">
        {created ? (
          <Created office={created} onAnother={() => setCreated(null)} />
        ) : (
          <>
            <h1 className="text-3xl font-extrabold text-navy-900 sm:text-4xl">Let residents wait anywhere</h1>
            <p className="mt-3 max-w-2xl text-lg text-muted">
              Set up a virtual line for your office in seconds. Residents join from their phones and get an alert when it’s their turn. Staff call people
              from a console, and a lobby screen shows who’s being served.
            </p>
            <CreateForm
              onCreated={(o) => {
                setStaffKey(o.officeId, o.staffKey);
                rememberOffice(o.officeId, o.office.name);
                setMine(listMyOffices());
                setCreated(o);
              }}
            />
          </>
        )}

        {mine.length > 0 && !created && (
          <section className="mt-12" aria-labelledby="mine-heading">
            <h2 id="mine-heading" className="label mb-3">
              Your offices on this device
            </h2>
            <ul className="card divide-y divide-muted-lighter">
              {mine.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold text-navy-900">{o.name}</span>
                    <span className="font-mono text-sm text-muted">{o.id}</span>
                  </span>
                  <Link to={`/o/${o.id}/staff`} className="font-semibold text-primary underline">
                    Staff
                  </Link>
                  <Link to={`/o/${o.id}/display`} className="font-semibold text-primary underline">
                    Display
                  </Link>
                  <Link to={`/o/${o.id}/settings`} className="font-semibold text-primary underline">
                    Settings
                  </Link>
                  <button
                    type="button"
                    className="text-sm text-muted underline hover:text-danger-dark"
                    onClick={() => {
                      forgetOffice(o.id);
                      setMine(listMyOffices());
                    }}
                    aria-label={`Remove ${o.name} from this list`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

function CreateForm({ onCreated }: { onCreated: (o: CreatedOffice) => void }) {
  const [name, setName] = useState('');
  const [seed, setSeed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await createOffice({ name: name.trim() || undefined, timezone: browserTimeZone(), seed }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the office. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card mt-8 space-y-5 p-6">
      <div>
        <label htmlFor="office-name" className="mb-2 block text-lg font-bold">
          Office name <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="office-name"
          value={name}
          maxLength={60}
          placeholder="City Services Office"
          onChange={(e) => setName(e.target.value)}
          className="block min-h-[52px] w-full rounded-md border-2 border-muted-light bg-white px-4 text-lg"
        />
        <p className="mt-1 text-sm text-muted">You can change this, the services, counters and opening hours later in Settings.</p>
      </div>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" checked={seed} onChange={(e) => setSeed(e.target.checked)} className="mt-1 h-5 w-5 accent-primary" />
        <span>
          <span className="block font-semibold">Fill with sample residents</span>
          <span className="block text-sm text-muted">Starts with people already in line and a morning of history.</span>
        </span>
      </label>
      {error && (
        <p role="alert" className="rounded-md border-l-8 border-danger-dark bg-danger-light p-4 font-semibold text-danger-dark">
          {error}
        </p>
      )}
      <button type="submit" className="btn-primary min-h-[56px] w-full text-lg" disabled={busy}>
        {busy ? 'Creating…' : 'Create an office'}
      </button>
    </form>
  );
}

function Created({ office, onAnother }: { office: CreatedOffice; onAnother: () => void }) {
  const { base, reachable } = publicBase(office);
  const links = officeLinks(base, office.officeId, office.staffKey);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success-light text-success-darker">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m5 12 5 5L20 7" />
          </svg>
        </span>
        <h1 className="text-3xl font-extrabold text-navy-900">{office.office.name} is ready</h1>
      </div>
      <p className="mt-3 text-lg text-muted">Share these links. Each one opens a different screen for this office.</p>

      <div className="card mt-6 space-y-6 p-6">
        <CopyField
          label="Staff console link"
          value={links.staff}
          secret
          hint="Contains your secret staff key. Share it only with staff. It can’t be recovered, so save it somewhere safe."
        />
        <CopyField label="Lobby display link" value={links.display} hint="Open on the waiting-room TV. Shows a QR code residents can scan." />
        <CopyField label="Resident join link" value={links.join} hint="Residents open this on their phones to join the line." />
      </div>

      {!reachable && (
        <p className="mt-4 rounded-md border-l-8 border-warning bg-warning-light p-4">
          These links use <strong>localhost</strong>, which phones can’t reach. Set <code className="font-mono">PUBLIC_URL</code> on the server (see docs/configuration.md).
        </p>
      )}

      <div className="mt-8 flex flex-wrap gap-3">
        <Link to={`/o/${office.officeId}/staff`} className="btn-primary">
          Open staff console
        </Link>
        <Link to={`/o/${office.officeId}/settings`} className="btn-outline">
          Configure office
        </Link>
        <button type="button" className="btn-secondary" onClick={onAnother}>
          Create another office
        </button>
      </div>
      <p className="mt-6 text-sm text-muted">Offices are removed automatically after 30 days without activity.</p>
    </div>
  );
}
