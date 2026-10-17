import type { ServiceId } from '../types';

const PATHS: Record<ServiceId, JSX.Element> = {
  license: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="11" r="2" />
      <path d="M5.5 16c.6-1.6 1.7-2.3 3-2.3s2.4.7 3 2.3M14 10h4M14 13h3" />
    </>
  ),
  registration: (
    <>
      <path d="M5 16V12l2-5h10l2 5v4" />
      <path d="M4 12h16v4H4z" />
      <circle cx="7.5" cy="16.5" r="1.5" />
      <circle cx="16.5" cy="16.5" r="1.5" />
    </>
  ),
  id: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <circle cx="12" cy="10" r="2.6" />
      <path d="M8 17c.8-2 2.2-3 4-3s3.2 1 4 3" />
    </>
  ),
};

export function ServiceIcon({ service, className = 'h-6 w-6' }: { service: ServiceId; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[service]}
    </svg>
  );
}
