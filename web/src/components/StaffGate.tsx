import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, officeApi } from '../lib/api';
import { captureKeyFromUrl, clearStaffKey, getStaffKey, setStaffKey } from '../lib/staffKey';
import { Header } from './Header';

type Check = 'checking' | 'ok' | 'missing' | 'invalid';

/**
 * Ensures this device holds a valid staff key for the office before rendering
 * staff screens. Keys arrive via the staff link (#key=…) or can be pasted.
 */
export function StaffGate({
  officeId,
  officeName,
  title,
  children,
}: {
  officeId: string;
  officeName: string;
  title: string;
  children: (staffKey: string, onForbidden: () => void) => ReactNode;
}) {
  const [key, setKey] = useState<string | null>(() => captureKeyFromUrl(officeId) ?? getStaffKey(officeId));
  const [check, setCheck] = useState<Check>(key ? 'checking' : 'missing');

  useEffect(() => {
    if (!key) return setCheck('missing');
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setCheck('checking');
    const verify = () =>
      officeApi(officeId)
        .verifyStaffKey(key)
        .then(() => !cancelled && setCheck('ok'))
        .catch((err) => {
          if (cancelled) return;
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
            clearStaffKey(officeId);
            setCheck('invalid');
          } else timer = setTimeout(verify, 2000); // network trouble: keep trying
        });
    verify();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, officeId]);

  if (check === 'ok' && key) {
    return (
      <>
        {children(key, () => {
          clearStaffKey(officeId);
          setCheck('invalid');
        })}
      </>
    );
  }

  return (
    <div className="min-h-screen">
      <Header title={title} office={officeName} />
      {check === 'checking' ? (
        <p className="p-10 text-center text-lg text-muted" role="status">
          Checking staff access…
        </p>
      ) : (
        <KeyForm
          invalid={check === 'invalid'}
          onSubmit={(k) => {
            setStaffKey(officeId, k);
            setKey(k);
            setCheck('checking');
          }}
        />
      )}
    </div>
  );
}

function KeyForm({ invalid, onSubmit }: { invalid: boolean; onSubmit: (key: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Accept either a bare key or a whole staff link.
    const fromLink = value.match(/[#&]key=([^&\s]+)/);
    const key = (fromLink ? decodeURIComponent(fromLink[1]) : value).trim();
    if (key) onSubmit(key);
  };
  return (
    <main id="main" tabIndex={-1} className="outline-none mx-auto max-w-lg px-6 py-12">
      <h1 className="text-3xl font-extrabold text-navy-900">Staff access</h1>
      <p className="mt-2 text-lg text-muted">Open the staff link you were given, or paste it (or the staff key) below.</p>
      {invalid && (
        <p role="alert" className="mt-6 rounded-md border-l-8 border-danger-dark bg-danger-light p-4 font-semibold text-danger-dark">
          That staff key isn’t valid for this office.
        </p>
      )}
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="staff-key" className="mb-2 block font-bold">
            Staff link or key
          </label>
          <input
            id="staff-key"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="block min-h-[52px] w-full rounded-md border-2 border-muted-light bg-white px-4 font-mono"
          />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={!value.trim()}>
          Continue
        </button>
      </form>
    </main>
  );
}
