import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { LanguagePicker, TextSizeToggle } from './Preferences';

export function Seal({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={`shrink-0 ${className}`} aria-hidden="true">
      <circle cx="20" cy="20" r="19" fill="#fff" />
      <circle cx="20" cy="20" r="16" fill="none" stroke="#112f4e" strokeWidth="2" />
      <path d="M11 27h18M13 25V17m4.67 8V17m4.66 8V17M27 25V17M10.5 16 20 10.5l9.5 5.5z" stroke="#112f4e" strokeWidth="2" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Top bar. `office` is the office name; omit it for app-level pages.
 * Every page gets the larger-text switch; resident pages also get the language menu.
 */
export function Header({ title, office, languages = false, children }: { title: string; office?: string; languages?: boolean; children?: ReactNode }) {
  const { t } = useI18n();
  const brand = (
    <>
      <Seal />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-xs font-semibold uppercase tracking-wider text-primary-light">{office ?? t.common.appName}</div>
        <div className="truncate text-lg font-bold">{title}</div>
      </div>
    </>
  );
  return (
    <header className="bg-navy-900 text-white">
      {/* The settings drop to their own row when there isn't room (small phones, larger text). */}
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        {office ? (
          <div className="flex min-w-[12rem] flex-1 items-center gap-3">{brand}</div>
        ) : (
          <Link to="/" className="flex min-w-[12rem] flex-1 items-center gap-3 rounded focus-visible:outline-white">
            {brand}
          </Link>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-4">
          {children}
          {languages && <LanguagePicker />}
          <TextSizeToggle />
        </div>
      </div>
    </header>
  );
}
