import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type Redis from 'ioredis';
import { AnalyticsStore, DEFAULT_ANALYTICS_DAYS, eventKeys } from './analytics';
import { AppointmentBook } from './appointments';
import { defaultConfig, normalizeSettings, withDefaults, zonedParts, type OfficeConfig } from './officeConfig';
import { QueueError, QueueStore } from './queueStore';
import { SAVE_CONFIG, TOUCH } from './scripts';

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/o, 1/l/i)
const ID_LENGTH = 10;
const OFFICE_ID = /^[a-z0-9]{6,32}$/;

export function isOfficeId(value: unknown): value is string {
  return typeof value === 'string' && OFFICE_ID.test(value);
}

const hashKey = (key: string) => createHash('sha256').update(key).digest();

export interface OfficeStoreOptions {
  /** Root key prefix; each office lives under `${root}o:${officeId}:`. */
  root?: string;
  /** Offices (and all their data) expire after this long without activity. */
  ttlSec?: number;
  now?: () => number;
  /** Minimum gap between TTL refreshes for one office. */
  touchIntervalMs?: number;
  /** How many days of ticket events (analytics) an active office keeps. */
  analyticsDays?: number;
}

export interface CreatedOffice {
  officeId: string;
  /** Shown once; only its hash is stored. */
  staffKey: string;
  config: OfficeConfig;
}

/** Registry of offices: creation, settings, staff-key checks and expiry. */
export class OfficeStore {
  readonly root: string;
  readonly ttlSec: number;
  readonly analyticsDays: number;
  private readonly now: () => number;
  private readonly touchIntervalMs: number;
  private readonly lastTouch = new Map<string, number>();

  constructor(
    private readonly redis: Redis,
    opts: OfficeStoreOptions = {},
  ) {
    this.root = opts.root ?? 'vq:';
    this.ttlSec = opts.ttlSec ?? 30 * 24 * 60 * 60;
    this.now = opts.now ?? Date.now;
    this.touchIntervalMs = opts.touchIntervalMs ?? 60_000;
    this.analyticsDays = opts.analyticsDays ?? DEFAULT_ANALYTICS_DAYS;
  }

  prefixFor(officeId: string): string {
    return `${this.root}o:${officeId}:`;
  }

  private metaKey(officeId: string): string {
    return `${this.prefixFor(officeId)}meta`;
  }

  /** Pattern matching every office's events channel. */
  get eventsPattern(): string {
    return `${this.root}o:*:events`;
  }

  officeIdFromChannel(channel: string): string | null {
    const m = channel.slice(this.root.length).match(/^o:([a-z0-9]+):events$/);
    return m ? m[1] : null;
  }

