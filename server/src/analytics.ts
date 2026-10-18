import type Redis from 'ioredis';
import { addDays, WEEKDAYS, zonedParts, type OfficeConfig, type Weekday } from './officeConfig';
import { QueueError } from './queueStore';
import type { PriorityReason, TicketKind } from './types';

// Ticket events are written by the queue's Lua scripts (see EVENT_FN in
// scripts.ts) to one list per office-local day: `<prefix>ev:<YYYY-MM-DD>`.
// Everything here only reads those lists, so the dashboard never touches the
// live queue's keys.

export type EventType = 'joined' | 'called' | 'served' | 'no_show' | 'left';

export interface TicketEvent {
  /** Timestamp (ms). */
  t: number;
  e: EventType;
  /** Visit: a hash of the ticket id (the id itself is a secret). */
  v: string;
  /** Ticket number, e.g. "D-042" (numbers restart daily). */
  n: string;
  /** Service id. */
  s: string;
  /** Counter id (called, served, no-show, and leaving while called). */
  c?: number;
  k?: TicketKind;
  p?: PriorityReason;
}

/** One ticket's journey, assembled from its events. */
export interface Visit {
  visit: string;
  number: string;
  service: string;
  kind: TicketKind;
  priority: PriorityReason | null;
  joinedAt: number;
  calledAt: number | null;
  endedAt: number | null;
  /** null while the ticket is still waiting or at a counter. */
  outcome: 'served' | 'no_show' | 'left' | null;
  counter: number | null;
}

export interface WaitBucket {
  count: number;
  avgWaitSec: number | null;
  maxWaitSec: number | null;
}

export interface AnalyticsReport {
  from: string;
  to: string;
  timezone: string;
  totals: {
    joined: number;
    served: number;
    noShows: number;
    left: number;
    /** Average and longest time from joining to being called. */
    avgWaitSec: number | null;
    maxWaitSec: number | null;
    /** Average time at the counter, for people served. */
    avgServiceSec: number | null;
    /** No-shows as a share of everyone called (served + no-show). */
    noShowRate: number | null;
  };
  /** By the hour people joined (office time), 0–23. */
  waitByHour: Array<WaitBucket & { hour: number }>;
  /** By the weekday people joined, Monday first. */
  waitByWeekday: Array<WaitBucket & { day: Weekday }>;
  /** Every day in the range, including empty ones. */
  perDay: Array<{ date: string; joined: number; served: number; noShows: number; left: number }>;
  /** Busiest first. */
  services: Array<{ id: string; name: string; code: string; joined: number; served: number; noShows: number; left: number; avgWaitSec: number | null; avgServiceSec: number | null; share: number }>;
  counters: Array<{ id: number; name: string; served: number; avgServiceSec: number | null }>;
}

// ---------------------------------------------------------------- calculations

/**
 * Group events into visits. A visit needs its "joined" event; the first call
 * counts for waiting time (recalls don't restart it), and the last ending wins.
 */
export function buildVisits(events: TicketEvent[]): Visit[] {
  const byVisit = new Map<string, Visit>();
  const sorted = [...events].sort((a, b) => a.t - b.t);
  for (const ev of sorted) {
    if (ev.e === 'joined') {
      if (!byVisit.has(ev.v)) {
        byVisit.set(ev.v, {
          visit: ev.v,
          number: ev.n,
          service: ev.s,
          kind: ev.k ?? 'walkin',
          priority: null,
          joinedAt: ev.t,
          calledAt: null,
          endedAt: null,
          outcome: null,
          counter: null,
        });
      }
      continue;
    }
    const v = byVisit.get(ev.v);
    if (!v) continue; // joined before the loaded range
    if (ev.e === 'called') {
      v.calledAt ??= ev.t;
      v.counter = ev.c ?? v.counter;
      if (ev.p) v.priority = ev.p;
    } else {
      v.outcome = ev.e;
      v.endedAt = ev.t;
      if (ev.c !== undefined) v.counter = ev.c;
    }
  }
  return [...byVisit.values()];
}

const sec = (ms: number) => Math.round(ms / 1000);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Waiting time in ms, for visits that were called (no-shows waited too). */
export const waitMs = (v: Visit): number | null => (v.calledAt === null ? null : Math.max(0, v.calledAt - v.joinedAt));
/** Time at the counter in ms, for visits that were served. */
export const serviceMs = (v: Visit): number | null =>
  v.outcome === 'served' && v.calledAt !== null && v.endedAt !== null ? Math.max(0, v.endedAt - v.calledAt) : null;

function waitBucket(visits: Visit[]): WaitBucket {
  const waits = visits.map(waitMs).filter((w): w is number => w !== null);
  const a = avg(waits);
  // A loop, not Math.max(...waits): spreading huge arrays overflows the stack.
  let max = -1;
  for (const w of waits) if (w > max) max = w;
  return { count: waits.length, avgWaitSec: a === null ? null : sec(a), maxWaitSec: waits.length ? sec(max) : null };
}

