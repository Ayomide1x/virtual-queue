import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { z } from 'zod';
import { ALERT_TEXTS, formatDateIn, formatTimeIn } from '../i18n';
import type { OfficeConfig } from '../officeConfig';
import type { OfficeStore } from '../offices';
import { QueueError } from '../queueStore';
import { CLAIM_JOBS, ENQUEUE_ALERT } from '../scripts';
import { AlertSendError, maskEmail, type AlertMessage, type EmailSender, type PushSender, type PushSubscriptionJSON } from './senders';

export type AlertType = 'near' | 'called' | 'reminder' | 'confirm';
export type Channel = 'push' | 'email';
type Target = 'ticket' | 'appointment';

export interface AlertJob {
  id: string;
  officeId: string;
  target: Target;
  targetId: string;
  type: AlertType;
  channel: Channel;
  attempts: number;
}

export interface ContactSummary {
  push: boolean;
  /** Masked, e.g. "a******@g****.com" — the full address never leaves the server. */
  email: string | null;
}

/** Push services browsers actually use. Anything else is refused (no server-side requests to arbitrary URLs). */
export const DEFAULT_PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];

export interface AlertServiceOptions {
  redis: Redis;
  offices: OfficeStore;
  push: PushSender;
  email: EmailSender;
  /** Base URL used for links in alerts, e.g. "http://192.168.1.20:3000". */
  baseUrl: string;
  now?: () => number;
  /** Alert when this many people (or fewer) are ahead. */
  nearThreshold?: number;
  /** Appointment reminders go out this long before the slot. */
  reminderLeadMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** A claimed job whose worker hasn't finished within this time is retried. */
  leaseMs?: number;
  /** A send taking longer than this counts as a (retryable) failure. */
  sendTimeoutMs?: number;
  pollMs?: number;
  batchSize?: number;
  scanDebounceMs?: number;
  allowedPushHosts?: string[];
  log?: (line: string) => void;
}

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+=*$/),
    auth: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+=*$/),
  }),
});
const emailSchema = z.string().trim().toLowerCase().email('Please enter a valid email address.').max(254);

/**
 * Alerts for residents: stores their contact details, decides when an alert is
 * due, and delivers it from a Redis-backed background job queue — so a slow
 * or failing push/email service never touches the queue itself.
 */
export class AlertService {
  private readonly redis: Redis;
  private readonly offices: OfficeStore;
  readonly push: PushSender;
  readonly email: EmailSender;
  private readonly o: Required<Omit<AlertServiceOptions, 'redis' | 'offices' | 'push' | 'email' | 'now' | 'log'>>;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;
  private readonly scanTimers = new Map<string, NodeJS.Timeout>();

