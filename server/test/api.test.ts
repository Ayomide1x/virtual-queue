import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { OfficeStore } from '../src/offices';
import { closeAll, connect, deleteUnder, sleep, uniqueRoot } from './helpers';

interface TestServer {
  base: string;
  root: string;
  close: () => Promise<void>;
}

async function startServer(rateLimits?: Parameters<typeof createApp>[0]['rateLimits']): Promise<TestServer> {
  const redis = connect();
  const subscriber = connect();
  const root = uniqueRoot();
  const { server, io } = createApp({
    redis,
    subscriber,
    offices: new OfficeStore(redis, { root }),
    publicUrl: 'http://queue.example.test',
    lanIp: null,
    rateLimits: rateLimits ?? { createOffice: { limit: 1000, windowSec: 60 }, join: { limit: 1000, windowSec: 60 } },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    root,
    close: async () => {
      io.close();
      await deleteUnder(redis, root);
    },
  };
}

let srv: TestServer;
const sockets: Socket[] = [];

function client(base: string) {
  return async (method: string, path: string, body?: unknown, staffKey?: string) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (staffKey !== undefined) headers['x-staff-key'] = staffKey;
    const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, headers: r.headers, body: (await r.json().catch(() => null)) as any };
  };
}
let api: ReturnType<typeof client>;

async function createOffice(name = 'Office') {
  const r = await api('POST', '/offices', { name, timezone: 'UTC' });
  expect(r.status).toBe(201);
  return r.body as { officeId: string; staffKey: string; office: { name: string } };
}

/** Socket that records every event it receives. */
function socket(base: string) {
  const s = ioClient(base, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  const events: Array<{ event: string; data: any }> = [];
  s.onAny((event, data) => events.push({ event, data }));
  const waitFor = (pred: (e: { event: string; data: any }) => boolean, ms = 3000) =>
    new Promise<{ event: string; data: any }>((resolve, reject) => {
      const found = events.find(pred);
      if (found) return resolve(found);
      const t = setTimeout(() => reject(new Error('timed out waiting for socket event')), ms);
      s.onAny((event, data) => {
        if (pred({ event, data })) {
          clearTimeout(t);
          resolve({ event, data });
        }
      });
    });
  return { s, events, waitFor };
}

beforeAll(async () => {
  srv = await startServer();
  api = client(srv.base);
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await srv.close();
  await closeAll();
});

describe('creating offices', () => {
  it('returns an id, a secret staff key, settings and the public URL', async () => {
    const r = await api('POST', '/offices', { name: 'Downtown DMV', timezone: 'America/Chicago' });
    expect(r.status).toBe(201);
    expect(r.body.officeId).toMatch(/^[a-z0-9]{10}$/);
    expect(r.body.staffKey.length).toBeGreaterThanOrEqual(32);
    expect(r.body.office).toMatchObject({ name: 'Downtown DMV', timezone: 'America/Chicago' });
    expect(r.body.publicUrl).toBe('http://queue.example.test');
  });

  it('can start with sample residents', async () => {
    const r = await api('POST', '/offices', { seed: true });
    const lobby = await api('GET', `/o/${r.body.officeId}/lobby`);
    expect(lobby.body.services.reduce((a: number, s: any) => a + s.waitingCount, 0)).toBeGreaterThan(10);
  });

  it('unknown and malformed offices give a clear 404', async () => {
    for (const id of ['nosuchoffice', 'BAD-ID', 'a']) {
      const r = await api('GET', `/o/${id}`);
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ error: 'office_not_found' });
      expect(r.body.message).toMatch(/doesn’t exist or has expired/);
    }
    expect((await api('POST', '/o/nosuchoffice/tickets', { name: 'A', service: 'license' })).status).toBe(404);
  });
});

