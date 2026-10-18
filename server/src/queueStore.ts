import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { openStatus, zonedParts, type OfficeConfig } from './officeConfig';
import { DEFAULT_LANG, langOr, type Lang } from './i18n';
import { CALL_NEXT, COMPLETE, JOIN, LEAVE, RECALL, SET_LANG, SET_PRIORITY } from './scripts';
import {
  PRIORITY_REASONS,
  type CounterOutcome,
  CounterState,
  LobbyState,
  OfficeInfo,
  type PriorityReason,
  type RecentCall,
  type StaffState,
  type Ticket,
  type TicketKind,
  type TicketStatus,
  type TicketView,
  type WaitEstimate,
} from './types';

export type QueueErrorCode =
  | 'empty'
  | 'paused'
  | 'closed'
  | 'counter_busy'
  | 'service_busy'
  | 'no_active'
  | 'stale'
  | 'not_found'
  | 'not_active'
  | 'too_early'
  | 'missed'
  | 'slot_full'
  | 'appointments_off'
  | 'invalid';

const MESSAGES: Record<QueueErrorCode, string> = {
  empty: 'No one is waiting in line.',
  paused: 'That line is paused.',
  closed: 'Joining is closed right now.',
  counter_busy: 'This counter is already serving someone. Mark them served or no-show first.',
  service_busy: 'That service still has people in line.',
  no_active: 'No one is currently at this counter.',
  stale: 'This counter has moved on to a different ticket. Refresh and try again.',
  not_found: 'Ticket not found.',
  not_active: 'This ticket is no longer in line.',
  too_early: 'It’s too early to check in.',
  missed: 'This appointment was missed. The check-in window has closed.',
  slot_full: 'That time is fully booked. Please choose another.',
  appointments_off: 'This office isn’t taking appointments.',
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

const DAY = 24 * 60 * 60;

export interface QueueStoreOptions {
  /** Key prefix of the office, e.g. "vq:o:k3j9x2m4pq:". */
  prefix: string;
  /** The office's settings: services, counters, hours, time zone. */
  config: OfficeConfig;
  /** Clock, injectable for tests and the seed simulation. */
  now?: () => number;
  /** How many recent service durations feed the rolling average. */
  svcTimesMax?: number;
  recentMax?: number;
  /** Inactivity TTL applied to every key written. */
  officeTtlSec?: number;
  /** Service durations older than this are ignored when enough newer ones exist. */
  serviceWindowMs?: number;
  /** A counter counts as serving a line if it called from it within this window. */
  counterWindowMs?: number;
}

interface ServiceStats {
  meanSec: number;
  q1Sec: number;
  q3Sec: number;
  samples: number;
}

const MIN_SAMPLES = 3;

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

type ScriptResult = [string, string?, string?];

/**
 * All queue state and logic for one office. Cheap to construct: build one per
 * request from the office's current config.
 */
export class QueueStore {
  readonly prefix: string;
  readonly config: OfficeConfig;
  private readonly clock: () => number;
  private readonly svcTimesMax: number;
  private readonly recentMax: number;
  private readonly ttl: number;
  private readonly finishedTtl: number;
  private readonly statsTtl: number;
  private readonly seqTtl: number;
  private readonly serviceWindowMs: number;
  private readonly counterWindowMs: number;

  constructor(
    private readonly redis: Redis,
    opts: QueueStoreOptions,
  ) {
    this.prefix = opts.prefix;
    this.config = opts.config;
    this.clock = opts.now ?? Date.now;
    this.svcTimesMax = opts.svcTimesMax ?? 20;
    this.recentMax = opts.recentMax ?? 12;
    this.ttl = opts.officeTtlSec ?? 30 * DAY;
    // Shorter-lived keys never outlive the office itself.
    this.finishedTtl = Math.min(12 * 60 * 60, this.ttl);
    this.statsTtl = Math.min(8 * DAY, this.ttl);
    this.seqTtl = Math.min(2 * DAY, this.ttl);
    this.serviceWindowMs = opts.serviceWindowMs ?? 3 * 60 * 60_000;
    this.counterWindowMs = opts.counterWindowMs ?? 30 * 60_000;
  }

  /** Whole-millisecond timestamps (Redis HINCRBY needs integers). */
  private now(): number {
    return Math.round(this.clock());
  }

  /** Redis pub/sub channel announcing that this office's state changed. */
  get eventsChannel(): string {
    return `${this.prefix}events`;
  }

  private get serviceIds(): string[] {
    return this.config.services.map((s) => s.id);
  }

  private service(id: string) {
    return this.config.services.find((s) => s.id === id);
  }

  counterName(id: number | null | undefined): string | null {
    if (id == null) return null;
    return this.config.counters.find((c) => c.id === id)?.name ?? `Counter ${id}`;
  }

  /** "Today" in the office's own time zone. */
  private today(): string {
    return this.dayOf(this.now());
  }

  private dayOf(ts: number): string {
    return zonedParts(ts, this.config.timezone).dateKey;
  }

  private key = {
    ticket: (id: string) => `${this.prefix}ticket:${id}`,
    queue: (svc: string) => `${this.prefix}queue:${svc}`,
    svcTimes: (svc: string) => `${this.prefix}svctimes:${svc}`,
    seq: (day: string, svc: string) => `${this.prefix}seq:${day}:${svc}`,
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

  async notify(): Promise<void> {
    await this.redis.publish(this.eventsChannel, String(this.now()));
  }

  private assertCounter(counter: number): void {
    if (!this.config.counters.some((c) => c.id === counter)) {
      throw new QueueError('invalid', 'Unknown counter.');
    }
  }

  private assertService(service: string): void {
    if (!this.service(service)) throw new QueueError('invalid', 'Unknown service.');
  }

  officeInfo(): OfficeInfo {
    return { ...this.config, status: openStatus(this.config, this.now()) };
  }

  // ---------------------------------------------------------------- residents

  async join(name: string, service: string, opts: { joinedAt?: number; ignoreHours?: boolean; lang?: Lang } = {}): Promise<TicketView> {
    const cleanName = name.trim().replace(/\s+/g, ' ');
    if (!cleanName || cleanName.length > 30) throw new QueueError('invalid', 'Please enter a first name (up to 30 characters).');
    this.assertService(service);
    if (!opts.ignoreHours) {
      const status = openStatus(this.config, this.now());
      if (!status.open) throw new QueueError('closed', status.message ?? undefined);
    }

    const id = randomUUID();
    const joinedAt = Math.round(opts.joinedAt ?? this.now());
    await this.run(JOIN, [this.key.seq(this.today(), service)], [
      this.prefix,
      id,
      cleanName,
      service,
      this.service(service)!.code,
      joinedAt,
      this.seqTtl,
      this.ttl,
      opts.lang ?? DEFAULT_LANG,
      this.dayOf(joinedAt),
      this.ttl,
    ]);
    await this.notify();
    const view = await this.getTicketView(id);
    if (!view) throw new Error('Ticket vanished after join');
    return view;
  }

  /** Change the resident's language on an active ticket (alerts and announcements use it). */
  async setLanguage(id: string, lang: Lang): Promise<TicketView> {
    const view = await this.getTicketView(id);
    if (!view || view.ticket.status === 'left' || view.ticket.status === 'served' || view.ticket.status === 'no_show') {
      throw new QueueError('not_found', 'Ticket not found.');
    }
    await this.redis.eval(SET_LANG, 1, this.key.ticket(id), lang);
    await this.notify();
    return { ...view, ticket: { ...view.ticket, lang } };
  }

  /** Returns the status the ticket had before leaving. */
  async leave(id: string): Promise<TicketStatus> {
    const [status, detail] = await this.run(
      LEAVE,
      [this.key.counters(), this.key.stats(this.today()), this.key.counterLast()],
      [this.prefix, id, this.now(), this.finishedTtl, this.ttl, this.statsTtl, this.today(), this.ttl],
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
  async callNext(counter: number, service?: string): Promise<Ticket> {
    this.assertCounter(counter);
    if (service !== undefined) this.assertService(service);
    const services = service ? [service] : this.serviceIds;
    const [status, detail] = await this.run(
      CALL_NEXT,
      [this.key.counters(), this.key.paused(), this.key.recent(), this.key.stats(this.today())],
      [this.prefix, counter, this.now(), this.recentMax, this.ttl, this.statsTtl, this.today(), this.ttl, ...services],
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
      [this.key.counters(), this.key.stats(this.today()), this.key.counterLast()],
      [this.prefix, counter, this.now(), outcome, this.svcTimesMax, this.finishedTtl, expectedId ?? '', this.ttl, this.statsTtl, this.today(), this.ttl],
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
      [this.prefix, counter, this.now(), this.recentMax, this.ttl],
    );
    if (status !== 'ok') throw new QueueError(detail as QueueErrorCode);
    await this.notify();
    return (await this.getTicket(detail!))!;
  }

  async setPaused(service: string, paused: boolean): Promise<void> {
    this.assertService(service);
    const multi = this.redis.multi();
    if (paused) multi.sadd(this.key.paused(), service);
    else multi.srem(this.key.paused(), service);
    await multi.expire(this.key.paused(), this.ttl).exec();
    await this.notify();
  }

  /**
   * Mark a waiting ticket (by its public number) as priority, or pass null to
   * remove priority. Priority tickets are called before regular ones in the
   * same line, in their own join order.
   */
  async setPriority(number: string, reason: PriorityReason | null): Promise<Ticket> {
    if (reason !== null && !PRIORITY_REASONS.includes(reason)) throw new QueueError('invalid', 'Unknown priority reason.');
    const [status, detail] = await this.run(SET_PRIORITY, [], [this.prefix, number, reason ?? '', this.ttl, ...this.serviceIds]);
    if (status !== 'ok') {
      throw new QueueError(detail as QueueErrorCode, detail === 'not_found' ? `No one with ticket ${number} is waiting.` : undefined);
    }
    await this.notify();
    return (await this.getTicket(detail!))!;
  }

  /** Current ticket id at a counter (used to guard against stale screens). */
  async ticketIdAtCounter(counter: number): Promise<string | null> {
    return this.redis.hget(this.key.counters(), String(counter));
  }

  /** Wipes all queue state for this office, keeping the office itself. */
  /** Clears the live queue. Keeps the office's settings and its event history (analytics). */
  async reset(): Promise<void> {
    const keep = `${this.prefix}meta`;
    const history = `${this.prefix}ev:`;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 500);
      cursor = next;
      const doomed = keys.filter((k) => k !== keep && !k.startsWith(history));
      if (doomed.length) await this.redis.unlink(...doomed);
    } while (cursor !== '0');
    await this.notify();
  }

  // ------------------------------------------------------------------ queries

  async getTicket(id: string): Promise<Ticket | null> {
    const h = await this.redis.hgetall(this.key.ticket(id));
    return parseTicket(h);
  }

  async avgServiceSec(service: string): Promise<number> {
    return (await this.serviceStats())[service].meanSec;
  }

  /**
   * Recent service durations per service: mean and quartiles. Uses durations
   * from the rolling time window when there are enough of them, otherwise the
   * last N recorded, otherwise the service's configured default.
   */
  async serviceStats(): Promise<Record<string, ServiceStats>> {
    const pipe = this.redis.pipeline();
    for (const id of this.serviceIds) pipe.lrange(this.key.svcTimes(id), 0, -1);
    const results = (await pipe.exec()) ?? [];
    const cutoff = this.now() - this.serviceWindowMs;
    const out: Record<string, ServiceStats> = {};
    this.config.services.forEach((svc, i) => {
      const all = ((results[i]?.[1] as string[]) ?? [])
        .map((raw) => {
          const [dur, at] = raw.split(':').map(Number);
          return { sec: dur / 1000, at: Number.isFinite(at) ? at : null };
        })
        .filter((x) => Number.isFinite(x.sec));
      const recent = all.filter((x) => x.at !== null && x.at >= cutoff);
      const used = (recent.length >= MIN_SAMPLES ? recent : all).map((x) => x.sec).sort((a, b) => a - b);
      if (used.length === 0) {
        const d = svc.defaultServiceSec;
        out[svc.id] = { meanSec: d, q1Sec: d * 0.75, q3Sec: d * 1.3, samples: 0 };
        return;
      }
      const mean = used.reduce((a, b) => a + b, 0) / used.length;
      out[svc.id] =
        used.length < MIN_SAMPLES
          ? { meanSec: Math.round(mean), q1Sec: mean * 0.75, q3Sec: mean * 1.3, samples: used.length }
          : { meanSec: Math.round(mean), q1Sec: quantile(used, 0.25), q3Sec: quantile(used, 0.75), samples: used.length };
    });
    return out;
  }

  /**
   * How many counters are effectively serving each service: each counter's
   * calls in the recent window are split across the services it called from,
   * so a counter alternating between two lines counts as half for each.
   * Counters still serving someone called earlier count fully for that line.
   */
  async activeCounters(counterMap?: Record<string, string>): Promise<Record<string, number>> {
    const [log, map] = await Promise.all([
      this.redis.lrange(`${this.prefix}calllog`, 0, -1),
      counterMap ? Promise.resolve(counterMap) : this.redis.hgetall(this.key.counters()),
    ]);
    const cutoff = this.now() - this.counterWindowMs;
    const valid = new Set(this.config.counters.map((c) => c.id));
    const perCounter = new Map<number, Map<string, number>>();
    for (const raw of log) {
      const e = JSON.parse(raw) as { c: number; s: string; at: number };
      if (e.at < cutoff || !valid.has(e.c)) continue;
      const m = perCounter.get(e.c) ?? new Map<string, number>();
      m.set(e.s, (m.get(e.s) ?? 0) + 1);
      perCounter.set(e.c, m);
    }
    const out: Record<string, number> = Object.fromEntries(this.serviceIds.map((id) => [id, 0]));
    for (const m of perCounter.values()) {
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      for (const [svc, n] of m) if (svc in out) out[svc] += n / total;
    }
    // A counter busy with a long service may have no recent calls; count it for that line.
    const busyIds = Object.entries(map).filter(([c]) => !perCounter.has(Number(c)) && valid.has(Number(c)));
    if (busyIds.length) {
      const pipe = this.redis.pipeline();
      for (const [, id] of busyIds) pipe.hmget(this.key.ticket(id), 'service', 'status');
      const res = (await pipe.exec()) ?? [];
      for (const r of res) {
        const [svc, status] = (r?.[1] as [string | null, string | null]) ?? [];
        if (svc && status === 'called' && svc in out) out[svc] += 1;
      }
    }
    for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 100) / 100;
    return out;
  }

  /** Wait for someone with `ahead` people in front of them. */
  private estimate(ahead: number, stats: ServiceStats, counters: number): WaitEstimate {
    const c = Math.max(1, counters);
    const sec = Math.round((ahead * stats.meanSec) / c);
    return {
      sec,
      lowSec: Math.min(sec, Math.round((ahead * stats.q1Sec) / c)),
      highSec: Math.max(sec, Math.round((ahead * stats.q3Sec) / c)),
    };
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
    const [stats, active] = waiting.length ? await Promise.all([this.serviceStats(), this.activeCounters()]) : [null, null];
    const serverNow = this.now();

    ids.forEach((id, i) => {
      const ticket = tickets[i];
      if (!ticket) return out.set(id, null);
      const rank = rankById.get(id);
      const ahead = typeof rank === 'number' ? rank : null;
      const est = ahead !== null && stats?.[ticket.service] ? this.estimate(ahead, stats[ticket.service], active![ticket.service]) : null;
      out.set(id, {
        ticket,
        serviceName: this.service(ticket.service)?.name ?? 'Service',
        counterName: this.counterName(ticket.counter),
        ahead,
        position: ahead === null ? null : ahead + 1,
        estimatedWaitSec: est?.sec ?? null,
        estimate: est,
        servicePaused: paused.has(ticket.service),
        serverNow,
      });
    });
    return out;
  }

  async getStaffState(): Promise<StaffState> {
    const now = this.now();
    const services = this.config.services;
    const pipe = this.redis.pipeline();
    for (const s of services) pipe.zrange(this.key.queue(s.id), 0, -1);
    pipe.smembers(this.key.paused());
    pipe.hgetall(this.key.stats(this.today()));
    pipe.hgetall(this.key.counters());
    pipe.hgetall(this.key.counterLast());
    pipe.lrange(this.key.recent(), 0, -1);
    const res = (await pipe.exec()) ?? [];
    const n = services.length;
    const queueIds = services.map((_, i) => (res[i]?.[1] as string[]) ?? []);
    const paused = new Set((res[n]?.[1] as string[]) ?? []);
    const stats = (res[n + 1]?.[1] as Record<string, string>) ?? {};
    const counterMap = (res[n + 2]?.[1] as Record<string, string>) ?? {};
    const counterLast = (res[n + 3]?.[1] as Record<string, string>) ?? {};
    const recent = ((res[n + 4]?.[1] as string[]) ?? []).map((s) => {
      const r = JSON.parse(s) as Omit<RecentCall, 'counterName'>;
      return { ...r, counterName: this.counterName(r.counter)! };
    });

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
    const [svcStats, active] = await Promise.all([this.serviceStats(), this.activeCounters(counterMap)]);
    const stat = (svc: string, f: string) => Number(stats[`${svc}:${f}`] ?? 0);

    const serviceStates = services.map((svc, i) => {
      const waiting = queueIds[i]
        .map((id) => tickets.get(id))
        .filter((t): t is Ticket => t?.status === 'waiting')
        .map((t) => ({ number: t.number, name: t.name, joinedAt: t.joinedAt, priority: t.priority, kind: t.kind, appointmentAt: t.appointmentAt }));
      const waitCount = stat(svc.id, 'waitCount');
      return {
        id: svc.id,
        code: svc.code,
        name: svc.name,
        paused: paused.has(svc.id),
        waiting,
        waitingCount: waiting.length,
        avgServiceSec: svcStats[svc.id].meanSec,
        activeCounters: active[svc.id],
        estimatedWaitSec: this.estimate(waiting.length, svcStats[svc.id], active[svc.id]).sec,
        estimate: this.estimate(waiting.length, svcStats[svc.id], active[svc.id]),
        servedToday: stat(svc.id, 'served'),
        noShowToday: stat(svc.id, 'noShow'),
        avgWaitSec: waitCount ? Math.round(stat(svc.id, 'waitSum') / waitCount / 1000) : null,
      };
    });

    const counters: CounterState[] = this.config.counters.map((c) => {
      const t = counterMap[c.id] ? tickets.get(counterMap[c.id]) : undefined;
      return {
        counter: c.id,
        name: c.name,
        ticket:
          t && t.status === 'called'
            ? { number: t.number, name: t.name, service: t.service, calledAt: t.calledAt ?? now, recallCount: t.recallCount, lang: t.lang }
            : null,
        last: counterLast[c.id] ? (JSON.parse(counterLast[c.id]) as CounterOutcome) : null,
      };
    });

    const ids = services.map((s) => s.id);
    const totalWaitSum = ids.reduce((a, s) => a + stat(s, 'waitSum'), 0);
    const totalWaitCount = ids.reduce((a, s) => a + stat(s, 'waitCount'), 0);
    return {
      office: this.officeInfo(),
      services: serviceStates,
      counters,
      recent,
      totals: {
        waiting: serviceStates.reduce((a, s) => a + s.waitingCount, 0),
        servedToday: serviceStates.reduce((a, s) => a + s.servedToday, 0),
        noShowToday: serviceStates.reduce((a, s) => a + s.noShowToday, 0),
        avgWaitSec: totalWaitCount ? Math.round(totalWaitSum / totalWaitCount / 1000) : null,
      },
      serverNow: now,
    };
  }
}

/** Public lobby view: ticket numbers only, no names. */
export function toLobbyState(state: StaffState): LobbyState {
  return {
    office: state.office,
    services: state.services.map(({ id, code, name, paused, waitingCount, estimatedWaitSec, estimate }) => ({
      id,
      code,
      name,
      paused,
      waitingCount,
      estimatedWaitSec,
      estimate,
    })),
    nowServing: state.counters
      .filter((c) => c.ticket)
      .map((c) => ({ counter: c.counter, counterName: c.name, number: c.ticket!.number, service: c.ticket!.service, calledAt: c.ticket!.calledAt, lang: c.ticket!.lang }))
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
    service: h.service,
    status: h.status as TicketStatus,
    joinedAt: Number(h.joinedAt),
    calledAt: num(h.calledAt),
    endedAt: num(h.endedAt),
    counter: num(h.counter),
    recallCount: Number(h.recallCount ?? 0),
    priority: (h.priority as PriorityReason) || null,
    kind: (h.kind as TicketKind) || 'walkin',
    appointmentAt: num(h.appointmentAt),
    lang: langOr(h.lang),
  };
}
