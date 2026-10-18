import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import type { TicketEvent } from './analytics';
import { addDays, weekdayOf, zonedParts, zonedTimeToUtc, type OfficeConfig, type Weekday } from './officeConfig';
import type { PriorityReason } from './types';

/**
 * Realistic past days for the analytics dashboard in demos. Each day is a small
 * simulation of the office: arrivals follow a daily curve (busy mid-morning and
 * after lunch, Mondays busiest), counters work at slightly different speeds,
 * people are served first come first served by whichever counter frees up, a
 * few give up when the wait is long, and some don't come up when called.
 *
 * Writes the same events the live queue writes, to the same per-day lists.
 * Days that already have events (real history) are left alone, so seeding
 * again never duplicates anything.
 */

const MIN = 60_000;

/** Small, fast, seedable PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedOf = (text: string) => createHash('sha256').update(text).digest().readUInt32BE(0);

/** Hours used when the office has no opening hours set. */
const DEFAULT_HOURS: Record<Weekday, { open: string; close: string } | null> = {
  mon: { open: '08:30', close: '17:00' },
  tue: { open: '08:30', close: '17:00' },
  wed: { open: '08:30', close: '17:00' },
  thu: { open: '08:30', close: '17:00' },
  fri: { open: '08:30', close: '17:00' },
  sat: { open: '09:00', close: '13:00' },
  sun: null,
};

/** How busy each weekday is, relative to an average day. */
const DAY_LOAD: Record<Weekday, number> = { mon: 1.25, tue: 1.0, wed: 0.9, thu: 0.95, fri: 1.1, sat: 1.15, sun: 0.8 };

