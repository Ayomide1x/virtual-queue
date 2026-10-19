import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type Redis from 'ioredis';
import { Server as SocketServer } from 'socket.io';
import { z } from 'zod';
import type { AlertService } from './alerts/service';
import type { AppointmentBook } from './appointments';
import { disabledErrorTracker, type ErrorTracker } from './errors';
import { nullLogger, redactPath, type Logger } from './logger';
import { LANGS } from './i18n';
import { isValidTimeZone, openStatus, zonedParts, type OfficeConfig } from './officeConfig';
import { isOfficeId, type OfficeStore } from './offices';
import { QueueError, toLobbyState, type QueueStore } from './queueStore';
import { rateLimit, type RateLimitRule } from './rateLimit';
import { seedOffice } from './seed';
import { PRIORITY_REASONS } from './types';

export interface AppOptions {
  redis: Redis;
  /** Separate connection for pub/sub (a subscribed connection can't run commands). */
  subscriber: Redis;
  offices: OfficeStore;
  /** Base URL residents' phones use, e.g. "http://192.168.1.20:3000". */
  publicUrl: string | null;
  /** Detected LAN IP, a fallback when no public URL is configured. */
  lanIp: string | null;
  webDist?: string;
  rateLimits?: { createOffice?: RateLimitRule; join?: RateLimitRule; book?: RateLimitRule; notify?: RateLimitRule };
  /** Express "trust proxy" setting, so rate limits see the real client IP behind a proxy. */
  trustProxy?: boolean | number | string;
  /** How often to check whether offices have opened/closed. */
  hoursTickMs?: number;
  /** Push/email alerts. Without it, the alert endpoints report alerts as unavailable. */
  alerts?: AlertService;
  logger?: Logger;
  errors?: ErrorTracker;
  /** Reported by /health. */
  version?: string;
  /** Errors reported by browsers, per IP. */
  clientErrorLimit?: RateLimitRule;
}

const clientErrorSchema = z.object({
  message: z.string().max(1000),
  stack: z.string().max(4000).optional(),
  url: z.string().max(500).optional(),
  kind: z.enum(['error', 'unhandledrejection', 'react']).optional(),
});

interface OfficeLocals {
  officeId: string;
  config: OfficeConfig;
  store: QueueStore;
  book: AppointmentBook;
}

const createSchema = z
  .object({
    name: z.string().trim().max(60).optional(),
    timezone: z.string().optional(),
    seed: z.boolean().optional(),
  })
  .default({});
const langSchema = z.enum(LANGS);
const joinSchema = z.object({
  name: z.string().trim().min(1, 'Please enter your first name.').max(30, 'Name is too long.'),
  service: z.string().min(1, 'Please choose a service.').max(40),
  lang: langSchema.optional(),
});
const bookSchema = z.object({
  name: z.string().trim().min(1, 'Please enter your first name.').max(30, 'Name is too long.'),
  service: z.string().min(1, 'Please choose a service.').max(40),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Please choose a date.'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Please choose a time.'),
  lang: langSchema.optional(),
});
const setLangSchema = z.object({ lang: langSchema });
const prioritySchema = z.object({
  number: z.string().min(1).max(10),
  reason: z.enum(PRIORITY_REASONS).nullable(),
});
const notifySchema = z.object({ push: z.unknown().optional(), email: z.string().max(320).optional() });
const channelParam = (v: unknown): 'push' | 'email' | 'all' => (v === 'push' || v === 'email' ? v : 'all');
const callSchema = z.object({ service: z.string().max(40).optional() }).default({});
const completeSchema = z.object({ ticketNumber: z.string().optional() }).default({});
const subscribeSchema = z.discriminatedUnion('role', [
  z.object({ officeId: z.string(), role: z.literal('staff'), staffKey: z.string().max(200) }),
  z.object({ officeId: z.string(), role: z.literal('lobby') }),
  z.object({ officeId: z.string(), role: z.literal('ticket'), ticketId: z.string().uuid() }),
]);
type Subscription = z.infer<typeof subscribeSchema>;

