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

export function Header({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <header className="bg-navy-900 text-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link to="/" className="flex items-center gap-3 rounded focus-visible:outline-white">
          <Seal />
          <div className="leading-tight">
            <div className="text-xs font-semibold uppercase tracking-wider text-primary-light">City of Riverside</div>
            <div className="text-lg font-bold">{title ?? 'City Services Office'}</div>
          </div>
        </Link>
        {children}
      </div>
    </header>
  );
}
