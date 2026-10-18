import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildVisits, computeAnalytics, csvCell, eventsCsv, visitsCsv, type TicketEvent } from '../src/analytics';
import { createApp } from '../src/app';
import { seedHistory, simulateDay } from '../src/history';
import { seedOffice } from '../src/seed';
import { defaultConfig, type OfficeConfig } from '../src/officeConfig';
import { OfficeStore } from '../src/offices';
import { closeAll, connect, deleteUnder, uniqueRoot } from './helpers';

const MIN = 60_000;
const utc = (iso: string) => new Date(iso).getTime();
const config: OfficeConfig = { ...defaultConfig(), name: 'Test', timezone: 'UTC' };

/** Events for one visit: joined, then optionally called/ended at minute offsets. */
function visit(
  v: string,
  joinedIso: string,
  opts: { service?: string; called?: number; ended?: number; outcome?: 'served' | 'no_show' | 'left'; counter?: number; recalls?: number } = {},
): TicketEvent[] {
  const t0 = utc(joinedIso);
  const s = opts.service ?? 'license';
  const out: TicketEvent[] = [{ t: t0, e: 'joined', v, n: v.toUpperCase(), s, k: 'walkin' }];
  if (opts.called !== undefined) {
    out.push({ t: t0 + opts.called * MIN, e: 'called', v, n: v.toUpperCase(), s, c: opts.counter ?? 1 });
    for (let i = 1; i <= (opts.recalls ?? 0); i++) out.push({ t: t0 + (opts.called + i) * MIN, e: 'called', v, n: v.toUpperCase(), s, c: opts.counter ?? 1 });
  }
  if (opts.outcome) out.push({ t: t0 + (opts.ended ?? 0) * MIN, e: opts.outcome, v, n: v.toUpperCase(), s, c: opts.outcome === 'left' && opts.called === undefined ? undefined : (opts.counter ?? 1) });
  return out;
}

// ------------------------------------------------------------ calculations

