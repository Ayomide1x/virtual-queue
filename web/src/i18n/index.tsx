import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import type { Lang, OpenStatus, WaitEstimate, Weekday } from '../types';
import { en, type Messages } from './en';
import { es } from './es';

/**
 * Languages residents can pick. To add one: write a messages file like es.ts,
 * add a row here, add the code to `Lang` in types.ts, and add its alert texts
 * in server/src/i18n.ts. TypeScript flags anything missing.
 */
export const LANGUAGES: ReadonlyArray<{ code: Lang; name: string; locale: string; messages: Messages }> = [
  { code: 'en', name: 'English', locale: 'en-US', messages: en },
  { code: 'es', name: 'Español', locale: 'es-US', messages: es },
];

const STORAGE_KEY = 'vq.lang';
const byCode = (code: Lang) => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
export const isLang = (v: unknown): v is Lang => LANGUAGES.some((l) => l.code === v);

/** Saved choice, else the device's preferred languages, else English. */
function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* storage blocked */
  }
  for (const pref of navigator.languages ?? [navigator.language]) {
    const base = pref?.toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }
  return 'en';
}

export interface I18n {
  lang: Lang;
  locale: string;
  t: Messages;
  setLang: (lang: Lang) => void;
}

const ChoiceContext = createContext<{ lang: Lang; setLang: (l: Lang) => void } | null>(null);
const ScopeContext = createContext<Lang | null>(null);

/** Holds the resident's language choice for the whole app. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const value = useMemo(
    () => ({
      lang,
      setLang: (next: Lang) => {
        setLangState(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          /* choice just won't be remembered */
        }
      },
    }),
    [lang],
  );
  return <ChoiceContext.Provider value={value}>{children}</ChoiceContext.Provider>;
}

/**
 * Wrap a page with the language it is shown in: the resident's choice, or a
 * fixed one (staff pages are English-only). Sets <html lang> for screen readers.
 */
export function LangScope({ fixed, children }: { fixed?: Lang; children: ReactNode }) {
  const choice = useContext(ChoiceContext);
  const lang = fixed ?? choice?.lang ?? 'en';
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return <ScopeContext.Provider value={lang}>{children}</ScopeContext.Provider>;
}

export function useI18n(): I18n {
  const choice = useContext(ChoiceContext);
  const scoped = useContext(ScopeContext);
  const lang = scoped ?? choice?.lang ?? 'en';
  const { locale, messages } = byCode(lang);
  return { lang, locale, t: messages, setLang: choice?.setLang ?? (() => {}) };
}

/** Messages and locale for a given language (e.g. to announce a call in the resident's language). */
export function messagesFor(lang: Lang | undefined) {
  const l = byCode(lang ?? 'en');
  return { t: l.messages, locale: l.locale };
}

// ------------------------------------------------------------------ formatting

/** Message for an API error in the page's language; English pages keep the server's own wording. */
export function errorText(t: Messages, err: unknown, fallback?: string): string {
  const errors = t.errors as Record<string, string>;
  if (err instanceof ApiError) {
    if (t === en && err.code !== 'network') return err.message || fallback || errors.generic;
    if (errors[err.code]) return errors[err.code];
  }
  return fallback ?? errors.generic;
}

/** "13:30" → "1:30 PM" / "1:30 p. m." (a wall-clock time, no time zone shift). */
export function formatHHMM(hhmm: string, locale: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(Date.UTC(2000, 0, 1, h, m));
}

/** Time of a timestamp, in a time zone (the office's) or the device's. */
export function formatTime(ts: number, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(ts);
}

/** "2026-03-04" → "Wednesday, March 4" / "miércoles, 4 de marzo". */
export function formatDateKey(dateKey: string, locale: string, opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(Date.UTC(y, m - 1, d));
}

/** "monday" / "lunes" for a weekday key. */
export function weekdayName(day: Weekday, locale: string): string {
  const offset = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(day);
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1 + offset)); // 2024-01-01 is a Monday
}

/** The office's open/closed message in the page's language. */
export function hoursText(status: OpenStatus, i18n: Pick<I18n, 't' | 'locale'>): string | null {
  const { t, locale } = i18n;
  if (status.reopens) return t.hours.reopens(status.reopens, formatHHMM(status.reopens.time, locale), weekdayName(status.reopens.day, locale));
  if (status.open) return status.until ? t.hours.openUntil(formatHHMM(status.until, locale)) : null;
  return t.hours.closedNow;
}

/** "About 8 min", "8–12 min", "Less than a minute". */
export function formatEstimate(t: Messages, sec: number | null | undefined): string {
  if (sec == null) return '—';
  if (sec < 60) return t.time.lessThanMinute;
  const min = Math.round(sec / 60);
  if (min < 60) return t.time.aboutMin(min);
  return t.time.aboutHours(Math.floor(min / 60), min % 60);
}

export function formatRange(t: Messages, e: WaitEstimate | null | undefined): string {
  if (!e) return '—';
  if (e.highSec < 60) return t.time.lessThanMinute;
  const lo = Math.max(1, Math.round(e.lowSec / 60));
  const hi = Math.max(lo, Math.round(e.highSec / 60));
  if (hi - lo <= 1) return formatEstimate(t, e.sec);
  if (hi >= 60) return `${formatShort(t, e.lowSec)}–${formatShort(t, e.highSec)}`;
  return t.time.rangeMin(lo, hi);
}

function formatShort(t: Messages, sec: number): string {
  const min = Math.round(sec / 60);
  if (min < 1) return t.time.short.lessThanMinute;
  if (min < 60) return t.time.short.minutes(min);
  return t.time.short.hours(Math.floor(min / 60), min % 60);
}

/** Compact range for the lobby screen: "8–12m". */
export function formatRangeShort(t: Messages, e: { lowSec: number; highSec: number } | null | undefined): string {
  if (!e) return '—';
  if (e.highSec < 60) return t.time.short.lessThanMinute;
  const lo = Math.round(e.lowSec / 60);
  const hi = Math.max(lo, Math.round(e.highSec / 60));
  return lo === hi ? t.time.short.minutes(hi) : `${lo}–${t.time.short.minutes(hi)}`;
}

/** Renders "Tap **Share**" with the starred words in bold. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('**').map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))}
    </>
  );
}
