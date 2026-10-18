import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { QueueError, QueueStore, toLobbyState } from '../src/queueStore';
import type { Ticket } from '../src/types';
import { defaultConfig, type OfficeConfig } from '../src/officeConfig';
import { seedOffice } from '../src/seed';

const url = inject('redisUrl');
const connections: Redis[] = [];
const connect = () => {
  const r = new Redis(url);
  connections.push(r);
  return r;
};
const redis = connect();

let prefix: string;
let clock: number;
let store: QueueStore;
const MIN = 60_000;

/** Default services (D/V/I) and six counters. */
const config: OfficeConfig = {
  ...defaultConfig('Test Office', 'UTC'),
  counters: [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `Counter ${id}` })),
};

/** A store with its own Redis connection, as a second server process would have. */
const storeOnNewConnection = () => new QueueStore(connect(), { prefix, config, now: () => clock });

async function expectQueueError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(QueueError);
  await expect(p).rejects.toMatchObject({ code });
}

beforeEach(() => {
  prefix = `test:${randomUUID()}:`;
  clock = new Date('2026-03-02T10:00:00').getTime();
  store = new QueueStore(redis, { prefix, config, now: () => clock });
});

afterEach(async () => {
  await store.reset();
});

afterAll(async () => {
  await Promise.all(connections.map((c) => c.quit()));
});

describe('joining', () => {
  it('issues sequential, service-prefixed ticket numbers', async () => {
    const a = await store.join('Maria', 'license');
    const b = await store.join('James', 'license');
    const c = await store.join('Aisha', 'registration');
    expect([a.ticket.number, b.ticket.number, c.ticket.number]).toEqual(['D-001', 'D-002', 'V-001']);
    expect(a.ticket.status).toBe('waiting');
  });

  it('reports position, people ahead and estimated wait', async () => {
    await store.join('A', 'license');
    await store.join('B', 'license');
    const c = await store.join('C', 'license');
    expect(c.position).toBe(3);
    expect(c.ahead).toBe(2);
    // No history yet: falls back to the default 360s for driver's licenses.
    expect(c.estimatedWaitSec).toBe(2 * 360);
  });

  it('estimates wait from the rolling average of real service times', async () => {
    for (const durationMin of [2, 4]) {
      await store.join('X', 'id');
      await store.callNext(1, 'id');
      clock += durationMin * MIN;
      await store.markServed(1);
    }
    expect(await store.avgServiceSec('id')).toBe(180);
    await store.join('P', 'id');
    const q = await store.join('Q', 'id');
    expect(q.estimatedWaitSec).toBe(1 * 180);
  });

  it('rolling average only keeps the most recent durations', async () => {
    const s = new QueueStore(redis, { prefix, config, now: () => clock, svcTimesMax: 3 });
    for (const durationMin of [10, 1, 1, 1]) {
      await s.join('X', 'id');
      await s.callNext(1, 'id');
      clock += durationMin * MIN;
      await s.markServed(1);
    }
    expect(await s.avgServiceSec('id')).toBe(60);
  });

  it('rejects blank names', async () => {
    await expectQueueError(store.join('   ', 'license'), 'invalid');
  });
});

describe('calling', () => {
  it('calls residents in order and assigns the counter', async () => {
    const a = await store.join('A', 'license');
    const b = await store.join('B', 'license');
    const called = await store.callNext(2, 'license');
    expect(called.id).toBe(a.ticket.id);
    expect(called.status).toBe('called');
    expect(called.counter).toBe(2);

    const bView = await store.getTicketView(b.ticket.id);
    expect(bView?.position).toBe(1);
    expect(bView?.ahead).toBe(0);
  });

  it('without a service, calls whoever has waited longest across lines', async () => {
    await store.join('Late', 'license', { joinedAt: clock - 1 * MIN });
    const early = await store.join('Early', 'id', { joinedAt: clock - 10 * MIN });
    expect((await store.callNext(1)).id).toBe(early.ticket.id);
  });

  it('calling an empty queue is a clear error, not a crash', async () => {
    await expectQueueError(store.callNext(1, 'license'), 'empty');
    await expectQueueError(store.callNext(1), 'empty');
  });

  it('refuses to call while the counter is still serving someone', async () => {
    await store.join('A', 'license');
    await store.join('B', 'license');
    await store.callNext(1, 'license');
    await expectQueueError(store.callNext(1, 'license'), 'counter_busy');
  });

  it('rejects counters outside the configured range', async () => {
    await expectQueueError(store.callNext(0), 'invalid');
    await expectQueueError(store.callNext(99), 'invalid');
  });
});

