import { formatEstimate as i18nEstimate, formatRange as i18nRange, formatRangeShort as i18nRangeShort } from '../i18n';
import { en } from '../i18n/en';
import type { WaitEstimate } from '../types';

// Staff screens are English; resident pages use the versions in ../i18n with their language.
export const formatEstimate = (sec: number | null | undefined) => i18nEstimate(en, sec);
export const formatRange = (e: WaitEstimate | null | undefined) => i18nRange(en, e);
export const formatRangeShort = (e: { lowSec: number; highSec: number } | null | undefined) => i18nRangeShort(en, e);

/** Compact "12m" / "1h 5m" for dashboards. */
export function formatMinutes(sec: number | null | undefined): string {
  if (sec == null) return '—';
  const min = Math.round(sec / 60);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

/** Live elapsed timer, "4:07" or "1:02:33". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatClock(ts: number, locale?: string): string {
  return new Date(ts).toLocaleTimeString(locale ?? [], { hour: 'numeric', minute: '2-digit' });
}

/** Spell out a ticket number for speech: "D-042" -> "D, 0, 4, 2". */
export function speakableTicket(number: string): string {
  return number.replace('-', ' ').split('').filter((c) => c.trim()).join(', ');
}

/** "13:30" -> "1:30 PM" (a wall-clock time already in the office's zone). */
export function formatHHMM(t: string): string {
  const h = Number(t.slice(0, 2));
  return `${h % 12 === 0 ? 12 : h % 12}:${t.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`;
}
