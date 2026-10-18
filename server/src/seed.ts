import type Redis from 'ioredis';
import type { OfficeConfig } from './officeConfig';
import { AppointmentBook } from './appointments';
import { seedHistory } from './history';
import { QueueStore } from './queueStore';

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
 * Resets an office's queue and simulates a morning there: a history of served
 * residents (realistic stats + service-time averages), a couple of no-shows,
 * up to two counters mid-service, and populated waiting lines. Works with any
 * set of services and counters.
 */
export async function seedOffice(
  redis: Redis,
  opts: { prefix: string; config: OfficeConfig; officeTtlSec?: number; historyDays?: number },
): Promise<void> {
  const realNow = Date.now();
  // Past weeks for the analytics dashboard (skips days that already have history).
  await seedHistory(redis, { ...opts, days: opts.historyDays ?? 60, now: realNow });
  let clock = realNow - 95 * MIN;
  const store = new QueueStore(redis, { ...opts, now: () => clock });
  const rand = rng(42);
  let nameIdx = 0;
  const nextName = () => NAMES[nameIdx++ % NAMES.length];
  const services = opts.config.services;
  const counters = opts.config.counters.map((c) => c.id);
  const svcAt = (i: number) => services[i % services.length];
  const duration = (sec: number) => sec * 1000 * (0.6 + rand() * 0.8);

  await store.reset();

  // History: one resident at a time, rotating services and the first few counters.
  const historyCounters = counters.slice(0, 3);
  for (let i = 0; i < 16; i++) {
    const svc = svcAt(i % 2 === 0 ? 0 : i);
    const counter = historyCounters[i % historyCounters.length];
    await store.join(nextName(), svc.id, { joinedAt: clock - (6 + rand() * 16) * MIN, ignoreHours: true });
    await store.callNext(counter, svc.id);
    if (i === 5 || i === 12) {
      clock += 2 * MIN;
      await store.markNoShow(counter);
    } else {
      clock += duration(svc.defaultServiceSec);
      await store.markServed(counter);
    }
    clock += 0.5 * MIN;
  }

  // Live lines: 15 people who joined over the last ~25 minutes, busiest line first.
  clock = realNow;
  const minsAgo = [26, 24, 21, 19, 17, 15, 13, 11, 9, 8, 6, 5, 3, 2, 1];
  const pattern = [0, 1, 0, 2, 0, 1, 0, 2, 1, 0, 2, 0, 1, 0, 2];
  for (let i = 0; i < minsAgo.length; i++) {
    await store.join(nextName(), svcAt(pattern[i]).id, { joinedAt: realNow - minsAgo[i] * MIN, ignoreHours: true });
  }

  // Up to two counters are mid-service when the demo opens.
  clock = realNow - 3 * MIN;
  await store.callNext(counters[0], svcAt(0).id);
  if (counters[1] !== undefined) {
    clock = realNow - 1 * MIN;
    await store.callNext(counters[1], svcAt(1).id).catch(() => store.callNext(counters[1]));
  }

  // A senior near the back of the busiest line has been given priority.
  clock = realNow;
  const lineup = (await store.getStaffState()).services[0].waiting;
  if (lineup.length >= 3) await store.setPriority(lineup[lineup.length - 2].number, 'senior');

  if (opts.config.appointments.enabled) await seedAppointments(redis, opts, nextName).catch(() => {});
}

/** Book a few appointments today and on the next open day; check one in if its window is open. */
async function seedAppointments(redis: Redis, opts: { prefix: string; config: OfficeConfig; officeTtlSec?: number }, nextName: () => string) {
  const ttl = opts.officeTtlSec ?? 30 * 24 * 3600;
  const book = new AppointmentBook(redis, new QueueStore(redis, opts), { officeTtlSec: ttl });
  const services = opts.config.services;
  const early = opts.config.appointments.checkInEarlyMin * MIN;
  let booked = 0;
  let checkedIn = false;
  const days = await book.availability(services[0].id);
  for (const day of days.filter((d) => d.slots.length).slice(0, 2)) {
    for (const [i, slot] of day.slots.slice(0, 6).entries()) {
      if (i % 2 === 1) continue; // every other slot, so the day view looks realistic
      const service = services[(booked + 1) % services.length].id;
      const view = await book.book({ name: nextName(), service, date: day.date, time: slot.time }).catch(() => null);
      if (!view) continue;
      booked++;
      if (!checkedIn && slot.start - early <= Date.now()) {
        await book.checkIn(view.appointment.id).catch(() => {});
        checkedIn = true;
      }
    }
  }
}