describe('calculations', () => {
  it('builds visits: first call sets the wait (recalls don’t), order doesn’t matter, orphans are ignored', () => {
    const events = [
      ...visit('a', '2026-03-02T09:00:00Z', { called: 10, recalls: 2, ended: 20, outcome: 'served', counter: 2 }),
      { t: utc('2026-03-02T09:30:00Z'), e: 'served', v: 'ghost', n: 'X', s: 'license', c: 1 } as TicketEvent,
    ].reverse();
    const [a, ...rest] = buildVisits(events);
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ visit: 'a', joinedAt: utc('2026-03-02T09:00:00Z'), calledAt: utc('2026-03-02T09:10:00Z'), outcome: 'served', counter: 2 });
  });

  it('totals: average and longest wait, average service time, no-show rate', () => {
    const events = [
      ...visit('a', '2026-03-02T09:00:00Z', { called: 10, ended: 16, outcome: 'served' }), // wait 10, service 6
      ...visit('b', '2026-03-02T09:05:00Z', { called: 20, ended: 32, outcome: 'served' }), // wait 20, service 12
      ...visit('c', '2026-03-02T09:10:00Z', { called: 30, ended: 32, outcome: 'no_show' }), // wait 30, no service time
      ...visit('d', '2026-03-02T09:15:00Z', { ended: 40, outcome: 'left' }), // never called: no wait counted
      ...visit('e', '2026-03-02T09:20:00Z'), // still waiting
    ];
    const r = computeAnalytics(events, { from: '2026-03-02', to: '2026-03-02', config });
    expect(r.totals).toEqual({
      joined: 5,
      served: 2,
      noShows: 1,
      left: 1,
      avgWaitSec: 20 * 60, // (10 + 20 + 30) / 3
      maxWaitSec: 30 * 60,
      avgServiceSec: 9 * 60, // (6 + 12) / 2
      noShowRate: 1 / 3, // of the 3 people called
    });
  });

  it('wait by hour and weekday use the hour people joined, in the office’s time zone (DST included)', () => {
    const ny = { ...config, timezone: 'America/New_York' };
    const events = [
      // Monday 2 March 2026 (EST, UTC-5): 14:30Z is 9:30 local
      ...visit('a', '2026-03-02T14:30:00Z', { called: 10, ended: 15, outcome: 'served' }),
      ...visit('b', '2026-03-02T14:50:00Z', { called: 30, ended: 35, outcome: 'served' }),
      // Wednesday 11 March 2026 (EDT, UTC-4): 13:30Z is 9:30 local too
      ...visit('c', '2026-03-11T13:30:00Z', { called: 5, ended: 9, outcome: 'served' }),
      ...visit('d', '2026-03-11T15:00:00Z', { called: 40, ended: 45, outcome: 'served' }), // 11:00 local
    ];
    const r = computeAnalytics(events, { from: '2026-03-01', to: '2026-03-14', config: ny });
    expect(r.waitByHour[9]).toEqual({ hour: 9, count: 3, avgWaitSec: 15 * 60, maxWaitSec: 30 * 60 });
    expect(r.waitByHour[11]).toEqual({ hour: 11, count: 1, avgWaitSec: 40 * 60, maxWaitSec: 40 * 60 });
    expect(r.waitByHour[14]).toEqual({ hour: 14, count: 0, avgWaitSec: null, maxWaitSec: null });
    expect(r.waitByWeekday.find((d) => d.day === 'mon')).toEqual({ day: 'mon', count: 2, avgWaitSec: 20 * 60, maxWaitSec: 30 * 60 });
    expect(r.waitByWeekday.find((d) => d.day === 'wed')).toMatchObject({ count: 2, avgWaitSec: 22.5 * 60, maxWaitSec: 40 * 60 });
    expect(r.waitByWeekday.map((d) => d.day)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });

  it('per day: every day in the range, counted on the day people joined', () => {
    const events = [
      ...visit('a', '2026-03-02T23:50:00Z', { called: 20, ended: 30, outcome: 'served' }), // served after midnight
      ...visit('b', '2026-03-04T10:00:00Z', { called: 5, ended: 7, outcome: 'no_show' }),
      ...visit('c', '2026-03-04T10:01:00Z', { ended: 50, outcome: 'left' }),
      ...visit('z', '2026-03-06T10:00:00Z', { called: 5, ended: 9, outcome: 'served' }), // outside the range
    ];
    const r = computeAnalytics(events, { from: '2026-03-02', to: '2026-03-05', config });
    expect(r.perDay).toEqual([
      { date: '2026-03-02', joined: 1, served: 1, noShows: 0, left: 0 },
      { date: '2026-03-03', joined: 0, served: 0, noShows: 0, left: 0 },
      { date: '2026-03-04', joined: 2, served: 0, noShows: 1, left: 1 },
      { date: '2026-03-05', joined: 0, served: 0, noShows: 0, left: 0 },
    ]);
    expect(r.totals.joined).toBe(3);
  });

  it('busiest services first, with shares; quiet and removed services still listed', () => {
    const events = [
      ...visit('a', '2026-03-02T09:00:00Z', { service: 'id', called: 4, ended: 8, outcome: 'served' }),
      ...visit('b', '2026-03-02T09:01:00Z', { service: 'id', called: 6, ended: 7, outcome: 'no_show' }),
      ...visit('c', '2026-03-02T09:02:00Z', { service: 'id', ended: 30, outcome: 'left' }),
      ...visit('d', '2026-03-02T09:03:00Z', { service: 'license', called: 2, ended: 12, outcome: 'served' }),
      ...visit('e', '2026-03-02T09:04:00Z', { service: 'passport', called: 1, ended: 3, outcome: 'served' }), // service since removed
    ];
    const r = computeAnalytics(events, { from: '2026-03-02', to: '2026-03-02', config });
    expect(r.services.map((s) => [s.id, s.joined])).toEqual([
      ['id', 3],
      ['license', 1],
      ['passport', 1],
      ['registration', 0],
    ]);
    expect(r.services[0]).toMatchObject({ name: 'ID Card', served: 1, noShows: 1, left: 1, avgWaitSec: 5 * 60, avgServiceSec: 4 * 60, share: 0.6 });
    expect(r.services.find((s) => s.id === 'passport')).toMatchObject({ name: 'passport', code: '?' });
    expect(r.services.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1);
  });

  it('average service time per counter counts served people only', () => {
    const events = [
      ...visit('a', '2026-03-02T09:00:00Z', { called: 1, ended: 5, outcome: 'served', counter: 1 }), // 4 min
      ...visit('b', '2026-03-02T09:00:00Z', { called: 2, ended: 10, outcome: 'served', counter: 1 }), // 8 min
      ...visit('c', '2026-03-02T09:00:00Z', { called: 3, ended: 5, outcome: 'no_show', counter: 1 }), // excluded
      ...visit('d', '2026-03-02T09:00:00Z', { called: 3, ended: 13, outcome: 'served', counter: 3 }), // 10 min
      ...visit('e', '2026-03-02T09:00:00Z', { called: 3, ended: 8, outcome: 'served', counter: 9 }), // counter since removed
    ];
    const r = computeAnalytics(events, { from: '2026-03-02', to: '2026-03-02', config });
    expect(r.counters).toEqual([
      { id: 1, name: 'Counter 1', served: 2, avgServiceSec: 6 * 60 },
      { id: 2, name: 'Counter 2', served: 0, avgServiceSec: null },
      { id: 3, name: 'Counter 3', served: 1, avgServiceSec: 10 * 60 },
      { id: 4, name: 'Counter 4', served: 0, avgServiceSec: null },
      { id: 9, name: 'Counter 9', served: 1, avgServiceSec: 5 * 60 },
    ]);
  });

  it('an empty range gives zeros and nulls, not errors', () => {
    const r = computeAnalytics([], { from: '2026-03-02', to: '2026-03-03', config });
    expect(r.totals).toEqual({ joined: 0, served: 0, noShows: 0, left: 0, avgWaitSec: null, maxWaitSec: null, avgServiceSec: null, noShowRate: null });
    expect(r.perDay).toHaveLength(2);
    expect(r.services.every((s) => s.share === 0)).toBe(true);
  });

  it('handles a large range quickly', () => {
    const events: TicketEvent[] = [];
    for (let d = 0; d < 90; d++) events.push(...simulateDay(config, `2026-01-${String((d % 28) + 1).padStart(2, '0')}`, d));
    const started = performance.now();
    const r = computeAnalytics(events, { from: '2026-01-01', to: '2026-01-28', config });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(r.totals.joined).toBeGreaterThan(5000);
  });
});