describe('staff key', () => {
  const staffCalls: Array<[string, string, unknown?]> = [
    ['GET', '/state'],
    ['GET', '/session'],
    ['GET', '/settings'],
    ['PUT', '/settings', {}],
    ['POST', '/counters/1/call', {}],
    ['POST', '/counters/1/served', {}],
    ['POST', '/counters/1/no-show', {}],
    ['POST', '/counters/1/recall'],
    ['POST', '/services/license/pause'],
    ['POST', '/services/license/resume'],
    ['POST', '/seed'],
    ['POST', '/reset'],
    ['POST', '/priority', { number: 'D-001', reason: 'senior' }],
    ['GET', '/appointments'],
  ];

  it('every staff action needs a key (401) and rejects a wrong one (403)', async () => {
    const a = await createOffice();
    for (const [method, path, body] of staffCalls) {
      expect((await api(method, `/o/${a.officeId}${path}`, body)).status, `${method} ${path} without key`).toBe(401);
      const wrong = await api(method, `/o/${a.officeId}${path}`, body, 'not-the-key');
      expect(wrong.status, `${method} ${path} with wrong key`).toBe(403);
      expect(wrong.body.error).toBe('forbidden');
    }
  });

  it('another office’s valid key is rejected (403)', async () => {
    const a = await createOffice();
    const b = await createOffice();
    for (const [method, path, body] of staffCalls) {
      expect((await api(method, `/o/${a.officeId}${path}`, body, b.staffKey)).status, `${method} ${path}`).toBe(403);
    }
  });

  it('the right key works; display and join need none', async () => {
    const a = await createOffice();
    expect((await api('GET', `/o/${a.officeId}/session`, undefined, a.staffKey)).status).toBe(200);
    expect((await api('GET', `/o/${a.officeId}`)).status).toBe(200);
    expect((await api('GET', `/o/${a.officeId}/lobby`)).status).toBe(200);
    expect((await api('POST', `/o/${a.officeId}/tickets`, { name: 'Ana', service: 'license' })).status).toBe(201);
  });

  it('a rejected staff action changes nothing', async () => {
    const a = await createOffice();
    await api('POST', `/o/${a.officeId}/tickets`, { name: 'Ana', service: 'license' });
    await api('POST', `/o/${a.officeId}/counters/1/call`, {}, 'wrong');
    await api('PUT', `/o/${a.officeId}/settings`, { name: 'Hacked' }, 'wrong');
    await api('POST', `/o/${a.officeId}/reset`, undefined, 'wrong');
    const state = await api('GET', `/o/${a.officeId}/state`, undefined, a.staffKey);
    expect(state.body.totals.waiting).toBe(1);
    expect(state.body.office.name).toBe('Office');
  });
});

describe('offices cannot see or change each other’s data', () => {
  it('tickets, state and actions stay inside their office', async () => {
    const a = await createOffice('A');
    const b = await createOffice('B');
    const ta = (await api('POST', `/o/${a.officeId}/tickets`, { name: 'Alice', service: 'license' })).body;
    const tb = (await api('POST', `/o/${b.officeId}/tickets`, { name: 'Bob', service: 'license' })).body;

    // A's ticket id is meaningless in office B — reading or leaving through B fails.
    expect((await api('GET', `/o/${b.officeId}/tickets/${ta.ticket.id}`)).status).toBe(404);
    expect((await api('DELETE', `/o/${b.officeId}/tickets/${ta.ticket.id}`)).status).toBe(404);
    expect((await api('GET', `/o/${a.officeId}/tickets/${ta.ticket.id}`)).body.ticket.status).toBe('waiting');

    // Staff state and lobby only contain their own office.
    const stateA = (await api('GET', `/o/${a.officeId}/state`, undefined, a.staffKey)).body;
    expect(JSON.stringify(stateA)).toContain('Alice');
    expect(JSON.stringify(stateA)).not.toContain('Bob');
    expect(JSON.stringify(stateA)).not.toContain(tb.ticket.id);

    // Calling next in B never touches A.
    const called = await api('POST', `/o/${b.officeId}/counters/1/call`, {}, b.staffKey);
    expect(called.body.name).toBe('Bob');
    expect((await api('POST', `/o/${b.officeId}/counters/2/call`, {}, b.staffKey)).body.error).toBe('empty');
    expect((await api('GET', `/o/${a.officeId}/tickets/${ta.ticket.id}`)).body.ticket.status).toBe('waiting');

    // Settings and reset are per office.
    const settingsB = (await api('GET', `/o/${b.officeId}/settings`, undefined, b.staffKey)).body;
    await api('PUT', `/o/${b.officeId}/settings`, { ...settingsB, name: 'B renamed' }, b.staffKey);
    await api('POST', `/o/${b.officeId}/reset`, undefined, b.staffKey);
    expect((await api('GET', `/o/${a.officeId}`)).body.office.name).toBe('A');
    expect((await api('GET', `/o/${a.officeId}/lobby`)).body.services[0].waitingCount).toBe(1);
  });

  it('live updates only reach the office they belong to', async () => {
    const a = await createOffice('A');
    const b = await createOffice('B');
    const lobbyA = socket(srv.base);
    lobbyA.s.emit('subscribe', { officeId: a.officeId, role: 'lobby' });
    await lobbyA.waitFor((e) => e.event === 'lobby:state');

    await api('POST', `/o/${b.officeId}/tickets`, { name: 'Bob', service: 'license' });
    await api('POST', `/o/${b.officeId}/counters/1/call`, {}, b.staffKey);
    await sleep(300);
    expect(lobbyA.events.every((e) => e.data.officeId === a.officeId)).toBe(true);
    expect(lobbyA.events.filter((e) => e.event === 'lobby:state')).toHaveLength(1);

    await api('POST', `/o/${a.officeId}/tickets`, { name: 'Alice', service: 'id' });
    const update = await lobbyA.waitFor((e) => e.event === 'lobby:state' && e.data.services.some((s: any) => s.waitingCount === 1));
    expect(update.data.officeId).toBe(a.officeId);
    expect(JSON.stringify(lobbyA.events)).not.toContain('Bob');
  });

  it('a ticket can’t be watched through another office', async () => {
    const a = await createOffice();
    const b = await createOffice();
    const ta = (await api('POST', `/o/${a.officeId}/tickets`, { name: 'Alice', service: 'license' })).body;
    const spy = socket(srv.base);
    spy.s.emit('subscribe', { officeId: b.officeId, role: 'ticket', ticketId: ta.ticket.id });
    const got = await spy.waitFor((e) => e.event === 'ticket:update');
    expect(got.data.view).toBeNull();
  });
});