const roomFor = (s: Subscription) => (s.role === 'ticket' ? `${s.officeId}:ticket:${s.ticketId}` : `${s.officeId}:${s.role}`);
const officeOfRoom = (room: string) => (room.includes(':') ? room.slice(0, room.indexOf(':')) : null);

const NOT_FOUND_MESSAGE = 'This office doesn’t exist or has expired. Offices are removed after 30 days without activity.';

export function createApp(opts: AppOptions) {
  const { redis, subscriber, offices, publicUrl, lanIp, webDist, alerts } = opts;
  const log = opts.logger ?? nullLogger;
  const errors = opts.errors ?? disabledErrorTracker;
  const startedAt = Date.now();
  let draining = false;
  const app = express();
  const server = http.createServer(app);
  // Keep idle connections open longer than any proxy in front of us (Caddy keeps
  // upstream connections up to 2 min, nginx 60 s). With Node's default of 5 s, a
  // request sent just as the server closes an idle connection fails with
  // "connection reset" (seen in load tests) or a 502 from the proxy.
  server.keepAliveTimeout = 125_000;
  server.headersTimeout = 126_000;
  const io = new SocketServer(server, { cors: { origin: true } });

  app.disable('x-powered-by');
  if (opts.trustProxy !== undefined) app.set('trust proxy', opts.trustProxy);
  app.use(express.json({ limit: '32kb' }));

  // Request ids and one structured log line per request. Paths are redacted:
  // ticket and appointment ids in URLs are secrets, and query strings are dropped.
  const httpLog = log.child({ component: 'http' });
  app.use((req, res, next) => {
    const id = (req.get('x-request-id') ?? '').replace(/[^\w-]/g, '').slice(0, 64) || randomUUID().slice(0, 8);
    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
      const p = redactPath(req.originalUrl);
      const fields = { method: req.method, path: p, status: res.statusCode, ms, requestId: id, officeId: res.locals.office?.officeId };
      if (res.statusCode >= 500) httpLog.error('request failed', fields);
      else if (p.startsWith('/api/') && !p.endsWith('/health')) httpLog.info('request', fields);
      else httpLog.debug('request', fields);
    });
    next();
  });

  // Liveness and readiness in one: 200 when Redis answers, 503 when it doesn't
  // or while the server is shutting down (so a proxy stops sending traffic).
  const health = async (_req: Request, res: Response) => {
    const t0 = Date.now();
    const ok = (await Promise.race([redis.ping().catch(() => null), new Promise((r) => setTimeout(() => r(null), 1000))])) === 'PONG';
    const status = draining ? 'shutting_down' : ok ? 'ok' : 'redis_unavailable';
    res
      .status(status === 'ok' ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json({ status, ok: status === 'ok', redis: { ok, latencyMs: ok ? Date.now() - t0 : null }, uptimeSec: Math.round((Date.now() - startedAt) / 1000), version: opts.version ?? null });
  };
  app.get('/health', health);

  const limits = {
    createOffice: opts.rateLimits?.createOffice ?? { limit: 10, windowSec: 3600 },
    join: opts.rateLimits?.join ?? { limit: 30, windowSec: 60 },
    book: opts.rateLimits?.book ?? { limit: 10, windowSec: 600 },
    notify: opts.rateLimits?.notify ?? { limit: 20, windowSec: 600 },
  };
  const requireAlerts = (): AlertService => {
    if (!alerts) throw new QueueError('invalid', 'Alerts aren’t available on this server.');
    return alerts;
  };

  // ----------------------------------------------------------------- REST API
  const api = express.Router();

  api.get('/health', health);

  // Browsers report crashes here (see web/src/lib/errorReporting.ts), so they
  // show up in the logs and error tracking alongside server errors.
  const webLog = log.child({ component: 'web' });
  api.post('/client-errors', rateLimit(redis, offices.root, 'clienterr', opts.clientErrorLimit ?? { limit: 20, windowSec: 600 }), (req, res) => {
    const parsed = clientErrorSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid', message: 'Invalid error report.' });
    const { message, stack, url, kind } = parsed.data;
    const where = url ? redactPath(url.replace(/^https?:\/\/[^/]+/, '')) : undefined;
    webLog.warn('browser error', { message, kind, path: where, requestId: res.locals.requestId });
    const err = new Error(message);
    err.name = 'BrowserError';
    if (stack) err.stack = stack;
    errors.capture(err, { source: 'web', path: where, requestId: res.locals.requestId, extra: { kind } });
    res.status(204).end();
  });

  api.get('/meta', (_req, res) => {
    res.json({
      publicUrl,
      lanIp,
      alerts: {
        push: { enabled: !!alerts?.push.enabled, publicKey: alerts?.push.publicKey ?? null },
        email: { enabled: !!alerts, mode: alerts?.email.mode ?? null },
      },
    });
  });

  api.post('/offices', rateLimit(redis, offices.root, 'create', limits.createOffice), async (req, res) => {
    const body = createSchema.parse(req.body ?? {});
    const created = await offices.create({
      name: body.name,
      timezone: body.timezone && isValidTimeZone(body.timezone) ? body.timezone : undefined,
    });
    if (body.seed) await seedOffice(redis, { prefix: offices.prefixFor(created.officeId), config: created.config, officeTtlSec: offices.ttlSec, historyDays: Math.min(60, offices.analyticsDays - 1) });
    res.status(201).json({ officeId: created.officeId, staffKey: created.staffKey, office: created.config, publicUrl, lanIp });
  });

  // Everything under /o/:officeId is scoped to that office.
  const office = express.Router({ mergeParams: true });

  office.use(async (req, res, next) => {
    const officeId = String(req.params.officeId);
    const config = isOfficeId(officeId) ? await offices.getConfig(officeId) : null;
    if (!config) return res.status(404).json({ error: 'office_not_found', message: NOT_FOUND_MESSAGE });
    const locals: OfficeLocals = { officeId, config, store: offices.queue(officeId, config), book: offices.appointments(officeId, config) };
    res.locals.office = locals;
    void offices.touch(officeId, config).catch((err) => log.warn('touch failed', { officeId, err }));
    next();
  });

  const ctx = (res: Response) => res.locals.office as OfficeLocals;

  const requireStaff = async (req: Request, res: Response, next: NextFunction) => {
    const key = req.get('x-staff-key');
    if (!key) return res.status(401).json({ error: 'unauthorized', message: 'A staff key is required.' });
    if (!(await offices.verifyKey(ctx(res).officeId, key))) {
      return res.status(403).json({ error: 'forbidden', message: 'That staff key isn’t valid for this office.' });
    }
    next();
  };

  // --- public
  office.get('/', (_req, res) => {
    res.json({ office: ctx(res).store.officeInfo(), publicUrl, lanIp });
  });

  office.get('/lobby', async (_req, res) => {
    res.json(toLobbyState(await ctx(res).store.getStaffState()));
  });

  office.post('/tickets', rateLimit(redis, offices.root, 'join', limits.join), async (req, res) => {
    const { name, service, lang } = joinSchema.parse(req.body);
    res.status(201).json(await ctx(res).store.join(name, service, { lang }));
  });

  // The resident switched language: alerts and lobby announcements follow.
  office.put('/tickets/:ticketId/language', rateLimit(redis, offices.root, 'lang', limits.notify), async (req, res) => {
    const { lang } = setLangSchema.parse(req.body);
    res.json(await ctx(res).store.setLanguage(String(req.params.ticketId), lang));
  });

  office.get('/tickets/:ticketId', async (req, res) => {
    const view = await ctx(res).store.getTicketView(String(req.params.ticketId));
    if (!view) throw new QueueError('not_found');
    res.json(view);
  });

  office.delete('/tickets/:ticketId', async (req, res) => {
    const id = String(req.params.ticketId);
    await ctx(res).store.leave(id);
    res.json(await ctx(res).store.getTicketView(id));
  });

  // Per-office web app manifest, so "Add to Home Screen" opens this office. iOS
  // gives installed apps their own storage, so start_url may carry the
  // resident's ticket (or appointment) to pick up where they were. Without a
  // valid start, start_url is left out so it defaults to the page's own URL:
  // iOS reads the manifest once at page load (before joining) and saves the
  // address bar URL, which the join page keeps in sync with the ticket.
  office.get('/manifest.webmanifest', (req, res) => {
    const { officeId, config } = ctx(res);
    const root = `/o/${officeId}`;
    const start = String(req.query.start ?? '');
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    const valid = new RegExp(`^${root}/(join(\\?ticket=${uuid})?|appointment/${uuid})$`);
    res
      .type('application/manifest+json')
      .set('Cache-Control', 'no-store')
      .send(
        JSON.stringify({
          id: `${root}/`,
          name: config.name,
          short_name: config.name.length > 14 ? 'Queue' : config.name,
          description: `Join the line at ${config.name} and get an alert when it’s your turn.`,
          start_url: valid.test(start) ? start : undefined,
          scope: '/',
          display: 'standalone',
          background_color: '#f0f0f0',
          theme_color: '#112f4e',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        }),
      );
  });

  // --- alerts (public; the secret ticket/appointment id is the proof)
  office.get('/tickets/:ticketId/notify', async (req, res) => {
    res.json(await requireAlerts().getTicketContact(ctx(res).officeId, String(req.params.ticketId)));
  });

  office.post('/tickets/:ticketId/notify', rateLimit(redis, offices.root, 'notify', limits.notify), async (req, res) => {
    const body = notifySchema.parse(req.body ?? {});
    res.json(await requireAlerts().setTicketContact(ctx(res).officeId, String(req.params.ticketId), body));
  });

  office.delete('/tickets/:ticketId/notify', async (req, res) => {
    res.json(await requireAlerts().removeTicketContact(ctx(res).officeId, String(req.params.ticketId), channelParam(req.query.channel)));
  });

  office.get('/appointments/:apptId/notify', async (req, res) => {
    res.json(await requireAlerts().getAppointmentContact(ctx(res).officeId, String(req.params.apptId)));
  });

  office.post('/appointments/:apptId/notify', rateLimit(redis, offices.root, 'notify', limits.notify), async (req, res) => {
    const body = notifySchema.parse(req.body ?? {});
    res.json(await requireAlerts().setAppointmentContact(ctx(res).officeId, String(req.params.apptId), body));
  });

  office.delete('/appointments/:apptId/notify', async (req, res) => {
    res.json(await requireAlerts().removeAppointmentContact(ctx(res).officeId, String(req.params.apptId), channelParam(req.query.channel)));
  });

  // --- appointments (public; the secret appointment id is the resident's proof)
  office.get('/slots', async (req, res) => {
    res.json({ days: await ctx(res).book.availability(String(req.query.service ?? '')), settings: ctx(res).config.appointments });
  });

  office.post('/appointments', rateLimit(redis, offices.root, 'book', limits.book), async (req, res) => {
    res.status(201).json(await ctx(res).book.book(bookSchema.parse(req.body)));
  });

  office.put('/appointments/:apptId/language', rateLimit(redis, offices.root, 'lang', limits.notify), async (req, res) => {
    const { lang } = setLangSchema.parse(req.body);
    res.json(await ctx(res).book.setLanguage(String(req.params.apptId), lang));
  });

  office.get('/appointments/:apptId', async (req, res) => {
    const view = await ctx(res).book.view(String(req.params.apptId));
    if (!view) throw new QueueError('not_found', 'Appointment not found.');
    res.json(view);
  });

  office.post('/appointments/:apptId/check-in', async (req, res) => {
    const { book, store } = ctx(res);
    const ticketId = await book.checkIn(String(req.params.apptId));
    await alerts?.afterCheckIn(ctx(res).officeId, ticketId).catch(() => {});
    res.json({ ticketId, view: await store.getTicketView(ticketId) });
  });

  office.post('/appointments/:apptId/cancel', async (req, res) => {
    const { book } = ctx(res);
    await book.cancel(String(req.params.apptId));
    res.json(await book.view(String(req.params.apptId)));
  });

  // --- staff only
  const staff = express.Router({ mergeParams: true });
  staff.use(requireStaff);

  staff.get('/session', (_req, res) => {
    res.json({ ok: true });
  });

  staff.get('/state', async (_req, res) => {
    res.json(await ctx(res).store.getStaffState());
  });

  const counterParam = (req: Request) => Number(req.params.counter);
  // Staff identify tickets by public number; ticket ids never leave the resident's device.
  const publicTicket = (store: QueueStore, t: { number: string; name: string; service: string; counter: number | null }) => ({
    number: t.number,
    name: t.name,
    service: t.service,
    counter: t.counter,
    counterName: store.counterName(t.counter),
  });

  staff.post('/counters/:counter/call', async (req, res) => {
    const { service } = callSchema.parse(req.body ?? {});
    const { store } = ctx(res);
    res.json(publicTicket(store, await store.callNext(counterParam(req), service)));
  });

  // The optional ticketNumber guards against acting on a stale screen (e.g. double clicks).
  const completeHandler = (outcome: 'served' | 'no_show') => async (req: Request, res: Response) => {
    const { ticketNumber } = completeSchema.parse(req.body ?? {});
    const { store } = ctx(res);
    const counter = counterParam(req);
    let expectedId: string | undefined;
    if (ticketNumber) {
      expectedId = (await store.ticketIdAtCounter(counter)) ?? undefined;
      const current = expectedId ? await store.getTicket(expectedId) : null;
      if (!current || current.number !== ticketNumber) throw new QueueError(current ? 'stale' : 'no_active');
    }
    const t = outcome === 'served' ? await store.markServed(counter, expectedId) : await store.markNoShow(counter, expectedId);
    res.json(publicTicket(store, t));
  };
  staff.post('/counters/:counter/served', completeHandler('served'));
  staff.post('/counters/:counter/no-show', completeHandler('no_show'));

  staff.post('/counters/:counter/recall', async (req, res) => {
    const { store } = ctx(res);
    res.json(publicTicket(store, await store.recall(counterParam(req))));
  });

  staff.post('/services/:service/pause', async (req, res) => {
    await ctx(res).store.setPaused(String(req.params.service), true);
    res.json({ ok: true });
  });

  staff.post('/services/:service/resume', async (req, res) => {
    await ctx(res).store.setPaused(String(req.params.service), false);
    res.json({ ok: true });
  });

  // --- analytics (reads only the event history, never the live queue)
  const rangeQuery = (req: Request) => ({
    from: typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined,
    to: typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined,
  });
  const analyticsFor = (res: Response) => offices.analytics(ctx(res).officeId, ctx(res).config);

  staff.get('/analytics', async (req, res) => {
    const { from, to } = rangeQuery(req);
    const store = analyticsFor(res);
    res.json({ ...(await store.report(from, to)), today: store.today(), retentionDays: store.retentionDays });
  });

  const sendCsv = (res: Response, name: string, body: string) =>
    res
      .type('text/csv; charset=utf-8')
      .set('Cache-Control', 'no-store')
      .attachment(name)
      .send('\ufeff' + body); // BOM so Excel reads UTF-8 names correctly

  staff.get('/analytics/events.csv', async (req, res) => {
    const { from, to } = rangeQuery(req);
    const store = analyticsFor(res);
    const r = store.range(from, to);
    sendCsv(res, `events-${ctx(res).officeId}-${r.from}-to-${r.to}.csv`, await store.eventsCsv(r.from, r.to));
  });

  staff.get('/analytics/visits.csv', async (req, res) => {
    const { from, to } = rangeQuery(req);
    const store = analyticsFor(res);
    const r = store.range(from, to);
    sendCsv(res, `tickets-${ctx(res).officeId}-${r.from}-to-${r.to}.csv`, await store.visitsCsv(r.from, r.to));
  });

  staff.get('/appointments', async (req, res) => {
    const { book, config } = ctx(res);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? String(req.query.date) : zonedParts(Date.now(), config.timezone).dateKey;
    res.json({ ...(await book.day(date)), today: zonedParts(Date.now(), config.timezone).dateKey, settings: config.appointments });
  });

  staff.post('/priority', async (req, res) => {
    const { number, reason } = prioritySchema.parse(req.body);
    const { store } = ctx(res);
    res.json(publicTicket(store, await store.setPriority(number, reason)));
  });

  staff.get('/settings', (_req, res) => {
    res.json(ctx(res).config);
  });

  staff.put('/settings', async (req, res) => {
    res.json(await offices.saveSettings(ctx(res).officeId, req.body));
  });

  staff.post('/seed', async (_req, res) => {
    const { officeId, config } = ctx(res);
    await seedOffice(redis, { prefix: offices.prefixFor(officeId), config, officeTtlSec: offices.ttlSec, historyDays: Math.min(60, offices.analyticsDays - 1) });
    res.json({ ok: true });
  });

  staff.post('/reset', async (_req, res) => {
    await ctx(res).store.reset();
    res.json({ ok: true });
  });

  office.use('/', staff);
  api.use('/o/:officeId', office);

  api.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Unknown API route.' });
  });

  app.use('/api', api);

  // Production: serve the built React app with SPA fallback.
  if (webDist && fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(
      express.static(webDist, {
        index: false,
        maxAge: '1h',
        // The service worker must always be revalidated so updates reach devices.
        setHeaders: (res, file) => {
          if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/socket.io')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof QueueError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'invalid' ? 400 : 409;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid', message: err.issues[0]?.message ?? 'Invalid request.', issues: err.issues });
    }
    if (err instanceof SyntaxError) {
      return res.status(400).json({ error: 'invalid', message: 'Malformed JSON.' });
    }
    const requestId = res.locals.requestId as string | undefined;
    log.error('unhandled error', { err, requestId, path: redactPath(req.originalUrl), officeId: res.locals.office?.officeId });
    errors.capture(err, { source: 'http', requestId, path: req.originalUrl, officeId: res.locals.office?.officeId });
    res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.', requestId });
  });

  // ---------------------------------------------------------------- real time
  async function sendTo(socketId: string, sub: Subscription, store: QueueStore) {
    if (sub.role === 'ticket') {
      const view = await store.getTicketView(sub.ticketId);
      io.to(socketId).emit('ticket:update', { officeId: sub.officeId, id: sub.ticketId, view });
    } else {
      const state = await store.getStaffState();
      if (sub.role === 'staff') io.to(socketId).emit('staff:state', { officeId: sub.officeId, ...state });
      else io.to(socketId).emit('lobby:state', { officeId: sub.officeId, ...toLobbyState(state) });
    }
  }

  io.on('connection', (socket) => {
    socket.on('subscribe', async (raw: unknown) => {
      const parsed = subscribeSchema.safeParse(raw);
      if (!parsed.success) return;
      const sub = parsed.data;
      const fail = (code: 'office_not_found' | 'forbidden') => socket.emit('subscribe:error', { officeId: sub.officeId, role: sub.role, code });
      try {
        const config = await offices.getConfig(sub.officeId);
        if (!config) return fail('office_not_found');
        if (sub.role === 'staff' && !(await offices.verifyKey(sub.officeId, sub.staffKey))) return fail('forbidden');
        await socket.join(roomFor(sub));
        void offices.touch(sub.officeId, config).catch(() => {});
        // Send current state straight away, so (re)connecting clients are never stale.
        await sendTo(socket.id, sub, offices.queue(sub.officeId, config));
      } catch (err) {
        log.error('subscribe failed', { err, officeId: sub.officeId, role: sub.role });
        errors.capture(err, { source: 'socket', officeId: sub.officeId });
      }
    });
    socket.on('unsubscribe', (raw: unknown) => {
      const parsed = subscribeSchema.safeParse(raw);
      if (parsed.success) void socket.leave(roomFor(parsed.data));
    });
  });

  const inFlight = new Set<string>();
  const dirty = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();
  // What each ticket room was last sent, so unchanged views aren't re-sent to
  // every phone on every change in the office (most changes move only some people).
  const lastTicketView = new Map<string, string>();
  io.of('/').adapter.on('delete-room', (room: string) => lastTicketView.delete(room));

  async function broadcast(officeId: string) {
    if (inFlight.has(officeId)) {
      dirty.add(officeId);
      return;
    }
    inFlight.add(officeId);
    try {
      do {
        dirty.delete(officeId);
        const config = await offices.getConfig(officeId);
        if (!config) return;
        const store = offices.queue(officeId, config);
        const state = await store.getStaffState();
        io.to(`${officeId}:staff`).emit('staff:state', { officeId, ...state });
        io.to(`${officeId}:lobby`).emit('lobby:state', { officeId, ...toLobbyState(state) });

        const ticketPrefix = `${officeId}:ticket:`;
        const ticketIds = [...io.sockets.adapter.rooms.keys()].filter((r) => r.startsWith(ticketPrefix)).map((r) => r.slice(ticketPrefix.length));
        const views = await store.getTicketViews(ticketIds);
        for (const [id, view] of views) {
          const room = `${ticketPrefix}${id}`;
          // serverNow changes every time; compare everything else.
          const fingerprint = JSON.stringify(view ? { ...view, serverNow: 0 } : null);
          if (lastTicketView.get(room) === fingerprint) continue;
          lastTicketView.set(room, fingerprint);
          io.to(room).emit('ticket:update', { officeId, id, view });
        }
      } while (dirty.has(officeId));
    } catch (err) {
      log.error('broadcast failed', { err, officeId });
      errors.capture(err, { source: 'broadcast', officeId });
    } finally {
      inFlight.delete(officeId);
    }
  }

  /** Coalesce bursts of changes (e.g. seeding) into one broadcast per office. */
  function scheduleBroadcast(officeId: string) {
    if (timers.has(officeId)) return;
    timers.set(
      officeId,
      setTimeout(() => {
        timers.delete(officeId);
        void broadcast(officeId);
      }, 25),
    );
  }

  /** Offices that currently have someone watching. */
  function watchedOffices(): Set<string> {
    const ids = new Set<string>();
    for (const room of io.sockets.adapter.rooms.keys()) {
      const id = officeOfRoom(room);
      if (id) ids.add(id);
    }
    return ids;
  }

  // Every mutation publishes on its office's channel — including ones from
  // other processes such as the CLI seed — so all screens stay in sync.
  void subscriber.psubscribe(offices.eventsPattern);
  subscriber.on('pmessage', (_pattern, channel) => {
    const officeId = offices.officeIdFromChannel(channel);
    if (officeId) {
      scheduleBroadcast(officeId);
      // Alerts are decided off the request path; a slow push service can't slow the queue.
      alerts?.scheduleScan(officeId);
    }
  });
  // After a Redis outage, push fresh state to everyone.
  redis.on('ready', () => watchedOffices().forEach(scheduleBroadcast));

  // Opening hours: when an office opens or closes, nothing is written to Redis,
  // so check periodically and push the change to that office's screens.
  const lastOpen = new Map<string, boolean>();
  const hoursTimer = setInterval(async () => {
    for (const officeId of watchedOffices()) {
      const config = await offices.getConfig(officeId).catch(() => null);
      if (!config) continue;
      const open = openStatus(config, Date.now()).open;
      if (lastOpen.has(officeId) && lastOpen.get(officeId) !== open) scheduleBroadcast(officeId);
      lastOpen.set(officeId, open);
      // Persist missed appointments as their check-in windows close.
      const missed = await offices
        .appointments(officeId, config)
        .expireMissed(zonedParts(Date.now(), config.timezone).dateKey)
        .catch(() => 0);
      if (missed > 0) scheduleBroadcast(officeId);
    }
  }, opts.hoursTickMs ?? 30_000);
  hoursTimer.unref();
  server.on('close', () => clearInterval(hoursTimer));

  /**
   * Graceful shutdown, step one: report "shutting down" on /health, stop
   * timers, stop accepting connections, disconnect sockets (clients reconnect
   * on their own, to this server's replacement), and wait for in-flight HTTP
   * requests to finish. The caller then stops workers and closes Redis.
   */
  async function close(graceMs = 8000): Promise<void> {
    draining = true;
    clearInterval(hoursTimer);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    await new Promise<void>((resolve) => {
      io.close(() => resolve()); // also closes the HTTP server, which waits for open requests
      // A connection that finishes its request stays open (keep-alive) and would
      // hold the server open for keepAliveTimeout, so keep closing idle ones as
      // requests finish; after the grace period, close whatever is left.
      server.closeIdleConnections();
      const sweep = setInterval(() => server.closeIdleConnections(), 50);
      const deadline = setTimeout(() => server.closeAllConnections(), graceMs);
      server.once('close', () => {
        clearInterval(sweep);
        clearTimeout(deadline);
      });
    });
  }

  return { app, server, io, broadcast, close };
}
