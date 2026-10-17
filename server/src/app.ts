import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type Redis from 'ioredis';
import { Server as SocketServer } from 'socket.io';
import { z } from 'zod';
import { QueueError, QueueStore, toLobbyState } from './queueStore';
import { SERVICE_IDS, SERVICES } from './services';
import { seedDemo } from './seed';

export interface AppOptions {
  redis: Redis;
  /** Separate connection for pub/sub (a subscribed connection can't run commands). */
  subscriber: Redis;
  store: QueueStore;
  lanIp: string | null;
  publicJoinUrl?: string;
  webDist?: string;
}

const joinSchema = z.object({
  name: z.string().trim().min(1, 'Please enter your first name.').max(30, 'Name is too long.'),
  service: z.enum(SERVICE_IDS),
});
const callSchema = z.object({ service: z.enum(SERVICE_IDS).optional() }).default({});
const completeSchema = z.object({ ticketNumber: z.string().optional() }).default({});
const subscribeSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('staff') }),
  z.object({ role: z.literal('lobby') }),
  z.object({ role: z.literal('ticket'), ticketId: z.string().uuid() }),
]);
type Subscription = z.infer<typeof subscribeSchema>;

const roomFor = (s: Subscription) => (s.role === 'ticket' ? `ticket:${s.ticketId}` : s.role);