describe('priority and appointments over the API', () => {
  it('staff mark priority by ticket number; the line reorders', async () => {
    const a = await createOffice();
    await api('POST', `/o/${a.officeId}/tickets`, { name: 'First', service: 'license' });
    const second = (await api('POST', `/o/${a.officeId}/tickets`, { name: 'Second', service: 'license' })).body;
    const r = await api('POST', `/o/${a.officeId}/priority`, { number: second.ticket.number, reason: 'senior' }, a.staffKey);
    expect(r.status).toBe(200);
    expect((await api('GET', `/o/${a.officeId}/tickets/${second.ticket.id}`)).body).toMatchObject({ position: 1, ticket: { priority: 'senior' } });
    expect((await api('POST', `/o/${a.officeId}/priority`, { number: second.ticket.number, reason: 'vip' }, a.staffKey)).status).toBe(400);
    expect((await api('POST', `/o/${a.officeId}/priority`, { number: 'D-999', reason: null }, a.staffKey)).status).toBe(404);
    // The public lobby never reveals priority reasons.
    expect(JSON.stringify((await api('GET', `/o/${a.officeId}/lobby`)).body)).not.toContain('senior');
  });

  it('book, view and cancel an appointment; it stays inside its office', async () => {
    const a = await createOffice();
    const b = await createOffice();
    const slots = (await api('GET', `/o/${a.officeId}/slots?service=license`)).body;
    const day = slots.days.find((d: any) => d.slots.length);
    expect(day).toBeTruthy();
    const booked = await api('POST', `/o/${a.officeId}/appointments`, { name: 'Ana', service: 'license', date: day.date, time: day.slots[0].time });
    expect(booked.status).toBe(201);
    const id = booked.body.appointment.id;
    expect(booked.body.appointment).toMatchObject({ name: 'Ana', status: 'booked', serviceName: "Driver's License" });
    expect(booked.body.appointment.ref).toMatch(/^[A-Z0-9]{6}$/);

    expect((await api('GET', `/o/${b.officeId}/appointments/${id}`)).status).toBe(404);
    expect((await api('POST', `/o/${b.officeId}/appointments/${id}/cancel`)).status).toBe(404);
    expect((await api('POST', `/o/${b.officeId}/appointments/${id}/check-in`)).status).toBe(404);

    const dayView = await api('GET', `/o/${a.officeId}/appointments?date=${day.date}`, undefined, a.staffKey);
    expect(dayView.body.entries.map((e: any) => e.name)).toEqual(['Ana']);
    expect((await api('GET', `/o/${b.officeId}/appointments?date=${day.date}`, undefined, b.staffKey)).body.entries).toEqual([]);

    const cancelled = await api('POST', `/o/${a.officeId}/appointments/${id}/cancel`);
    expect(cancelled.body.appointment.status).toBe('cancelled');
    expect((await api('POST', `/o/${a.officeId}/appointments/${id}/check-in`)).status).toBe(409);
  });

  it('booking is refused when the office has appointments switched off', async () => {
    const a = await createOffice();
    const settings = (await api('GET', `/o/${a.officeId}/settings`, undefined, a.staffKey)).body;
    await api('PUT', `/o/${a.officeId}/settings`, { ...settings, appointments: { ...settings.appointments, enabled: false } }, a.staffKey);
    const r = await api('GET', `/o/${a.officeId}/slots?service=license`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('appointments_off');
  });
});

describe('socket authorization', () => {
  it('staff subscriptions need the right key; wrong keys get an error and no data', async () => {
    const a = await createOffice();
    const b = await createOffice();
    for (const staffKey of ['wrong', b.staffKey, '']) {
      const sock = socket(srv.base);
      sock.s.emit('subscribe', { officeId: a.officeId, role: 'staff', staffKey });
      const err = await sock.waitFor((e) => e.event === 'subscribe:error');
      expect(err.data).toMatchObject({ officeId: a.officeId, role: 'staff', code: 'forbidden' });
      await api('POST', `/o/${a.officeId}/tickets`, { name: 'Leak?', service: 'license' });
      await sleep(200);
      expect(sock.events.some((e) => e.event === 'staff:state')).toBe(false);
    }
    const ok = socket(srv.base);
    ok.s.emit('subscribe', { officeId: a.officeId, role: 'staff', staffKey: a.staffKey });
    const state = await ok.waitFor((e) => e.event === 'staff:state');
    expect(state.data.officeId).toBe(a.officeId);
  });

  it('subscribing to an unknown office reports office_not_found', async () => {
    const sock = socket(srv.base);
    sock.s.emit('subscribe', { officeId: 'nosuchoffice', role: 'lobby' });
    expect((await sock.waitFor((e) => e.event === 'subscribe:error')).data.code).toBe('office_not_found');
  });
});

describe('settings over the API', () => {
  it('saves valid settings, reflects them live, and rejects invalid ones with a message', async () => {
    const a = await createOffice();
    const lobby = socket(srv.base);
    lobby.s.emit('subscribe', { officeId: a.officeId, role: 'lobby' });
    await lobby.waitFor((e) => e.event === 'lobby:state');

    const settings = (await api('GET', `/o/${a.officeId}/settings`, undefined, a.staffKey)).body;
    settings.name = 'Riverside DMV';
    settings.counters[0].name = 'Window A';
    const saved = await api('PUT', `/o/${a.officeId}/settings`, settings, a.staffKey);
    expect(saved.status).toBe(200);
    const live = await lobby.waitFor((e) => e.event === 'lobby:state' && e.data.office.name === 'Riverside DMV');
    expect(live.data.office.counters[0].name).toBe('Window A');

    settings.services[1].code = settings.services[0].code;
    const bad = await api('PUT', `/o/${a.officeId}/settings`, settings, a.staffKey);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/both use the letter/);
  });

  it('closes joining outside opening hours, on the join API and the display', async () => {
    const a = await createOffice();
    const settings = (await api('GET', `/o/${a.officeId}/settings`, undefined, a.staffKey)).body;
    settings.hoursEnabled = true;
    for (const d of Object.keys(settings.hours)) settings.hours[d] = null;
    settings.hours.mon = { open: '09:00', close: '10:00' };
    // Pick a time zone where it is certainly not Monday 09:00–10:00 right now.
    const day = new Date().getUTCDay();
    settings.timezone = day === 1 ? 'Pacific/Kiritimati' : 'UTC';
    await api('PUT', `/o/${a.officeId}/settings`, settings, a.staffKey);

    const join = await api('POST', `/o/${a.officeId}/tickets`, { name: 'Ana', service: 'license' });
    expect(join.status).toBe(409);
    expect(join.body.error).toBe('closed');
    expect(join.body.message).toMatch(/We open/);
    const lobby = (await api('GET', `/o/${a.officeId}/lobby`)).body;
    expect(lobby.office.status.open).toBe(false);
  });
});

describe('rate limits', () => {
  it('limits office creation and joining per IP, with Retry-After', async () => {
    const limited = await startServer({ createOffice: { limit: 2, windowSec: 60 }, join: { limit: 3, windowSec: 60 } });
    const call = client(limited.base);
    try {
      expect((await call('POST', '/offices', {})).status).toBe(201);
      const second = await call('POST', '/offices', {});
      expect(second.status).toBe(201);
      const third = await call('POST', '/offices', {});
      expect(third.status).toBe(429);
      expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(third.body.message).toMatch(/Too many requests/);

      const officeId = second.body.officeId;
      for (let i = 0; i < 3; i++) expect((await call('POST', `/o/${officeId}/tickets`, { name: `R${i}`, service: 'license' })).status).toBe(201);
      const blocked = await call('POST', `/o/${officeId}/tickets`, { name: 'R4', service: 'license' });
      expect(blocked.status).toBe(429);
      // Reading stays available.
      expect((await call('GET', `/o/${officeId}/lobby`)).status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
