import Redis from 'ioredis';
import { config } from './config';
import { QueueStore } from './queueStore';
import type { ServiceId } from './services';

const NAMES = [
  'Maria', 'James', 'Aisha', 'Wei', 'Carlos', 'Priya', 'Daniel', 'Fatima', 'Liam', 'Grace',
  'Mohammed', 'Sofia', 'Kwame', 'Elena', 'Tyler', 'Hana', 'Andre', 'Olivia', 'Raj', 'Chloe',
  'Diego', 'Amara', 'Noah', 'Mei', 'Samuel', 'Leila', 'Ethan', 'Yusuf', 'Isabella', 'Tomás',
  'Nadia', 'Marcus', 'Ana', 'Jamal', 'Emma', 'Hiroshi', 'Zoe', 'Omar', 'Lucia', 'Ben',
];

/** Deterministic PRNG so the demo looks the same every time it's seeded. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const MIN = 60_000;

/**
 * Resets the queue and simulates a morning at the office: a history of served
 * residents (realistic stats + service-time averages), a couple of no-shows,
 * two counters mid-service, and populated waiting lines.
 */
export async function seedDemo(redis: Redis, opts: { prefix?: string; counters?: number } = {}): Promise<void> {
  const realNow = Date.now();
  let clock = realNow - 95 * MIN;
  const store = new QueueStore(redis, { ...opts, now: () => clock });
  const rand = rng(42);
  let nameIdx = 0;
  const nextName = () => NAMES[nameIdx++ % NAMES.length];
  const durations: Record<ServiceId, [number, number]> = {
    license: [4 * MIN, 8 * MIN],
    registration: [2.5 * MIN, 5 * MIN],
    id: [2 * MIN, 4 * MIN],
  };
  const between = ([lo, hi]: [number, number]) => lo + rand() * (hi - lo);

  await store.reset();

  // History: one resident at a time per round, rotating services and counters.
  const historyPlan: ServiceId[] = [
    'license', 'registration', 'id', 'license', 'registration', 'license', 'id', 'registration',
    'license', 'id', 'license', 'registration', 'license', 'id', 'registration', 'license',
  ];
  for (let i = 0; i < historyPlan.length; i++) {
    const svc = historyPlan[i];
    const counter = (i % 3) + 1;
    await store.join(nextName(), svc, { joinedAt: clock - between([6 * MIN, 22 * MIN]) });
    await store.callNext(counter, svc);
    if (i === 5 || i === 12) {
      clock += 2 * MIN;
      await store.markNoShow(counter);
    } else {
      clock += between(durations[svc]);
      await store.markServed(counter);
    }
    clock += 0.5 * MIN;
  }

  // Live lines: people who joined over the last ~25 minutes.
  clock = realNow;
  const waiting: Array<[ServiceId, number]> = [
    ['license', 26], ['registration', 24], ['license', 21], ['id', 19], ['license', 17],
    ['registration', 15], ['license', 13], ['id', 11], ['registration', 9], ['license', 8],
    ['id', 6], ['license', 5], ['registration', 3], ['license', 2], ['id', 1],
  ];
  for (const [svc, minsAgo] of waiting) {
    await store.join(nextName(), svc, { joinedAt: realNow - minsAgo * MIN });
  }

  // Two counters are mid-service when the demo opens.
  clock = realNow - 3 * MIN;
  await store.callNext(1, 'license');
  clock = realNow - 1 * MIN;
  await store.callNext(2, 'registration');
}

if (require.main === module) {
  const redis = new Redis(config.redisUrl);
  seedDemo(redis, { counters: config.counters })
    .then(async () => {
      const state = await new QueueStore(redis, { counters: config.counters }).getStaffState();
      console.log(`Seeded demo data: ${state.totals.waiting} waiting, ${state.totals.servedToday} served today.`);
      for (const s of state.services) console.log(`  ${s.name.padEnd(22)} ${s.waitingCount} waiting`);
    })
    .catch((err) => {
      console.error('Seeding failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => redis.quit());
}
