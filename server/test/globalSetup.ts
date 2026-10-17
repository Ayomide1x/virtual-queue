import { spawn, type ChildProcess } from 'node:child_process';
import Redis from 'ioredis';
import type { GlobalSetupContext } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string;
  }
}

/**
 * Tests run against a real Redis so the Lua scripts (and their atomicity) are
 * exercised for real. By default we start a throwaway, non-persistent
 * redis-server on a spare port so your own Redis data is never touched.
 * Set TEST_REDIS_URL to use an existing instance instead.
 */
const PORT = Number(process.env.TEST_REDIS_PORT ?? 6399);
let child: ChildProcess | undefined;

async function ping(url: string): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  r.on('error', () => {});
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

export async function setup({ provide }: GlobalSetupContext) {
  if (process.env.TEST_REDIS_URL) {
    if (!(await ping(process.env.TEST_REDIS_URL))) throw new Error(`Cannot reach TEST_REDIS_URL=${process.env.TEST_REDIS_URL}`);
    provide('redisUrl', process.env.TEST_REDIS_URL);
    return;
  }
  const url = `redis://127.0.0.1:${PORT}`;
  if (!(await ping(url))) {
    child = spawn('redis-server', ['--port', String(PORT), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    child.on('error', () => {
      console.error(
        '\nCould not start redis-server. Install Redis (brew install redis) or set TEST_REDIS_URL,\n' +
          `e.g. docker run --rm -p ${PORT}:6379 redis:7-alpine  then  TEST_REDIS_URL=redis://127.0.0.1:${PORT} npm test\n`,
      );
    });
    for (let i = 0; i < 50 && !(await ping(url)); i++) await new Promise((r) => setTimeout(r, 100));
    if (!(await ping(url))) throw new Error('redis-server did not start');
  }
  provide('redisUrl', url);
}

export async function teardown() {
  child?.kill();
}
