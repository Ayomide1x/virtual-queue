import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppointmentBook } from '../src/appointments';
import { defaultConfig, type OfficeConfig } from '../src/officeConfig';
import { QueueStore } from '../src/queueStore';
import type { Ticket } from '../src/types';
import { closeAll, connect, deleteUnder } from './helpers';

const redis = connect();
const at = (hhmm: string) => new Date(`2026-03-04T${hhmm}:00Z`).getTime(); // a Wednesday, UTC office

const config: OfficeConfig = {
  ...defaultConfig('Priority Office', 'UTC'),
  counters: [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, name: `Counter ${id}` })),
};

let prefix: string;
let clock: number;
let store: QueueStore;
const newStore = (r = redis) => new QueueStore(r, { prefix, config, now: () => clock });
const newBook = (r = redis) => new AppointmentBook(r, newStore(r), { officeTtlSec: 3600 * 24 * 30, now: () => clock });

async function joinAt(hhmm: string, name: string, service = 'license') {
  clock = at(hhmm);
  return (await store.join(name, service)).ticket;
}

/** Order in which tickets were called, read from the lobby's "recent" list. */
async function callOrder(): Promise<string[]> {
  return (await store.getStaffState()).recent.map((r) => r.number).reverse();
}

beforeEach(() => {
  prefix = `test:${randomUUID()}:`;
  clock = at('09:00');
  store = newStore();
});
afterEach(() => deleteUnder(redis, prefix));
afterAll(closeAll);

