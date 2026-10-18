import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export interface ServiceDef {
  /** Stable id; renaming a service never changes it. */
  id: string;
  /** Single letter used in ticket numbers, e.g. "D" in D-042. */
  code: string;
  name: string;
  /** Used for wait estimates until real service times have been recorded. */
  defaultServiceSec: number;
}

export interface CounterDef {
  id: number;
  name: string;
}

export interface DayHours {
  open: string; // "HH:MM", 24-hour, office local time
  close: string;
}

export interface AppointmentSettings {
  enabled: boolean;
  /** Length of each bookable slot. */
  slotMinutes: number;
  /** Bookings allowed per slot, per service. */
  capacity: number;
  /** How many days ahead (including today) residents can book. */
  daysAhead: number;
  /** Check-in opens this many minutes before the slot… */
  checkInEarlyMin: number;
  /** …and closes this many minutes after it starts; later arrivals have missed it. */
  checkInLateMin: number;
}

export interface OfficeConfig {
  name: string;
  timezone: string;
  services: ServiceDef[];
  counters: CounterDef[];
  /** When false the office accepts residents at any time. */
  hoursEnabled: boolean;
  hours: Record<Weekday, DayHours | null>;
  appointments: AppointmentSettings;
}

export interface OpenStatus {
  open: boolean;
  /** Human-readable, e.g. "Open until 5:00 PM" or "We open again Monday at 9:00 AM." */
  message: string | null;
  /** The same facts in structured form, so pages can say them in the resident's language. */
  until?: string;
  reopens?: { day: Weekday; time: string; when: 'today' | 'tomorrow' | 'this_week' | 'next_week' };
}

// ------------------------------------------------------------------ validation

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM times.');
const dayHours = z
  .object({ open: time, close: time })
  .refine((h) => h.open < h.close, 'Closing time must be after opening time.')
  .nullable();

const serviceInput = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9_-]{1,24}$/)
    .optional(),
  name: z.string().trim().min(1, 'Every service needs a name.').max(40, 'Service names can be up to 40 characters.'),
  code: z
    .string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(z.string().regex(/^[A-Z]$/, 'Ticket letters must be a single letter A–Z.')),
  defaultServiceSec: z.number().int().min(30, 'Service time must be at least 30 seconds.').max(4 * 3600),
});

const counterInput = z.object({
  id: z.number().int().min(1).max(999).optional(),
  name: z.string().trim().min(1, 'Every counter needs a name.').max(30, 'Counter names can be up to 30 characters.'),
});

export const DEFAULT_APPOINTMENTS: AppointmentSettings = {
  enabled: true,
  slotMinutes: 15,
  capacity: 2,
  daysAhead: 7,
  checkInEarlyMin: 15,
  checkInLateMin: 10,
};

const appointmentsInput = z.object({
  enabled: z.boolean(),
  slotMinutes: z.number().int().min(5, 'Slots must be at least 5 minutes.').max(240),
  capacity: z.number().int().min(1, 'Each slot needs room for at least one booking.').max(50),
  daysAhead: z.number().int().min(1).max(60, 'Bookings can be up to 60 days ahead.'),
  checkInEarlyMin: z.number().int().min(0).max(120),
  checkInLateMin: z.number().int().min(0).max(120),
});

export const settingsSchema = z
  .object({
    name: z.string().trim().min(1, 'Please enter an office name.').max(60),
    timezone: z.string().refine(isValidTimeZone, 'Unknown time zone.'),
    services: z.array(serviceInput).min(1, 'Add at least one service.').max(8, 'Up to 8 services.'),
    counters: z.array(counterInput).min(1, 'Add at least one counter.').max(20, 'Up to 20 counters.'),
    hoursEnabled: z.boolean(),
    hours: z.object({
      mon: dayHours,
      tue: dayHours,
      wed: dayHours,
      thu: dayHours,
      fri: dayHours,
      sat: dayHours,
      sun: dayHours,
    }),
    appointments: appointmentsInput.default(DEFAULT_APPOINTMENTS),
  })
  .superRefine((s, ctx) => {
    const seen = new Map<string, string>();
    s.services.forEach((svc, i) => {
      const other = seen.get(svc.code);
      if (other) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['services', i, 'code'],
          message: `“${svc.name}” and “${other}” both use the letter ${svc.code}. Each service needs its own letter.`,
        });
      }
      seen.set(svc.code, svc.name);
    });
    const ids = s.services.map((x) => x.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['services'], message: 'Duplicate service ids.' });
    const cids = s.counters.map((x) => x.id).filter(Boolean);
    if (new Set(cids).size !== cids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['counters'], message: 'Duplicate counter ids.' });
  });

export type SettingsInput = z.input<typeof settingsSchema>;

/** Validates settings and assigns ids to newly added services and counters. */
export function normalizeSettings(input: unknown): OfficeConfig {
  const s = settingsSchema.parse(input);
  let nextCounter = Math.max(0, ...s.counters.map((c) => c.id ?? 0)) + 1;
  return {
    name: s.name,
    timezone: s.timezone,
    services: s.services.map((svc) => ({ ...svc, id: svc.id ?? `s${randomBytes(4).toString('hex')}` })),
    counters: s.counters.map((c) => ({ id: c.id ?? nextCounter++, name: c.name })),
    hoursEnabled: s.hoursEnabled,
    hours: s.hours,
    appointments: s.appointments,
  };
}

