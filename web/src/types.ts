// Mirrors server/src/types.ts — keep in sync.
export type ServiceId = 'license' | 'registration' | 'id';
export type TicketStatus = 'waiting' | 'called' | 'served' | 'no_show' | 'left';

export interface ServiceDef {
  id: ServiceId;
  code: string;
  name: string;
  defaultServiceSec: number;
}

export interface Ticket {
  id: string;
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

export interface CounterState {
  counter: number;
  ticket: { number: string; name: string; service: ServiceId; calledAt: number; recallCount: number } | null;
  last: { number: string; outcome: 'served' | 'no_show' | 'left'; at: number } | null;
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

export interface AppConfig {
  services: ServiceDef[];
  counters: number;
  lanIp: string | null;
  publicJoinUrl: string | null;
}
