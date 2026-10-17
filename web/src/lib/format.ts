/** "about 8 min" style estimate for residents. */
export function formatEstimate(sec: number | null | undefined): string {
  if (sec == null) return '—';
  if (sec < 60) return 'Less than a minute';
  const min = Math.round(sec / 60);
  if (min < 60) return `About ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `About ${h} hr${m ? ` ${m} min` : ''}`;
}

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

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Spell out a ticket number for speech: "D-042" -> "D, 0, 4, 2". */
export function speakableTicket(number: string): string {
  return number.replace('-', ' ').split('').filter((c) => c.trim()).join(', ');
}
