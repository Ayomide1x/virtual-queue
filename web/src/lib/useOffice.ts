import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { OfficeResponse } from '../types';
import { ApiError, officeApi } from './api';

export function useOfficeId(): string {
  return useParams<{ officeId: string }>().officeId ?? '';
}

export type OfficeLoad = { state: 'loading' } | { state: 'not_found'; message: string } | { state: 'ready'; data: OfficeResponse };

/** Loads the office (and checks it exists), retrying on network errors. */
export function useOffice(officeId: string): OfficeLoad {
  const [load, setLoad] = useState<OfficeLoad>({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoad({ state: 'loading' });
    const attempt = (n = 0) =>
      officeApi(officeId)
        .info()
        .then((data) => !cancelled && setLoad({ state: 'ready', data }))
        .catch((err) => {
          if (cancelled) return;
          if (err instanceof ApiError && err.status === 404) setLoad({ state: 'not_found', message: err.message });
          else timer = setTimeout(() => attempt(n + 1), Math.min(1000 * (n + 1), 5000));
        });
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [officeId]);
  return load;
}