/** Every date from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The dashboard numbers for visits that *joined* between `from` and `to`
 * (office-local dates, inclusive).
 */
export function computeAnalytics(
  events: TicketEvent[],
  opts: { from: string; to: string; config: Pick<OfficeConfig, 'timezone' | 'services' | 'counters'> },
): AnalyticsReport {
  const { from, to, config } = opts;
  const tz = config.timezone;
  const local = new Map<string, ReturnType<typeof zonedParts>>();
  const partsOf = (ts: number) => {
    const key = String(ts);
    let p = local.get(key);
    if (!p) local.set(key, (p = zonedParts(ts, tz)));
    return p;
  };
  const visits = buildVisits(events).filter((v) => {
    const d = partsOf(v.joinedAt).dateKey;
    return d >= from && d <= to;
  });

  const served = visits.filter((v) => v.outcome === 'served');
  const noShows = visits.filter((v) => v.outcome === 'no_show').length;
  const left = visits.filter((v) => v.outcome === 'left').length;
  const all = waitBucket(visits);
  const serviceTimes = served.map(serviceMs).filter((x): x is number => x !== null);
  const avgService = avg(serviceTimes);

  // Group once (ranges can hold tens of thousands of visits).
  const group = <K,>(key: (v: Visit) => K) => {
    const m = new Map<K, Visit[]>();
    for (const v of visits) {
      const k = key(v);
      const list = m.get(k);
      if (list) list.push(v);
      else m.set(k, [v]);
    }
    return m;
  };
  const hours = group((v) => Math.floor(partsOf(v.joinedAt).minutes / 60));
  const weekdays = group((v) => partsOf(v.joinedAt).weekday);
  const dates = group((v) => partsOf(v.joinedAt).dateKey);
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, ...waitBucket(hours.get(hour) ?? []) }));
  const byWeekday = WEEKDAYS.map((day) => ({ day, ...waitBucket(weekdays.get(day) ?? []) }));

  const perDay = daysBetween(from, to).map((date) => {
    const day = dates.get(date) ?? [];
    return {
      date,
      joined: day.length,
      served: day.filter((v) => v.outcome === 'served').length,
      noShows: day.filter((v) => v.outcome === 'no_show').length,
      left: day.filter((v) => v.outcome === 'left').length,
    };
  });

  // Services: configured ones first (even if quiet), then any removed ones that still have history.
  const serviceIds = [...new Set([...config.services.map((s) => s.id), ...visits.map((v) => v.service)])];
  const services = serviceIds
    .map((id) => {
      const def = config.services.find((s) => s.id === id);
      const mine = visits.filter((v) => v.service === id);
      const times = mine.map(serviceMs).filter((x): x is number => x !== null);
      const a = avg(times);
      return {
        id,
        name: def?.name ?? id,
        code: def?.code ?? '?',
        joined: mine.length,
        served: mine.filter((v) => v.outcome === 'served').length,
        noShows: mine.filter((v) => v.outcome === 'no_show').length,
        left: mine.filter((v) => v.outcome === 'left').length,
        avgWaitSec: waitBucket(mine).avgWaitSec,
        avgServiceSec: a === null ? null : sec(a),
        share: visits.length ? mine.length / visits.length : 0,
      };
    })
    .filter((s) => s.joined > 0 || config.services.some((d) => d.id === s.id))
    .sort((a, b) => b.joined - a.joined || a.name.localeCompare(b.name));

  const counterIds = [...new Set([...config.counters.map((c) => c.id), ...served.map((v) => v.counter).filter((c): c is number => c !== null)])].sort((a, b) => a - b);
  const counters = counterIds.map((id) => {
    const times = served.filter((v) => v.counter === id).map(serviceMs).filter((x): x is number => x !== null);
    const a = avg(times);
    return { id, name: config.counters.find((c) => c.id === id)?.name ?? `Counter ${id}`, served: times.length, avgServiceSec: a === null ? null : sec(a) };
  });

  return {
    from,
    to,
    timezone: tz,
    totals: {
      joined: visits.length,
      served: served.length,
      noShows,
      left,
      avgWaitSec: all.avgWaitSec,
      maxWaitSec: all.maxWaitSec,
      avgServiceSec: avgService === null ? null : sec(avgService),
      noShowRate: served.length + noShows ? noShows / (served.length + noShows) : null,
    },
    waitByHour: byHour,
    waitByWeekday: byWeekday,
    perDay,
    services,
    counters,
  };
}

// ------------------------------------------------------------------------ CSV