// ------------------------------------------------------------------- CSV

describe('CSV export', () => {
  it('quotes cells that need it and defuses spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-5)).toBe('-5'); // numbers are fine
    expect(csvCell(null)).toBe('');
  });

  it('events CSV: one row per event, office-local date and time, names for services and counters', () => {
    const ny = { ...config, timezone: 'America/New_York', services: [{ ...config.services[0], name: '=Licenses, renewals' }, ...config.services.slice(1)] };
    const out = eventsCsv(visit('a', '2026-03-02T14:30:00Z', { called: 10, ended: 15, outcome: 'served', counter: 2 }), ny);
    const lines = out.trim().split('\r\n');
    expect(lines[0]).toBe('timestamp_utc,date,time,event,ticket,visit,service_id,service,counter_id,counter,kind,priority');
    expect(lines[1]).toBe(`2026-03-02T14:30:00.000Z,2026-03-02,09:30:00,joined,A,a,license,"'=Licenses, renewals",,,walkin,`);
    expect(lines[2]).toContain(',09:40:00,called,A,a,license,');
    expect(lines[3]).toContain(',2,Counter 2,,');
    expect(lines).toHaveLength(4);
  });

  it('tickets CSV: one row per ticket with wait and service minutes', () => {
    const v = buildVisits([...visit('a', '2026-03-02T09:00:00Z', { called: 12.5, ended: 20, outcome: 'served', counter: 1 }), ...visit('b', '2026-03-02T09:05:00Z')]);
    const lines = visitsCsv(v, config).trim().split('\r\n');
    expect(lines[0]).toBe('date,ticket,visit,service,kind,priority,joined,called,ended,outcome,counter,wait_minutes,service_minutes');
    expect(lines[1]).toBe("2026-03-02,A,a,Driver's License,walkin,,09:00:00,09:12:30,09:20:00,served,Counter 1,12.5,7.5");
    expect(lines[2]).toBe("2026-03-02,B,b,Driver's License,walkin,,09:05:00,,,open,,,");
  });
});

