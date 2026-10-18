import { randomInt, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { bookableDates, formatDateLabel, formatZonedTime, slotsForDate, zonedParts, type OfficeConfig } from './officeConfig';
import { QueueError, type QueueErrorCode, type QueueStore } from './queueStore';
import { BOOK, CANCEL_APPT, CHECK_IN, EXPIRE_MISSED } from './scripts';

export type AppointmentStatus = 'booked' | 'checked_in' | 'cancelled' | 'missed';

export interface Appointment {
  /** Secret id; the confirmation link is the resident's proof of booking. */
  id: string;
  /** Short reference shown to staff and the resident, e.g. "K7M2QX". */
  ref: string;
  name: string;
  service: string;
  serviceName: string;
  date: string; // "YYYY-MM-DD", office local
  time: string; // "HH:MM", office local
  slotStart: number;
  status: AppointmentStatus;
  ticketId: string | null;
}

export interface AppointmentView {
  appointment: Appointment;
  dateLabel: string;
  timeLabel: string;
  checkIn: { opensAt: number; closesAt: number; open: boolean; opensLabel: string; closesLabel: string };
  serverNow: number;
}

export interface DayAvailability {
  date: string;
  label: string;
  slots: Array<{ time: string; start: number; remaining: number }>;
}

export interface DayViewEntry {
  id: string;
  ref: string;
  name: string;
  service: string;
  serviceName: string;
  time: string;
  slotStart: number;
  status: AppointmentStatus;
  ticket: { number: string; status: string } | null;
  canCheckIn: boolean;
}

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DAY_MS = 24 * 60 * 60_000;

/** Appointment booking, check-in and the staff day view for one office. */
export class AppointmentBook {
  private readonly prefix: string;
  private readonly config: OfficeConfig;

  constructor(
    private readonly redis: Redis,
    private readonly queue: QueueStore,
    private readonly opts: { officeTtlSec: number; now?: () => number },
  ) {
    this.prefix = queue.prefix;
    this.config = queue.config;
  }

  private now(): number {
    return Math.round((this.opts.now ?? Date.now)());
  }

  private get settings() {
    return this.config.appointments;
  }

  private key = {
    appt: (id: string) => `${this.prefix}appt:${id}`,
    slots: (date: string) => `${this.prefix}slots:${date}`,
    day: (date: string) => `${this.prefix}appts:${date}`,
  };

  private window(slotStart: number) {
    return {
      opensAt: slotStart - this.settings.checkInEarlyMin * 60_000,
      closesAt: slotStart + this.settings.checkInLateMin * 60_000,
    };
  }

  private assertEnabled() {
    if (!this.settings.enabled) throw new QueueError('appointments_off');
  }

  private serviceName(id: string) {
    return this.config.services.find((s) => s.id === id)?.name ?? 'Service';
  }

  /** Open slots per bookable day for a service, with how many places remain. */
  async availability(service: string): Promise<DayAvailability[]> {
    this.assertEnabled();
    if (!this.config.services.some((s) => s.id === service)) throw new QueueError('invalid', 'Unknown service.');
    const now = this.now();
    const dates = bookableDates(this.config, now);
    const pipe = this.redis.pipeline();
    for (const d of dates) pipe.hgetall(this.key.slots(d));
    const counts = (await pipe.exec()) ?? [];
    return dates.map((date, i) => {
      const booked = (counts[i]?.[1] as Record<string, string>) ?? {};
      return {
        date,
        label: formatDateLabel(date),
        slots: slotsForDate(this.config, date)
          .filter((s) => s.start > now)
          .map((s) => ({ ...s, remaining: Math.max(0, this.settings.capacity - Number(booked[`${s.time}|${service}`] ?? 0)) })),
      };
    });
  }

  async book(input: { name: string; service: string; date: string; time: string }): Promise<AppointmentView> {
    this.assertEnabled();
    const name = input.name.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 30) throw new QueueError('invalid', 'Please enter a first name (up to 30 characters).');
    if (!this.config.services.some((s) => s.id === input.service)) throw new QueueError('invalid', 'Unknown service.');
    const now = this.now();
    if (!bookableDates(this.config, now).includes(input.date)) throw new QueueError('invalid', 'That date can’t be booked.');
    const slot = slotsForDate(this.config, input.date).find((s) => s.time === input.time);
    if (!slot) throw new QueueError('invalid', 'That time isn’t an available slot.');
    if (slot.start <= now) throw new QueueError('invalid', 'That time has already passed.');

    const id = randomUUID();
    const ref = Array.from({ length: 6 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('');
    // Keep the booking until two days after its slot, never longer than the office lives.
    const ttl = Math.min(this.opts.officeTtlSec, Math.ceil((slot.start + 2 * DAY_MS - now) / 1000));
    const [status, detail] = (await this.redis.eval(
      BOOK,
      2,
      this.key.slots(input.date),
      this.key.day(input.date),
      this.prefix,
      id,
      `${input.time}|${input.service}`,
      String(this.settings.capacity),
      name,
      input.service,
      input.date,
      input.time,
      String(slot.start),
      String(now),
      ref,
      String(ttl),
    )) as [string, string?];
    if (status !== 'ok') throw new QueueError(detail as QueueErrorCode);
    await this.queue.notify();
    return (await this.view(id))!;
  }

  async get(id: string): Promise<Appointment | null> {
    const h = await this.redis.hgetall(this.key.appt(id));
    if (!h.id) return null;
    const slotStart = Number(h.slotStart);
    let status = h.status as AppointmentStatus;
    // Missed as soon as the window closes, even before the sweep persists it.
    if (status === 'booked' && this.now() > this.window(slotStart).closesAt) status = 'missed';
    return {
      id: h.id,
      ref: h.ref,
      name: h.name,
      service: h.service,
      serviceName: this.serviceName(h.service),
      date: h.date,
      time: h.time,
      slotStart,
      status,
      ticketId: h.ticketId || null,
    };
  }

  async view(id: string): Promise<AppointmentView | null> {
    const appointment = await this.get(id);
    if (!appointment) return null;
    const now = this.now();
    const { opensAt, closesAt } = this.window(appointment.slotStart);
    const tz = this.config.timezone;
    return {
      appointment,
      dateLabel: formatDateLabel(appointment.date),
      timeLabel: formatZonedTime(appointment.slotStart, tz),
      checkIn: {
        opensAt,
        closesAt,
        open: appointment.status === 'booked' && now >= opensAt && now <= closesAt,
        opensLabel: formatZonedTime(opensAt, tz),
        closesLabel: formatZonedTime(closesAt, tz),
      },
      serverNow: now,
    };
  }

  /**
   * Check in: within the window around the slot, the appointment becomes a
   * ticket that ranks as if it had joined at the slot time. Returns the ticket id.
   */
  async checkIn(id: string): Promise<string> {
    const appt = await this.get(id);
    if (!appt) throw new QueueError('not_found', 'Appointment not found.');
    const svc = this.config.services.find((s) => s.id === appt.service);
    if (!svc) throw new QueueError('invalid', 'This service is no longer offered. Please see the front desk.');
    const now = this.now();
    const [status, detail] = (await this.redis.eval(
      CHECK_IN,
      1,
      `${this.prefix}seq:${zonedParts(now, this.config.timezone).dateKey}:${svc.id}`,
      this.prefix,
      id,
      String(now),
      String(this.settings.checkInEarlyMin * 60_000),
      String(this.settings.checkInLateMin * 60_000),
      randomUUID(),
      svc.id,
      svc.code,
      String(Math.min(2 * 24 * 3600, this.opts.officeTtlSec)),
      String(this.opts.officeTtlSec),
    )) as [string, string?, string?];
    if (status !== 'ok') {
      const { opensAt } = this.window(appt.slotStart);
      const messages: Partial<Record<string, string>> = {
        too_early: `It’s too early to check in. Check-in opens at ${formatZonedTime(opensAt, this.config.timezone)}.`,
        not_active: appt.status === 'cancelled' ? 'This appointment was cancelled.' : 'This appointment can’t be checked in.',
      };
      if (detail === 'missed') await this.queue.notify();
      throw new QueueError(detail as QueueErrorCode, messages[detail!]);
    }
    await this.queue.notify();
    return detail!;
  }

  async cancel(id: string): Promise<void> {
    const appt = await this.get(id);
    if (!appt) throw new QueueError('not_found', 'Appointment not found.');
    if (appt.status === 'missed') throw new QueueError('missed');
    const [status, detail] = (await this.redis.eval(CANCEL_APPT, 0, this.prefix, id)) as [string, string?];
    if (status !== 'ok') throw new QueueError(detail as QueueErrorCode, detail === 'not_active' ? 'This appointment can’t be cancelled.' : undefined);
    await this.queue.notify();
  }

  /** Persist "missed" for appointments on a date whose check-in window has closed. */
  async expireMissed(date: string): Promise<number> {
    const cutoff = this.now() - this.settings.checkInLateMin * 60_000;
    return (await this.redis.eval(EXPIRE_MISSED, 1, this.key.day(date), this.prefix, String(cutoff))) as number;
  }

  /** Staff day view: every appointment on a date, in slot order. */
  async day(date: string): Promise<{ date: string; label: string; entries: DayViewEntry[] }> {
    await this.expireMissed(date);
    const ids = await this.redis.zrange(this.key.day(date), 0, -1);
    const appts = (await Promise.all(ids.map((id) => this.get(id)))).filter((a): a is Appointment => !!a);
    const pipe = this.redis.pipeline();
    for (const a of appts) pipe.hmget(`${this.prefix}ticket:${a.ticketId ?? 'none'}`, 'number', 'status');
    const tickets = appts.length ? ((await pipe.exec()) ?? []) : [];
    const now = this.now();
    return {
      date,
      label: formatDateLabel(date),
      entries: appts.map((a, i) => {
        const [number, status] = (tickets[i]?.[1] as [string | null, string | null]) ?? [];
        const w = this.window(a.slotStart);
        return {
          id: a.id,
          ref: a.ref,
          name: a.name,
          service: a.service,
          serviceName: a.serviceName,
          time: a.time,
          slotStart: a.slotStart,
          status: a.status,
          ticket: number && status ? { number, status } : null,
          canCheckIn: a.status === 'booked' && now >= w.opensAt && now <= w.closesAt,
        };
      }),
    };
  }

  /** Booked (future or in-window) appointments for a service, e.g. before removing it. */
  async upcomingCount(service: string): Promise<number> {
    const now = this.now();
    let n = 0;
    for (const date of bookableDates(this.config, now)) {
      const ids = await this.redis.zrangebyscore(this.key.day(date), now - this.settings.checkInLateMin * 60_000, '+inf');
      for (const id of ids) {
        const a = await this.redis.hmget(this.key.appt(id), 'service', 'status');
        if (a[0] === service && a[1] === 'booked') n++;
      }
    }
    return n;
  }
}
