import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { inject } from 'vitest';

const connections: Redis[] = [];

export function connect(): Redis {
  const r = new Redis(inject('redisUrl'));
  connections.push(r);
  return r;
}

export async function closeAll(): Promise<void> {
  await Promise.all(connections.splice(0).map((c) => c.quit().catch(() => {})));
}

/** A unique root prefix so each test file is isolated on the shared Redis. */
export const uniqueRoot = () => `test:${randomUUID()}:`;

export async function keysUnder(redis: Redis, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    out.push(...keys);
  } while (cursor !== '0');
  return out;
}

export async function deleteUnder(redis: Redis, prefix: string): Promise<void> {
  const keys = await keysUnder(redis, prefix);
  if (keys.length) await redis.unlink(...keys);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