  async create(opts: { name?: string; timezone?: string } = {}): Promise<CreatedOffice> {
    const config = defaultConfig(opts.name?.trim().slice(0, 60) || undefined, opts.timezone);
    const staffKey = randomBytes(24).toString('base64url');
    for (let attempt = 0; attempt < 5; attempt++) {
      const officeId = Array.from({ length: ID_LENGTH }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('');
      const key = this.metaKey(officeId);
      // HSETNX claims the id atomically, so two creations can never collide.
      if (!(await this.redis.hsetnx(key, 'createdAt', String(this.now())))) continue;
      await this.redis
        .multi()
        .hset(key, 'config', JSON.stringify(config), 'keyHash', hashKey(staffKey).toString('hex'))
        .expire(key, this.ttlSec)
        .exec();
      return { officeId, staffKey, config };
    }
    throw new Error('Could not allocate an office id');
  }

  /** The office's settings, or null if it doesn't exist (or has expired). */
  async getConfig(officeId: string): Promise<OfficeConfig | null> {
    if (!isOfficeId(officeId)) return null;
    const raw = await this.redis.hget(this.metaKey(officeId), 'config');
    return raw ? withDefaults(JSON.parse(raw) as OfficeConfig) : null;
  }

  /** Constant-time check of a staff key against the stored hash. */
  async verifyKey(officeId: string, staffKey: unknown): Promise<boolean> {
    if (!isOfficeId(officeId) || typeof staffKey !== 'string' || !staffKey) return false;
    const stored = await this.redis.hget(this.metaKey(officeId), 'keyHash');
    if (!stored) return false;
    return timingSafeEqual(Buffer.from(stored, 'hex'), hashKey(staffKey));
  }

  queue(officeId: string, config: OfficeConfig, opts: { now?: () => number } = {}): QueueStore {
    return new QueueStore(this.redis, { prefix: this.prefixFor(officeId), config, officeTtlSec: this.ttlSec, now: opts.now ?? this.now });
  }

  analytics(officeId: string, config: OfficeConfig): AnalyticsStore {
    return new AnalyticsStore(this.redis, this.prefixFor(officeId), config, { retentionDays: this.analyticsDays, now: this.now });
  }

  appointments(officeId: string, config: OfficeConfig, opts: { now?: () => number } = {}): AppointmentBook {
    return new AppointmentBook(this.redis, this.queue(officeId, config, opts), { officeTtlSec: this.ttlSec, now: opts.now ?? this.now });
  }

  /**
   * Validate and save settings. Refuses (atomically) to remove a service that
   * still has people in it, or a counter that is serving someone.
   */
  async saveSettings(officeId: string, input: unknown): Promise<OfficeConfig> {
    const previous = await this.getConfig(officeId);
    if (!previous) throw new QueueError('not_found', 'Office not found.');
    const next = normalizeSettings(input);

    const removedServices = previous.services.filter((s) => !next.services.some((n) => n.id === s.id));
    const removedCounters = previous.counters.filter((c) => !next.counters.some((n) => n.id === c.id));
    const book = this.appointments(officeId, previous);
    for (const svc of removedServices) {
      const n = await book.upcomingCount(svc.id);
      if (n > 0) {
        throw new QueueError('service_busy', `Can’t remove “${svc.name}” while ${n} upcoming appointment${n === 1 ? ' is' : 's are'} booked for it. Cancel them first.`);
      }
    }
    const prefix = this.prefixFor(officeId);
    const [status, code, detail, count] = (await this.redis.eval(
      SAVE_CONFIG,
      2,
      this.metaKey(officeId),
      `${prefix}counters`,
      prefix,
      String(this.ttlSec),
      JSON.stringify(next),
      String(removedServices.length),
      ...removedServices.map((s) => s.id),
      ...removedCounters.map((c) => String(c.id)),
    )) as [string, string?, string?, string?];

    if (status !== 'ok') {
      if (code === 'service_busy') {
        const name = previous.services.find((s) => s.id === detail)?.name ?? 'That service';
        const who = Number(count) > 0 ? `${count} ${Number(count) === 1 ? 'person is' : 'people are'} still waiting` : 'someone is being served';
        throw new QueueError('service_busy', `Can’t remove “${name}” while ${who}. Pause the line and serve them first.`);
      }
      if (code === 'counter_busy') {
        const name = previous.counters.find((c) => String(c.id) === detail)?.name ?? 'That counter';
        throw new QueueError('counter_busy', `Can’t remove “${name}” while it is serving someone.`);
      }
      throw new QueueError('not_found', 'Office not found.');
    }
    await this.touch(officeId, next, { force: true });
    await this.redis.publish(`${prefix}events`, 'settings');
    return next;
  }

  /**
   * Record activity: refresh the inactivity TTL on all of the office's live
   * keys. Throttled per office, since it runs on every request.
   */
  async touch(officeId: string, config: OfficeConfig, opts: { force?: boolean } = {}): Promise<void> {
    const now = this.now();
    if (!opts.force && now - (this.lastTouch.get(officeId) ?? 0) < this.touchIntervalMs) return;
    this.lastTouch.set(officeId, now);
    await this.redis.eval(TOUCH, 0, this.prefixFor(officeId), String(this.ttlSec), ...config.services.map((s) => s.id));
    // Event history within the retention window lives as long as the office;
    // older days stop being refreshed and expire on their own.
    const pipe = this.redis.pipeline();
    for (const key of eventKeys(this.prefixFor(officeId), zonedParts(now, config.timezone).dateKey, this.analyticsDays)) pipe.expire(key, this.ttlSec);
    await pipe.exec();
  }
}
