// Mirrors server/src/types.ts and server/src/officeConfig.ts — keep in sync.
export type TicketStatus = 'waiting' | 'called' | 'served' | 'no_show' | 'left';
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const PRIORITY_REASONS = ['disability', 'senior', 'returning_no_show', 'other'] as const;
export type PriorityReason = (typeof PRIORITY_REASONS)[number];
export const PRIORITY_LABELS: Record<PriorityReason, string> = {
  disability: 'Disability',
  senior: 'Senior',
  returning_no_show: 'Returning no-show',
  other: 'Other',
};
export type TicketKind = 'walkin' | 'appointment';

export interface WaitEstimate {
  sec: number;
  lowSec: number;
  highSec: number;
}

export interface AppointmentSettings {
  enabled: boolean;
  slotMinutes: number;
  capacity: number;
  daysAhead: number;
  checkInEarlyMin: number;
  checkInLateMin: number;
}

export interface ServiceDef {
  id: string;
  code: string;
  name: string;
  defaultServiceSec: number;
}

export interface CounterDef {
  id: number;
  name: string;
}

export interface DayHours {
  open: string;
  close: string;
}

export interface OfficeConfig {
  name: string;
  timezone: string;
  services: ServiceDef[];
  counters: CounterDef[];
  hoursEnabled: boolean;
  hours: Record<Weekday, DayHours | null>;
  appointments: AppointmentSettings;
}

export interface OpenStatus {
  open: boolean;
  /** English text from the server; pages build their own from the fields below. */
  message: string | null;
  until?: string;
  reopens?: { day: Weekday; time: string; when: 'today' | 'tomorrow' | 'this_week' | 'next_week' };
}

/** Resident languages. Mirrors server/src/i18n.ts LANGS. */
export type Lang = 'en' | 'es';

export interface OfficeInfo extends OfficeConfig {
  status: OpenStatus;
}

export interface Ticket {
  id: string;
  number: string;
  name: string;
  service: string;
  status: TicketStatus;
  joinedAt: number;
  calledAt: number | null;
  endedAt: number | null;
  counter: number | null;
  recallCount: number;
  priority: PriorityReason | null;
  kind: TicketKind;
  appointmentAt: number | null;
  lang: Lang;
}

export interface TicketView {
  ticket: Ticket;
  serviceName: string;
  counterName: string | null;
  position: number | null;
  ahead: number | null;
  estimatedWaitSec: number | null;
  estimate: WaitEstimate | null;
  servicePaused: boolean;
  serverNow: number;
}

export interface WaitingEntry {
  number: string;
  name: string;
  joinedAt: number;
  priority: PriorityReason | null;
  kind: TicketKind;
  appointmentAt: number | null;
}

export interface CounterState {
  counter: number;
  name: string;
  ticket: { number: string; name: string; service: string; calledAt: number; recallCount: number } | null;
  last: { number: string; outcome: 'served' | 'no_show' | 'left'; at: number } | null;
}

export interface RecentCall {
  number: string;
  counter: number;
  counterName: string;
  service: string;
  at: number;
  recall?: boolean;
  lang?: Lang;
}

export interface ServiceState {
  id: string;
  code: string;
  name: string;
  paused: boolean;
  waiting: WaitingEntry[];
  waitingCount: number;
  avgServiceSec: number;
  activeCounters: number;
  estimatedWaitSec: number;
  estimate: WaitEstimate;
  servedToday: number;
  noShowToday: number;
  avgWaitSec: number | null;
}

export interface StaffState {
  officeId: string;
  office: OfficeInfo;
  services: ServiceState[];
  counters: CounterState[];
  recent: RecentCall[];
  totals: { waiting: number; servedToday: number; noShowToday: number; avgWaitSec: number | null };
  serverNow: number;
}

export interface LobbyState {
  officeId: string;
  office: OfficeInfo;
  services: Array<Pick<ServiceState, 'id' | 'code' | 'name' | 'paused' | 'waitingCount' | 'estimatedWaitSec' | 'estimate'>>;
  nowServing: Array<{ counter: number; counterName: string; number: string; service: string; calledAt: number; lang: Lang }>;
  recent: RecentCall[];
  serverNow: number;
}

export interface OfficeResponse {
  office: OfficeInfo;
  publicUrl: string | null;
  lanIp: string | null;
}

export interface CreatedOffice {
  officeId: string;
  staffKey: string;
  office: OfficeConfig;
  publicUrl: string | null;
  lanIp: string | null;
}

export type AppointmentStatus = 'booked' | 'checked_in' | 'cancelled' | 'missed';

export interface Appointment {
  id: string;
  ref: string;
  name: string;
  service: string;
  serviceName: string;
  date: string;
  time: string;
  slotStart: number;
  status: AppointmentStatus;
  ticketId: string | null;
  lang: Lang;
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

export interface DayView {
  date: string;
  label: string;
  today: string;
  entries: DayViewEntry[];
  settings: AppointmentSettings;
}