describe('pausing', () => {
  it('blocks calls on a paused line, and resumes', async () => {
    const a = await store.join('A', 'license');
    await store.setPaused('license', true);
    await expectQueueError(store.callNext(1, 'license'), 'paused');
    expect((await store.getTicketView(a.ticket.id))?.servicePaused).toBe(true);

    await store.setPaused('license', false);
    expect((await store.callNext(1, 'license')).id).toBe(a.ticket.id);
  });

  it('"call any" skips paused lines even if they have waited longer', async () => {
    await store.join('Paused line', 'license', { joinedAt: clock - 10 * MIN });
    const open = await store.join('Open line', 'id', { joinedAt: clock - 1 * MIN });
    await store.setPaused('license', true);
    expect((await store.callNext(1)).id).toBe(open.ticket.id);
  });

  it('residents can still join a paused line', async () => {
    await store.setPaused('id', true);
    const v = await store.join('A', 'id');
    expect(v.position).toBe(1);
    expect(v.servicePaused).toBe(true);
  });
});

describe('finishing', () => {
  it('mark served records stats and frees the counter', async () => {
    await store.join('A', 'license', { joinedAt: clock - 4 * MIN });
    await store.callNext(3, 'license');
    clock += 5 * MIN;
    const t = await store.markServed(3);
    expect(t.status).toBe('served');

    const state = await store.getStaffState();
    const lic = state.services.find((s) => s.id === 'license')!;
    expect(lic.servedToday).toBe(1);
    expect(lic.avgWaitSec).toBe(240);
    expect(lic.avgServiceSec).toBe(300);
    expect(state.counters[2].ticket).toBeNull();
    expect(state.counters[2].last).toMatchObject({ number: 'D-001', outcome: 'served' });
  });

  it('cannot mark served twice', async () => {
    await store.join('A', 'license');
    await store.callNext(1, 'license');
    await store.markServed(1);
    await expectQueueError(store.markServed(1), 'no_active');
  });

  it('no-show is counted separately and does not affect service times', async () => {
    await store.join('A', 'license');
    await store.callNext(1, 'license');
    clock += 10 * MIN;
    const t = await store.markNoShow(1);
    expect(t.status).toBe('no_show');
    const lic = (await store.getStaffState()).services.find((s) => s.id === 'license')!;
    expect(lic.noShowToday).toBe(1);
    expect(lic.servedToday).toBe(0);
    expect(lic.avgServiceSec).toBe(360); // still the default
  });

  it('rejects completing a ticket the screen no longer shows (stale UI guard)', async () => {
    const a = await store.join('A', 'license');
    await store.join('B', 'license');
    await store.callNext(1, 'license');
    await store.markServed(1, a.ticket.id);
    const b = await store.callNext(1, 'license');
    await expectQueueError(store.markServed(1, a.ticket.id), 'stale');
    expect((await store.getTicket(b.id))?.status).toBe('called');
  });

  it('recall re-announces the current ticket', async () => {
    await store.join('A', 'license');
    await store.callNext(4, 'license');
    const t = await store.recall(4);
    expect(t.recallCount).toBe(1);
    const state = await store.getStaffState();
    expect(state.recent[0]).toMatchObject({ number: 'D-001', counter: 4, recall: true });
    await store.markServed(4);
    await expectQueueError(store.recall(4), 'no_active');
  });
});

describe('leaving', () => {
  it('leaving moves everyone behind up', async () => {
    await store.join('A', 'registration');
    const b = await store.join('B', 'registration');
    const c = await store.join('C', 'registration');
    expect(await store.leave(b.ticket.id)).toBe('waiting');
    expect((await store.getTicketView(c.ticket.id))?.position).toBe(2);
    expect((await store.getTicketView(b.ticket.id))?.ticket.status).toBe('left');
  });

  it('resident leaving while being called frees the counter and tells staff why', async () => {
    const a = await store.join('A', 'license');
    await store.callNext(2, 'license');
    expect(await store.leave(a.ticket.id)).toBe('called');

    const state = await store.getStaffState();
    expect(state.counters[1].ticket).toBeNull();
    expect(state.counters[1].last).toMatchObject({ number: 'D-001', outcome: 'left' });
    // Staff pressing "Mark Served" on the now-empty counter gets a clean error.
    await expectQueueError(store.markServed(2), 'no_active');
    // And the counter can immediately call the next person.
    await store.join('B', 'license');
    await expect(store.callNext(2, 'license')).resolves.toMatchObject({ name: 'B' });
  });

  it('cannot leave twice or leave after being served', async () => {
    const a = await store.join('A', 'license');
    await store.leave(a.ticket.id);
    await expectQueueError(store.leave(a.ticket.id), 'not_active');

    const b = await store.join('B', 'license');
    await store.callNext(1, 'license');
    await store.markServed(1);
    await expectQueueError(store.leave(b.ticket.id), 'not_active');
  });

  it('unknown ticket ids are reported as not found', async () => {
    await expectQueueError(store.leave(randomUUID()), 'not_found');
    expect(await store.getTicketView(randomUUID())).toBeNull();
  });
});

