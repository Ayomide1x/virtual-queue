import type { Lang } from './i18n';
import type { OfficeConfig, OpenStatus } from './officeConfig';

export type TicketStatus = 'waiting' | 'called' | 'served' | 'no_show' | 'left';
export const PRIORITY_REASONS = ['disability', 'senior', 'returning_no_show', 'other'] as const;
export type PriorityReason = (typeof PRIORITY_REASONS)[number];
export type TicketKind = 'walkin' | 'appointment';

/** Wait estimate as a range; `sec` is the central estimate. */
export interface WaitEstimate {
  sec: number;
  lowSec: number;
  highSec: number;
}

export interface Ticket {
  /** Secret, unguessable id. Only the resident holding the ticket knows it. */
  id: string;
  /** Public ticket number shown on screens, e.g. "D-042". */
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
  /** Slot start, for tickets created by appointment check-in. */
  appointmentAt: number | null;
  /** The resident's language, for alerts and lobby announcements. */
  lang: Lang;
}

export interface TicketView {
  ticket: Ticket;
  serviceName: string;
  counterName: string | null;
  /** 1-based place in line while waiting; null otherwise. */
  position: number | null;
  ahead: number | null;
  estimatedWaitSec: number | null;
  estimate: WaitEstimate | null;
  servicePaused: boolean;
  serverNow: number;
}

/** Office settings plus live open/closed status — safe to show anyone. */
export interface OfficeInfo extends OfficeConfig {
  status: OpenStatus;
}

export interface WaitingEntry {
  number: string;
  name: string;
  joinedAt: number;
  priority: PriorityReason | null;
  kind: TicketKind;
  appointmentAt: number | null;
}

export interface CounterOutcome {
  number: string;
  outcome: 'served' | 'no_show' | 'left';
  at: number;
}

export interface CounterState {
  counter: number;
  name: string;
  ticket: { number: string; name: string; service: string; calledAt: number; recallCount: number; lang: Lang } | null;
  last: CounterOutcome | null;
}

export interface RecentCall {
  number: string;
  counter: number;
  counterName: string;
  service: string;
  at: number;
  recall?: boolean;
  /** Language to announce this call in (the resident's). */
  lang?: Lang;
}

export interface ServiceState {
  id: string;
  code: string;
  name: string;
  paused: boolean;
  waiting: WaitingEntry[];
  waitingCount: number;
  /** Mean of recent service durations (rolling window). */
  avgServiceSec: number;
  /** Counters effectively serving this line lately (fractional if shared). */
  activeCounters: number;
  /** Estimated wait for someone joining now. */
  estimatedWaitSec: number;
  estimate: WaitEstimate;
  servedToday: number;
  noShowToday: number;
  avgWaitSec: number | null;
}

export interface StaffState {
  office: OfficeInfo;
  services: ServiceState[];
  counters: CounterState[];
  recent: RecentCall[];
  totals: { waiting: number; servedToday: number; noShowToday: number; avgWaitSec: number | null };
  serverNow: number;
}

export interface LobbyState {
  office: OfficeInfo;
  services: Array<Pick<ServiceState, 'id' | 'code' | 'name' | 'paused' | 'waitingCount' | 'estimatedWaitSec' | 'estimate'>>;
  nowServing: Array<{ counter: number; counterName: string; number: string; service: string; calledAt: number; lang: Lang }>;
  recent: RecentCall[];
  serverNow: number;
}