  constructor(opts: AlertServiceOptions) {
    this.redis = opts.redis;
    this.offices = opts.offices;
    this.push = opts.push;
    this.email = opts.email;
    this.clock = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.log(line));
    this.o = {
      baseUrl: opts.baseUrl.replace(/\/+$/, ''),
      nearThreshold: opts.nearThreshold ?? 3,
      reminderLeadMs: opts.reminderLeadMs ?? 60 * 60_000,
      maxAttempts: opts.maxAttempts ?? 6,
      backoffBaseMs: opts.backoffBaseMs ?? 5_000,
      backoffMaxMs: opts.backoffMaxMs ?? 5 * 60_000,
      leaseMs: opts.leaseMs ?? 60_000,
      sendTimeoutMs: opts.sendTimeoutMs ?? 15_000,
      pollMs: opts.pollMs ?? 500,
      batchSize: opts.batchSize ?? 20,
      scanDebounceMs: opts.scanDebounceMs ?? 100,
      allowedPushHosts: opts.allowedPushHosts ?? DEFAULT_PUSH_HOSTS,
    };
  }

  private now(): number {
    return Math.round(this.clock());
  }

  // ------------------------------------------------------------------ keys

  private readonly global = {
    jobs: () => `${this.offices.root}alerts:jobs`,
    processing: () => `${this.offices.root}alerts:processing`,
    reminders: () => `${this.offices.root}alerts:reminders`,
  };

  private contactKey(officeId: string, target: Target, id: string): string {
    const p = this.offices.prefixFor(officeId);
    return target === 'ticket' ? `${p}notify:${id}` : `${p}notify:appt:${id}`;
  }

  private alertedKey(officeId: string, target: Target, id: string): string {
    const p = this.offices.prefixFor(officeId);
    return target === 'ticket' ? `${p}alerts:${id}` : `${p}alerts:appt:${id}`;
  }

  private indexKey(officeId: string): string {
    return `${this.offices.prefixFor(officeId)}notifyidx`;
  }

  // -------------------------------------------------------------- contacts

  private parseContact(input: { push?: unknown; email?: unknown }): { push?: PushSubscriptionJSON; email?: string } {
    const out: { push?: PushSubscriptionJSON; email?: string } = {};
    if (input.push !== undefined && input.push !== null) {
      if (!this.push.enabled) throw new QueueError('invalid', 'Push notifications aren’t set up on this server.');
      const sub = subscriptionSchema.safeParse(input.push);
      if (!sub.success) throw new QueueError('invalid', 'That push subscription isn’t valid.');
      const url = new URL(sub.data.endpoint);
      const allowed = url.protocol === 'https:' && this.o.allowedPushHosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
      if (!allowed) throw new QueueError('invalid', 'That push service isn’t supported.');
      out.push = sub.data as PushSubscriptionJSON;
    }
    if (input.email !== undefined && input.email !== null && input.email !== '') {
      const email = emailSchema.safeParse(input.email);
      if (!email.success) throw new QueueError('invalid', 'Please enter a valid email address.');
      out.email = email.data;
    }
    if (!out.push && !out.email) throw new QueueError('invalid', 'Choose notifications or enter an email address.');
    return out;
  }

  private summarize(h: Record<string, string>): ContactSummary {
    return { push: !!h.push, email: h.email ? maskEmail(h.email) : null };
  }

  private async requireOffice(officeId: string): Promise<OfficeConfig> {
    const config = await this.offices.getConfig(officeId);
    if (!config) throw new QueueError('not_found', 'Office not found.');
    return config;
  }

  /** Opt a waiting (or called) ticket in to alerts. */
  async setTicketContact(officeId: string, ticketId: string, input: { push?: unknown; email?: unknown }): Promise<ContactSummary> {
    const contact = this.parseContact(input);
    const config = await this.requireOffice(officeId);
    const view = await this.offices.queue(officeId, config, { now: this.clock }).getTicketView(ticketId);
    if (!view) throw new QueueError('not_found');
    if (view.ticket.status !== 'waiting' && view.ticket.status !== 'called') throw new QueueError('not_active');

    const key = this.contactKey(officeId, 'ticket', ticketId);
    const alerted = this.alertedKey(officeId, 'ticket', ticketId);
    const ttl = this.offices.ttlSec;
    const multi = this.redis.multi();
    if (contact.push) multi.hset(key, 'push', JSON.stringify(contact.push));
    if (contact.email) multi.hset(key, 'email', contact.email);
    multi.expire(key, ttl).sadd(this.indexKey(officeId), ticketId).expire(this.indexKey(officeId), ttl);
    // Opting in when already close (or called) shouldn't fire an instant "3 away" alert.
    if (view.ticket.status === 'called' || (view.ahead !== null && view.ahead <= this.o.nearThreshold)) multi.hsetnx(alerted, 'near', 'skipped');
    if (view.ticket.status === 'called') multi.hsetnx(alerted, 'called', 'skipped');
    multi.expire(alerted, ttl);
    await multi.exec();

    for (const channel of ['push', 'email'] as const) {
      if (contact[channel]) await this.enqueue(officeId, 'ticket', ticketId, 'confirm', [channel], `confirm:${channel}`);
    }
    this.scheduleScan(officeId);
    return this.summarize(await this.redis.hgetall(key));
  }

  async getTicketContact(officeId: string, ticketId: string): Promise<ContactSummary> {
    return this.summarize(await this.redis.hgetall(this.contactKey(officeId, 'ticket', ticketId)));
  }

  async removeTicketContact(officeId: string, ticketId: string, channel: Channel | 'all'): Promise<ContactSummary> {
    return this.removeContact(officeId, 'ticket', ticketId, channel);
  }

  /** Opt a booked appointment in to a reminder (and, after check-in, queue alerts). */
  async setAppointmentContact(officeId: string, apptId: string, input: { push?: unknown; email?: unknown }): Promise<ContactSummary> {
    const contact = this.parseContact(input);
    const config = await this.requireOffice(officeId);
    const appt = await this.offices.appointments(officeId, config, { now: this.clock }).get(apptId);
    if (!appt) throw new QueueError('not_found', 'Appointment not found.');
    if (appt.status !== 'booked') throw new QueueError('not_active', 'This appointment can no longer get reminders.');

    const key = this.contactKey(officeId, 'appointment', apptId);
    // Same lifetime as the appointment itself.
    const ttl = Math.max(1, await this.redis.ttl(`${this.offices.prefixFor(officeId)}appt:${apptId}`));
    const multi = this.redis.multi();
    if (contact.push) multi.hset(key, 'push', JSON.stringify(contact.push));
    if (contact.email) multi.hset(key, 'email', contact.email);
    multi.expire(key, ttl);
    const remindAt = appt.slotStart - this.o.reminderLeadMs;
    if (remindAt > this.now()) multi.zadd(this.global.reminders(), remindAt, `${officeId}:${apptId}`);
    await multi.exec();

    for (const channel of ['push', 'email'] as const) {
      if (contact[channel]) await this.enqueue(officeId, 'appointment', apptId, 'confirm', [channel], `confirm:${channel}`);
    }
    return this.summarize(await this.redis.hgetall(key));
  }

  async getAppointmentContact(officeId: string, apptId: string): Promise<ContactSummary> {
    return this.summarize(await this.redis.hgetall(this.contactKey(officeId, 'appointment', apptId)));
  }

  async removeAppointmentContact(officeId: string, apptId: string, channel: Channel | 'all'): Promise<ContactSummary> {
    return this.removeContact(officeId, 'appointment', apptId, channel);
  }

  /**
   * After an appointment check-in moved its contact onto the new ticket: don't
   * send an instant "3 away" if they're already that close, then scan.
   */
  async afterCheckIn(officeId: string, ticketId: string): Promise<void> {
    if (!(await this.redis.exists(this.contactKey(officeId, 'ticket', ticketId)))) return;
    const config = await this.requireOffice(officeId);
    const view = await this.offices.queue(officeId, config, { now: this.clock }).getTicketView(ticketId);
    if (view?.ahead !== null && view?.ahead !== undefined && view.ahead <= this.o.nearThreshold) {
      const alerted = this.alertedKey(officeId, 'ticket', ticketId);
      await this.redis.multi().hsetnx(alerted, 'near', 'skipped').expire(alerted, this.offices.ttlSec).exec();
    }
    this.scheduleScan(officeId);
  }

  private async removeContact(officeId: string, target: Target, id: string, channel: Channel | 'all'): Promise<ContactSummary> {
    const key = this.contactKey(officeId, target, id);
    if (channel === 'all') await this.redis.del(key);
    else await this.redis.hdel(key, channel);
    if (target === 'ticket' && !(await this.redis.exists(key))) await this.redis.srem(this.indexKey(officeId), id);
    return this.summarize(await this.redis.hgetall(key));
  }

  // ------------------------------------------------------------- detection

  /** Debounced scan after an office changes (called from the pub/sub listener). */
  scheduleScan(officeId: string): void {
    if (this.scanTimers.has(officeId)) return;
    this.scanTimers.set(
      officeId,
      setTimeout(() => {
        this.scanTimers.delete(officeId);
        this.scanOffice(officeId).catch((err) => this.log(`[alerts] scan failed for office ${officeId}: ${(err as Error).message}`));
      }, this.o.scanDebounceMs),
    );
  }

  /** Queue "3 away" and "called" alerts for tickets that have become due. */
  async scanOffice(officeId: string): Promise<number> {
    const ids = await this.redis.smembers(this.indexKey(officeId));
    if (!ids.length) return 0;
    const config = await this.offices.getConfig(officeId);
    if (!config) return 0;
    const views = await this.offices.queue(officeId, config, { now: this.clock }).getTicketViews(ids);
    let queued = 0;
    for (const [id, view] of views) {
      if (!view || !(await this.redis.exists(this.contactKey(officeId, 'ticket', id)))) {
        await this.redis.srem(this.indexKey(officeId), id);
        continue;
      }
      const { status } = view.ticket;
      if (status === 'waiting' && view.ahead !== null && view.ahead <= this.o.nearThreshold) queued += await this.enqueue(officeId, 'ticket', id, 'near');
      if (status === 'called') queued += await this.enqueue(officeId, 'ticket', id, 'called');
    }
    return queued;
  }

  /** Queue one job per channel, exactly once per (target, dedupe field). */
  private async enqueue(officeId: string, target: Target, targetId: string, type: AlertType, channels: Channel[] = ['push', 'email'], field: string = type): Promise<number> {
    const job = (channel: Channel) =>
      channels.includes(channel) ? JSON.stringify({ id: randomUUID(), officeId, target, targetId, type, channel, attempts: 0 } satisfies AlertJob) : '';
    const n = (await this.redis.eval(
      ENQUEUE_ALERT,
      3,
      this.alertedKey(officeId, target, targetId),
      this.contactKey(officeId, target, targetId),
      this.global.jobs(),
      field,
      String(this.now()),
      String(this.offices.ttlSec),
      job('push'),
      job('email'),
    )) as number;
    if (n > 0) this.kick();
    return n;
  }

  /** Move due appointment reminders into the job queue. */
  private async processReminders(): Promise<void> {
    const due = await this.redis.zrangebyscore(this.global.reminders(), '-inf', this.now(), 'LIMIT', 0, 50);
    for (const member of due) {
      // Whoever removes it owns it — several server processes never double-send.
      if (!(await this.redis.zrem(this.global.reminders(), member))) continue;
      const [officeId, apptId] = member.split(':');
      const config = await this.offices.getConfig(officeId);
      if (!config) continue;
      const appt = await this.offices.appointments(officeId, config, { now: this.clock }).get(apptId);
      if (appt?.status === 'booked') await this.enqueue(officeId, 'appointment', apptId, 'reminder');
    }
  }

  // ---------------------------------------------------------------- worker

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.o.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.scanTimers.values()) clearTimeout(t);
    this.scanTimers.clear();
  }

  /**
   * Stop, and wait (up to `timeoutMs`) for a send that's already under way. Jobs
   * not started stay queued in Redis for the next server; a send cut off mid-way
   * is retried when its lease runs out, so nothing is lost.
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    this.stop();
    const until = Date.now() + timeoutMs;
    while (this.running && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  }

  /** Run the worker soon (after a new job is queued), without waiting for the next poll. */
  kick(): void {
    if (this.timer) setImmediate(() => void this.tick());
  }

  /** One worker pass: due reminders, then a batch of due jobs. Returns jobs handled. */
  async tick(): Promise<number> {
    if (this.running) {
      this.again = true;
      return 0;
    }
    this.running = true;
    let handled = 0;
    try {
      do {
        this.again = false;
        await this.processReminders();
        const jobs = (await this.redis.eval(
          CLAIM_JOBS,
          2,
          this.global.jobs(),
          this.global.processing(),
          String(this.now()),
          String(this.o.leaseMs),
          String(this.o.batchSize),
        )) as string[];
        await Promise.allSettled(jobs.map((raw) => this.process(raw)));
        handled += jobs.length;
        if (jobs.length === this.o.batchSize) this.again = true;
      } while (this.again);
    } catch (err) {
      this.log(`[alerts] worker error: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
    return handled;
  }

  /** Process everything currently due (tests, and graceful shutdown). */
  async drain(maxRounds = 50): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.tick();
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  private backoff(attempts: number): number {
    const exp = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** attempts);
    return Math.round(exp * (0.8 + Math.random() * 0.4));
  }

  private async process(raw: string): Promise<void> {
    const job = JSON.parse(raw) as AlertJob;
    const ack = () => this.redis.zrem(this.global.processing(), raw);
    const who = `${job.type} via ${job.channel} (office ${job.officeId})`;
    try {
      const result = await this.deliver(job);
      if (result !== 'sent') this.log(`[alerts] skipped ${who}: ${result}`);
      await ack();
    } catch (err) {
      const e = err instanceof AlertSendError ? err : new AlertSendError((err as Error).message, true);
      if (e.expired) {
        await this.removeContact(job.officeId, job.target, job.targetId, 'push');
        this.log(`[alerts] removed expired push subscription (${who})`);
        await ack();
        return;
      }
      const attempts = job.attempts + 1;
      if (e.retry && attempts < this.o.maxAttempts) {
        const delay = this.backoff(job.attempts);
        await this.redis
          .multi()
          .zrem(this.global.processing(), raw)
          .zadd(this.global.jobs(), this.now() + delay, JSON.stringify({ ...job, attempts }))
          .exec();
        this.log(`[alerts] ${who} failed (${e.message}); retry ${attempts}/${this.o.maxAttempts - 1} in ${Math.round(delay / 1000)}s`);
      } else {
        this.log(`[alerts] gave up on ${who} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${e.message}`);
        await ack();
      }
    }
  }

  private async deliver(job: AlertJob): Promise<'sent' | string> {
    const config = await this.offices.getConfig(job.officeId);
    if (!config) return 'office no longer exists';
    const contact = await this.redis.hgetall(this.contactKey(job.officeId, job.target, job.targetId));
    const address = contact[job.channel];
    if (!address) return 'no contact for this channel (visit ended or opted out)';
    const message = await this.buildMessage(job, config);
    if (!message) return 'no longer relevant';

    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new AlertSendError(`timed out after ${this.o.sendTimeoutMs}ms`, true)), this.o.sendTimeoutMs);
      t.unref?.();
    });
    const send =
      job.channel === 'push' ? this.push.send(JSON.parse(address) as PushSubscriptionJSON, message) : this.email.send(address, message);
    await Promise.race([send, timeout]);
    const to = job.channel === 'email' ? ` to ${maskEmail(address)}` : '';
    this.log(`[alerts] sent ${job.type} via ${job.channel}${to} (office ${job.officeId})`);
    return 'sent';
  }

  /** Build the alert from current state, or null if it no longer applies. */
  async buildMessage(job: AlertJob, config: OfficeConfig): Promise<AlertMessage | null> {
    const base = `${this.o.baseUrl}/o/${job.officeId}`;
    const tag = `vq-${job.targetId.slice(0, 8)}`;
    if (job.target === 'ticket') {
      const view = await this.offices.queue(job.officeId, config, { now: this.clock }).getTicketView(job.targetId);
      if (!view) return null;
      const t = view.ticket;
      const lang = t.lang;
      const tx = ALERT_TEXTS[lang];
      const url = `${base}/t/${job.targetId}`;
      if (job.type === 'near') {
        if (t.status !== 'waiting') return null;
        return { title: tx.nearTitle(t.number), body: tx.nearBody(view.ahead ?? 0, config.name), url, tag, lang };
      }
      if (job.type === 'called') {
        if (t.status !== 'called') return null;
        return { title: tx.calledTitle(t.number), body: tx.calledBody(view.counterName ?? ''), url, tag, lang, urgent: true };
      }
      if (job.type === 'confirm') {
        if (t.status !== 'waiting' && t.status !== 'called') return null;
        return { title: tx.confirmTitle, body: tx.confirmBody(this.o.nearThreshold, t.number), url, tag: `${tag}-confirm`, lang };
      }
      return null;
    }

    const view = await this.offices.appointments(job.officeId, config, { now: this.clock }).view(job.targetId);
    if (!view || view.appointment.status !== 'booked') return null;
    const a = view.appointment;
    const lang = a.lang;
    const tx = ALERT_TEXTS[lang];
    const tz = config.timezone;
    const time = formatTimeIn(lang, a.slotStart, tz);
    const url = `${base}/appointment/${job.targetId}`;
    if (job.type === 'reminder') {
      const opensAt = formatTimeIn(lang, view.checkIn.opensAt, tz);
      return { title: tx.reminderTitle(time), body: tx.reminderBody(a.serviceName, config.name, opensAt), url, tag, lang };
    }
    if (job.type === 'confirm') {
      return { title: tx.reminderSetTitle, body: tx.reminderSetBody(time, formatDateIn(lang, a.slotStart, tz)), url, tag: `${tag}-confirm`, lang };
    }
    return null;
  }
}