// ------------------------------------------------- recording + API (real Redis)

const redis = connect();
let root: string;
let offices: OfficeStore;
let clock: number;
const at = (hhmm: string) => utc(`2026-03-04T${hhmm}:00Z`); // a Wednesday

beforeEach(() => {
  root = uniqueRoot();
  clock = at('09:00');
  offices = new OfficeStore(redis, { root, now: () => clock });
});
afterEach(() => deleteUnder(redis, root));
afterAll(closeAll);

describe('recording events from the live queue', () => {
  it('records every ticket event with time, service and counter, under a hash of the ticket id', async () => {
    const { officeId, config: cfg } = await offices.create({ name: 'Rec', timezone: 'UTC' });
    const q = offices.queue(officeId, cfg, { now: () => clock });
    const a = (await q.join('Ann', 'license')).ticket;
    const b = (await q.join('Bob', 'license')).ticket;
    const c = (await q.join('Cy', 'id')).ticket;
    const d = (await q.join('Dee', 'id')).ticket;
    clock = at('09:10');
    await q.callNext(2, 'license'); // Ann
    clock = at('09:16');
    await q.markServed(2);
    clock = at('09:20');
    await q.callNext(3, 'license'); // Bob
    clock = at('09:22');
    await q.markNoShow(3);
    await q.leave(c.id); // Cy leaves while waiting
    clock = at('09:25');
    await q.callNext(4, 'id'); // Dee
    await q.leave(d.id); // …and leaves while called

    const raw = await redis.lrange(`${root}o:${officeId}:ev:2026-03-04`, 0, -1);
    const events = raw.map((r) => JSON.parse(r) as TicketEvent);
    expect(events.map((e) => [e.e, e.n, e.s, e.c ?? null])).toEqual([
      ['joined', a.number, 'license', null],
      ['joined', b.number, 'license', null],
      ['joined', c.number, 'id', null],
      ['joined', d.number, 'id', null],
      ['called', a.number, 'license', 2],
      ['served', a.number, 'license', 2],
      ['called', b.number, 'license', 3],
      ['no_show', b.number, 'license', 3],
      ['left', c.number, 'id', null],
      ['called', d.number, 'id', 4],
      ['left', d.number, 'id', 4],
    ]);
    expect(events[5].t).toBe(at('09:16'));
    // The secret ticket id never appears; the visit hash links a ticket's events.
    expect(raw.join()).not.toContain(a.id);
    expect(new Set(events.filter((e) => e.n === a.number).map((e) => e.v)).size).toBe(1);
    expect(await redis.ttl(`${root}o:${officeId}:ev:2026-03-04`)).toBeGreaterThan(0);

    const report = await offices.analytics(officeId, cfg).report('2026-03-04', '2026-03-04');
    expect(report.totals).toMatchObject({ joined: 4, served: 1, noShows: 1, left: 2, avgWaitSec: ((10 + 20 + 25) * 60) / 3, avgServiceSec: 6 * 60, noShowRate: 0.5 });
  });

  it('records appointment check-ins as joins of kind "appointment", and priority on the call', async () => {
    const { officeId, config: cfg0 } = await offices.create({ name: 'Appt', timezone: 'UTC' });
    const cfg = await offices.saveSettings(officeId, { ...cfg0, appointments: { ...cfg0.appointments, enabled: true } });
    const book = offices.appointments(officeId, cfg, { now: () => clock });
    const appt = (await book.book({ name: 'Eva', service: 'id', date: '2026-03-04', time: '12:00' })).appointment;
    clock = at('11:55');
    await book.checkIn(appt.id);
    const q = offices.queue(officeId, cfg, { now: () => clock });
    const walk = (await q.join('Walt', 'license')).ticket;
    await q.setPriority(walk.number, 'senior');
    await q.callNext(1, 'license');
    const events = (await redis.lrange(`${root}o:${officeId}:ev:2026-03-04`, 0, -1)).map((r) => JSON.parse(r) as TicketEvent);
    expect(events[0]).toMatchObject({ e: 'joined', s: 'id', k: 'appointment', t: at('11:55') });
    expect(events.find((e) => e.e === 'called')).toMatchObject({ n: walk.number, p: 'senior', k: 'walkin' });
  });

  it('clearing the queues (reset, and the demo seed) keeps the history', async () => {
    const { officeId, config: cfg } = await offices.create({ name: 'Keep', timezone: 'UTC' });
    const q = offices.queue(officeId, cfg, { now: () => clock });
    await q.join('Ann', 'license');
    await q.reset();
    expect(await redis.llen(`${root}o:${officeId}:ev:2026-03-04`)).toBe(1);
    expect(await q.getStaffState().then((s) => s.totals.waiting)).toBe(0);
  });

  it('keeps history alive while the office is active (TTL refresh)', async () => {
    const { officeId, config: cfg } = await offices.create({ name: 'TTL', timezone: 'UTC' });
    const key = `${root}o:${officeId}:ev:2026-02-20`;
    await redis.rpush(key, '{}');
    await redis.expire(key, 60);
    await offices.touch(officeId, cfg, { force: true });
    expect(await redis.ttl(key)).toBeGreaterThan(60 * 60 * 24);
  });
});