describe('priority tickets', () => {
  it('are called before regular tickets in the same line', async () => {
    await joinAt('09:00', 'Ann');
    await joinAt('09:05', 'Ben');
    const cat = await joinAt('09:10', 'Cat');
    await store.setPriority(cat.number, 'disability');
    expect((await store.getTicketView(cat.id))?.position).toBe(1);
    expect((await store.callNext(1, 'license')).name).toBe('Cat');
    expect((await store.callNext(2, 'license')).name).toBe('Ann');
  });

  it('keep their own join order, not the order they were marked in', async () => {
    await joinAt('09:00', 'Ann');
    const ben = await joinAt('09:05', 'Ben');
    const cat = await joinAt('09:10', 'Cat');
    await store.setPriority(cat.number, 'senior'); // marked first…
    await store.setPriority(ben.number, 'other'); // …but Ben joined earlier
    const names = [];
    for (let c = 1; c <= 3; c++) names.push((await store.callNext(c, 'license')).name);
    expect(names).toEqual(['Ben', 'Cat', 'Ann']);
  });

  it('removing priority puts the ticket back in its original place', async () => {
    const ann = await joinAt('09:00', 'Ann');
    const ben = await joinAt('09:05', 'Ben');
    await store.setPriority(ben.number, 'senior');
    expect((await store.getTicketView(ann.id))?.position).toBe(2);
    await store.setPriority(ben.number, null);
    expect((await store.getTicketView(ann.id))?.position).toBe(1);
    expect((await store.getTicketView(ben.id))?.ticket.priority).toBeNull();
  });

  it('only affects its own line', async () => {
    const id1 = await joinAt('09:00', 'IdFirst', 'id');
    const lic = await joinAt('09:10', 'Lic', 'license');
    await store.setPriority(lic.number, 'senior');
    expect((await store.callNext(1, 'id')).id).toBe(id1.id);
  });

  it('“call any line” takes priority tickets first across lines', async () => {
    await joinAt('09:00', 'EarlyId', 'id');
    const lic = await joinAt('09:30', 'PriorityLic', 'license');
    await store.setPriority(lic.number, 'returning_no_show');
    expect((await store.callNext(1)).id).toBe(lic.id);
  });

  it('records the reason, shows it to staff, but never in the public lobby', async () => {
    const ann = await joinAt('09:00', 'Ann');
    await store.setPriority(ann.number, 'disability');
    const state = await store.getStaffState();
    expect(state.services[0].waiting[0]).toMatchObject({ number: ann.number, priority: 'disability' });
  });

  it('rejects unknown numbers, finished tickets and unknown reasons', async () => {
    await expect(store.setPriority('D-999', 'senior')).rejects.toMatchObject({ code: 'not_found' });
    const ann = await joinAt('09:00', 'Ann');
    await store.callNext(1, 'license');
    await expect(store.setPriority(ann.number, 'senior')).rejects.toMatchObject({ code: 'not_found' });
    const ben = await joinAt('09:05', 'Ben');
    await expect(store.setPriority(ben.number, 'vip' as never)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('beats checked-in appointments too', async () => {
    const book = newBook();
    clock = at('08:00');
    const appt = await book.book({ name: 'Appt', service: 'license', date: '2026-03-04', time: '10:00' });
    clock = at('10:00');
    await book.checkIn(appt.appointment.id);
    const late = await joinAt('10:20', 'Late');
    await store.setPriority(late.number, 'senior');
    expect((await store.callNext(1, 'license')).name).toBe('Late');
    expect((await store.callNext(2, 'license')).name).toBe('Appt');
  });
});

describe('concurrent Call Next with mixed priority, appointment and walk-in tickets', () => {
  it('assigns every ticket exactly once, in the correct order', async () => {
    const book = newBook();
    clock = at('08:00');
    const a1 = await book.book({ name: 'ApptLate', service: 'license', date: '2026-03-04', time: '10:00' });
    const a2 = await book.book({ name: 'ApptEarly', service: 'license', date: '2026-03-04', time: '10:00' });

    await joinAt('09:40', 'W1');
    await joinAt('09:50', 'W2');
    clock = at('09:55');
    await book.checkIn(a2.appointment.id); // early check-in still ranks at 10:00
    const w3 = await joinAt('10:02', 'W3');
    const w4 = await joinAt('10:03', 'W4');
    clock = at('10:04');
    await book.checkIn(a1.appointment.id); // late check-in still ranks at 10:00
    const w5 = await joinAt('10:06', 'W5');
    await store.setPriority(w5.number, 'senior');
    await store.setPriority(w3.number, 'disability');
    void w4;

    // Expected: priority (in join order) → walk-ins before 10:00 → appointments (slot 10:00,
    // in check-in order) → walk-ins after 10:00.
    const expected = ['W3', 'W5', 'W1', 'W2', 'ApptEarly', 'ApptLate', 'W4'];
    const waiting = (await store.getStaffState()).services[0].waiting.map((w) => w.name);
    expect(waiting).toEqual(expected);
    const numberOf = Object.fromEntries((await store.getStaffState()).services[0].waiting.map((w) => [w.name, w.number]));

    // 8 counters × 3 rounds, all fired at once from separate connections.
    clock = at('10:10');
    const calls: Promise<Ticket>[] = [];
    for (let round = 0; round < 3; round++) {
      for (let c = 1; c <= 8; c++) calls.push(newStore(connect()).callNext(c, 'license'));
    }
    const results = await Promise.allSettled(calls);
    const assigned = results.filter((r): r is PromiseFulfilledResult<Ticket> => r.status === 'fulfilled').map((r) => r.value);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason.code);

    expect(assigned).toHaveLength(expected.length);
    expect(new Set(assigned.map((t) => t.id)).size).toBe(expected.length);
    expect(errors.every((code) => code === 'empty' || code === 'counter_busy')).toBe(true);
    // Redis ran the calls one at a time; the order it called people in must match the queue order.
    expect(await callOrder()).toEqual(expected.map((n) => numberOf[n]));
    // No counter holds two people, and nobody is left waiting.
    const state = await store.getStaffState();
    expect(new Set(state.counters.filter((c) => c.ticket).map((c) => c.ticket!.number)).size).toBe(expected.length);
    expect(state.totals.waiting).toBe(0);
  });

  it('marking priority while counters are calling never loses or duplicates a ticket', async () => {
    const tickets = [];
    for (let i = 0; i < 12; i++) tickets.push(await joinAt(`09:${String(10 + i).padStart(2, '0')}`, `R${i}`));
    clock = at('10:00');
    const ops: Promise<unknown>[] = [];
    for (let c = 1; c <= 8; c++) ops.push(newStore(connect()).callNext(c, 'license'));
    for (const t of tickets.slice(6)) ops.push(newStore(connect()).setPriority(t.number, 'other').catch(() => null));
    await Promise.all(ops.map((p) => p.catch(() => null)));

    const state = await store.getStaffState();
    const atCounters = state.counters.filter((c) => c.ticket).map((c) => c.ticket!.number);
    const waiting = state.services[0].waiting.map((w) => w.number);
    expect(atCounters).toHaveLength(8);
    expect(new Set([...atCounters, ...waiting]).size).toBe(12);
    expect([...atCounters, ...waiting].sort()).toEqual(tickets.map((t) => t.number).sort());
  });
});
