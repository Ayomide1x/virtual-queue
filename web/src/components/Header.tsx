import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function Seal({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <circle cx="20" cy="20" r="19" fill="#fff" />
      <circle cx="20" cy="20" r="16" fill="none" stroke="#112f4e" strokeWidth="2" />
      <path d="M11 27h18M13 25V17m4.67 8V17m4.66 8V17M27 25V17M10.5 16 20 10.5l9.5 5.5z" stroke="#112f4e" strokeWidth="2" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

/** Top bar. `office` is the office name; omit it for app-level pages. */
export function Header({ title, office, children }: { title: string; office?: string; children?: ReactNode }) {
  const brand = (
    <>
      <Seal />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-xs font-semibold uppercase tracking-wider text-primary-light">{office ?? 'Virtual Queue'}</div>
        <div className="truncate text-lg font-bold">{title}</div>
      </div>
    </>
  );
  return (
    <header className="bg-navy-900 text-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        {office ? (
          <div className="flex min-w-0 items-center gap-3">{brand}</div>
        ) : (
          <Link to="/" className="flex min-w-0 items-center gap-3 rounded focus-visible:outline-white">
            {brand}
          </Link>
        )}
        {children}
      </div>
    </header>
  );
}
