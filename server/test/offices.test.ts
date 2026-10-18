import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OfficeStore } from '../src/offices';
import { QueueError } from '../src/queueStore';
import { seedOffice } from '../src/seed';
import { closeAll, connect, deleteUnder, keysUnder, sleep, uniqueRoot } from './helpers';

const redis = connect();
let root: string;
let offices: OfficeStore;

beforeEach(() => {
  root = uniqueRoot();
  offices = new OfficeStore(redis, { root });
});
afterEach(() => deleteUnder(redis, root));
afterAll(closeAll);

async function newOffice(store = offices) {
  const created = await store.create({ name: 'Test Office', timezone: 'UTC' });
  return { ...created, queue: store.queue(created.officeId, created.config) };
}

describe('creating offices', () => {
  it('returns a random office id and staff key, storing only a hash of the key', async () => {
    const a = await newOffice();
    const b = await newOffice();
    expect(a.officeId).toMatch(/^[a-z0-9]{10}$/);
    expect(a.officeId).not.toBe(b.officeId);
    expect(a.staffKey.length).toBeGreaterThanOrEqual(32);
    const meta = await redis.hgetall(`${root}o:${a.officeId}:meta`);
    expect(JSON.stringify(meta)).not.toContain(a.staffKey);
    expect(meta.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies the right key and rejects wrong, empty or other offices’ keys', async () => {
    const a = await newOffice();
    const b = await newOffice();
    expect(await offices.verifyKey(a.officeId, a.staffKey)).toBe(true);
    expect(await offices.verifyKey(a.officeId, b.staffKey)).toBe(false);
    expect(await offices.verifyKey(a.officeId, a.staffKey + 'x')).toBe(false);
    expect(await offices.verifyKey(a.officeId, '')).toBe(false);
    expect(await offices.verifyKey(a.officeId, undefined)).toBe(false);
    expect(await offices.verifyKey('nosuchoffice', a.staffKey)).toBe(false);
  });

  it('unknown or malformed office ids are simply not found', async () => {
    expect(await offices.getConfig('doesnotexist')).toBeNull();
    expect(await offices.getConfig('../../etc')).toBeNull();
    expect(await offices.getConfig('a:b*')).toBeNull();
  });
});

describe('isolation between offices', () => {
  it('each office has its own queue, ticket numbers, stats and counters', async () => {
    const a = await newOffice();
    const b = await newOffice();
    const ta = await a.queue.join('Alice', 'license');
    const tb = await b.queue.join('Bob', 'license');
    // Numbering is per office.
    expect(ta.ticket.number).toBe('D-001');
    expect(tb.ticket.number).toBe('D-001');

    // Office B can't see or fetch A's ticket, even knowing its secret id.
    expect(await b.queue.getTicketView(ta.ticket.id)).toBeNull();
    await expect(b.queue.leave(ta.ticket.id)).rejects.toMatchObject({ code: 'not_found' });

    // Calling next in B never takes A's resident.
    expect((await b.queue.callNext(1)).name).toBe('Bob');
    await expect(b.queue.callNext(2)).rejects.toMatchObject({ code: 'empty' });
    const stateA = await a.queue.getStaffState();
    expect(stateA.totals.waiting).toBe(1);
    expect(stateA.counters.every((c) => c.ticket === null)).toBe(true);
    expect(JSON.stringify(stateA)).not.toContain('Bob');
  });

  it('pausing, resetting and seeding one office leaves the other untouched', async () => {
    const a = await newOffice();
    const b = await newOffice();
    await a.queue.join('Alice', 'license');
    await b.queue.setPaused('license', true);
    await b.queue.reset();
    await seedOffice(redis, { prefix: offices.prefixFor(b.officeId), config: b.config });

    const stateA = await a.queue.getStaffState();
    expect(stateA.services[0].paused).toBe(false);
    expect(stateA.totals.waiting).toBe(1);
    expect(stateA.totals.servedToday).toBe(0);
    expect((await b.queue.getStaffState()).totals.waiting).toBeGreaterThan(10);
    // Reset keeps the office itself.
    expect(await offices.getConfig(b.officeId)).not.toBeNull();
  });

  it('every key an office writes lives under its own prefix', async () => {
    const a = await newOffice();
    await seedOffice(redis, { prefix: offices.prefixFor(a.officeId), config: a.config });
    const all = await keysUnder(redis, root);
    expect(all.length).toBeGreaterThan(5);
    expect(all.every((k) => k.startsWith(`${root}o:${a.officeId}:`))).toBe(true);
  });
});

describe('settings', () => {
  it('renaming services and counters keeps people in line', async () => {
    const a = await newOffice();
    const t = await a.queue.join('Alice', 'license');
    const next = structuredClone(a.config);
    next.name = 'Downtown DMV';
    next.services[0].name = 'Licenses & Permits';
    next.services[0].code = 'L'; // existing tickets keep their number; new ones use L
    next.counters[0].name = 'Window A';
    const saved = await offices.saveSettings(a.officeId, next);
    const q = offices.queue(a.officeId, saved);

    const view = await q.getTicketView(t.ticket.id);
    expect(view).toMatchObject({ position: 1, serviceName: 'Licenses & Permits' });
    expect((await q.join('Bea', 'license')).ticket.number).toBe('L-002');
    const called = await q.callNext(1);
    expect(q.counterName(called.counter)).toBe('Window A');
  });

  it('refuses to remove a service while people are waiting in it', async () => {
    const a = await newOffice();
    await a.queue.join('Alice', 'id');
    const next = { ...a.config, services: a.config.services.filter((s) => s.id !== 'id') };
    const err = await offices.saveSettings(a.officeId, next).catch((e) => e);
    expect(err).toBeInstanceOf(QueueError);
    expect(err.message).toMatch(/Can’t remove “ID Card” while 1 person is still waiting/);
    expect((await offices.getConfig(a.officeId))!.services).toHaveLength(3);
  });

  it('refuses to remove a service whose resident is at a counter, or a busy counter', async () => {
    const a = await newOffice();
    await a.queue.join('Alice', 'id');
    await a.queue.callNext(2);
    await expect(offices.saveSettings(a.officeId, { ...a.config, services: a.config.services.slice(0, 2) })).rejects.toMatchObject({
      code: 'service_busy',
    });
    await expect(offices.saveSettings(a.officeId, { ...a.config, counters: a.config.counters.filter((c) => c.id !== 2) })).rejects.toMatchObject({
      code: 'counter_busy',
    });
    // Removing an idle counter and adding a service is fine.
    const saved = await offices.saveSettings(a.officeId, {
      ...a.config,
      counters: a.config.counters.filter((c) => c.id !== 4),
      services: [...a.config.services, { name: 'Passports', code: 'P', defaultServiceSec: 300 }],
    });
    expect(saved.counters.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(saved.services.at(-1)?.id).toMatch(/^s/);
  });

  it('joining is refused outside opening hours, with the reason', async () => {
    const a = await newOffice();
    const closed = { ...a.config, hoursEnabled: true, hours: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null } };
    const q = offices.queue(a.officeId, await offices.saveSettings(a.officeId, closed));
    await expect(q.join('Alice', 'license')).rejects.toMatchObject({ code: 'closed', message: 'Joining is closed right now.' });
    expect(q.officeInfo().status.open).toBe(false);
  });
});

describe('expiry after inactivity', () => {
  it('every key of an office has a TTL no longer than the office TTL', async () => {
    const ttl = 3600;
    const store = new OfficeStore(redis, { root, ttlSec: ttl });
    const a = await newOffice(store);
    const q = a.queue;
    await seedOffice(redis, { prefix: store.prefixFor(a.officeId), config: a.config, officeTtlSec: ttl });
    const t = await q.join('Alice', 'license');
    await q.setPaused('id', true);
    await q.recall(1);
    await q.leave(t.ticket.id);
    await store.saveSettings(a.officeId, { ...a.config, name: 'Renamed' });

    const keys = await keysUnder(redis, root);
    const ttls = await Promise.all(keys.map((k) => redis.ttl(k)));
    const bad = keys.filter((_, i) => ttls[i] < 0 || ttls[i] > ttl);
    expect(bad).toEqual([]);
  });

  it('activity refreshes the TTL', async () => {
    const store = new OfficeStore(redis, { root, ttlSec: 100, touchIntervalMs: 0 });
    const a = await newOffice(store);
    await a.queue.join('Alice', 'license');
    const meta = `${root}o:${a.officeId}:meta`;
    await redis.expire(meta, 5);
    await store.touch(a.officeId, a.config);
    expect(await redis.ttl(meta)).toBeGreaterThan(90);
  });

  it('an office with no activity expires completely, and is then unknown', async () => {
    const store = new OfficeStore(redis, { root, ttlSec: 1 });
    const a = await newOffice(store);
    await a.queue.join('Alice', 'license');
    await a.queue.callNext(1);
    await sleep(2100);
    expect(await store.getConfig(a.officeId)).toBeNull();
    expect(await keysUnder(redis, root)).toEqual([]);
  });
});
