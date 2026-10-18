import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppointmentBook } from '../src/appointments';
import { defaultConfig, slotsForDate, zonedTimeToUtc, type OfficeConfig } from '../src/officeConfig';
import { OfficeStore } from '../src/offices';
import { QueueStore } from '../src/queueStore';
import { closeAll, connect, deleteUnder, uniqueRoot } from './helpers';

const redis = connect();
const at = (hhmm: string, date = '2026-03-04') => new Date(`${date}T${hhmm}:00Z`).getTime(); // Wed, UTC office
const DATE = '2026-03-04';

const config: OfficeConfig = {
  ...defaultConfig('Appointments Office', 'UTC'),
  // Mon–Fri 09:00–17:00, Sat 09:00–13:00, Sun closed (defaults).
  appointments: { enabled: true, slotMinutes: 15, capacity: 2, daysAhead: 7, checkInEarlyMin: 15, checkInLateMin: 10 },
};

let prefix: string;
let clock: number;
let store: QueueStore;
let book: AppointmentBook;
const makeBook = (cfg = config, r = redis) => new AppointmentBook(r, new QueueStore(r, { prefix, config: cfg, now: () => clock }), { officeTtlSec: 30 * 86400, now: () => clock });

async function bookAt(time: string, name = 'Res', service = 'license', date = DATE) {
  return (await book.book({ name, service, date, time })).appointment;
}

beforeEach(() => {
  prefix = `test:${randomUUID()}:`;
  clock = at('08:00');
  store = new QueueStore(redis, { prefix, config, now: () => clock });
  book = makeBook();
});
afterEach(() => deleteUnder(redis, prefix));
afterAll(closeAll);

describe('slots', () => {
  it('are generated from the opening hours and slot length', () => {
    const slots = slotsForDate(config, DATE);
    expect(slots).toHaveLength(32); // 8 hours × 4 per hour
    expect(slots[0]).toEqual({ time: '09:00', start: at('09:00') });
    expect(slots.at(-1)?.time).toBe('16:45');
    expect(slotsForDate(config, '2026-03-07')).toHaveLength(16); // Saturday 09–13
    expect(slotsForDate(config, '2026-03-08')).toEqual([]); // Sunday closed
  });

  it('are converted to UTC in the office time zone, across daylight-saving changes', () => {
    // US DST starts 2026-03-08: 9 AM New York is 14:00 UTC before, 13:00 UTC after.
    expect(zonedTimeToUtc('2026-03-06', '09:00', 'America/New_York')).toBe(at('14:00', '2026-03-06'));
    expect(zonedTimeToUtc('2026-03-09', '09:00', 'America/New_York')).toBe(at('13:00', '2026-03-09'));
  });

  it('availability hides past slots and counts remaining places', async () => {
    clock = at('12:05');
    await bookAt('12:30', 'A');
    const today = (await book.availability('license'))[0];
    expect(today.date).toBe(DATE);
    expect(today.slots[0].time).toBe('12:15');
    expect(today.slots.find((s) => s.time === '12:30')?.remaining).toBe(1);
    // Capacity is per service.
    expect((await book.availability('id'))[0].slots.find((s) => s.time === '12:30')?.remaining).toBe(2);
  });

  it('rejects times off the grid, past slots, dates out of range, closed days and disabled booking', async () => {
    await expect(bookAt('10:07')).rejects.toMatchObject({ code: 'invalid' });
    await expect(bookAt('07:00')).rejects.toMatchObject({ code: 'invalid' });
    clock = at('11:00');
    await expect(bookAt('10:30')).rejects.toMatchObject({ code: 'invalid', message: 'That time has already passed.' });
    await expect(bookAt('10:00', 'X', 'license', '2026-03-20')).rejects.toMatchObject({ code: 'invalid' });
    await expect(bookAt('10:00', 'X', 'license', '2026-03-08')).rejects.toMatchObject({ code: 'invalid' });
    const off = makeBook({ ...config, appointments: { ...config.appointments, enabled: false } });
    await expect(off.book({ name: 'X', service: 'license', date: DATE, time: '12:00' })).rejects.toMatchObject({ code: 'appointments_off' });
  });

  it('never overbooks a slot, even with simultaneous bookings', async () => {
    const attempts = Array.from({ length: 10 }, (_, i) => makeBook(config, connect()).book({ name: `P${i}`, service: 'license', date: DATE, time: '10:00' }));
    const results = await Promise.allSettled(attempts);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'slot_full')).toBe(true);
    expect((await book.availability('license'))[0].slots.find((s) => s.time === '10:00')?.remaining).toBe(0);
  });

  it('cancelling frees the place again', async () => {
    const a = await bookAt('10:00', 'A');
    await bookAt('10:00', 'B');
    await expect(bookAt('10:00', 'C')).rejects.toMatchObject({ code: 'slot_full' });
    await book.cancel(a.id);
    await expect(bookAt('10:00', 'C')).resolves.toMatchObject({ name: 'C' });
    await expect(book.checkIn(a.id)).rejects.toMatchObject({ message: 'This appointment was cancelled.' });
  });
});

