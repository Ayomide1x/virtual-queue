import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, type OfficeConfig } from '../src/officeConfig';
import { QueueStore } from '../src/queueStore';
import { closeAll, connect, deleteUnder } from './helpers';

const redis = connect();
const MIN = 60_000;
const config: OfficeConfig = {
  ...defaultConfig('Estimates Office', 'UTC'),
  counters: [1, 2, 3, 4].map((id) => ({ id, name: `Counter ${id}` })),
};

let prefix: string;
let clock: number;
let store: QueueStore;

/** Serve one resident of `service` at `counter`, taking `sec` seconds. */
async function serve(counter: number, service: string, sec: number) {
  await store.join('Served', service);
  await store.callNext(counter, service);
  clock += sec * 1000;
  await store.markServed(counter);
}

async function waitFor(n: number, service: string) {
  for (let i = 0; i < n; i++) await store.join(`W${i}`, service);
}

const svc = async (id: string) => (await store.getStaffState()).services.find((s) => s.id === id)!;

beforeEach(() => {
  prefix = `test:${randomUUID()}:`;
  clock = new Date('2026-03-04T10:00:00Z').getTime();
  store = new QueueStore(redis, { prefix, config, now: () => clock });
});
afterEach(() => deleteUnder(redis, prefix));
afterAll(closeAll);

describe('wait estimates', () => {
  it('with no history, use the default service time and one counter, as a range', async () => {
    await waitFor(2, 'license'); // default 360s
    const s = await svc('license');
    expect(s.activeCounters).toBe(0);
    expect(s.estimate).toEqual({ sec: 720, lowSec: 540, highSec: 936 });
  });

  it('use the middle half of recent service times for the range', async () => {
    for (const sec of [60, 120, 180, 240, 300]) await serve(1, 'id', sec);
    await waitFor(2, 'id');
    const s = await svc('id');
    expect(s.avgServiceSec).toBe(180);
    expect(s.activeCounters).toBe(1);
    // 2 people × (25th pct 120s … mean 180s … 75th pct 240s) ÷ 1 counter
    expect(s.estimate).toEqual({ sec: 360, lowSec: 240, highSec: 480 });
  });

  it('divide by the number of counters actively serving the line', async () => {
    for (let i = 0; i < 3; i++) {
      await serve(1, 'id', 180);
      await serve(2, 'id', 180);
    }
    await waitFor(4, 'id');
    const s = await svc('id');
    expect(s.activeCounters).toBe(2);
    expect(s.estimate.sec).toBe((4 * 180) / 2);
    const last = await store.join('Last', 'id');
    expect(last.ahead).toBe(4);
    expect(last.estimate?.sec).toBe(360);
  });

  it('a counter splitting its time between two lines counts as half for each', async () => {
    await serve(3, 'license', 300);
    await serve(3, 'id', 180);
    await serve(4, 'id', 180);
    const state = await store.getStaffState();
    expect(state.services.find((s) => s.id === 'license')!.activeCounters).toBe(0.5);
    expect(state.services.find((s) => s.id === 'id')!.activeCounters).toBe(1.5);
  });

  it('counters that have stopped calling from a line drop out of the count', async () => {
    await serve(1, 'id', 180);
    await serve(2, 'id', 180);
    clock += 31 * MIN;
    await serve(1, 'id', 180);
    expect((await svc('id')).activeCounters).toBe(1);
  });

  it('a counter busy with a long service still counts for that line', async () => {
    await store.join('Long', 'license');
    await store.callNext(2, 'license');
    clock += 45 * MIN; // its call is now outside the window
    expect((await svc('license')).activeCounters).toBe(1);
  });

  it('prefer service times from the rolling window over older ones', async () => {
    for (let i = 0; i < 3; i++) await serve(1, 'id', 900); // slow, long ago
    clock += 4 * 60 * MIN;
    for (let i = 0; i < 3; i++) await serve(1, 'id', 120); // quick, recent
    expect((await svc('id')).avgServiceSec).toBe(120);
  });

  it('fall back to older times when the window has too few', async () => {
    for (let i = 0; i < 3; i++) await serve(1, 'id', 600);
    clock += 4 * 60 * MIN;
    await serve(1, 'id', 120);
    expect((await svc('id')).avgServiceSec).toBe(Math.round((600 * 3 + 120) / 4));
  });

  it('the next person in line has a zero estimate; ranges always contain the estimate', async () => {
    for (const sec of [100, 100, 100, 2000]) await serve(1, 'id', sec); // skewed: mean above 75th pct
    const first = await store.join('First', 'id');
    const second = await store.join('Second', 'id');
    expect(first.estimate).toEqual({ sec: 0, lowSec: 0, highSec: 0 });
    const e = second.estimate!;
    expect(e.lowSec).toBeLessThanOrEqual(e.sec);
    expect(e.highSec).toBeGreaterThanOrEqual(e.sec);
  });
});
