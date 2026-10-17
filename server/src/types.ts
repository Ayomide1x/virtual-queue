import type { ServiceId } from './services';

export type TicketStatus = 'waiting' | 'called' | 'served' | 'no_show' | 'left';

export interface Ticket {
  /** Secret, unguessable id. Only the resident holding the ticket knows it. */
  id: string;
  /** Public ticket number shown on screens, e.g. "D-042". */
  number: string;
  name: string;
  service: ServiceId;
  status: TicketStatus;
  joinedAt: number;
  calledAt: number | null;
  endedAt: number | null;
  counter: number | null;
  recallCount: number;
}

export interface TicketView {
  ticket: Ticket;
  /** 1-based place in line while waiting; null otherwise. */
  position: number | null;
  ahead: number | null;
  estimatedWaitSec: number | null;
  servicePaused: boolean;
  serverNow: number;
}

export interface WaitingEntry {
  number: string;
  name: string;
  joinedAt: number;
}

export interface CounterOutcome {
  number: string;
  outcome: 'served' | 'no_show' | 'left';
  at: number;
}

export interface CounterState {
  counter: number;
  ticket: { number: string; name: string; service: ServiceId; calledAt: number; recallCount: number } | null;
  last: CounterOutcome | null;
}

export interface RecentCall {
  number: string;
  counter: number;
  service: ServiceId;
  at: number;
  recall?: boolean;
}

export interface ServiceState {
  id: ServiceId;
  code: string;
  name: string;
  paused: boolean;
  waiting: WaitingEntry[];
  waitingCount: number;
  avgServiceSec: number;
  /** Estimated wait for someone joining now. */
  estimatedWaitSec: number;
  servedToday: number;
  noShowToday: number;
  avgWaitSec: number | null;
}

export interface StaffState {
  services: ServiceState[];
  counters: CounterState[];
  recent: RecentCall[];
  totals: { waiting: number; servedToday: number; noShowToday: number; avgWaitSec: number | null };
  serverNow: number;
}

export interface LobbyState {
  services: Array<Pick<ServiceState, 'id' | 'code' | 'name' | 'paused' | 'waitingCount' | 'estimatedWaitSec'>>;
  nowServing: Array<{ counter: number; number: string; service: ServiceId; calledAt: number }>;
  recent: RecentCall[];
  serverNow: number;
}