/** Fill in settings added after an office was created. */
export function withDefaults(config: OfficeConfig): OfficeConfig {
  return { ...config, appointments: { ...DEFAULT_APPOINTMENTS, ...(config.appointments ?? {}) } };
}

export function defaultConfig(name = 'City Services Office', timezone = 'UTC'): OfficeConfig {
  const weekday = { open: '09:00', close: '17:00' };
  return {
    name,
    timezone: isValidTimeZone(timezone) ? timezone : 'UTC',
    services: [
      { id: 'license', code: 'D', name: "Driver's License", defaultServiceSec: 360 },
      { id: 'registration', code: 'V', name: 'Vehicle Registration', defaultServiceSec: 240 },
      { id: 'id', code: 'I', name: 'ID Card', defaultServiceSec: 180 },
    ],
    counters: [1, 2, 3, 4].map((id) => ({ id, name: `Counter ${id}` })),
    hoursEnabled: false,
    hours: { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: { open: '09:00', close: '13:00' }, sun: null },
    appointments: { ...DEFAULT_APPOINTMENTS },
  };
}

// ------------------------------------------------------------- time & hours

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Calendar date, weekday and minutes-since-midnight in the given time zone. */
export function zonedParts(ts: number, tz: string): { dateKey: string; weekday: Weekday; minutes: number } {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday.toLowerCase().slice(0, 3) as Weekday,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** "17:30" -> "5:30 PM" */
export function formatTime(t: string): string {
  const h = Number(t.slice(0, 2));
  const m = t.slice(3, 5);
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

export function openStatus(config: Pick<OfficeConfig, 'hoursEnabled' | 'hours' | 'timezone'>, ts: number): OpenStatus {
  if (!config.hoursEnabled) return { open: true, message: null };
  const { weekday, minutes } = zonedParts(ts, config.timezone);
  const today = config.hours[weekday];
  if (today && minutes >= toMinutes(today.open) && minutes < toMinutes(today.close)) {
    return { open: true, message: `Open until ${formatTime(today.close)}`, until: today.close };
  }
  if (today && minutes < toMinutes(today.open)) {
    return {
      open: false,
      message: `Joining is closed right now. We open today at ${formatTime(today.open)}.`,
      reopens: { day: weekday, time: today.open, when: 'today' },
    };
  }
  const idx = WEEKDAYS.indexOf(weekday);
  for (let i = 1; i <= 7; i++) {
    const day = WEEKDAYS[(idx + i) % 7];
    const h = config.hours[day];
    if (h) {
      const when = i === 1 ? 'tomorrow' : i === 7 ? `next ${WEEKDAY_NAMES[day]}` : WEEKDAY_NAMES[day];
      return {
        open: false,
        message: `Joining is closed right now. We open again ${when} at ${formatTime(h.open)}.`,
        reopens: { day, time: h.open, when: i === 1 ? 'tomorrow' : i === 7 ? 'next_week' : 'this_week' },
      };
    }
  }
  return { open: false, message: 'Joining is closed right now.' };
}

// ------------------------------------------------------------- appointments

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-03-04" + n days, as a calendar date (no time zone involved). */
export function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function weekdayOf(dateKey: string): Weekday {
  const [y, m, d] = dateKey.split('-').map(Number);
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
}

/** UTC timestamp of a wall-clock time in a time zone (handles DST shifts). */
export function zonedTimeToUtc(dateKey: string, time: string, tz: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, Number(time.slice(0, 2)), Number(time.slice(3, 5)));
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    const [py, pm, pd] = p.dateKey.split('-').map(Number);
    const seenAsWall = Date.UTC(py, pm - 1, pd) + p.minutes * 60_000;
    const next = guess + (wall - seenAsWall);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

export interface Slot {
  time: string; // "HH:MM" local
  start: number; // UTC ms
}

/** Bookable slots on a date, generated from that weekday's opening hours. */
export function slotsForDate(config: OfficeConfig, dateKey: string): Slot[] {
  const hours = config.hours[weekdayOf(dateKey)];
  if (!hours) return [];
  const len = config.appointments.slotMinutes;
  const out: Slot[] = [];
  for (let min = toMinutes(hours.open); min + len <= toMinutes(hours.close); min += len) {
    const time = `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
    out.push({ time, start: zonedTimeToUtc(dateKey, time, config.timezone) });
  }
  return out;
}

/** Dates residents can book, starting today in the office's time zone. */
export function bookableDates(config: OfficeConfig, now: number): string[] {
  const today = zonedParts(now, config.timezone).dateKey;
  return Array.from({ length: config.appointments.daysAhead }, (_, i) => addDays(today, i));
}

/** "Wednesday, March 4" */
export function formatDateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
}

/** Wall-clock time of a timestamp in the office time zone, e.g. "9:45 AM". */
export function formatZonedTime(ts: number, tz: string): string {
  const { minutes } = zonedParts(ts, tz);
  return formatTime(`${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
}
