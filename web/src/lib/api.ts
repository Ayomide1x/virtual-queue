import type {
  AnalyticsReport,
  AppointmentSettings,
  AppointmentView,
  CreatedOffice,
  DayAvailability,
  DayView,
  Lang,
  OfficeConfig,
  OfficeResponse,
  PriorityReason,
  TicketView,
} from '../types';
import { getStaffKey } from './staffKey';

export interface AlertContact {
  push: boolean;
  /** Masked by the server, e.g. "a******@g****.com". */
  email: string | null;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network', 'Can’t reach the server. Check your connection and try again.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? 'server_error', data.message ?? 'Something went wrong.', res.status);
  return data as T;
}

const rangeQuery = (from?: string, to?: string) => {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const createOffice = (opts: { name?: string; timezone?: string; seed?: boolean }) =>
  request<CreatedOffice>('POST', '/offices', opts);

/** API scoped to one office. Staff calls send the key saved for that office. */
export function officeApi(officeId: string) {
  const base = `/o/${officeId}`;
  const staff = <T = unknown>(method: string, path: string, body?: unknown) =>
    request<T>(method, `${base}${path}`, body, { 'X-Staff-Key': getStaffKey(officeId) ?? '' });
  return {
    officeId,
    info: () => request<OfficeResponse>('GET', base),
    join: (name: string, service: string, lang: Lang) => request<TicketView>('POST', `${base}/tickets`, { name, service, lang }),
    setTicketLanguage: (ticketId: string, lang: Lang) => request<TicketView>('PUT', `${base}/tickets/${ticketId}/language`, { lang }),
    setAppointmentLanguage: (id: string, lang: Lang) => request<AppointmentView>('PUT', `${base}/appointments/${id}/language`, { lang }),
    leave: (ticketId: string) => request<TicketView>('DELETE', `${base}/tickets/${ticketId}`),
    getTicketAlerts: (ticketId: string) => request<AlertContact>('GET', `${base}/tickets/${ticketId}/notify`),
    setTicketAlerts: (ticketId: string, body: { push?: PushSubscriptionJSON; email?: string }) => request<AlertContact>('POST', `${base}/tickets/${ticketId}/notify`, body),
    removeTicketAlerts: (ticketId: string, channel: 'push' | 'email') => request<AlertContact>('DELETE', `${base}/tickets/${ticketId}/notify?channel=${channel}`),
    getAppointmentAlerts: (id: string) => request<AlertContact>('GET', `${base}/appointments/${id}/notify`),
    setAppointmentAlerts: (id: string, body: { push?: PushSubscriptionJSON; email?: string }) => request<AlertContact>('POST', `${base}/appointments/${id}/notify`, body),
    removeAppointmentAlerts: (id: string, channel: 'push' | 'email') => request<AlertContact>('DELETE', `${base}/appointments/${id}/notify?channel=${channel}`),
    slots: (service: string) => request<{ days: DayAvailability[]; settings: AppointmentSettings }>('GET', `${base}/slots?service=${encodeURIComponent(service)}`),
    book: (input: { name: string; service: string; date: string; time: string; lang: Lang }) => request<AppointmentView>('POST', `${base}/appointments`, input),
    appointment: (id: string) => request<AppointmentView>('GET', `${base}/appointments/${id}`),
    checkIn: (id: string) => request<{ ticketId: string; view: TicketView }>('POST', `${base}/appointments/${id}/check-in`),
    cancelAppointment: (id: string) => request<AppointmentView>('POST', `${base}/appointments/${id}/cancel`),

    verifyStaffKey: (key: string) => request('GET', `${base}/session`, undefined, { 'X-Staff-Key': key }),
    callNext: (counter: number, service?: string) => staff<{ number: string; name: string; counterName: string }>('POST', `/counters/${counter}/call`, { service }),
    served: (counter: number, ticketNumber?: string) => staff<{ number: string }>('POST', `/counters/${counter}/served`, { ticketNumber }),
    noShow: (counter: number, ticketNumber?: string) => staff<{ number: string }>('POST', `/counters/${counter}/no-show`, { ticketNumber }),
    recall: (counter: number) => staff<{ number: string }>('POST', `/counters/${counter}/recall`),
    pause: (service: string) => staff('POST', `/services/${service}/pause`),
    resume: (service: string) => staff('POST', `/services/${service}/resume`),
    setPriority: (number: string, reason: PriorityReason | null) => staff<{ number: string }>('POST', '/priority', { number, reason }),
    dayView: (date?: string) => staff<DayView>('GET', `/appointments${date ? `?date=${date}` : ''}`),
    getSettings: () => staff<OfficeConfig>('GET', '/settings'),
    saveSettings: (settings: unknown) => staff<OfficeConfig>('PUT', '/settings', settings),
    analytics: (from?: string, to?: string) => staff<AnalyticsReport>('GET', `/analytics${rangeQuery(from, to)}`),
    /** CSV files need the staff key header, so they're fetched and then saved by the browser. */
    downloadCsv: async (kind: 'events' | 'visits', from: string, to: string) => {
      let res: Response;
      try {
        res = await fetch(`/api${base}/analytics/${kind}.csv${rangeQuery(from, to)}`, { headers: { 'X-Staff-Key': getStaffKey(officeId) ?? '' } });
      } catch {
        throw new ApiError('network', 'Can’t reach the server. Check your connection and try again.', 0);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ApiError(data.error ?? 'server_error', data.message ?? 'Could not download the file.', res.status);
      }
      const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${kind}.csv`;
      return { blob: await res.blob(), name };
    },
    seed: () => staff('POST', '/seed'),
    reset: () => staff('POST', '/reset'),
  };
}
