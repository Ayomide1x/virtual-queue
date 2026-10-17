import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { CALL_NEXT, COMPLETE, JOIN, LEAVE, RECALL } from './scripts';
import { SERVICES, SERVICE_IDS, getService, isServiceId, type ServiceId } from './services';
import type {
  CounterOutcome,
  CounterState,
  LobbyState,
  RecentCall,
  StaffState,
  Ticket,
  TicketStatus,
  TicketView,
} from './types';

export type QueueErrorCode =
  | 'empty'
  | 'paused'
  | 'counter_busy'
  | 'no_active'
  | 'stale'
  | 'not_found'
  | 'not_active'
  | 'invalid';

const MESSAGES: Record<QueueErrorCode, string> = {
  empty: 'No one is waiting in line.',
  paused: 'That line is paused.',
  counter_busy: 'This counter is already serving someone. Mark them served or no-show first.',
  no_active: 'No one is currently at this counter.',
  stale: 'This counter has moved on to a different ticket. Refresh and try again.',
  not_found: 'Ticket not found.',
  not_active: 'This ticket is no longer in line.',
  invalid: 'Invalid request.',
};

export class QueueError extends Error {
  constructor(
    public readonly code: QueueErrorCode,
    message: string = MESSAGES[code],
  ) {
    super(message);
    this.name = 'QueueError';
  }
}

export interface QueueStoreOptions {
  /** Key prefix, lets tests run in isolation on a shared Redis. */
  prefix?: string;
  /** Number of counters in the office (1..counters). */
  counters?: number;
  /** Clock, injectable for tests and the seed simulation. */
  now?: () => number;
  /** How many recent service durations feed the rolling average. */
  svcTimesMax?: number;
  recentMax?: number;
  /** How long finished tickets are kept around (so a resident sees "served"). */
  finishedTicketTtlSec?: number;
}

type ScriptResult = [string, string?, string?];