describe('seeded history', () => {
  it('writes realistic past days once, and never over real history', async () => {
    const { officeId, config: cfg } = await offices.create({ name: 'Seed', timezone: 'UTC' });
    const prefix = `${root}o:${officeId}:`;
    await redis.rpush(`${prefix}ev:2026-03-03`, JSON.stringify({ t: at('08:00') - 86_400_000, e: 'joined', v: 'real', n: 'D-001', s: 'license' }));
    const written = await seedHistory(redis, { prefix, config: cfg, days: 28, now: at('09:00') });
    expect(written).toBe(28 - 1 - 4); // minus the real day, minus 4 Sundays (closed by default)
    expect(await redis.llen(`${prefix}ev:2026-03-03`)).toBe(1); // real day untouched
    expect(await seedHistory(redis, { prefix, config: cfg, days: 28, now: at('09:00') })).toBe(0); // idempotent
    expect(await redis.exists(`${prefix}ev:2026-03-04`)).toBe(0); // not today

    const r = await offices.analytics(officeId, cfg).report('2026-02-04', '2026-03-03');
    const day = (d: string) => r.waitByWeekday.find((x) => x.day === d)!;
    // Looks like a real office: busy, mostly served, a few no-shows and walk-outs.
    expect(r.totals.joined).toBeGreaterThan(1500);
    expect(r.totals.noShowRate!).toBeGreaterThan(0.03);
    expect(r.totals.noShowRate!).toBeLessThan(0.12);
    expect(r.totals.left / r.totals.joined).toBeLessThan(0.15);
    expect(day('sun').count).toBe(0);
    // Mondays are busier than Wednesdays, and the mid-morning rush waits longer than opening time.
    expect(r.perDay.filter((d) => d.date >= '2026-02-09' && new Date(d.date).getUTCDay() === 1).reduce((a, d) => a + d.joined, 0)).toBeGreaterThan(
      r.perDay.filter((d) => d.date >= '2026-02-09' && new Date(d.date).getUTCDay() === 3).reduce((a, d) => a + d.joined, 0),
    );
    expect(r.waitByHour[11].avgWaitSec!).toBeGreaterThan(r.waitByHour[8].avgWaitSec!);
    // Counters work at different speeds.
    const speeds = r.counters.map((c) => c.avgServiceSec!);
    expect(Math.max(...speeds) - Math.min(...speeds)).toBeGreaterThan(30);
  });

  it('the demo seed (as used by "create office with sample data") leaves weeks of history', async () => {
    const { officeId, config: cfg } = await offices.create({ name: 'Demo', timezone: 'UTC' });
    await seedOffice(redis, { prefix: `${root}o:${officeId}:`, config: cfg, historyDays: 14 });
    const keys = await redis.keys(`${root}o:${officeId}:ev:*`);
    expect(keys.length).toBeGreaterThanOrEqual(12); // 14 past days minus Sundays, plus today
  });

  it('simulated days are consistent: every call follows a join, every ending follows its call', () => {
    const events = simulateDay({ ...config, timezone: 'America/Chicago' }, '2026-03-09', 7);
    const visits = buildVisits(events);
    expect(visits.length).toBeGreaterThan(50);
    for (const v of visits) {
      if (v.calledAt !== null) expect(v.calledAt).toBeGreaterThanOrEqual(v.joinedAt);
      if (v.endedAt !== null) expect(v.endedAt).toBeGreaterThanOrEqual(v.calledAt ?? v.joinedAt);
      expect(v.outcome).not.toBeNull(); // history days are complete
    }
    // Same seed, same day.
    expect(simulateDay({ ...config, timezone: 'America/Chicago' }, '2026-03-09', 7)).toEqual(events);
    // Honors the office's own hours: closed days have nothing.
    const hours = { ...config.hours, mon: null };
    expect(simulateDay({ ...config, hoursEnabled: true, hours }, '2026-03-09', 7)).toEqual([]);
  });
});