/** Arrival rate through the day (by local hour), relative to capacity. */
function hourLoad(hour: number): number {
  const curve: Record<number, number> = { 7: 0.5, 8: 0.75, 9: 1.0, 10: 1.25, 11: 1.15, 12: 0.8, 13: 1.1, 14: 1.0, 15: 0.85, 16: 0.65, 17: 0.4, 18: 0.3 };
  return curve[hour] ?? 0.35;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Simulate one day and return its events. Exported for tests. */
export function simulateDay(config: OfficeConfig, date: string, seed: number): TicketEvent[] {
  const rand = prng(seed);
  const weekday = weekdayOf(date);
  const hours = (config.hoursEnabled ? config.hours : DEFAULT_HOURS)[weekday];
  if (!hours || config.services.length === 0 || config.counters.length === 0) return [];
  const tz = config.timezone;

  // Staff: everyone on weekdays, about half on Saturdays.
  const counters = config.counters.slice(0, weekday === 'sat' ? Math.max(1, Math.ceil(config.counters.length / 2)) : config.counters.length);
  // Each counter has its own pace (some staff are quicker than others).
  const PACES = [1.0, 0.85, 1.2, 0.92, 1.1, 0.8, 1.15, 0.95];
  const pace = new Map(config.counters.map((c, i) => [c.id, PACES[i % PACES.length]]));

  // Service mix: the first service is the busiest.
  const weights = config.services.map((_, i) => 1 / (i + 1.3));
  const totalW = weights.reduce((a, b) => a + b, 0);
  const pickService = () => {
    let r = rand() * totalW;
    for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) <= 0) return config.services[i];
    return config.services[0];
  };
  const meanServiceSec = config.services.reduce((a, s, i) => a + s.defaultServiceSec * weights[i], 0) / totalW;
  const perHourCapacity = (counters.length * 3600) / meanServiceSec;
  // Day-to-day variation, so the chart doesn't look machine-made.
  const dayNoise = 0.85 + rand() * 0.3;

  // Arrivals: a Poisson process whose rate follows the hourly curve.
  const openMin = toMin(hours.open);
  const closeMin = toMin(hours.close);
  // Opening time in UTC, worked out once (DST changes happen overnight, never during opening hours).
  const openUtc = zonedTimeToUtc(date, hours.open, tz);
  const arrivals: number[] = [];
  for (let m = openMin; m < closeMin; m++) {
    const rate = (perHourCapacity * 0.82 * DAY_LOAD[weekday] * hourLoad(Math.floor(m / 60)) * dayNoise) / 60; // per minute
    let k = 0;
    // Poisson sample for this minute.
    const L = Math.exp(-rate);
    for (let p = rand(); p > L; p *= rand()) k++;
    for (let i = 0; i < k; i++) arrivals.push(openUtc + (m - openMin) * MIN + Math.floor(rand() * MIN));
  }
  arrivals.sort((a, b) => a - b);

  const freeAt = new Map(counters.map((c) => [c.id, openUtc]));
  const seq = new Map<string, number>();
  const events: TicketEvent[] = [];
  const priorities: PriorityReason[] = ['senior', 'disability', 'senior', 'returning_no_show'];

  for (const at of arrivals) {
    const svc = pickService();
    const n = (seq.get(svc.id) ?? 0) + 1;
    seq.set(svc.id, n);
    const number = `${svc.code}-${String(((n - 1) % 999) + 1).padStart(3, '0')}`;
    const v = Math.floor(rand() * 2 ** 48).toString(16).padStart(12, '0');
    const kind = config.appointments.enabled && rand() < 0.08 ? 'appointment' : 'walkin';
    events.push({ t: at, e: 'joined', v, n: number, s: svc.id, k: kind });

    // First come, first served: the counter that frees up soonest takes them.
    let counter = counters[0].id;
    for (const c of counters) if (freeAt.get(c.id)! < freeAt.get(counter)!) counter = c.id;
    const start = Math.max(at, freeAt.get(counter)!);

    // Patience: most people wait, some give up when it gets long.
    const patience = (20 + -Math.log(1 - rand()) * 50) * MIN;
    if (start - at > patience) {
      events.push({ t: at + Math.round(patience), e: 'left', v, n: number, s: svc.id });
      continue;
    }
    const priority = rand() < 0.04 ? priorities[Math.floor(rand() * priorities.length)] : undefined;
    events.push({ t: start, e: 'called', v, n: number, s: svc.id, c: counter, k: kind, ...(priority ? { p: priority } : {}) });
    if (rand() < 0.07) {
      // Didn't come up: the counter waits a minute or two, then moves on.
      const end = start + Math.round((1 + rand()) * MIN);
      events.push({ t: end, e: 'no_show', v, n: number, s: svc.id, c: counter });
      freeAt.set(counter, end);
      continue;
    }
    // Service time: skewed (most are quick, a few take much longer).
    const factor = Math.exp((rand() + rand() + rand() - 1.5) * 0.6);
    const durMs = Math.round(svc.defaultServiceSec * 1000 * pace.get(counter)! * factor);
    const end = start + Math.max(45_000, durMs);
    events.push({ t: end, e: 'served', v, n: number, s: svc.id, c: counter });
    freeAt.set(counter, end + Math.round(rand() * 30_000)); // a short reset between people
  }
  return events.sort((a, b) => a.t - b.t);
}

/** Fill the past `days` days (not today) with simulated history. Returns how many days were written. */
export async function seedHistory(
  redis: Redis,
  opts: { prefix: string; config: OfficeConfig; officeTtlSec?: number; days?: number; now?: number },
): Promise<number> {
  const ttl = opts.officeTtlSec ?? 30 * 24 * 3600;
  const today = zonedParts(opts.now ?? Date.now(), opts.config.timezone).dateKey;
  const dates = Array.from({ length: opts.days ?? 60 }, (_, i) => addDays(today, -(i + 1)));
  const keyOf = (d: string) => `${opts.prefix}ev:${d}`;

  const check = redis.pipeline();
  for (const d of dates) check.exists(keyOf(d));
  const exists = ((await check.exec()) ?? []).map(([, n]) => n === 1);

  const write = redis.pipeline();
  let written = 0;
  dates.forEach((d, i) => {
    if (exists[i]) return; // real (or already seeded) history: keep it
    const events = simulateDay(opts.config, d, seedOf(`${opts.prefix}${d}`));
    if (!events.length) return;
    write.rpush(keyOf(d), ...events.map((e) => JSON.stringify(e)));
    write.expire(keyOf(d), ttl);
    written++;
  });
  if (written) await write.exec();
  return written;
}