/** Quote when needed, and defuse spreadsheet formulas (=, +, -, @) in text cells. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csv = (rows: Array<Array<string | number | null | undefined>>) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** "2026-03-04" and "14:05:09" in the office's time zone. */
export function localDateTime(ts: number, timeZone: string): { date: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(ts)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

export function eventsCsv(events: TicketEvent[], config: Pick<OfficeConfig, 'timezone' | 'services' | 'counters'>): string {
  const svc = (id: string) => config.services.find((s) => s.id === id)?.name ?? id;
  const ctr = (id: number | undefined) => (id === undefined ? '' : (config.counters.find((c) => c.id === id)?.name ?? `Counter ${id}`));
  const rows = [...events]
    .sort((a, b) => a.t - b.t)
    .map((e) => {
      const { date, time } = localDateTime(e.t, config.timezone);
      return [new Date(e.t).toISOString(), date, time, e.e, e.n, e.v, e.s, svc(e.s), e.c ?? '', ctr(e.c), e.k ?? '', e.p ?? ''];
    });
  return csv([['timestamp_utc', 'date', 'time', 'event', 'ticket', 'visit', 'service_id', 'service', 'counter_id', 'counter', 'kind', 'priority'], ...rows]);
}

export function visitsCsv(visits: Visit[], config: Pick<OfficeConfig, 'timezone' | 'services' | 'counters'>): string {
  const minutes = (ms: number | null) => (ms === null ? null : Math.round((ms / 60_000) * 10) / 10);
  const clock = (ts: number | null) => (ts === null ? '' : localDateTime(ts, config.timezone).time);
  const rows = [...visits]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((v) => [
      localDateTime(v.joinedAt, config.timezone).date,
      v.number,
      v.visit,
      config.services.find((s) => s.id === v.service)?.name ?? v.service,
      v.kind,
      v.priority ?? '',
      clock(v.joinedAt),
      clock(v.calledAt),
      clock(v.endedAt),
      v.outcome ?? 'open',
      v.counter === null ? '' : (config.counters.find((c) => c.id === v.counter)?.name ?? `Counter ${v.counter}`),
      minutes(waitMs(v)),
      minutes(serviceMs(v)),
    ]);
  return csv([['date', 'ticket', 'visit', 'service', 'kind', 'priority', 'joined', 'called', 'ended', 'outcome', 'counter', 'wait_minutes', 'service_minutes'], ...rows]);
}

// ---------------------------------------------------------------------- store

export const DEFAULT_ANALYTICS_DAYS = 90;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads one office's event history. */
export class AnalyticsStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    readonly config: OfficeConfig,
    private readonly opts: { retentionDays?: number; now?: () => number } = {},
  ) {}

  get retentionDays(): number {
    return this.opts.retentionDays ?? DEFAULT_ANALYTICS_DAYS;
  }

  today(): string {
    return zonedParts((this.opts.now ?? Date.now)(), this.config.timezone).dateKey;
  }

  /** Validate a requested range; defaults to the last 30 days. */
  range(from?: string, to?: string): { from: string; to: string } {
    const today = this.today();
    const end = to ?? today;
    const start = from ?? addDays(end, -29);
    if (!DATE.test(start) || !DATE.test(end) || start > end) throw new QueueError('invalid', 'Choose a start date on or before the end date.');
    if (end > today) throw new QueueError('invalid', 'The end date can’t be in the future.');
    if (start < addDays(today, -(this.retentionDays - 1))) throw new QueueError('invalid', `History goes back ${this.retentionDays} days.`);
    return { from: start, to: end };
  }

  /** Events from these days, plus the day after (people called after midnight). */
  async events(from: string, to: string): Promise<TicketEvent[]> {
    const days = daysBetween(from, addDays(to, 1));
    const pipe = this.redis.pipeline();
    for (const d of days) pipe.lrange(`${this.prefix}ev:${d}`, 0, -1);
    const res = (await pipe.exec()) ?? [];
    const out: TicketEvent[] = [];
    for (const [, rows] of res) for (const row of (rows as string[]) ?? []) out.push(JSON.parse(row) as TicketEvent);
    return out;
  }

  async report(from?: string, to?: string): Promise<AnalyticsReport> {
    const r = this.range(from, to);
    return computeAnalytics(await this.events(r.from, r.to), { ...r, config: this.config });
  }

  /** Raw events in the range (by event day), for export. */
  async eventsCsv(from?: string, to?: string): Promise<string> {
    const r = this.range(from, to);
    const days = new Set(daysBetween(r.from, r.to));
    const events = (await this.events(r.from, r.to)).filter((e) => days.has(zonedParts(e.t, this.config.timezone).dateKey));
    return eventsCsv(events, this.config);
  }

  /** One row per ticket that joined in the range, with wait and service minutes. */
  async visitsCsv(from?: string, to?: string): Promise<string> {
    const r = this.range(from, to);
    const visits = buildVisits(await this.events(r.from, r.to)).filter((v) => {
      const d = zonedParts(v.joinedAt, this.config.timezone).dateKey;
      return d >= r.from && d <= r.to;
    });
    return visitsCsv(visits, this.config);
  }
}

/** Keys holding the last `days` days of events (for TTL refreshes). */
export function eventKeys(prefix: string, today: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => `${prefix}ev:${addDays(today, -i)}`);
}