describe('analytics API', () => {
  it('needs the staff key, validates the range, and exports CSV', async () => {
    const { server, io } = createApp({ redis, subscriber: connect(), offices, publicUrl: null, lanIp: null });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    try {
      const created = await (await fetch(`${base}/offices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"timezone":"UTC"}' })).json();
      const o = `${base}/o/${created.officeId}`;
      const key = { 'x-staff-key': created.staffKey };
      const other = await (await fetch(`${base}/offices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();

      for (const path of ['/analytics', '/analytics/events.csv', '/analytics/visits.csv']) {
        expect((await fetch(o + path)).status).toBe(401);
        expect((await fetch(o + path, { headers: { 'x-staff-key': other.staffKey } })).status).toBe(403);
      }

      await fetch(`${o}/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Ann","service":"license"}' });
      const report = await (await fetch(`${o}/analytics?from=2026-03-01&to=2026-03-04`, { headers: key })).json();
      expect(report).toMatchObject({ from: '2026-03-01', to: '2026-03-04', today: '2026-03-04', retentionDays: 90 });
      expect(report.totals.joined).toBe(1);
      expect(report.perDay).toHaveLength(4);

      const bad = async (q: string) => (await fetch(`${o}/analytics?${q}`, { headers: key })).status;
      expect(await bad('from=2026-03-05&to=2026-03-04')).toBe(400); // backwards
      expect(await bad('to=2026-03-05')).toBe(400); // future
      expect(await bad('from=2025-11-01&to=2026-03-04')).toBe(400); // past retention
      expect(await bad('from=yesterday')).toBe(400);
      expect(await bad('from=&to=')).toBe(200); // blank means "use the default

      const csvRes = await fetch(`${o}/analytics/events.csv?from=2026-03-04&to=2026-03-04`, { headers: key });
      expect(csvRes.headers.get('content-type')).toContain('text/csv');
      expect(csvRes.headers.get('content-disposition')).toContain(`events-${created.officeId}-2026-03-04-to-2026-03-04.csv`);
      const bytes = new Uint8Array(await csvRes.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM, so Excel shows accents right
      const body = new TextDecoder().decode(bytes);
      expect(body).toContain('joined,D-001');
      expect(body).not.toContain('Ann'); // names stay out of exports
      const tickets = await (await fetch(`${o}/analytics/visits.csv?from=2026-03-04&to=2026-03-04`, { headers: key })).text();
      expect(tickets.split('\r\n')[1]).toContain(',open,');
    } finally {
      io.close();
    }
  });
});
