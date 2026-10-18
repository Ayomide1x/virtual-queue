import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { OfficeStore } from '../src/offices';
import { closeAll, connect, deleteUnder, uniqueRoot } from './helpers';

const redis = connect();
const root = uniqueRoot();
let base: string;
let closeServer: () => void;
let office: { officeId: string; staffKey: string };

async function api(method: string, path: string, body?: unknown, staffKey?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (staffKey) headers['x-staff-key'] = staffKey;
  const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
const o = (path: string) => `/o/${office.officeId}${path}`;

beforeAll(async () => {
  const { server, io } = createApp({
    redis,
    subscriber: connect(),
    offices: new OfficeStore(redis, { root }),
    publicUrl: 'http://queue.example.test',
    lanIp: null,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () => io.close();
  office = (await api('POST', '/offices', { name: 'Language Office', timezone: 'UTC' })).body;
});
afterAll(async () => {
  closeServer();
  await deleteUnder(redis, root);
  await closeAll();
});

describe('resident language', () => {
  it('stores the language a resident joins in, defaulting to English', async () => {
    const es = await api('POST', o('/tickets'), { name: 'Lucía', service: 'license', lang: 'es' });
    expect(es.status).toBe(201);
    expect(es.body.ticket.lang).toBe('es');
    const plain = await api('POST', o('/tickets'), { name: 'Sam', service: 'license' });
    expect(plain.body.ticket.lang).toBe('en');
  });

  it('rejects languages it doesn’t support', async () => {
    const r = await api('POST', o('/tickets'), { name: 'X', service: 'license', lang: 'xx' });
    expect(r.status).toBe(400);
    expect((await api('PUT', o(`/tickets/${crypto.randomUUID()}/language`), { lang: 'fr' })).status).toBe(400);
  });

  it('lets a resident change language on an active ticket only, without creating keys', async () => {
    const t = (await api('POST', o('/tickets'), { name: 'Ana', service: 'id' })).body.ticket;
    const r = await api('PUT', o(`/tickets/${t.id}/language`), { lang: 'es' });
    expect(r.status).toBe(200);
    expect(r.body.ticket.lang).toBe('es');
    expect((await api('GET', o(`/tickets/${t.id}`))).body.ticket.lang).toBe('es');

    const ghost = crypto.randomUUID();
    expect((await api('PUT', o(`/tickets/${ghost}/language`), { lang: 'es' })).status).toBe(404);
    expect(await redis.exists(`${root}o:${office.officeId}:ticket:${ghost}`)).toBe(0);

    await api('DELETE', o(`/tickets/${t.id}`));
    expect((await api('PUT', o(`/tickets/${t.id}/language`), { lang: 'en' })).status).toBe(404);
  });

  it('tells the lobby which language to announce each call in', async () => {
    const t = (await api('POST', o('/tickets'), { name: 'Rosa', service: 'registration', lang: 'es' })).body.ticket;
    await api('POST', o('/counters/2/call'), { service: 'registration' }, office.staffKey);
    await api('POST', o('/counters/2/recall'), {}, office.staffKey);
    const lobby = (await api('GET', o('/lobby'))).body;
    expect(lobby.recent.slice(0, 2)).toEqual([
      expect.objectContaining({ number: t.number, recall: true, lang: 'es' }),
      expect.objectContaining({ number: t.number, lang: 'es' }),
    ]);
    expect(lobby.nowServing.find((s: any) => s.number === t.number)).toMatchObject({ counterName: 'Counter 2', lang: 'es' });
    // Still no names on the public lobby.
    expect(JSON.stringify(lobby)).not.toContain('Rosa');
  });

  it('stores an appointment’s language and lets the resident change it', async () => {
    await api('PUT', o('/settings'), { appointments: { enabled: true } }, office.staffKey);
    const day = (await api('GET', o('/slots?service=id'))).body.days.find((d: any) => d.slots.some((s: any) => s.remaining > 0));
    const slot = day.slots.find((s: any) => s.remaining > 0);
    const booked = await api('POST', o('/appointments'), { name: 'Eva', service: 'id', date: day.date, time: slot.time, lang: 'es' });
    expect(booked.status).toBe(201);
    expect(booked.body.appointment.lang).toBe('es');
    const changed = await api('PUT', o(`/appointments/${booked.body.appointment.id}/language`), { lang: 'en' });
    expect(changed.body.appointment.lang).toBe('en');
    expect((await api('PUT', o(`/appointments/${crypto.randomUUID()}/language`), { lang: 'en' })).status).toBe(404);
  });
});