export function createApp({ redis, subscriber, store, lanIp, publicJoinUrl, webDist }: AppOptions) {
  const app = express();
  const server = http.createServer(app);
  const io = new SocketServer(server, { cors: { origin: true } });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  // ----------------------------------------------------------------- REST API
  const api = express.Router();

  api.get('/health', async (_req, res) => {
    const ok = (await redis.ping().catch(() => null)) === 'PONG';
    res.status(ok ? 200 : 503).json({ ok, redis: ok });
  });

  api.get('/config', (_req, res) => {
    res.json({ services: SERVICES, counters: store.counters, lanIp, publicJoinUrl: publicJoinUrl ?? null });
  });

  api.post('/tickets', async (req, res) => {
    const { name, service } = joinSchema.parse(req.body);
    res.status(201).json(await store.join(name, service));
  });

  api.get('/tickets/:id', async (req, res) => {
    const view = await store.getTicketView(String(req.params.id));
    if (!view) throw new QueueError('not_found');
    res.json(view);
  });

  api.delete('/tickets/:id', async (req, res) => {
    await store.leave(String(req.params.id));
    res.json(await store.getTicketView(String(req.params.id)));
  });

  api.get('/state', async (_req, res) => {
    res.json(await store.getStaffState());
  });

  api.get('/lobby', async (_req, res) => {
    res.json(toLobbyState(await store.getStaffState()));
  });

  const counterParam = (req: Request) => Number(req.params.counter);
  // Staff identify tickets by public number; ticket ids never leave the resident's device.
  const publicTicket = (t: { number: string; name: string; service: string; counter: number | null }) => ({
    number: t.number,
    name: t.name,
    service: t.service,
    counter: t.counter,
  });

  api.post('/counters/:counter/call', async (req, res) => {
    const { service } = callSchema.parse(req.body ?? {});
    res.json(publicTicket(await store.callNext(counterParam(req), service)));
  });

  // The optional ticketNumber guards against acting on a stale screen (e.g. double clicks).
  const completeHandler = (outcome: 'served' | 'no_show') => async (req: Request, res: Response) => {
    const { ticketNumber } = completeSchema.parse(req.body ?? {});
    const counter = counterParam(req);
    let expectedId: string | undefined;
    if (ticketNumber) {
      expectedId = await redis.hget(`${store.prefix}counters`, String(counter)).then((id) => id ?? undefined);
      const current = expectedId ? await store.getTicket(expectedId) : null;
      if (!current || current.number !== ticketNumber) throw new QueueError(current ? 'stale' : 'no_active');
    }
    const t = outcome === 'served' ? await store.markServed(counter, expectedId) : await store.markNoShow(counter, expectedId);
    res.json(publicTicket(t));
  };
  api.post('/counters/:counter/served', completeHandler('served'));
  api.post('/counters/:counter/no-show', completeHandler('no_show'));

  api.post('/counters/:counter/recall', async (req, res) => {
    res.json(publicTicket(await store.recall(counterParam(req))));
  });

  api.post('/services/:service/pause', async (req, res) => {
    await store.setPaused(z.enum(SERVICE_IDS).parse(req.params.service), true);
    res.json({ ok: true });
  });

  api.post('/services/:service/resume', async (req, res) => {
    await store.setPaused(z.enum(SERVICE_IDS).parse(req.params.service), false);
    res.json({ ok: true });
  });

  api.post('/admin/seed', async (_req, res) => {
    await seedDemo(redis, { prefix: store.prefix, counters: store.counters });
    res.json({ ok: true });
  });

  api.post('/admin/reset', async (_req, res) => {
    await store.reset();
    res.json({ ok: true });
  });

  api.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Unknown API route.' });
  });

  app.use('/api', api);

  // Production: serve the built React app with SPA fallback.
  if (webDist && fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/socket.io')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof QueueError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'invalid' ? 400 : 409;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid', message: err.issues[0]?.message ?? 'Invalid request.' });
    }
    if (err instanceof SyntaxError) {
      return res.status(400).json({ error: 'invalid', message: 'Malformed JSON.' });
    }
    console.error(err);
    res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
  });

  // ---------------------------------------------------------------- real time
  async function sendTo(target: string, sub: Subscription) {
    if (sub.role === 'ticket') {
      const view = await store.getTicketView(sub.ticketId);
      io.to(target).emit('ticket:update', { id: sub.ticketId, view });
    } else {
      const state = await store.getStaffState();
      if (sub.role === 'staff') io.to(target).emit('staff:state', state);
      else io.to(target).emit('lobby:state', toLobbyState(state));
    }
  }

  io.on('connection', (socket) => {
    socket.on('subscribe', async (raw: unknown) => {
      const parsed = subscribeSchema.safeParse(raw);
      if (!parsed.success) return;
      await socket.join(roomFor(parsed.data));
      // Send current state straight away, so (re)connecting clients are never stale.
      await sendTo(socket.id, parsed.data).catch((err) => console.error('subscribe send failed', err));
    });
    socket.on('unsubscribe', (raw: unknown) => {
      const parsed = subscribeSchema.safeParse(raw);
      if (parsed.success) void socket.leave(roomFor(parsed.data));
    });
  });

  let broadcasting = false;
  let dirty = false;
  let timer: NodeJS.Timeout | null = null;

  async function broadcast() {
    if (broadcasting) {
      dirty = true;
      return;
    }
    broadcasting = true;
    try {
      do {
        dirty = false;
        const state = await store.getStaffState();
        io.to('staff').emit('staff:state', state);
        io.to('lobby').emit('lobby:state', toLobbyState(state));

        const ticketIds = [...io.sockets.adapter.rooms.keys()]
          .filter((r) => r.startsWith('ticket:'))
          .map((r) => r.slice('ticket:'.length));
        const views = await store.getTicketViews(ticketIds);
        for (const [id, view] of views) io.to(`ticket:${id}`).emit('ticket:update', { id, view });
      } while (dirty);
    } catch (err) {
      console.error('broadcast failed', err);
    } finally {
      broadcasting = false;
    }
  }

  /** Coalesce bursts of changes (e.g. seeding) into one broadcast. */
  function scheduleBroadcast() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void broadcast();
    }, 25);
  }

  // Every mutation publishes on this channel — including ones from other
  // processes such as the seed script — so all screens stay in sync.
  void subscriber.subscribe(store.eventsChannel);
  subscriber.on('message', (channel) => {
    if (channel === store.eventsChannel) scheduleBroadcast();
  });
  // After a Redis outage, push fresh state to everyone.
  redis.on('ready', scheduleBroadcast);

  return { app, server, io, broadcast };
}