describe('concurrency', () => {
  it('two staff pressing Call Next at the same moment never get the same ticket', async () => {
    const only = await store.join('Only', 'license');
    const s1 = storeOnNewConnection();
    const s2 = storeOnNewConnection();

    const results = await Promise.allSettled([s1.callNext(1, 'license'), s2.callNext(2, 'license')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({ code: 'empty' });

    const state = await store.getStaffState();
    const assigned = state.counters.filter((c) => c.ticket);
    expect(assigned).toHaveLength(1);
    expect((await store.getTicket(only.ticket.id))?.counter).toBe(assigned[0].counter);
  });

  it('many counters calling at once each get a distinct ticket, in order', async () => {
    const COUNTERS = 6;
    const TICKETS = 4; // fewer tickets than counters, so some calls must find the line empty
    const joined = [];
    for (let i = 0; i < TICKETS; i++) joined.push(await store.join(`R${i}`, 'license'));

    // Fire every call several times over, all at once, from separate connections.
    const calls: Promise<Ticket>[] = [];
    for (let round = 0; round < 3; round++) {
      for (let c = 1; c <= COUNTERS; c++) {
        const s = new QueueStore(connect(), { prefix, config, now: () => clock });
        calls.push(s.callNext(c, 'license'));
      }
    }
    const results = await Promise.allSettled(calls);
    const assignedIds = results
      .filter((r): r is PromiseFulfilledResult<Ticket> => r.status === 'fulfilled')
      .map((r) => r.value.id);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason.code);

    expect(new Set(assignedIds).size).toBe(TICKETS);
    expect(assignedIds).toHaveLength(TICKETS);
    expect(new Set(assignedIds)).toEqual(new Set(joined.map((j) => j.ticket.id)));
    expect(errors.every((code) => code === 'empty' || code === 'counter_busy')).toBe(true);

    const state = await store.getStaffState();
    const atCounters = state.counters.filter((c) => c.ticket).map((c) => c.ticket!.number);
    expect(new Set(atCounters).size).toBe(TICKETS);
    expect(state.services.find((s) => s.id === 'license')!.waitingCount).toBe(0);
  });

  it('double-clicking Call Next on one counter calls only one resident', async () => {
    await store.join('A', 'license');
    await store.join('B', 'license');
    const s1 = storeOnNewConnection();
    const s2 = storeOnNewConnection();
    const results = await Promise.allSettled([s1.callNext(1, 'license'), s2.callNext(1, 'license')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('counter_busy');
    expect((await store.getStaffState()).services.find((s) => s.id === 'license')!.waitingCount).toBe(1);
  });

  it('a resident leaving at the moment they are called leaves state consistent', async () => {
    for (let i = 0; i < 20; i++) {
      const t = await store.join('Racer', 'id');
      const [left] = await Promise.allSettled([storeOnNewConnection().leave(t.ticket.id), storeOnNewConnection().callNext(1, 'id')]);
      expect(left.status).toBe('fulfilled');
      const ticket = await store.getTicket(t.ticket.id);
      expect(ticket?.status).toBe('left');
      // Whichever order they ran in, the counter is not left pointing at a departed resident.
      const state = await store.getStaffState();
      expect(state.counters[0].ticket).toBeNull();
      expect(state.services.find((s) => s.id === 'id')!.waitingCount).toBe(0);
    }
  });
});

describe('views', () => {
  it('lobby state exposes ticket numbers but never names', async () => {
    await store.join('Secretname', 'license');
    await store.callNext(1, 'license');
    await store.join('Othersecret', 'id');
    const lobby = toLobbyState(await store.getStaffState());
    expect(lobby.nowServing).toEqual([expect.objectContaining({ counter: 1, number: 'D-001' })]);
    expect(JSON.stringify(lobby)).not.toMatch(/secret/i);
  });

  it('staff state never exposes secret ticket ids', async () => {
    const a = await store.join('A', 'license');
    await store.join('B', 'license');
    await store.callNext(1, 'license');
    expect(JSON.stringify(await store.getStaffState())).not.toContain(a.ticket.id);
  });

  it('the seed script produces a populated, consistent demo', async () => {
    await seedOffice(redis, { prefix, config });
    const live = new QueueStore(redis, { prefix, config });
    const state = await live.getStaffState();
    expect(state.totals.waiting).toBeGreaterThanOrEqual(10);
    expect(state.totals.servedToday).toBeGreaterThan(5);
    expect(state.counters.filter((c) => c.ticket)).toHaveLength(2);
    for (const s of state.services) expect(s.waitingCount).toBeGreaterThan(0);
  });
});