describe('check-in', () => {
  it('is refused before the window opens, saying when it does', async () => {
    const a = await bookAt('10:00');
    clock = at('09:44');
    await expect(book.checkIn(a.id)).rejects.toMatchObject({
      code: 'too_early',
      message: 'It’s too early to check in. Check-in opens at 9:45 AM.',
    });
    expect((await book.view(a.id))?.checkIn).toMatchObject({ open: false, opensLabel: '9:45 AM', closesLabel: '10:10 AM' });
  });

  it('works at the edges of the window', async () => {
    const a = await bookAt('10:00', 'Edge1');
    const b = await bookAt('10:00', 'Edge2');
    clock = at('09:45');
    await expect(book.checkIn(a.id)).resolves.toBeTruthy();
    clock = at('10:10');
    await expect(book.checkIn(b.id)).resolves.toBeTruthy();
  });

  it('ranks the ticket as if it joined at the slot time', async () => {
    const appt = await bookAt('10:00', 'Appt');
    const before = await (async () => ((clock = at('09:50')), (await store.join('Before', 'license')).ticket))();
    const after = await (async () => ((clock = at('10:02')), (await store.join('After', 'license')).ticket))();
    clock = at('10:08'); // checks in late, but still within the window
    const ticketId = await book.checkIn(appt.id);
    const view = await store.getTicketView(ticketId);
    expect(view).toMatchObject({ position: 2, ticket: { kind: 'appointment', appointmentAt: at('10:00'), name: 'Appt' } });
    expect((await store.getTicketView(before.id))?.position).toBe(1);
    expect((await store.getTicketView(after.id))?.position).toBe(3);
  });

  it('checking in early does not jump people who joined before the slot', async () => {
    const appt = await bookAt('10:00', 'Appt');
    clock = at('09:46');
    const ticketId = await book.checkIn(appt.id);
    clock = at('09:55');
    const walkIn = (await store.join('WalkIn', 'license')).ticket;
    expect((await store.getTicketView(walkIn.id))?.position).toBe(1);
    expect((await store.getTicketView(ticketId))?.position).toBe(2);
  });

  it('after the window closes the appointment is missed, and stays missed', async () => {
    const a = await bookAt('10:00');
    clock = at('10:11');
    expect((await book.view(a.id))?.appointment.status).toBe('missed');
    await expect(book.checkIn(a.id)).rejects.toMatchObject({ code: 'missed' });
    clock = at('09:50'); // even if the clock were somehow earlier, it was persisted
    await expect(book.checkIn(a.id)).rejects.toMatchObject({ code: 'not_active' });
    expect(await redis.hget(`${prefix}appt:${a.id}`, 'status')).toBe('missed');
  });

  it('missed appointments are swept for the day view', async () => {
    const a = await bookAt('10:00', 'Missed');
    const b = await bookAt('11:00', 'Upcoming');
    clock = at('10:30');
    const day = await book.day(DATE);
    expect(day.entries.map((e) => [e.name, e.status, e.canCheckIn])).toEqual([
      ['Missed', 'missed', false],
      ['Upcoming', 'booked', false],
    ]);
    expect(await redis.hget(`${prefix}appt:${a.id}`, 'status')).toBe('missed');
    clock = at('10:50');
    expect((await book.day(DATE)).entries[1]).toMatchObject({ canCheckIn: true });
    void b;
  });

  it('checking in twice returns the same ticket', async () => {
    const a = await bookAt('10:00');
    clock = at('10:00');
    const t1 = await book.checkIn(a.id);
    const t2 = await book.checkIn(a.id);
    expect(t2).toBe(t1);
    expect((await store.getStaffState()).totals.waiting).toBe(1);
  });

  it('simultaneous check-ins of one appointment create a single ticket', async () => {
    const a = await bookAt('10:00');
    clock = at('10:00');
    const ids = await Promise.all(Array.from({ length: 6 }, () => makeBook(config, connect()).checkIn(a.id)));
    expect(new Set(ids).size).toBe(1);
    expect((await store.getStaffState()).totals.waiting).toBe(1);
  });

  it('the day view links checked-in appointments to their ticket', async () => {
    const a = await bookAt('10:00', 'Linked');
    clock = at('10:00');
    await book.checkIn(a.id);
    const entry = (await book.day(DATE)).entries[0];
    expect(entry).toMatchObject({ status: 'checked_in', ticket: { status: 'waiting' } });
    expect(entry.ticket?.number).toMatch(/^D-\d{3}$/);
  });
});

describe('settings', () => {
  it('a service with upcoming appointments cannot be removed', async () => {
    const offices = new OfficeStore(redis, { root: uniqueRoot() });
    const { officeId, config: cfg } = await offices.create({ timezone: 'UTC' });
    const officeBook = offices.appointments(officeId, cfg);
    const days = await officeBook.availability('id');
    const day = days.find((d) => d.slots.length)!;
    await officeBook.book({ name: 'A', service: 'id', date: day.date, time: day.slots[0].time });
    await expect(offices.saveSettings(officeId, { ...cfg, services: cfg.services.filter((s) => s.id !== 'id') })).rejects.toMatchObject({
      code: 'service_busy',
      message: expect.stringMatching(/1 upcoming appointment is booked/),
    });
    await deleteUnder(redis, offices.root);
  });
});