/** Local calendar date (server time zone), used to bucket "today" stats. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class QueueStore {
  readonly prefix: string;
  readonly counters: number;
  private readonly clock: () => number;
  private readonly svcTimesMax: number;
  private readonly recentMax: number;
  private readonly ttl: number;

  constructor(
    private readonly redis: Redis,
    opts: QueueStoreOptions = {},
  ) {
    this.prefix = opts.prefix ?? 'vq:';
    this.counters = opts.counters ?? 6;
    this.clock = opts.now ?? Date.now;
    this.svcTimesMax = opts.svcTimesMax ?? 20;
    this.recentMax = opts.recentMax ?? 12;
    this.ttl = opts.finishedTicketTtlSec ?? 60 * 60 * 12;
  }

  /** Whole-millisecond timestamps (Redis HINCRBY needs integers). */
  private now(): number {
    return Math.round(this.clock());
  }

  /** Redis pub/sub channel announcing that queue state changed. */
  get eventsChannel(): string {
    return `${this.prefix}events`;
  }

  private key = {
    ticket: (id: string) => `${this.prefix}ticket:${id}`,
    queue: (svc: ServiceId) => `${this.prefix}queue:${svc}`,
    svcTimes: (svc: ServiceId) => `${this.prefix}svctimes:${svc}`,
    seq: (day: string, svc: ServiceId) => `${this.prefix}seq:${day}:${svc}`,
    stats: (day: string) => `${this.prefix}stats:${day}`,
    counters: () => `${this.prefix}counters`,
    counterLast: () => `${this.prefix}counterlast`,
    paused: () => `${this.prefix}paused`,
    recent: () => `${this.prefix}recent`,
  };

  private async run(script: string, keys: string[], args: Array<string | number>): Promise<ScriptResult> {
    // ioredis transparently uses EVALSHA with an EVAL fallback.
    return (await this.redis.eval(script, keys.length, ...keys, ...args.map(String))) as ScriptResult;
  }

  private async notify(): Promise<void> {
    await this.redis.publish(this.eventsChannel, String(this.now()));
  }

  private assertCounter(counter: number): void {
    if (!Number.isInteger(counter) || counter < 1 || counter > this.counters) {
      throw new QueueError('invalid', `Counter must be between 1 and ${this.counters}.`);
    }
  }

  // ---------------------------------------------------------------- residents

  async join(name: string, service: ServiceId, opts: { joinedAt?: number } = {}): Promise<TicketView> {
    const cleanName = name.trim().replace(/\s+/g, ' ');
    if (!cleanName || cleanName.length > 30) throw new QueueError('invalid', 'Please enter a first name (up to 30 characters).');
    if (!isServiceId(service)) throw new QueueError('invalid', 'Unknown service.');

    const id = randomUUID();
    const joinedAt = Math.round(opts.joinedAt ?? this.now());
    const svc = getService(service);
    await this.run(JOIN, [this.key.seq(dayKey(this.now()), service)], [
      this.prefix,
      id,
      cleanName,
      service,
      svc.code,
      joinedAt,
      60 * 60 * 48,
    ]);
    await this.notify();
    const view = await this.getTicketView(id);
    if (!view) throw new Error('Ticket vanished after join');
    return view;
  }

  /** Returns the status the ticket had before leaving. */
  async leave(id: string): Promise<TicketStatus> {
    const [status, detail] = await this.run(
      LEAVE,
      [this.key.counters(), this.key.stats(dayKey(this.now())), this.key.counterLast()],
      [this.prefix, id, this.now(), this.ttl],
    );
    if (status !== 'ok') throw new QueueError(detail as QueueErrorCode);
    await this.notify();
    return detail as TicketStatus;
  }

  // -------------------------------------------------------------------- staff

  /**
   * Atomically assigns the next waiting ticket to `counter`. With no service,
   * takes whoever has waited longest across all open lines.
   */
  async callNext(counter: number, service?: ServiceId): Promise<Ticket> {
    this.assertCounter(counter);
    if (service !== undefined && !isServiceId(service)) throw new QueueError('invalid', 'Unknown service.');
    const services = service ? [service] : [...SERVICE_IDS];
    const [status, detail] = await this.run(
      CALL_NEXT,
      [this.key.counters(), this.key.paused(), this.key.recent(), this.key.stats(dayKey(this.now()))],
      [this.prefix, counter, this.now(), this.recentMax, ...services],
    );
    if (status !== 'ok') throw new QueueError(detail as QueueErrorCode);
    await this.notify();
    return (await this.getTicket(detail!))!;
  }

  markServed(counter: number, expectedTicketId?: string): Promise<Ticket> {
    return this.complete(counter, 'served', expectedTicketId);
  }

  markNoShow(counter: number, expectedTicketId?: string): Promise<Ticket> {
    return this.complete(counter, 'no_show', expectedTicketId);
  }

  private async complete(counter: number, outcome: 'served' | 'no_show', expectedId?: string): Promise<Ticket> {
    this.assertCounter(counter);
    const [status, detail] = await this.run(
      COMPLETE,
      [this.key.counters(), this.key.stats(dayKey(this.now())), this.key.counterLast()],
      [this.prefix, counter, this.now(), outcome, this.svcTimesMax, this.ttl, expectedId ?? ''],
    );
    if (status !== 'ok') {
      // A resident leaving mid-call clears the counter, which is worth broadcasting.
      if (detail === 'no_active') await this.notify();
      throw new QueueError(detail as QueueErrorCode);
    }
    await this.notify();
    return (await this.getTicket(detail!))!;
  }

  async recall(counter: number): Promise<Ticket> {
    this.assertCounter(counter);
    const [status, detail] = await this.run(
      RECALL,
      [this.key.counters(), this.key.recent()],
      [this.prefix, counter, this.now(), this.recentMax],
    );
    if (status !== 'ok') throw new QueueError(detail as QueueErrorCode);
    await this.notify();
    return (await this.getTicket(detail!))!;
  }

  async setPaused(service: ServiceId, paused: boolean): Promise<void> {
    if (!isServiceId(service)) throw new QueueError('invalid', 'Unknown service.');
    if (paused) await this.redis.sadd(this.key.paused(), service);
    else await this.redis.srem(this.key.paused(), service);
    await this.notify();
  }

  /** Wipes all queue state under this prefix. */
  async reset(): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) await this.redis.unlink(...keys);
    } while (cursor !== '0');
    await this.notify();
  }

  /** Pre-load rolling-average history (used by the seed script). */
  async recordServiceTimes(service: ServiceId, durationsMs: number[]): Promise<void> {
    if (!durationsMs.length) return;
    await this.redis
      .multi()
      .lpush(this.key.svcTimes(service), ...durationsMs.map((d) => Math.round(d)))
      .ltrim(this.key.svcTimes(service), 0, this.svcTimesMax - 1)
      .exec();
  }

  // ------------------------------------------------------------------ queries

  async getTicket(id: string): Promise<Ticket | null> {
    const h = await this.redis.hgetall(this.key.ticket(id));
    return parseTicket(h);
  }

  async avgServiceSec(service: ServiceId): Promise<number> {
    return (await this.avgServiceSecAll())[service];
  }

  private async avgServiceSecAll(): Promise<Record<ServiceId, number>> {
    const pipe = this.redis.pipeline();
    for (const id of SERVICE_IDS) pipe.lrange(this.key.svcTimes(id), 0, -1);
    const results = (await pipe.exec()) ?? [];
    const out = {} as Record<ServiceId, number>;
    SERVICE_IDS.forEach((id, i) => {
      const values = ((results[i]?.[1] as string[]) ?? []).map(Number).filter((n) => Number.isFinite(n));
      out[id] = values.length
        ? Math.round(values.reduce((a, b) => a + b, 0) / values.length / 1000)
        : getService(id).defaultServiceSec;
    });
    return out;
  }

  async getTicketView(id: string): Promise<TicketView | null> {
    return (await this.getTicketViews([id])).get(id) ?? null;
  }

  /** Batched lookup of resident views; missing tickets map to null. */
  async getTicketViews(ids: string[]): Promise<Map<string, TicketView | null>> {
    const out = new Map<string, TicketView | null>();
    if (!ids.length) return out;

    const pipe = this.redis.pipeline();
    for (const id of ids) pipe.hgetall(this.key.ticket(id));
    pipe.smembers(this.key.paused());
    const res = (await pipe.exec()) ?? [];
    const paused = new Set((res[ids.length]?.[1] as string[]) ?? []);
    const tickets = ids.map((_, i) => parseTicket(res[i]?.[1] as Record<string, string>));

    const rankPipe = this.redis.pipeline();
    const waiting = tickets.filter((t): t is Ticket => t?.status === 'waiting');
    for (const t of waiting) rankPipe.zrank(this.key.queue(t.service), t.id);
    const ranks = waiting.length ? ((await rankPipe.exec()) ?? []) : [];
    const rankById = new Map(waiting.map((t, i) => [t.id, ranks[i]?.[1] as number | null]));
    const avg = await this.avgServiceSecAll();
    const serverNow = this.now();

    ids.forEach((id, i) => {
      const ticket = tickets[i];
      if (!ticket) return out.set(id, null);
      const rank = rankById.get(id);
      const ahead = typeof rank === 'number' ? rank : null;
      out.set(id, {
        ticket,
        ahead,
        position: ahead === null ? null : ahead + 1,
        // Spec: estimated wait = people ahead × rolling average service time.
        estimatedWaitSec: ahead === null ? null : ahead * avg[ticket.service],
        servicePaused: paused.has(ticket.service),
        serverNow,
      });
    });
    return out;
  }

  async getStaffState(): Promise<StaffState> {
    const now = this.now();
    const pipe = this.redis.pipeline();
    for (const id of SERVICE_IDS) pipe.zrange(this.key.queue(id), 0, -1);
    pipe.smembers(this.key.paused());
    pipe.hgetall(this.key.stats(dayKey(now)));
    pipe.hgetall(this.key.counters());
    pipe.hgetall(this.key.counterLast());
    pipe.lrange(this.key.recent(), 0, -1);
    const res = (await pipe.exec()) ?? [];
    const n = SERVICE_IDS.length;
    const queueIds = SERVICE_IDS.map((_, i) => (res[i]?.[1] as string[]) ?? []);
    const paused = new Set((res[n]?.[1] as string[]) ?? []);
    const stats = (res[n + 1]?.[1] as Record<string, string>) ?? {};
    const counterMap = (res[n + 2]?.[1] as Record<string, string>) ?? {};
    const counterLast = (res[n + 3]?.[1] as Record<string, string>) ?? {};
    const recent = ((res[n + 4]?.[1] as string[]) ?? []).map((s) => JSON.parse(s) as RecentCall);

    // Load every ticket we need to describe in one round trip.
    const allIds = [...queueIds.flat(), ...Object.values(counterMap)];
    const tPipe = this.redis.pipeline();
    for (const id of allIds) tPipe.hgetall(this.key.ticket(id));
    const tRes = allIds.length ? ((await tPipe.exec()) ?? []) : [];
    const tickets = new Map<string, Ticket>();
    allIds.forEach((id, i) => {
      const t = parseTicket(tRes[i]?.[1] as Record<string, string>);
      if (t) tickets.set(id, t);
    });
    const avg = await this.avgServiceSecAll();
    const stat = (svc: string, f: string) => Number(stats[`${svc}:${f}`] ?? 0);

    const services = SERVICES.map((svc, i) => {
      const waiting = queueIds[i]
        .map((id) => tickets.get(id))
        .filter((t): t is Ticket => t?.status === 'waiting')
        .map((t) => ({ number: t.number, name: t.name, joinedAt: t.joinedAt }));
      const waitCount = stat(svc.id, 'waitCount');
      return {
        id: svc.id,
        code: svc.code,
        name: svc.name,
        paused: paused.has(svc.id),
        waiting,
        waitingCount: waiting.length,
        avgServiceSec: avg[svc.id],
        estimatedWaitSec: waiting.length * avg[svc.id],
        servedToday: stat(svc.id, 'served'),
        noShowToday: stat(svc.id, 'noShow'),
        avgWaitSec: waitCount ? Math.round(stat(svc.id, 'waitSum') / waitCount / 1000) : null,
      };
    });

    const counters: CounterState[] = [];
    for (let c = 1; c <= this.counters; c++) {
      const t = counterMap[c] ? tickets.get(counterMap[c]) : undefined;
      counters.push({
        counter: c,
        ticket:
          t && t.status === 'called'
            ? { number: t.number, name: t.name, service: t.service, calledAt: t.calledAt ?? now, recallCount: t.recallCount }
            : null,
        last: counterLast[c] ? (JSON.parse(counterLast[c]) as CounterOutcome) : null,
      });
    }

    const totalWaitSum = SERVICE_IDS.reduce((a, s) => a + stat(s, 'waitSum'), 0);
    const totalWaitCount = SERVICE_IDS.reduce((a, s) => a + stat(s, 'waitCount'), 0);
    return {
      services,
      counters,
      recent,
      totals: {
        waiting: services.reduce((a, s) => a + s.waitingCount, 0),
        servedToday: services.reduce((a, s) => a + s.servedToday, 0),
        noShowToday: services.reduce((a, s) => a + s.noShowToday, 0),
        avgWaitSec: totalWaitCount ? Math.round(totalWaitSum / totalWaitCount / 1000) : null,
      },
      serverNow: now,
    };
  }
}

/** Public lobby view: ticket numbers only, no names. */
export function toLobbyState(state: StaffState): LobbyState {
  return {
    services: state.services.map(({ id, code, name, paused, waitingCount, estimatedWaitSec }) => ({
      id,
      code,
      name,
      paused,
      waitingCount,
      estimatedWaitSec,
    })),
    nowServing: state.counters
      .filter((c) => c.ticket)
      .map((c) => ({ counter: c.counter, number: c.ticket!.number, service: c.ticket!.service, calledAt: c.ticket!.calledAt }))
      .sort((a, b) => b.calledAt - a.calledAt),
    recent: state.recent,
    serverNow: state.serverNow,
  };
}

function parseTicket(h: Record<string, string> | null | undefined): Ticket | null {
  if (!h || !h.id) return null;
  const num = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v));
  return {
    id: h.id,
    number: h.number,
    name: h.name,
    service: h.service as ServiceId,
    status: h.status as TicketStatus,
    joinedAt: Number(h.joinedAt),
    calledAt: num(h.calledAt),
    endedAt: num(h.endedAt),
    counter: num(h.counter),
    recallCount: Number(h.recallCount ?? 0),
  };
}
