import type { AppConfig, ServiceId, TicketView } from '../types';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network', 'Can’t reach the server. Check your connection and try again.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? 'server_error', data.message ?? 'Something went wrong.', res.status);
  return data as T;
}

export const api = {
  config: () => request<AppConfig>('GET', '/config'),
  join: (name: string, service: ServiceId) => request<TicketView>('POST', '/tickets', { name, service }),
  getTicket: (id: string) => request<TicketView>('GET', `/tickets/${id}`),
  leave: (id: string) => request<TicketView>('DELETE', `/tickets/${id}`),
  callNext: (counter: number, service?: ServiceId) => request('POST', `/counters/${counter}/call`, { service }),
  served: (counter: number, ticketNumber?: string) => request('POST', `/counters/${counter}/served`, { ticketNumber }),
  noShow: (counter: number, ticketNumber?: string) => request('POST', `/counters/${counter}/no-show`, { ticketNumber }),
  recall: (counter: number) => request('POST', `/counters/${counter}/recall`),
  pause: (service: ServiceId) => request('POST', `/services/${service}/pause`),
  resume: (service: ServiceId) => request('POST', `/services/${service}/resume`),
  seed: () => request('POST', '/admin/seed'),
  reset: () => request('POST', '/admin/reset'),
};
