import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import Redis from 'ioredis';
import { io as ioClient } from 'socket.io-client';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../src/app';
import { createErrorTracker, scrubEvent, type ErrorContext, type ErrorTracker } from '../src/errors';
import { createLogger, nullLogger, redactPath, type LogLevel } from '../src/logger';
import { OfficeStore } from '../src/offices';
import { closeAll, connect, deleteUnder, uniqueRoot } from './helpers';

const TICKET = '0f8fad5b-d9cb-469f-a165-70867728950e';

function capture() {
  const lines: Array<Record<string, any>> = [];
  const logger = createLogger({ level: 'debug', format: 'json', write: (l) => lines.push(JSON.parse(l)) });
  return { logger, lines };
}

class FakeTracker implements ErrorTracker {
  readonly enabled = true;
  captured: Array<{ err: unknown; ctx?: ErrorContext }> = [];
  capture(err: unknown, ctx?: ErrorContext) {
    this.captured.push({ err, ctx });
  }
  async flush() {}
}

async function start(opts: Partial<Parameters<typeof createApp>[0]> = {}) {
  const redis = opts.redis ?? connect();
  const root = uniqueRoot();
  const offices = opts.offices ?? new OfficeStore(redis, { root });
  const handle = createApp({ redis, subscriber: connect(), offices, publicUrl: null, lanIp: null, ...opts });
  await new Promise<void>((r) => handle.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
  return { ...handle, base, offices, cleanup: () => deleteUnder(connect(), root) };
}

afterAll(closeAll);

describe('structured logs', () => {
  it('writes one JSON object per line with level, time, message and fields', () => {
    const { logger, lines } = capture();
    logger.child({ component: 'alerts' }).warn('retrying', { attempt: 2 });
    expect(lines[0]).toMatchObject({ level: 'warn', msg: 'retrying', component: 'alerts', attempt: 2 });
    expect(new Date(lines[0].time).toString()).not.toBe('Invalid Date');
  });

  it('filters by level and serializes errors', () => {
    const out: string[] = [];
    const logger = createLogger({ level: 'warn' as LogLevel, format: 'json', write: (l) => out.push(l) });
    logger.info('hidden');
    logger.error('boom', { err: Object.assign(new Error('bad thing'), { code: 'E_BAD' }) });
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]).err).toMatchObject({ name: 'Error', message: 'bad thing', code: 'E_BAD', stack: expect.stringContaining('bad thing') });
  });

  it('redacts secret ids and query strings from paths', () => {
    expect(redactPath(`/api/o/abc123/tickets/${TICKET}/notify?channel=email`)).toBe('/api/o/abc123/tickets/:id/notify');
    expect(redactPath(`/o/abc123/join?ticket=${TICKET}`)).toBe('/o/abc123/join');
    expect(redactPath(`/o/abc123/appointment/${TICKET.toUpperCase()}`)).toBe('/o/abc123/appointment/:id');
  });

  it('logs each API request (method, redacted path, status, time, request id), and 5xx as errors', async () => {
    const { logger, lines } = capture();
    const tracker = new FakeTracker();
    const app = await start({ logger, errors: tracker });
    try {
      const created = await (await fetch(`${app.base}/api/offices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
      const r = await fetch(`${app.base}/api/o/${created.officeId}/tickets/${TICKET}?x=1`, { headers: { 'x-request-id': 'req-123' } });
      expect(r.status).toBe(404);
      expect(r.headers.get('x-request-id')).toBe('req-123');
      const line = lines.find((l) => l.requestId === 'req-123')!;
      expect(line).toMatchObject({ level: 'info', component: 'http', method: 'GET', path: `/api/o/${created.officeId}/tickets/:id`, status: 404, officeId: created.officeId });
      expect(typeof line.ms).toBe('number');
      expect(JSON.stringify(lines)).not.toContain(TICKET);

      // An unexpected failure: logged as an error, tracked, and the client gets a request id.
      app.offices.getConfig = async () => {
        throw new Error('database on fire');
      };
      const bad = await fetch(`${app.base}/api/o/${created.officeId}/lobby`);
      expect(bad.status).toBe(500);
      const body = await bad.json();
      expect(body).toMatchObject({ error: 'server_error', requestId: expect.any(String) });
      expect(body.message).not.toContain('fire'); // internals stay out of responses
      expect(lines.find((l) => l.msg === 'unhandled error')).toMatchObject({ level: 'error', requestId: body.requestId, err: { message: 'database on fire' } });
      expect(tracker.captured).toHaveLength(1);
      expect(tracker.captured[0].ctx).toMatchObject({ source: 'http', requestId: body.requestId });
    } finally {
      await app.close();
      await app.cleanup();
    }
  });
});

describe('/health', () => {
  it('reports Redis status: 200 when it answers, 503 when it doesn’t', async () => {
    const app = await start({ version: '1.2.3' });
    const down = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
    down.on('error', () => {});
    const broken = await start({ redis: down, offices: new OfficeStore(down) });
    try {
      for (const p of ['/health', '/api/health']) {
        const r = await fetch(app.base + p);
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ status: 'ok', ok: true, redis: { ok: true, latencyMs: expect.any(Number) }, version: '1.2.3', uptimeSec: expect.any(Number) });
      }
      const r = await fetch(broken.base + '/health');
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ status: 'redis_unavailable', ok: false, redis: { ok: false } });
    } finally {
      await app.close();
      await broken.close();
      down.disconnect();
    }
  });
});

describe('error tracking', () => {
  it('is off without SENTRY_DSN', async () => {
    expect((await createErrorTracker({ logger: nullLogger })).enabled).toBe(false);
  });

  it('sends errors to the DSN with secrets and personal data removed', async () => {
    const bodies: string[] = [];
    const ingest = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => ingest.listen(0, '127.0.0.1', r));
    const port = (ingest.address() as AddressInfo).port;
    try {
      const tracker = await createErrorTracker({ dsn: `http://publickey@127.0.0.1:${port}/42`, environment: 'test', release: 'abc', logger: nullLogger });
      expect(tracker.enabled).toBe(true);
      tracker.capture(new Error('kaboom'), { source: 'http', officeId: 'office1', path: `/api/o/office1/tickets/${TICKET}?email=a@b.c` });
      await tracker.flush(3000);
      const all = bodies.join('\n');
      expect(all).toContain('kaboom');
      expect(all).toContain('/api/o/office1/tickets/:id');
      expect(all).not.toContain(TICKET);
      expect(all).not.toContain('a@b.c');
    } finally {
      ingest.close();
    }
  });

  it('scrubs request data, users and breadcrumbs from events', () => {
    const ev = scrubEvent({ request: { url: `https://q.test/o/x/join?ticket=${TICKET}`, method: 'GET', headers: { 'x-staff-key': 'secret' }, data: '{"email":"a@b.c"}' }, user: { ip_address: '1.2.3.4' }, breadcrumbs: [{}] });
    expect(ev).toEqual({ request: { url: 'https://q.test/o/x/join', method: 'GET' } });
  });

  it('browser errors are logged and tracked, with redacted URLs and a rate limit', async () => {
    const { logger, lines } = capture();
    const tracker = new FakeTracker();
    const app = await start({ logger, errors: tracker, clientErrorLimit: { limit: 2, windowSec: 60 } });
    try {
      const send = (body: unknown) => fetch(`${app.base}/api/client-errors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect((await send({ message: 'destroy is not a function', stack: 'at x', url: `https://q.test/o/abc/join?ticket=${TICKET}`, kind: 'error' })).status).toBe(204);
      expect(lines.find((l) => l.msg === 'browser error')).toMatchObject({ level: 'warn', component: 'web', message: 'destroy is not a function', path: '/o/abc/join' });
      expect(tracker.captured[0]).toMatchObject({ err: expect.objectContaining({ name: 'BrowserError', message: 'destroy is not a function' }), ctx: { source: 'web', path: '/o/abc/join' } });
      expect((await send({ nope: true })).status).toBe(400);
      expect((await send({ message: 'again' })).status).toBe(429); // 3rd report in the window
      expect(JSON.stringify(lines)).not.toContain(TICKET);
    } finally {
      await app.close();
      await app.cleanup();
    }
  });
});

describe('graceful shutdown', () => {
  it('finishes in-flight requests, refuses new connections and disconnects sockets', async () => {
    const app = await start();
    app.app.get('/__slow', (_req, res) => {
      setTimeout(() => res.send('done'), 400);
    });
    const socket = ioClient(app.base, { transports: ['websocket'], reconnection: false });
    await new Promise<void>((r) => socket.on('connect', () => r()));
    const disconnected = new Promise<string>((r) => socket.on('disconnect', (reason) => r(reason)));

    const slow = fetch(`${app.base}/__slow`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50)); // request is in flight
    const t0 = Date.now();
    const closing = app.close();
    expect(await slow).toBe('done');
    await closing;
    // Promptly, even though the finished request's connection was kept alive.
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(['io server disconnect', 'transport close']).toContain(await disconnected); // clients reconnect on their own
    await expect(fetch(`${app.base}/health`)).rejects.toThrow();
    socket.close();
  });

  it('the server process exits cleanly on SIGTERM, logging each step', async () => {
    const serverDir = path.resolve(__dirname, '..');
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', REDIS_URL: inject('redisUrl'), LOG_FORMAT: 'json', LOG_LEVEL: 'info', NODE_ENV: 'test', PUBLIC_URL: 'http://q.test', SENTRY_DSN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: Array<Record<string, any>> = [];
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          lines.push(JSON.parse(line));
        } catch {
          /* not ours */
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const waitFor = async (msg: string, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!lines.some((l) => l.msg === msg)) {
        if (Date.now() > end) throw new Error(`no "${msg}" log; got: ${lines.map((l) => l.msg).join(', ')}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await waitFor('listening');
    expect(lines.find((l) => l.msg === 'listening')).toMatchObject({ level: 'info', service: 'virtual-queue' });
    const exit = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    child.kill('SIGTERM');
    expect(await exit).toBe(0);
    expect(lines.map((l) => l.msg)).toEqual(expect.arrayContaining(['shutting down', 'shutdown complete']));
    expect(lines.find((l) => l.msg === 'shutting down')).toMatchObject({ signal: 'SIGTERM' });
  }, 30_000);
});
